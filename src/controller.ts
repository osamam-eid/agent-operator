/**
 * Agent Operator — `/operator` runtime controller.
 *
 * `OperatorRuntime` is the only mutable object in the runtime slice. It
 * holds two pieces of in-memory state: the *id* of the active session (per
 * the Stage 2/3 contract: canonical state always lives in the injected
 * store) and, new in Stage 4, the in-memory map of `ActiveExecutionBatch`
 * handles currently in flight, keyed by `operatorSessionId` (plan §4.1:
 * "the runtime owns the handle"). Every mutating command or callback goes
 * through the single `#applyWithCas` helper: reload the latest record,
 * apply a pure `state.ts` reducer to it (which re-validates every
 * precondition against the *fresh* record — the "legality recheck"), and
 * persist with compare-and-swap, retrying a bounded number of times on a
 * conflict. Nothing here ever mutates a loaded record in place, and no
 * exception from a completion/timeout/shutdown callback ever escapes —
 * every public entry point below is `async` and returns a normal
 * `OperatorCommandOutcome`, even on internal failure.
 *
 * CONTINUE no longer executes a node synchronously. It selects a ready
 * batch, allocates attempt/provider-session identity, persists every
 * selected node `RUNNING` *before* the adapter is ever called, builds each
 * node's `NodeExecutionRequest` via the injected `contextProjector`, calls
 * `NodeExecutionAdapterResolver`-selected adapter (which itself returns
 * immediately), records the returned `ActiveExecutionBatch`, and returns.
 * The extension-owned task supervisor (not this class) is responsible for
 * safely wiring `batch.completion` to `completeBatch` and a per-batch
 * timeout to `timeoutBatch`, via the optional `registerActiveBatch` hook —
 * this class never creates a raw detached promise itself; tests may also
 * drive `completeBatch`/`timeoutBatch` directly.
 */

import { validateOperatorCommandOutcome, validateStoredOperatorSession } from './runtime-validators.js';
import { StoreConflictError } from './store.js';
import { existsSync, readFileSync } from 'node:fs';
import { parseOperatorCommand } from './commands.js';
import { bootstrapCatalog, defaultModelsYamlPath, fleetCatalogPath, loadCatalogFile, mergeCatalog, parseOmpModelsYaml, saveCatalogFile } from './fleet-catalog.js';
import { validateAgentResult } from './validation/results.js';
import {
  beginExecutionBatch,
  cancelExecutionBatch,
  completeExecutionBatch,
  decideGate,
  deriveAttemptId,
  isTransitionError,
  reconcileExecutionBatch,
  selectReadyBatch,
  startSession,
  type OperatorTransitionError,
} from './state.js';
import { assertStage7FeatureSetMatch, Stage7FeatureSetMismatchError } from './stage7/feature-config.js';
import { Stage7RouteResolutionError } from './stage7/adapter-resolver.js';
import type { NodeExecutionTuple } from './stage7/types.js';
import type { AgentResult, ExecutionGraphNode, HumanGate } from './contracts.js';
import type {
  ActiveExecutionBatch,
  ExecutionBatchRequest,
  NodeExecutionAttemptAllocation,
  NodeExecutionOutcome,
  NodeExecutionRequest,
  NodeExecutionAdapter,
  OperatorCommandErrorCode,
  OperatorCommandOutcome,
  OperatorRuntimeDependencies,
  StoredOperatorSession,
} from './runtime-types.js';
import type { WorkflowCompilerContext } from './stage3-types.js';

type LoadedActive = { readonly ok: true; readonly record: StoredOperatorSession } | { readonly ok: false; readonly outcome: OperatorCommandOutcome };

type PersistResult = { readonly ok: true } | { readonly ok: false; readonly outcome: OperatorCommandOutcome };

function trustedUsage(usage: NodeExecutionOutcome['usage']): NodeExecutionOutcome['usage'] {
  if (usage === undefined || !Number.isInteger(usage.tokens) || usage.tokens < 0) return undefined;
  if (usage.cost !== null && (!Number.isFinite(usage.cost) || usage.cost < 0)) return undefined;
  return { tokens: usage.tokens, cost: usage.cost };
}

type CasResult = { readonly ok: true; readonly record: StoredOperatorSession } | { readonly ok: false; readonly outcome: OperatorCommandOutcome };

const DEFAULT_CAS_ATTEMPTS = 5;

export class OperatorRuntime {
  readonly #deps: OperatorRuntimeDependencies;
  #activeSessionId: string | undefined;
  readonly #activeBatches = new Map<string, ActiveExecutionBatch>();

  constructor(deps: OperatorRuntimeDependencies) {
    this.#deps = deps;
  }

  async handle(rawArgs: string): Promise<OperatorCommandOutcome> {
    const parsed = parseOperatorCommand(rawArgs);
    let outcome: OperatorCommandOutcome = {
      ok: false,
      text: 'Unsupported operator command.',
      errorCode: 'INVALID_COMMAND',
    };
    if (parsed.kind === 'PARSE_ERROR') {
      outcome = { ok: false, text: parsed.message, errorCode: 'INVALID_COMMAND' };
    } else {
      switch (parsed.kind) {
        case 'START':
          outcome = await this.#handleStart(parsed.request, parsed.mode);
          break;
        case 'EXPLAIN':
          outcome = await this.#handleExplain();
          break;
        case 'WHY':
          outcome = await this.#handleWhy();
          break;
        case 'STATUS':
          outcome = await this.#handleStatus();
          break;
        case 'GRAPH':
          outcome = await this.#handleGraph();
          break;
        case 'APPROVE':
          outcome = await this.#handleDecision(parsed.gateId, 'APPROVE');
          break;
        case 'REJECT':
          outcome = await this.#handleDecision(parsed.gateId, 'REJECT');
          break;
        case 'CONTINUE':
          outcome = await this.#handleContinue();
          break;
        case 'CANCEL':
          outcome = await this.#handleCancel();
          break;
        case 'RESUME':
          outcome = await this.#handleResume(parsed.operatorSessionId);
          break;
        case 'FLEET':
          outcome = await this.#handleFleet(parsed.subcommand, parsed.args);
          break;
        case 'IMPROVE':
          outcome = this.#deps.evaluatorHandler === undefined
            ? { ok: false, text: 'The evaluator subsystem is disabled by immutable startup configuration.', errorCode: 'FEATURE_DISABLED' }
            : await this.#deps.evaluatorHandler(parsed.subcommand, parsed.args);
          break;
      }
    }

    const validation = validateOperatorCommandOutcome(outcome);
    if (!validation.ok) {
      return {
        ok: false,
        text: 'Operator produced an invalid command outcome and refused to expose it.',
        errorCode: 'CONTRACT_INVALID',
      };
    }
    return validation.value;
  }

  // -------------------------------------------------------------------------
  // Public runtime-lifecycle surface for the extension-owned task
  // supervisor (execution-coordinator.ts). None of these throw.
  // -------------------------------------------------------------------------

  /** Read-only accessor for an in-flight batch (used by `status` output and
   * by the supervisor to wire `completion`/timeouts after launch). */
  getActiveBatch(operatorSessionId: string): ActiveExecutionBatch | undefined {
    return this.#activeBatches.get(operatorSessionId);
  }

  /** The supervised completion job (plan §6.2): validates every outcome's
   * `AgentResult` shape, folds only outcomes whose attempt still matches
   * the session's `activeAttempts` exactly, and persists via bounded CAS.
   * A stale, replayed, or already-superseded batch is a no-op, not an
   * error the human needs to see. */
  async completeBatch(operatorSessionId: string, batchId: string, outcomes: readonly NodeExecutionOutcome[]): Promise<OperatorCommandOutcome> {
    try {
      const sanitized = this.#sanitizeOutcomes(outcomes);
      const result = await this.#applyWithCas(operatorSessionId, (current, now) => {
        const stillActive = Object.values(current.activeAttempts).some((attempt) => attempt.batchId === batchId);
        if (!stillActive) {
          return transitionErrorLocal('CONTRACT_INVALID', `Batch "${batchId}" is no longer active for session "${operatorSessionId}"; its completion is ignored.`);
        }
        return completeExecutionBatch(current, sanitized, this.#deps.ids, now);
      });
      if (result.ok) this.#activeBatches.delete(operatorSessionId);
      if (!result.ok) return result.outcome;
      if (result.record.session.currentState === 'FAILED') {
        const workflowStatus = result.record.session.terminalResult?.status.workflowStatus;
        const dispositionBlocked = workflowStatus === 'BLOCKED' || workflowStatus === 'HUMAN_DECISION_REQUIRED';
        return {
          ok: false,
          text: dispositionBlocked
            ? `Batch "${batchId}" completed for session ${operatorSessionId}: a reported finding disposition prevents progression. Session is FAILED closed.`
            : `Batch "${batchId}" completed for session ${operatorSessionId}: a mandatory node failed. Session is FAILED.`,
          errorCode: 'NODE_EXECUTION_FAILED',
          operatorSessionId,
          session: result.record.session,
        };
      }
      if (result.record.session.currentState === 'BLOCKED') {
        return {
          ok: false,
          text: `Batch "${batchId}" completed for session ${operatorSessionId}: a mandatory node reported BLOCKED. Session is BLOCKED.`,
          errorCode: 'BLOCKED_CAPABILITY',
          operatorSessionId,
          session: result.record.session,
        };
      }
      return {
        ok: true,
        text: `Batch "${batchId}" completed for session ${operatorSessionId}; session is now ${result.record.session.currentState}.`,
        operatorSessionId,
        session: result.record.session,
      };
    } catch (error) {
      return { ok: false, text: `Failed to apply batch "${batchId}" completion: ${describeError(error)}`, errorCode: 'CONTRACT_INVALID', operatorSessionId };
    }
  }

  /** Called by the supervisor when a batch's earliest attempt timeout
   * fires. A no-op if the named batch is no longer the active one (a
   * winning completion already resolved it — timeout never overwrites a
   * legitimate terminal state). */
  async timeoutBatch(operatorSessionId: string, batchId: string): Promise<OperatorCommandOutcome> {
    try {
      const active = this.#activeBatches.get(operatorSessionId);
      if (active === undefined || active.batchId !== batchId) {
        return { ok: true, text: `Timeout for batch "${batchId}" ignored: it is no longer the active batch for session ${operatorSessionId}.`, operatorSessionId };
      }
      await active.cancel('TIMEOUT');
      const result = await this.#applyWithCas(operatorSessionId, (current, now) => {
        const attemptIds = Object.values(current.activeAttempts)
          .filter((attempt) => attempt.batchId === batchId)
          .map((attempt) => attempt.attemptId);
        if (attemptIds.length === 0) return current;
        return cancelExecutionBatch(current, attemptIds, 'TIMEOUT', now);
      });
      if (result.ok) this.#activeBatches.delete(operatorSessionId);
      if (!result.ok) return result.outcome;
      return {
        ok: true,
        text: `Batch "${batchId}" for session ${operatorSessionId} timed out; session is now ${result.record.session.currentState}.`,
        operatorSessionId,
        session: result.record.session,
      };
    } catch (error) {
      return { ok: false, text: `Failed to apply batch "${batchId}" timeout: ${describeError(error)}`, errorCode: 'EXECUTION_TIMEOUT', operatorSessionId };
    }
  }

  /** Cancels every currently active batch with `'SHUTDOWN'`. Awaits every
   * cancellation and CAS application (`Promise.allSettled`); never throws. */
  async shutdownActive(): Promise<void> {
    const entries = Array.from(this.#activeBatches.entries());
    await Promise.allSettled(
      entries.map(async ([operatorSessionId, active]) => {
        await active.cancel('SHUTDOWN');
        await this.#applyWithCas(operatorSessionId, (current, now) => {
          const attemptIds = Object.values(current.activeAttempts).map((attempt) => attempt.attemptId);
          if (attemptIds.length === 0) return current;
          return cancelExecutionBatch(current, attemptIds, 'SHUTDOWN', now);
        });
        this.#activeBatches.delete(operatorSessionId);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Shared load/validate/persist plumbing
  // -------------------------------------------------------------------------

  async #loadActive(): Promise<LoadedActive> {
    if (this.#activeSessionId === undefined) {
      return {
        ok: false,
        outcome: { ok: false, text: 'No active session. Start one with a request, or resume an existing session id.', errorCode: 'NO_ACTIVE_SESSION' },
      };
    }
    const record = await this.#deps.store.load(this.#activeSessionId);
    if (record === undefined) {
      return {
        ok: false,
        outcome: {
          ok: false,
          text: `Active session "${this.#activeSessionId}" was not found in the store.`,
          errorCode: 'SESSION_NOT_FOUND',
          operatorSessionId: this.#activeSessionId,
        },
      };
    }
    return { ok: true, record };
  }

  /** Validates the store envelope (session + gates + Stage 4 ledgers)
   * before ever calling `store.save`: nothing invalid is ever persisted.
   * Maps `StoreConflictError` to `STORE_CONFLICT`; any other thrown error
   * propagates (it is not a legal command-outcome shape). */
  async #persist(record: StoredOperatorSession, expectedUpdatedAt?: string): Promise<PersistResult> {
    const validation = validateStoredOperatorSession(record);
    if (!validation.ok) {
      const detail = validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return {
        ok: false,
        outcome: {
          ok: false,
          text: `Refusing to persist invalid session state: ${detail}`,
          errorCode: 'CONTRACT_INVALID',
          operatorSessionId: record.session.operatorSessionId,
        },
      };
    }
    try {
      await this.#deps.store.save(record, expectedUpdatedAt);
      return { ok: true };
    } catch (error) {
      if (error instanceof StoreConflictError) {
        return {
          ok: false,
          outcome: {
            ok: false,
            text: `Store conflict: ${error.message}`,
            errorCode: 'STORE_CONFLICT',
            operatorSessionId: error.operatorSessionId,
          },
        };
      }
      throw error;
    }
  }

  /** The single bounded reload-recheck-reduce-CAS helper every
   * state-mutating command and callback uses (plan §6.2). Each attempt
   * reloads the *latest* record, applies `reduce` (a pure `state.ts`
   * function that re-validates its own preconditions against that fresh
   * record — the "legality recheck"), and persists with the just-reloaded
   * `updatedAt` as the compare-and-swap token. A `STORE_CONFLICT` retries
   * (bounded); any other failure or transition error returns immediately. */
  async #applyWithCas(
    operatorSessionId: string,
    reduce: (record: StoredOperatorSession, now: string) => StoredOperatorSession | OperatorTransitionError,
    maxAttempts: number = DEFAULT_CAS_ATTEMPTS,
  ): Promise<CasResult> {
    let lastConflict: OperatorCommandOutcome | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const current = await this.#deps.store.load(operatorSessionId);
      if (current === undefined) {
        return { ok: false, outcome: { ok: false, text: `Session "${operatorSessionId}" was not found.`, errorCode: 'SESSION_NOT_FOUND', operatorSessionId } };
      }
      const now = this.#deps.clock.now();
      const reduced = reduce(current, now);
      if (isTransitionError(reduced)) {
        return {
          ok: false,
          outcome: { ok: false, text: reduced.message, errorCode: reduced.errorCode, operatorSessionId, session: current.session },
        };
      }
      const persisted = await this.#persist(reduced, current.session.updatedAt);
      if (persisted.ok) {
        return { ok: true, record: reduced };
      }
      if (persisted.outcome.errorCode !== 'STORE_CONFLICT') {
        return { ok: false, outcome: persisted.outcome };
      }
      lastConflict = persisted.outcome;
    }
    return { ok: false, outcome: lastConflict ?? { ok: false, text: 'Exhausted compare-and-swap retries.', errorCode: 'STORE_CONFLICT', operatorSessionId } };
  }

  /** Shape-validates every outcome's `AgentResult` against `AgentResult.v1`
   * and its own attempt. An invalid one is replaced with a synthesized
   * `FAILED` result bound to the same attempt (never fabricated for a node
   * it does not belong to — the identity/attempt binding itself is
   * `completeExecutionBatch`'s job, since only it holds `activeAttempts`). */
  #sanitizeOutcomes(outcomes: readonly NodeExecutionOutcome[]): readonly NodeExecutionOutcome[] {
    return outcomes.map((outcome) => {
      const validation = validateAgentResult(outcome.result);
      const identityOk =
        validation.ok &&
        validation.value.operatorSessionId === outcome.attempt.operatorSessionId &&
        validation.value.nodeId === outcome.attempt.nodeId &&
        validation.value.capabilityId === outcome.attempt.capabilityId;
      if (validation.ok && identityOk) {
        const usage = trustedUsage(outcome.usage);
        return usage === undefined ? { attempt: outcome.attempt, result: validation.value } : { attempt: outcome.attempt, result: validation.value, usage };
      }
      const reason = validation.ok ? 'result identity did not match its attempt (operatorSessionId/nodeId/capabilityId)' : validation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      const at = this.#deps.clock.now();
      const failed: AgentResult = {
        resultId: this.#deps.ids.next('result'),
        operatorSessionId: outcome.attempt.operatorSessionId,
        nodeId: outcome.attempt.nodeId,
        capabilityId: outcome.attempt.capabilityId,
        status: 'FAILED',
        summary: `Adapter output rejected: ${reason}`.slice(0, 4000),
        producedArtifactRefs: [],
        consumedArtifactRefs: [],
        findingIds: [],
        evidenceIds: [],
        startedAt: at,
        completedAt: at,
        policyRefs: ['operator-runtime@1:result.rejected'],
      };
      return { attempt: outcome.attempt, result: failed };
    });
  }

  // -------------------------------------------------------------------------
  // START
  // -------------------------------------------------------------------------

  async #handleStart(request: string, mode: 'EXECUTE' | 'EXPLAIN' | 'DRY_RUN'): Promise<OperatorCommandOutcome> {
    if (this.#activeSessionId !== undefined) {
      const current = await this.#deps.store.load(this.#activeSessionId);
      const currentIsTerminal =
        current !== undefined &&
        (current.session.currentState === 'COMPLETED' || current.session.currentState === 'FAILED' || current.session.currentState === 'CANCELLED');
      if (current !== undefined && !currentIsTerminal) {
        return {
          ok: false,
          text: `A session is already active (${this.#activeSessionId}, state ${current.session.currentState}). Cancel it, let it finish, or resume a different session before starting a new one.`,
          errorCode: 'SESSION_ALREADY_ACTIVE',
          operatorSessionId: this.#activeSessionId,
          session: current.session,
        };
      }
    }

    const now = this.#deps.clock.now();
    const operatorSessionId = this.#deps.ids.next('session');
    const graphId = this.#deps.ids.next('graph');
    const gateId = this.#deps.ids.next('gate');
    let fleetRoute = false;
    let effectiveRequest = request.trim();
    if (effectiveRequest.startsWith('--fleet')) {
      fleetRoute = true;
      effectiveRequest = effectiveRequest.slice('--fleet'.length).trim();
      if (effectiveRequest === '') {
        return { ok: false, text: 'Fleet requests require a non-empty task after "--fleet".' };
      }
    }
    const context: WorkflowCompilerContext = { projectRoot: this.#deps.projectRoot, operatorSessionId, graphId, gateId, now, ...(fleetRoute ? { fleetRoute: true as const } : {}) };
    const compilation = await this.#deps.compiler.compile(effectiveRequest, context);
    if (!compilation.ok) {
      return {
        ok: false,
        text: `Compilation failed (${compilation.code}): ${compilation.message}`,
        errorCode: 'COMPILATION_FAILED',
      };
    }

    if (mode === 'DRY_RUN' && this.#deps.preflight !== undefined) {
      const preflight = await this.#deps.preflight(compilation.compiled, context);
      if (!preflight.ok) {
        return { ok: false, text: `Dry-run preflight failed: ${preflight.message}`, errorCode: preflight.code };
      }
    }

    const startupFeatureSetHash = this.#deps.stage7FeatureSet?.stage7Enabled === true ? this.#deps.stage7FeatureSet.hash : undefined;
    const record = startSession(request, mode, operatorSessionId, compilation.compiled, now, startupFeatureSetHash);
    if (isTransitionError(record)) {
      return { ok: false, text: record.message, errorCode: record.errorCode };
    }
    const persisted = await this.#persist(record);
    if (!persisted.ok) return persisted.outcome;

    this.#activeSessionId = record.session.operatorSessionId;
    const openedGate = record.gates[0];
    const text =
      mode === 'EXPLAIN'
        ? `Explain-only plan built for session ${record.session.operatorSessionId} (workflow "${compilation.compiled.template.templateId}"); it never dispatches. Use status/graph/why to inspect it, or cancel it.`
        : mode === 'DRY_RUN'
          ? `Dry-run preflight passed for session ${record.session.operatorSessionId} (workflow "${compilation.compiled.template.templateId}"); no provider session was created and no request was submitted to a model. Use status/graph/why to inspect it, or cancel it.`
          : `Session ${record.session.operatorSessionId} started and awaiting ${openedGate?.decisionType ?? 'approval'} on gate ${openedGate?.gateId ?? '<none>'}.`;
    return {
      ok: true,
      text,
      operatorSessionId: record.session.operatorSessionId,
      session: record.session,
      ...(openedGate !== undefined ? { gate: openedGate } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Read-only inspection: explain / why / status / graph
  // -------------------------------------------------------------------------

  async #handleExplain(): Promise<OperatorCommandOutcome> {
    const loaded = await this.#loadActive();
    if (!loaded.ok) return loaded.outcome;
    const { session } = loaded.record;
    const routeSummary =
      session.routeDecision !== null
        ? `route "${session.routeDecision.selectedWorkflow}" (classification ${session.routeDecision.requestClassification}/${session.routeDecision.riskClassification}, required gates [${session.routeDecision.requiredGates.join(', ')}])`
        : 'no route decision yet';
    const graphSummary =
      session.executionGraph !== null
        ? `graph ${session.executionGraph.graphId} rev ${session.executionGraph.graphRevision} with ${session.executionGraph.nodes.length} node(s), hash ${session.executionGraph.graphHash}`
        : 'no execution graph yet';
    const text = `Session ${session.operatorSessionId} (${session.currentState}, "${session.currentPhase}") for request "${session.originalRequest}". Plan: ${routeSummary}; ${graphSummary}.`;
    return { ok: true, text, operatorSessionId: session.operatorSessionId, session };
  }

  /** Renders the actual compiled route: real selected capability/provider
   * assignments, real rejected alternatives, and real provider-health-driven
   * fallback decisions — never fixed placeholder wording. */
  async #handleWhy(): Promise<OperatorCommandOutcome> {
    const loaded = await this.#loadActive();
    if (!loaded.ok) return loaded.outcome;
    const { session } = loaded.record;
    if (session.routeDecision === null) {
      return { ok: true, text: `Session ${session.operatorSessionId} has no route decision yet.`, operatorSessionId: session.operatorSessionId, session };
    }
    const route = session.routeDecision;
    const graphRevision = session.executionGraph?.graphRevision ?? 0;
    const roles = route.selectedRolesProviders.map((assignment) => `${assignment.role}=${assignment.provider}/${assignment.capabilityId}`).join(', ') || 'none';
    const rejected =
      route.rejectedAlternatives
        .map((alternative) => `${alternative.option}:${alternative.reasonCode}${alternative.details !== undefined ? ` (${alternative.details})` : ''}`)
        .join(', ') || 'none';
    const fallbacks = route.fallbackDecisions.map((fallback) => `${fallback.role}:${fallback.from}->${fallback.to}/${fallback.reasonCode}`).join(', ') || 'none';
    const text =
      `Classification: ${route.requestClassification}. Risk: ${route.riskClassification}. ` +
      `Workflow: ${route.selectedWorkflow}, graph revision ${graphRevision}. Roles/providers and capability fit: ${roles}. ` +
      `Rejected alternatives: ${rejected}. Required gates: ${route.requiredGates.join(', ') || 'none'}. ` +
      `Budget effect: ${JSON.stringify(route.budgetEffect)}. Provider health/fallback decisions: ${fallbacks}. ` +
      `Policy refs: ${route.policyRefs.join(', ')}. Confidence: ${route.confidence}; abstained: ${route.abstention.abstained}` +
      `${route.abstention.reason !== undefined ? ` (${route.abstention.reason})` : ''}.`;
    return { ok: true, text, operatorSessionId: session.operatorSessionId, session };
  }

  async #handleStatus(): Promise<OperatorCommandOutcome> {
    const loaded = await this.#loadActive();
    if (!loaded.ok) return loaded.outcome;
    const { session, gates } = loaded.record;
    const nodeStateSummary = Object.entries(session.nodeStates)
      .map(([nodeId, state]) => `${nodeId}=${state}`)
      .join(', ');
    const gateSuffix = session.openGateId !== undefined ? `, open gate ${session.openGateId}` : '';
    const active = this.#activeBatches.get(session.operatorSessionId);
    const batchSuffix = active !== undefined ? ` Active batch "${active.batchId}" (${active.attempts.length} attempt(s) in flight).` : '';
    const text = `Session ${session.operatorSessionId}: ${session.currentState} ("${session.currentPhase}")${gateSuffix}. Nodes: [${nodeStateSummary}].${batchSuffix}`;
    const openGate = session.openGateId !== undefined ? gates.find((g) => g.gateId === session.openGateId) : undefined;
    return {
      ok: true,
      text,
      operatorSessionId: session.operatorSessionId,
      session,
      ...(openGate !== undefined ? { gate: openGate } : {}),
    };
  }

  async #handleGraph(): Promise<OperatorCommandOutcome> {
    const loaded = await this.#loadActive();
    if (!loaded.ok) return loaded.outcome;
    const { session } = loaded.record;
    if (session.executionGraph === null) {
      return { ok: true, text: `Session ${session.operatorSessionId} has no execution graph yet.`, operatorSessionId: session.operatorSessionId, session };
    }
    const graph = session.executionGraph;
    const nodeLines = graph.nodes
      .map((node) => `${node.nodeId}[${session.nodeStates[node.nodeId] ?? 'UNKNOWN'}] role=${node.role} mandatory=${node.mandatory} dependsOn=[${node.dependsOn.join(', ')}]`)
      .join('; ');
    const text = `Graph ${graph.graphId} rev ${graph.graphRevision} (${graph.executionShape}), hash ${graph.graphHash}. Nodes: ${nodeLines}.`;
    return { ok: true, text, operatorSessionId: session.operatorSessionId, session };
  }

  // -------------------------------------------------------------------------
  // APPROVE / REJECT
  // -------------------------------------------------------------------------

  async #handleDecision(gateId: string, decision: 'APPROVE' | 'REJECT'): Promise<OperatorCommandOutcome> {
    if (this.#activeSessionId === undefined) {
      return { ok: false, text: 'No active session. Start one with a request, or resume an existing session id.', errorCode: 'NO_ACTIVE_SESSION' };
    }
    const operatorSessionId = this.#activeSessionId;
    const result = await this.#applyWithCas(operatorSessionId, (current, now) => decideGate(current, gateId, decision, this.#deps.ids, now));
    if (!result.ok) return result.outcome;
    const decidedGate = result.record.gates.find((g) => g.gateId === gateId);
    const text = this.#describeDecisionOutcome(gateId, decision, result.record);
    return {
      ok: true,
      text,
      operatorSessionId: result.record.session.operatorSessionId,
      session: result.record.session,
      ...(decidedGate !== undefined ? { gate: decidedGate } : {}),
    };
  }

  #describeDecisionOutcome(gateId: string, decision: 'APPROVE' | 'REJECT', result: StoredOperatorSession): string {
    if (decision === 'REJECT') {
      return result.session.currentState === 'NEEDS_REPLAN'
        ? `Gate "${gateId}" rejected. Session ${result.session.operatorSessionId} needs replan (this runtime does not implement automatic replanning; cancel to end it).`
        : `Gate "${gateId}" rejected. Session ${result.session.operatorSessionId} declined.`;
    }
    if (result.session.currentState === 'COMPLETED') {
      return `Gate "${gateId}" approved. Every required gate is now satisfied; session ${result.session.operatorSessionId} is COMPLETED.`;
    }
    if (result.session.currentState === 'AWAITING_HUMAN') {
      const openGate: HumanGate | undefined =
        result.session.openGateId !== undefined ? result.gates.find((g) => g.gateId === result.session.openGateId) : undefined;
      return `Gate "${gateId}" approved. Session ${result.session.operatorSessionId} is now awaiting ${openGate?.decisionType ?? 'approval'} on gate ${openGate?.gateId ?? '<none>'}.`;
    }
    return `Gate "${gateId}" approved. Session ${result.session.operatorSessionId} is READY; run continue to execute.`;
  }

  // -------------------------------------------------------------------------
  // CONTINUE
  // -------------------------------------------------------------------------

  async #handleContinue(): Promise<OperatorCommandOutcome> {
    if (this.#activeSessionId === undefined) {
      return { ok: false, text: 'No active session. Start one with a request, or resume an existing session id.', errorCode: 'NO_ACTIVE_SESSION' };
    }
    const operatorSessionId = this.#activeSessionId;
    const resolvedAdapters = new Map<string, NodeExecutionAdapter>();

    const begin = await this.#applyWithCas(operatorSessionId, (current, now) => {
      if (this.#activeBatches.has(operatorSessionId)) return transitionErrorLocal('EXECUTION_ACTIVE', `A batch is already active in this runtime for session "${operatorSessionId}"; use status or cancel.`);
      const graph = current.session.executionGraph;
      if (graph === null) return transitionErrorLocal('CONTRACT_INVALID', 'Cannot dispatch without an execution graph.');
      const candidates = selectReadyBatch(current, { maxConcurrency: Number.POSITIVE_INFINITY });
      if (candidates.length === 0) return transitionErrorLocal('CONTRACT_INVALID', 'No READY node is available to dispatch; approve a gate first or the graph may be fully executed.');

      const partitions = new Map<string, { readonly adapter: NodeExecutionAdapter; readonly nodes: ExecutionGraphNode[]; readonly firstIndex: number }>();
      for (const node of candidates) {
        const tuple: NodeExecutionTuple = {
          workflowTemplateId: graph.workflowTemplateId,
          nodeId: node.nodeId,
          role: node.role,
          capabilityId: node.capabilityId,
          requiredCapability: node.requiredCapability ?? node.capabilityId,
          mutationClass: node.mutation?.mutationClass ?? 'READ_ONLY',
        };
        let adapter: NodeExecutionAdapter;
        try {
          adapter = this.#deps.nodeExecutionAdapterResolver.resolve(tuple);
        } catch (error) {
          const code: OperatorCommandErrorCode = error instanceof Stage7RouteResolutionError && error.code === 'STAGE7_CAPABILITY_UNAVAILABLE' ? 'STAGE7_CAPABILITY_UNAVAILABLE' : 'STAGE7_ROUTE_UNAVAILABLE';
          return transitionErrorLocal(code, `Exact execution route unavailable for ${graph.workflowTemplateId}/${node.nodeId}: ${describeError(error)}`);
        }
        if (adapter.adapterId === 'mock' && this.#deps.stage7FeatureSet?.stage7Enabled === true) {
          return transitionErrorLocal('ADAPTER_UNAVAILABLE', `Stage-7 tuple ${graph.workflowTemplateId}/${node.nodeId} resolved to the forbidden mock adapter.`);
        }
        resolvedAdapters.set(node.nodeId, adapter);
        const existing = partitions.get(adapter.adapterId);
        if (existing === undefined) partitions.set(adapter.adapterId, { adapter, nodes: [node], firstIndex: graph.nodes.indexOf(node) });
        else existing.nodes.push(node);
      }
      const orderedPartitions = [...partitions.values()].sort((a, b) => a.firstIndex - b.firstIndex || a.adapter.adapterId.localeCompare(b.adapter.adapterId));
      const first = orderedPartitions[0];
      if (first === undefined) return transitionErrorLocal('ADAPTER_UNAVAILABLE', 'No resolved execution partition is available.');
      const capabilityCeilings = first.nodes.map((node) => this.#deps.capabilityConcurrency?.(node.capabilityId) ?? Number.POSITIVE_INFINITY);
      const effectiveMaxConcurrency = Math.max(1, Math.min(current.maxConcurrency, ...capabilityCeilings));
      const selected = first.nodes.slice(0, graph.executionShape === 'PARALLEL' ? effectiveMaxConcurrency : 1);
      const batchId = this.#deps.ids.next('batch');
      const graphRevision = graph.graphRevision;
      const attempts: NodeExecutionAttemptAllocation[] = selected.map((node) => {
        const providerSessionId = this.#deps.ids.next('providerSession');
        const attemptId = deriveAttemptId({ operatorSessionId, graphRevision, nodeId: node.nodeId, providerSessionId });
        const timeoutMs = Math.max(1, this.#deps.nodeTimeoutMs(node));
        const timeoutAt = new Date(Date.parse(now) + timeoutMs).toISOString();
        const adapter = resolvedAdapters.get(node.nodeId);
        if (adapter === undefined) throw new Error(`resolved adapter disappeared for node "${node.nodeId}"`);
        return { attemptId, batchId, operatorSessionId, graphRevision, nodeId: node.nodeId, capabilityId: node.capabilityId, adapterId: adapter.adapterId, providerSessionId, startedAt: now, timeoutAt };
      });
      return beginExecutionBatch(current, attempts, now);
    });
    if (!begin.ok) return begin.outcome;

    const record = begin.record;
    const attemptEntries = Object.values(record.activeAttempts);
    const batchId = attemptEntries[0]?.batchId;
    const graph = record.session.executionGraph;
    if (batchId === undefined || graph === null) return { ok: false, text: 'Internal error: batch begun but no active attempts or execution graph were persisted.', errorCode: 'CONTRACT_INVALID', operatorSessionId, session: record.session };
    const adapterId = attemptEntries[0]?.adapterId;
    const adapter = attemptEntries[0] === undefined ? undefined : resolvedAdapters.get(attemptEntries[0].nodeId);
    if (adapter === undefined || adapterId === undefined || attemptEntries.some((attempt) => attempt.adapterId !== adapterId)) {
      return { ok: false, text: `Batch "${batchId}" was not homogeneous after persistence.`, errorCode: 'CONTRACT_INVALID', operatorSessionId, session: record.session };
    }

    try {
      const nodeById = new Map(graph.nodes.map((node) => [node.nodeId, node] as const));
      const nodes: NodeExecutionRequest[] = [];
      for (const allocation of attemptEntries) {
        const node = nodeById.get(allocation.nodeId);
        if (node === undefined) throw new Error(`node "${allocation.nodeId}" is missing from the execution graph`);
        nodes.push(await this.#deps.contextProjector.project({ record, node, allocation }));
      }
      const executionShape: ExecutionBatchRequest['executionShape'] = graph.executionShape === 'PARALLEL' || graph.executionShape === 'PIPELINE' ? graph.executionShape : 'SINGLE';
      const batchRequest: ExecutionBatchRequest = { batchId, operatorSessionId, graphRevision: attemptEntries[0]?.graphRevision ?? graph.graphRevision, executionShape, nodes };
      const active = adapter.launchBatch(batchRequest);
      this.#activeBatches.set(operatorSessionId, active);
      const earliestTimeoutAt = attemptEntries.reduce<string>((earliest, a) => (a.timeoutAt < earliest ? a.timeoutAt : earliest), attemptEntries[0]?.timeoutAt ?? record.session.updatedAt);
      this.#deps.registerActiveBatch?.({ operatorSessionId, batch: active, earliestTimeoutAt });
      const nodeList = attemptEntries.map((a) => a.nodeId).join(', ');
      return { ok: true, text: `Batch "${batchId}" launched for node(s) [${nodeList}]; use status to observe progress or cancel to stop it.`, operatorSessionId, session: record.session };
    } catch (error) {
      const reconciled = await this.#applyWithCas(operatorSessionId, (current, now) => {
        if (Object.values(current.activeAttempts).length === 0) return current;
        return reconcileExecutionBatch(current, [], this.#deps.ids, now);
      });
      return { ok: false, text: `Failed to launch batch "${batchId}": ${describeError(error)}`, errorCode: 'ADAPTER_UNAVAILABLE', operatorSessionId, ...(reconciled.ok ? { session: reconciled.record.session } : {}) };
    }
  }

  // -------------------------------------------------------------------------
  // FLEET — operator-owned catalog management (list / bootstrap / remove)
  // -------------------------------------------------------------------------

  async #handleFleet(subcommand: string, args: readonly string[]): Promise<OperatorCommandOutcome> {
    const catalogPath = fleetCatalogPath();
    if (subcommand === 'bootstrap') {
      let modelsPath = defaultModelsYamlPath();
      const flagIndex = args.indexOf('--models');
      if (flagIndex !== -1 && args[flagIndex + 1] !== undefined) modelsPath = args[flagIndex + 1]!;
      if (!existsSync(modelsPath)) {
        return { ok: false, text: `fleet bootstrap: OMP model config not found at ${modelsPath}.`, errorCode: 'INVALID_COMMAND' };
      }
      const entries = parseOmpModelsYaml(readFileSync(modelsPath, 'utf8'));
      if (entries.length === 0) return { ok: false, text: 'fleet bootstrap: no providers found in the OMP model config.', errorCode: 'EVALUATOR_ERROR' };
      const merged = mergeCatalog(loadCatalogFile(catalogPath), bootstrapCatalog(entries));
      saveCatalogFile(catalogPath, merged);
      return { ok: true, text: `fleet catalog at ${catalogPath}: added ${merged.added.length} provider(s)${merged.added.length > 0 ? ` (${merged.added.join(', ')})` : ''}; total ${merged.providers.length}. Records start READ_ONLY — edit the file to widen.` };
    }
    if (subcommand === 'remove') {
      const target = args[0];
      if (target === undefined) return { ok: false, text: 'usage: /operator fleet remove <provider-id>', errorCode: 'INVALID_COMMAND' };
      const catalog = loadCatalogFile(catalogPath);
      if (catalog === undefined) return { ok: false, text: 'No fleet catalog to edit.', errorCode: 'INVALID_COMMAND' };
      const remaining = catalog.providers.filter((entry) => entry['providerId'] !== target);
      if (remaining.length === catalog.providers.length) return { ok: false, text: `Provider "${target}" is not in the catalog.`, errorCode: 'INVALID_COMMAND' };
      saveCatalogFile(catalogPath, { providers: remaining });
      return { ok: true, text: `Removed "${target}". ${remaining.length} provider(s) remain.` };
    }
    const catalog = loadCatalogFile(catalogPath);
    if (catalog === undefined || catalog.providers.length === 0) {
      return { ok: true, text: 'Fleet catalog is empty or absent. Run `/operator fleet bootstrap` to project your OMP providers into it.' };
    }
    const lines = catalog.providers.map((entry) => `- ${String(entry['providerId'])} (${String(entry['kind'])}, ${String(entry['health'])}, ${String(entry['mutability'])})`);
    return { ok: true, text: `Fleet catalog (${catalogPath}):\n${lines.join('\n')}` };
  }

  // -------------------------------------------------------------------------
  // CANCEL
  // -------------------------------------------------------------------------

  async #handleCancel(): Promise<OperatorCommandOutcome> {
    if (this.#activeSessionId === undefined) {
      return { ok: false, text: 'No active session. Start one with a request, or resume an existing session id.', errorCode: 'NO_ACTIVE_SESSION' };
    }
    const operatorSessionId = this.#activeSessionId;
    const active = this.#activeBatches.get(operatorSessionId);
    if (active !== undefined) {
      await active.cancel('USER');
    }
    const result = await this.#applyWithCas(operatorSessionId, (current, now) => {
      const attemptIds = Object.values(current.activeAttempts).map((a) => a.attemptId);
      return cancelExecutionBatch(current, attemptIds, 'USER', now);
    });
    if (result.ok) this.#activeBatches.delete(operatorSessionId);
    if (!result.ok) return result.outcome;
    return { ok: true, text: `Session ${result.record.session.operatorSessionId} cancelled.`, operatorSessionId: result.record.session.operatorSessionId, session: result.record.session };
  }

  // -------------------------------------------------------------------------
  // RESUME
  // -------------------------------------------------------------------------

  async #handleResume(operatorSessionId: string): Promise<OperatorCommandOutcome> {
    const record = await this.#deps.store.load(operatorSessionId);
    if (record === undefined) {
      return { ok: false, text: `Session "${operatorSessionId}" was not found.`, errorCode: 'SESSION_NOT_FOUND', operatorSessionId };
    }

    if (record.startupFeatureSetHash !== undefined || this.#deps.stage7FeatureSet?.stage7Enabled === true) {
      try {
        assertStage7FeatureSetMatch(record.startupFeatureSetHash, this.#deps.stage7FeatureSet);
      } catch (error) {
        const message = error instanceof Stage7FeatureSetMismatchError ? error.message : describeError(error);
        return { ok: false, text: message, errorCode: 'FEATURE_SET_MISMATCH', operatorSessionId };
      }
    }

    const providerEvidence =
      record.session.currentState === 'EXECUTING' && this.#deps.resumeEvidence !== undefined ? await this.#deps.resumeEvidence(record) : [];

    const result = await this.#applyWithCas(operatorSessionId, (current, now) => reconcileExecutionBatch(current, providerEvidence, this.#deps.ids, now));
    if (!result.ok) return result.outcome;

    this.#activeSessionId = operatorSessionId;
    const changed = result.record.session.updatedAt !== record.session.updatedAt;
    const text = changed
      ? `Resumed session ${operatorSessionId}: found interrupted node(s), reconciled (state ${result.record.session.currentState}).`
      : `Resumed session ${operatorSessionId} (state ${result.record.session.currentState}).`;
    return { ok: true, text, operatorSessionId, session: result.record.session };
  }
}

function transitionErrorLocal(errorCode: OperatorCommandErrorCode, message: string): OperatorTransitionError {
  return { kind: 'TRANSITION_ERROR', errorCode, message };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createOperatorRuntime(deps: OperatorRuntimeDependencies): OperatorRuntime {
  return new OperatorRuntime(deps);
}

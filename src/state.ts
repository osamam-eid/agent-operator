/**
 * Agent Operator — session-state reducer.
 *
 * Pure, synchronous, side-effect-free functions that transition a
 * `StoredOperatorSession` between the legal states of the V1 flow. The
 * route decision, execution graph, and initial (first required) gate are
 * built by `compiler.ts` from the classifier, config/trust, policy packs,
 * template registry, and capability registry; the controller allocates the
 * session/graph/gate ids and passes the resulting `CompiledWorkflow` into
 * `startSession`. This module never imports the compiler; it only consumes
 * its typed output. It also never imports an adapter, an OMP SDK type, or
 * `validators.ts`: every `NodeExecutionOutcome` it is handed is trusted
 * (already shape-validated by the controller before the reducer call), and
 * every function here only ever binds it against `StoredOperatorSession`'s
 * own runtime-owned identity ledgers (`activeAttempts`, `nodeResultRefs`).
 *
 *   START(EXECUTE)  -> AWAITING_HUMAN (first required gate open)
 *   START(EXPLAIN)  -> PLANNING (no gate; structurally cannot dispatch)
 *   SIMULATE never enters this reducer; it compiles/preflights without
 *   creating session state.
 *   APPROVE (gate 0, pre-execution)
 *                   -> READY (gate consumed, humanDecision recorded,
 *                      initially-eligible nodes promoted to READY)
 *   APPROVE (gate i>=1, post-execution, not last required gate)
 *                   -> AWAITING_HUMAN (next required gate opened,
 *                      graph+current-artifact bound; id allocated via the
 *                      injected `OperatorIdFactory`)
 *   APPROVE (last required gate)
 *                   -> COMPLETED
 *   REJECT (PLAN_APPROVAL gate)
 *                   -> NEEDS_REPLAN (non-terminal; stopDetail required;
 *                      terminalResult stays null; this runtime never
 *                      replans automatically)
 *   REJECT (any other gate type)
 *                   -> CANCELLED, terminalResult.workflowStatus = DECLINED
 *   selectReadyBatch -> the exact READY node(s) `beginExecutionBatch` may
 *                      dispatch next: exactly one for SINGLE/PIPELINE, up
 *                      to the effective concurrency ceiling for PARALLEL.
 *   beginExecutionBatch
 *                   -> EXECUTING (every selected node marked RUNNING and
 *                      bound to its `NodeExecutionAttemptAllocation` in
 *                      `activeAttempts`, persisted *before* the adapter is
 *                      ever invoked, so a crash between the two halves is
 *                      recoverable via `reconcileExecutionBatch`)
 *   completeExecutionBatch
 *                   -> folds every outcome whose attempt still matches its
 *                      `activeAttempts` entry exactly; a stale, replayed,
 *                      or foreign outcome is silently dropped (its node, if
 *                      any, stays active — never redispatched). On
 *                      SUCCEEDED: promotes newly-unblocked dependents to
 *                      READY; if mandatory nodes remain, returns to READY
 *                      for the next `continue`; once every mandatory node
 *                      has succeeded, either opens the next required gate
 *                      or (no gates remain) completes the session. Any
 *                      mandatory FAILED/BLOCKED/CANCELLED/UNKNOWN ends the
 *                      session immediately in the corresponding terminal
 *                      (or BLOCKED) state; the same statuses on an optional
 *                      node instead degrade it and continue.
 *   cancelExecutionBatch
 *                   -> USER/SHUTDOWN: CANCELLED (terminal), matching every
 *                      currently active attempt to a cancelled node.
 *                      TIMEOUT: BLOCKED (non-terminal; a human can cancel,
 *                      or a later explicitly planned recovery command may
 *                      resume — this runtime never retries automatically).
 *   reconcileExecutionBatch
 *                   -> ingests any `providerEvidence` proving a RUNNING
 *                      node's real terminal outcome (used by RESUME);
 *                      every RUNNING node left unproven becomes UNKNOWN and
 *                      the session moves to BLOCKED. Never guesses, never
 *                      retries.
 *
 * No store, clock, or executor calls happen here: every function takes the
 * current time and (where a gate may need to be allocated) the id factory
 * as plain arguments and returns a new `StoredOperatorSession` (or a
 * `OperatorTransitionError` for an illegal transition). The controller owns
 * all I/O, persistence, adapter dispatch, and attempt/provider-session id
 * allocation.
 */

import { createHash } from 'node:crypto';

import type {
  ExecutionGraph,
  ExecutionStatus,
  HumanDecisionRecord,
  NodeState,
  OperatorSession,
  SessionState,
  StopDetail,
  WorkflowStatus,
} from './contracts.js';
import type { CompiledWorkflow } from './stage3-types.js';
import { appendJournal, appendFallbackDecision } from './journal.js';
import type {
  NodeExecutionAttemptAllocation,
  NodeExecutionOutcome,
  NodeResultRefs,
  OperatorIdFactory,
  StoredOperatorSession,
} from './runtime-types.js';
import { transitionError, isTransitionError, type OperatorTransitionError } from './state/errors.js';
import { buildFinalResult, buildActionsNotPerformed, assessFindingDispositions } from './state/final-result.js';
import { buildPostExecutionGate } from './state/gates.js';
import { cancelExecutionBatch, reconcileExecutionBatch } from './state/lifecycle.js';
import { journalEventForStatus, mapAgentResultStatusToNodeState, outcomeMatchesActiveAttempt, toNodeResultRefs } from './state/outcomes.js';
import { promoteReadyNodes, selectReadyBatch, type BatchSelectionPolicy } from './state/scheduling.js';
import { degradedOptionalNodeIds, deriveVerificationState } from './state/verification.js';
import { createFailureFingerprint } from './execution-safety.js';

export { selectReadyBatch, type BatchSelectionPolicy };
export { isTransitionError, type OperatorTransitionError };
export { cancelExecutionBatch, reconcileExecutionBatch };


// ---------------------------------------------------------------------------
// Deterministic attempt identity (plan §4.2)
// ---------------------------------------------------------------------------

/** `attemptId` is a deterministic hash of the four values that already
 * uniquely identify one dispatch: which session, which graph revision,
 * which node, and which (controller-allocated, unique) provider session.
 * Any party holding those four values — including the adapter, purely to
 * self-check its own attempt object — can recompute the same id without a
 * schema amendment or a shared counter. It is replay protection, not a
 * retry token. */
export function deriveAttemptId(params: {
  readonly operatorSessionId: string;
  readonly graphRevision: number;
  readonly nodeId: string;
  readonly providerSessionId: string;
}): string {
  const material = [params.operatorSessionId, String(params.graphRevision), params.nodeId, params.providerSessionId].join('\u0000');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// START
// ---------------------------------------------------------------------------

/** Consumes a `CompiledWorkflow` already produced by the compiler for the
 * exact `operatorSessionId`/`graphId`/`gateId` the controller allocated
 * before compiling. EXECUTE mode requires at least one required gate (the
 * compiler-supplied `initialGate`, matching `routeDecision.requiredGates[0]`);
 * EXPLAIN is a persisted non-dispatching plan. Simulation never enters this
 * reducer and therefore cannot create session state. */
export function startSession(
  request: string,
  mode: 'EXECUTE' | 'EXPLAIN',
  operatorSessionId: string,
  compiled: CompiledWorkflow,
  now: string,
  startupFeatureSetHash?: string,
): StoredOperatorSession | OperatorTransitionError {
  const nodeStates: Record<string, NodeState> = {};
  for (const node of compiled.executionGraph.nodes) {
    nodeStates[node.nodeId] = 'PENDING';
  }

  const baseSession: OperatorSession = {
    operatorSessionId,
    schemaVersion: '1.0',
    originalRequest: request,
    createdAt: now,
    updatedAt: now,
    currentState: 'PLANNING',
    currentPhase: `Building ${compiled.template.templateId} plan`,
    routeDecision: compiled.routeDecision,
    workflowTemplateId: compiled.template.templateId,
    executionGraph: compiled.executionGraph,
    nodeStates,
    providerSessionIds: {},
    humanDecisions: [],
    artifacts: [],
    evidence: [],
    verificationState: deriveVerificationState(compiled.executionGraph, nodeStates),
    budgetState: { profile: compiled.policy.budgetProfile, tokensUsed: 0, costUsed: 0 },
    journal: [],
    terminalResult: null,
  };

  const started = appendJournal(baseSession, {
    timestamp: now,
    eventType: 'SESSION_STARTED',
    operatorSessionId,
    message: mode === 'EXECUTE' ? `Session started for request: ${request}` : `Explain-only plan built for request: ${request}`,
  });

  const baseRecord: StoredOperatorSession = {
    schemaVersion: '1.0',
    ...(startupFeatureSetHash !== undefined ? { startupFeatureSetHash } : {}),
    disclosureDecision: compiled.disclosureDecision,
    decisionTrace: compiled.decisionTrace,
    session: started,
    gates: [],
    maxConcurrency: Math.max(1, compiled.policy.maxConcurrency),
    activeAttempts: {},
    nodeResultRefs: {},
  };

  if (mode === 'EXPLAIN') {
    const nonDispatchSession: OperatorSession = {
      ...started,
      currentPhase: 'Explain-only plan ready (no dispatch)',
    };
    return { ...baseRecord, session: nonDispatchSession };
  }

  // EXECUTE mode: no node ever dispatches before the first required gate is
  // approved. The compiler must supply it whenever requiredGates is non-empty.
  const firstRequiredGate = compiled.routeDecision.requiredGates[0];
  if (firstRequiredGate === undefined) {
    return transitionError('CONTRACT_INVALID', 'Compiled route decision requires no gates; EXECUTE mode must never dispatch without human approval.');
  }
  if (compiled.initialGate === null) {
    return transitionError('CONTRACT_INVALID', 'Compiled workflow requires a first gate but the compiler supplied none.');
  }
  if (compiled.initialGate.decisionType !== firstRequiredGate) {
    return transitionError('CONTRACT_INVALID', "Compiled initial gate's decisionType does not match routeDecision.requiredGates[0].");
  }

  const awaitingApproval: OperatorSession = {
    ...started,
    currentState: 'AWAITING_HUMAN',
    currentPhase: `Awaiting ${compiled.initialGate.decisionType}`,
    openGateId: compiled.initialGate.gateId,
  };
  const withGateOpened = appendJournal(awaitingApproval, {
    timestamp: now,
    eventType: 'GATE_OPENED',
    operatorSessionId,
    gateId: compiled.initialGate.gateId,
    message: `Opened ${compiled.initialGate.decisionType} gate for the "${compiled.template.templateId}" workflow.`,
  });
  return { ...baseRecord, session: withGateOpened, gates: [compiled.initialGate] };
}

// ---------------------------------------------------------------------------
// APPROVE / REJECT
// ---------------------------------------------------------------------------

export function decideGate(
  record: StoredOperatorSession,
  gateId: string,
  decision: 'APPROVE' | 'REJECT',
  ids: OperatorIdFactory,
  now: string,
): StoredOperatorSession | OperatorTransitionError {
  const gate = record.gates.find((candidate) => candidate.gateId === gateId);
  if (gate === undefined) {
    return transitionError('GATE_NOT_FOUND', `No gate with id "${gateId}" exists on this session.`);
  }
  if (gate.status !== 'OPEN') {
    return transitionError('GATE_NOT_OPEN', `Gate "${gateId}" is not open (current status: ${gate.status}).`);
  }
  if (record.session.currentState !== 'AWAITING_HUMAN' || record.session.openGateId !== gateId) {
    return transitionError('GATE_MISMATCH', `Gate "${gateId}" is not the currently open gate for this session.`);
  }
  if (record.session.executionGraph === null) {
    return transitionError('CONTRACT_INVALID', 'Session has an open gate but no execution graph; cannot bind a decision to it.');
  }
  const graph = record.session.executionGraph;
  if (gate.graphRevision !== graph.graphRevision || gate.graphHash !== graph.graphHash) {
    return transitionError('GATE_MISMATCH', `Gate "${gateId}" is bound to a different execution graph revision or hash.`);
  }
  if (record.session.routeDecision === null) {
    return transitionError('CONTRACT_INVALID', 'Session has an open gate but no route decision; cannot bind a decision to it.');
  }
  const routeDecision = record.session.routeDecision;

  const currentArtifactHashes: string[] = [];
  for (const [index, artifactRef] of gate.artifactRefs.entries()) {
    const artifact = record.session.artifacts.find((candidate) => candidate.artifactId === artifactRef);
    if (artifact === undefined || artifact.hash !== gate.artifactHashes[index]) {
      return transitionError('GATE_MISMATCH', `Gate "${gateId}" is bound to artifact bytes that are no longer current.`);
    }
    currentArtifactHashes.push(artifact.hash);
  }

  const gateIndex = record.session.humanDecisions.length;
  const templateId = record.session.workflowTemplateId ?? graph.workflowTemplateId;

  const decisionRecord: HumanDecisionRecord = {
    gateId,
    decisionType: gate.decisionType,
    optionSelected: decision,
    outcome: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED',
    decidedAt: now,
    graphHashAtDecision: gate.graphHash,
    artifactHashesAtDecision: currentArtifactHashes,
  };
  const humanDecisions = [...record.session.humanDecisions, decisionRecord];
  const updatedGates = record.gates.map((candidate) =>
    candidate.gateId === gateId ? { ...candidate, status: decision === 'APPROVE' ? ('APPROVED' as const) : ('REJECTED' as const) } : candidate,
  );
  const { openGateId: _openGateId, ...sessionSansGate } = record.session;

  if (decision === 'APPROVE') {
    if (gateIndex === 0) {
      // Pre-execution gate approved: promote initially-eligible nodes and
      // hand off to CONTINUE.
      const readyNodeStates = promoteReadyNodes(graph, record.session.nodeStates);
      const ready: OperatorSession = {
        ...sessionSansGate,
        currentState: 'READY',
        currentPhase: 'Ready for execution',
        humanDecisions,
        nodeStates: readyNodeStates,
      };
      const journaled = appendJournal(ready, {
        timestamp: now,
        eventType: 'GATE_APPROVED',
        operatorSessionId: ready.operatorSessionId,
        gateId,
        message: `Gate "${gateId}" (${gate.decisionType}) approved.`,
      });
      return { ...record, session: journaled, gates: updatedGates };
    }

    // Post-execution gate approved (all mandatory nodes already succeeded
    // by the time this gate could have opened).
    const isLastRequiredGate = gateIndex + 1 >= routeDecision.requiredGates.length;
    if (!isLastRequiredGate) {
      const nextGateType = routeDecision.requiredGates[gateIndex + 1];
      if (nextGateType === undefined) {
        return transitionError('CONTRACT_INVALID', 'Route decision required-gates sequence is inconsistent with the number of decisions recorded.');
      }
      const nextGate = buildPostExecutionGate(
        nextGateType,
        sessionSansGate.operatorSessionId,
        graph,
        graph.nodes[graph.nodes.length - 1]?.nodeId ?? gate.resumeNode,
        record.session.artifacts,
        ids.next('gate'),
        now,
        record.gates[0]?.riskSummary,
      );
      const awaiting: OperatorSession = {
        ...sessionSansGate,
        currentState: 'AWAITING_HUMAN',
        currentPhase: `Awaiting ${nextGateType}`,
        openGateId: nextGate.gateId,
        humanDecisions,
      };
      const journaledApprove = appendJournal(awaiting, {
        timestamp: now,
        eventType: 'GATE_APPROVED',
        operatorSessionId: awaiting.operatorSessionId,
        gateId,
        message: `Gate "${gateId}" (${gate.decisionType}) approved.`,
      });
      const journaledOpen = appendJournal(journaledApprove, {
        timestamp: now,
        eventType: 'GATE_OPENED',
        operatorSessionId: awaiting.operatorSessionId,
        gateId: nextGate.gateId,
        message: `Opened ${nextGateType} gate for the "${templateId}" workflow after prior gate approval.`,
      });
      return { ...record, session: journaledOpen, gates: [...updatedGates, nextGate] };
    }

    // Last required gate approved: complete, preserving any explicit
    // optional-node degradation independently from mandatory success.
    const degradedNodeIds = degradedOptionalNodeIds(graph, record.session.nodeStates);
    const hasDegradedOptionalNodes = degradedNodeIds.length > 0;
    const hasDeferredFindings = assessFindingDispositions(record.nodeResultRefs).deferredFindings.length > 0;
    const hasDeferredItems = hasDegradedOptionalNodes || hasDeferredFindings;
    const resultSession: OperatorSession = { ...sessionSansGate, humanDecisions };
    const terminal = buildFinalResult({
      session: resultSession,
      workflowStatus: hasDeferredItems ? 'COMPLETED_WITH_DEFERRED_ITEMS' : 'COMPLETED',
      executionStatus: hasDeferredItems ? 'PARTIAL' : 'SUCCEEDED',
      recommendation: hasDeferredItems ? 'GO_WITH_DEFERRED_ITEMS' : 'GO',
      recommendationRationale: hasDeferredItems
        ? `All mandatory nodes of the "${templateId}" workflow succeeded and every required gate (${routeDecision.requiredGates.join(', ')}) was approved; deferred findings and optional outcomes remain explicitly recorded.`
        : `All mandatory nodes of the "${templateId}" workflow succeeded and every required gate (${routeDecision.requiredGates.join(', ')}) was approved.`,
      workPerformed: graph.nodes
        .filter((node) => record.session.nodeStates[node.nodeId] === 'SUCCEEDED')
        .map((node) => `Executed node "${node.nodeId}".`),
      changesMade: [],
      actionsNotPerformed: buildActionsNotPerformed(graph, record.session.nodeStates),
      degradedOptionalNodeIds: degradedNodeIds,
      nodeResultRefs: record.nodeResultRefs,
    });
    const completed: OperatorSession = {
      ...resultSession,
      currentState: 'COMPLETED',
      currentPhase: hasDeferredItems ? 'Completed with deferred items' : 'Completed',
      terminalResult: terminal,
    };
    const journaledApprove = appendJournal(completed, {
      timestamp: now,
      eventType: 'GATE_APPROVED',
      operatorSessionId: completed.operatorSessionId,
      gateId,
      message: `Gate "${gateId}" (${gate.decisionType}) approved.`,
    });
    const journaledComplete = appendJournal(journaledApprove, {
      timestamp: now,
      eventType: 'SESSION_COMPLETED',
      operatorSessionId: completed.operatorSessionId,
      message: hasDeferredItems
        ? `Session completed with deferred item(s): ${[...degradedNodeIds.map((nodeId) => `optional:${nodeId}`), ...assessFindingDispositions(record.nodeResultRefs).deferredFindings].join(', ')}.`
        : 'Session completed successfully after every required gate was approved.',
    });
    return { ...record, session: journaledComplete, gates: updatedGates };
  }

  // REJECT.
  if (gate.decisionType === 'PLAN_APPROVAL') {
    const stopDetail: StopDetail = {
      reason: 'NEEDS_REPLAN',
      affectedNodeId: gate.resumeNode,
      evidenceRefs: [],
      retryEligible: false,
      requiredDecisionOrPrerequisite: `The PLAN_APPROVAL gate "${gateId}" was rejected; the "${templateId}" workflow needs replanning (this runtime does not implement automatic replanning).`,
      nextAllowedActions: ['CANCEL'],
    };
    const replan: OperatorSession = {
      ...sessionSansGate,
      currentState: 'NEEDS_REPLAN',
      currentPhase: 'Needs replan',
      humanDecisions,
      stopDetail,
    };
    const journaledReject = appendJournal(replan, {
      timestamp: now,
      eventType: 'GATE_REJECTED',
      operatorSessionId: replan.operatorSessionId,
      gateId,
      message: `Gate "${gateId}" (PLAN_APPROVAL) rejected.`,
    });
    const journaledReplan = appendJournal(journaledReject, {
      timestamp: now,
      eventType: 'SESSION_NEEDS_REPLAN',
      operatorSessionId: replan.operatorSessionId,
      message: 'Session needs replan after PLAN_APPROVAL rejection.',
    });
    return { ...record, session: journaledReplan, gates: updatedGates };
  }

  const executionStatus: ExecutionStatus = gateIndex === 0 ? 'NOT_STARTED' : 'SUCCEEDED';
  const workPerformed =
    gateIndex === 0 ? [] : graph.nodes.filter((node) => node.mandatory).map((node) => `Executed node "${node.nodeId}".`);
  const terminal = buildFinalResult({
    session: record.session,
    workflowStatus: 'DECLINED',
    executionStatus,
    recommendation: 'STOP',
    recommendationRationale: `The human rejected the ${gate.decisionType} gate; the "${templateId}" workflow ${gateIndex === 0 ? 'was never dispatched' : 'results were discarded after execution'}.`,
    workPerformed,
    changesMade: [],
    actionsNotPerformed: [
      gateIndex === 0
        ? `Execution of the "${templateId}" workflow (declined at the ${gate.decisionType} gate).`
        : `Completion of the "${templateId}" workflow (declined at the ${gate.decisionType} gate after mandatory node(s) succeeded).`,
    ],
    nodeResultRefs: record.nodeResultRefs,
  });
  const declined: OperatorSession = {
    ...sessionSansGate,
    currentState: 'CANCELLED',
    currentPhase: 'Declined',
    humanDecisions,
    terminalResult: terminal,
  };
  const withRejection = appendJournal(declined, {
    timestamp: now,
    eventType: 'GATE_REJECTED',
    operatorSessionId: declined.operatorSessionId,
    gateId,
    message: `Gate "${gateId}" (${gate.decisionType}) rejected.`,
  });
  const withDecline = appendJournal(withRejection, {
    timestamp: now,
    eventType: 'SESSION_DECLINED',
    operatorSessionId: declined.operatorSessionId,
    message: 'Session declined by human.',
  });
  return { ...record, session: withDecline, gates: updatedGates };
}

// ---------------------------------------------------------------------------
// CONTINUE, phase 1: persist RUNNING + activeAttempts before dispatch
// ---------------------------------------------------------------------------

/** Marks every node named by `attempts` `RUNNING` and records its exact
 * dispatch identity in `activeAttempts`, keyed by `nodeId`. `attempts` must
 * be exactly the nodes `selectReadyBatch` just selected (the controller
 * allocates one `NodeExecutionAttemptAllocation` per selected node); this
 * function does not call `selectReadyBatch` itself so a caller can persist
 * against the same selection it built ids for. Never dispatches a node
 * that is not currently `READY`, and never dispatches into a session that
 * already has an active batch. */
export function beginExecutionBatch(
  record: StoredOperatorSession,
  attempts: readonly NodeExecutionAttemptAllocation[],
  now: string,
): StoredOperatorSession | OperatorTransitionError {
  if (record.session.currentState !== 'READY') {
    return transitionError('INVALID_TRANSITION', `Cannot continue from state ${record.session.currentState}; session must be READY.`);
  }
  if (Object.keys(record.activeAttempts).length > 0) {
    return transitionError('EXECUTION_ACTIVE', 'A batch is already active for this session; cancel it or wait for it to complete before continuing.');
  }
  const graph = record.session.executionGraph;
  if (graph === null) {
    return transitionError('CONTRACT_INVALID', 'READY session has no execution graph.');
  }
  if (attempts.length === 0) {
    return transitionError('CONTRACT_INVALID', 'No READY node is available to dispatch; the execution graph may be fully executed or inconsistent.');
  }
  const nodeIds = new Set(attempts.map((attempt) => attempt.nodeId));
  if (nodeIds.size !== attempts.length) {
    return transitionError('CONTRACT_INVALID', 'Duplicate nodeId across the selected attempt batch.');
  }
  for (const attempt of attempts) {
    if (record.session.nodeStates[attempt.nodeId] !== 'READY') {
      return transitionError('CONTRACT_INVALID', `Node "${attempt.nodeId}" is not READY; cannot begin execution for it.`);
    }
    if (attempt.operatorSessionId !== record.session.operatorSessionId || attempt.graphRevision !== graph.graphRevision) {
      return transitionError('CONTRACT_INVALID', `Attempt for node "${attempt.nodeId}" does not match this session/graph revision.`);
    }
  }

  const nextNodeStates: Record<string, NodeState> = { ...record.session.nodeStates };
  const nextActiveAttempts: Record<string, NodeExecutionAttemptAllocation> = { ...record.activeAttempts };
  const nextProviderSessionIds: Record<string, string> = { ...record.session.providerSessionIds };
  for (const attempt of attempts) {
    nextNodeStates[attempt.nodeId] = 'RUNNING';
    nextActiveAttempts[attempt.nodeId] = attempt;
    nextProviderSessionIds[attempt.nodeId] = attempt.providerSessionId;
  }

  const nodeList = attempts.map((attempt) => attempt.nodeId).join(', ');
  let executing: OperatorSession = {
    ...record.session,
    verificationState: deriveVerificationState(graph, nextNodeStates),
    currentState: 'EXECUTING',
    currentPhase: attempts.length === 1 ? `Executing node "${nodeList}"` : `Executing ${attempts.length} node(s): ${nodeList}`,
    nodeStates: nextNodeStates,
    providerSessionIds: nextProviderSessionIds,
  };
  for (const attempt of attempts) {
    executing = appendJournal(executing, {
      timestamp: now,
      eventType: 'EXECUTION_STARTED',
      operatorSessionId: executing.operatorSessionId,
      nodeId: attempt.nodeId,
      message: `Dispatching node "${attempt.nodeId}" as attempt "${attempt.attemptId}" (batch "${attempt.batchId}").`,
    });
  }
  if (record.session.routeDecision !== null) {
    for (const fallback of record.session.routeDecision.fallbackDecisions) {
      const appliesToAttempt = attempts.some((attempt) => graph.nodes.find((node) => node.nodeId === attempt.nodeId)?.role === fallback.role);
      if (appliesToAttempt) executing = appendFallbackDecision(executing, fallback, now);
    }
  }
  return { ...record, session: executing, activeAttempts: nextActiveAttempts };
}

/** Folds a batch of outcomes (one for `SINGLE`/`PIPELINE`, one or more for
 * `PARALLEL`) into node/session state. Outcomes whose attempt no longer
 * matches `record.activeAttempts` exactly are silently dropped — stale,
 * replayed, or foreign, never redispatched, never forced into a fabricated
 * failure for a node they do not truthfully belong to. Every accepted
 * outcome clears its node's `activeAttempts` entry and records its real
 * refs in `nodeResultRefs`. A mandatory node's non-SUCCEEDED terminal
 * status ends the session immediately (deterministic tie-break: first such
 * node in declared graph order); an optional node's does not. */
export function completeExecutionBatch(
  record: StoredOperatorSession,
  outcomes: readonly NodeExecutionOutcome[],
  ids: OperatorIdFactory,
  now: string,
): StoredOperatorSession {
  const graph = record.session.executionGraph;
  const routeDecision = record.session.routeDecision;
  if (graph === null || routeDecision === null) {
    // Unreachable in practice: EXECUTING is only reached via
    // beginExecutionBatch, which already requires a non-null execution
    // graph, and routeDecision is set once at PLANNING and never cleared.
    // Guarded anyway so this function stays total.
    const terminal = buildFinalResult({
      session: record.session,
      workflowStatus: 'FAILED',
      executionStatus: 'FAILED',
      recommendation: 'STOP',
      recommendationRationale: 'Execution completed but the session is missing its execution graph or route decision.',
      workPerformed: [],
      changesMade: [],
      actionsNotPerformed: ['No mutation was performed; the session failed before any node contract could be evaluated.'],
      nodeResultRefs: record.nodeResultRefs,
    });
    const failed: OperatorSession = { ...record.session, currentState: 'FAILED', currentPhase: 'Failed', terminalResult: terminal };
    return {
      ...record,
      activeAttempts: {},
      session: appendJournal(failed, {
        timestamp: now,
        eventType: 'SESSION_FAILED',
        operatorSessionId: failed.operatorSessionId,
        message: 'Session failed: missing execution graph or route decision after node completion.',
      }),
    };
  }

  const applicable = outcomes.filter((outcome) => outcomeMatchesActiveAttempt(record, outcome));

  let nodeStates: Record<string, NodeState> = { ...record.session.nodeStates };
  const nextActiveAttempts: Record<string, NodeExecutionAttemptAllocation> = { ...record.activeAttempts };
  const nextNodeResultRefs: Record<string, NodeResultRefs> = { ...record.nodeResultRefs };
  let session: OperatorSession = record.session;

  for (const outcome of applicable) {
    const result = outcome.result;
    delete nextActiveAttempts[result.nodeId];
    const node = graph.nodes.find((candidate) => candidate.nodeId === result.nodeId);
    const failureFingerprint = outcome.failureFingerprint ?? createFailureFingerprint(outcome, node?.mutation?.mutationClass ?? 'READ_ONLY');
    const resultRefs = toNodeResultRefs(result, outcome.attempt, now, outcome.usage, failureFingerprint, outcome.fallbackJournal);
    const dispositionBlocksProgression = resultRefs.recommendedDisposition === 'BLOCK' || resultRefs.recommendedDisposition === 'HUMAN_DECISION' || resultRefs.recommendedDisposition === 'CORRECT';
    nodeStates[result.nodeId] = dispositionBlocksProgression ? 'BLOCKED' : mapAgentResultStatusToNodeState(result.status);
    nextNodeResultRefs[result.nodeId] = resultRefs;
    session = appendJournal(
      { ...session, nodeStates, verificationState: deriveVerificationState(graph, nodeStates) },
      {
        timestamp: now,
        eventType: dispositionBlocksProgression ? 'EXECUTION_BLOCKED' : journalEventForStatus(result.status),
        operatorSessionId: session.operatorSessionId,
        nodeId: result.nodeId,
        message: dispositionBlocksProgression
          ? `Node "${result.nodeId}" returned SUCCEEDED with effective disposition ${resultRefs.recommendedDisposition}; progression is blocked: ${result.summary}`
          : `Node "${result.nodeId}" returned ${result.status}: ${result.summary}`,
      },
    );
    if (failureFingerprint !== undefined) {
      session = appendJournal(session, {
        timestamp: now,
        eventType: 'FAILURE_FINGERPRINTED',
        operatorSessionId: session.operatorSessionId,
        nodeId: result.nodeId,
        reasonCode: failureFingerprint.reasonCode,
        message: `Failure fingerprint ${failureFingerprint.fingerprint} recorded for ${failureFingerprint.adapterId}/${failureFingerprint.modelProvider}/${failureFingerprint.modelId}.`,
      });
    }
    if (outcome.fallbackJournal !== undefined) {
      session = appendJournal(session, {
        timestamp: now,
        eventType: 'PROVIDER_FALLBACK_JOURNALED',
        operatorSessionId: session.operatorSessionId,
        nodeId: result.nodeId,
        reasonCode: outcome.fallbackJournal.finalOutcome,
        message: `Provider fallback journal recorded ${outcome.fallbackJournal.attempts.length} attempt event(s); final outcome ${outcome.fallbackJournal.finalOutcome}.`,
      });
    }
  }

  const withFolded: StoredOperatorSession = { ...record, session, activeAttempts: nextActiveAttempts, nodeResultRefs: nextNodeResultRefs };

  const dispositionAssessment = assessFindingDispositions(nextNodeResultRefs);
  if (dispositionAssessment.workflowStatus !== undefined) {
    const affectedNode = applicable.find((outcome) => {
      const disposition = outcome.result.recommendedDisposition;
      return disposition === 'BLOCK' || disposition === 'HUMAN_DECISION' || disposition === 'CORRECT';
    })?.result.nodeId;
    const failedOnDisposition: OperatorSession = {
      ...session,
      currentState: 'FAILED',
      currentPhase: dispositionAssessment.humanDecisionRequired ? 'Failed closed pending human finding decision' : 'Failed closed on blocking finding disposition',
      terminalResult: null,
    };
    const terminal = buildFinalResult({
      session: failedOnDisposition,
      workflowStatus: dispositionAssessment.workflowStatus,
      executionStatus: dispositionAssessment.executionStatus ?? 'FAILED',
      recommendation: dispositionAssessment.recommendation ?? 'STOP',
      recommendationRationale: 'A terminal node reported a progression-blocking finding disposition; the successful provider status cannot authorize progression.',
      workPerformed: affectedNode === undefined ? [] : [`Dispatched node "${affectedNode}".`],
      changesMade: [],
      actionsNotPerformed: buildActionsNotPerformed(graph, nodeStates),
      nodeResultRefs: nextNodeResultRefs,
    });
    const journaled = appendJournal({ ...failedOnDisposition, terminalResult: terminal }, {
      timestamp: now,
      eventType: 'SESSION_FAILED',
      operatorSessionId: failedOnDisposition.operatorSessionId,
      ...(affectedNode !== undefined ? { nodeId: affectedNode } : {}),
      message: dispositionAssessment.humanDecisionRequired
        ? 'Session failed closed: human decision is required for a reported finding.'
        : 'Session failed closed: a reported finding blocks progression.',
    });
    return { ...withFolded, session: journaled };
  }

  // Deterministic tie-break: first mandatory non-SUCCEEDED terminal in
  // declared graph order among the nodes this call actually completed.
  const completedMandatoryFailure = graph.nodes.find((node) => {
    if (node.mandatory !== true) return false;
    const outcome = applicable.find((o) => o.result.nodeId === node.nodeId);
    return outcome !== undefined && outcome.result.status !== 'SUCCEEDED';
  });

  if (completedMandatoryFailure !== undefined) {
    const failingOutcome = applicable.find((o) => o.result.nodeId === completedMandatoryFailure.nodeId);
    const result = failingOutcome?.result;
    if (result === undefined) {
      // Unreachable: completedMandatoryFailure was found via the same
      // `applicable` list. Guarded so this branch stays total.
      return withFolded;
    }
    if (result.status === 'BLOCKED') {
      const stopDetail: StopDetail = {
        reason: 'BLOCKED_CAPABILITY',
        affectedNodeId: result.nodeId,
        evidenceRefs: [],
        retryEligible: false,
        requiredDecisionOrPrerequisite: `Node "${result.nodeId}" reported BLOCKED: ${result.summary}`,
        nextAllowedActions: ['CANCEL'],
      };
      const blocked: OperatorSession = { ...session, currentState: 'BLOCKED', currentPhase: 'Blocked by node execution', stopDetail };
      return { ...withFolded, session: blocked };
    }
    const workflowStatus: WorkflowStatus = result.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    const executionStatus: ExecutionStatus = result.status === 'CANCELLED' ? 'CANCELLED' : result.status === 'UNKNOWN' ? 'UNKNOWN' : 'FAILED';
    const sessionState: SessionState = result.status === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    const terminal = buildFinalResult({
      session,
      workflowStatus,
      executionStatus,
      recommendation: 'STOP',
      recommendationRationale: `Node "${result.nodeId}" returned status ${result.status}: ${result.summary}`,
      workPerformed: [`Dispatched node "${result.nodeId}".`],
      changesMade: [],
      actionsNotPerformed: buildActionsNotPerformed(graph, nodeStates),
      nodeResultRefs: nextNodeResultRefs,
    });
    const ended: OperatorSession = { ...session, currentState: sessionState, currentPhase: workflowStatus === 'CANCELLED' ? 'Cancelled' : 'Failed', terminalResult: terminal };
    const withTerminalJournal = appendJournal(ended, {
      timestamp: now,
      eventType: workflowStatus === 'CANCELLED' ? 'SESSION_CANCELLED' : 'SESSION_FAILED',
      operatorSessionId: ended.operatorSessionId,
      message: `Session ${workflowStatus === 'CANCELLED' ? 'cancelled' : 'failed'} after node execution.`,
    });
    return { ...withFolded, session: withTerminalJournal };
  }

  // No mandatory failure among the outcomes just folded: promote newly
  // eligible nodes (this also handles optional-node degradation via
  // `promoteReadyNodes`'s dependency rule) and decide the next state.
  const promoted = promoteReadyNodes(graph, nodeStates);
  const templateId = record.session.workflowTemplateId ?? graph.workflowTemplateId;
  const allMandatorySucceeded = graph.nodes.filter((node) => node.mandatory).every((node) => promoted[node.nodeId] === 'SUCCEEDED');
  const hasStillActiveAttempts = Object.keys(nextActiveAttempts).length > 0;

  if (!allMandatorySucceeded || hasStillActiveAttempts) {
    // Either more mandatory work remains, or (defensively) this batch left
    // some attempt still active — either way, READY for the next continue,
    // never re-selecting an attempt that is still active.
    const readyAgain: OperatorSession = {
      ...session,
      nodeStates: promoted,
      currentState: hasStillActiveAttempts ? 'EXECUTING' : 'READY',
      currentPhase: hasStillActiveAttempts ? 'Awaiting remaining node(s) in the active batch' : 'Ready for next node execution',
    };
    return { ...withFolded, session: readyAgain };
  }

  const nextGateType = routeDecision.requiredGates[record.session.humanDecisions.length];
  if (nextGateType !== undefined) {
    const gate = buildPostExecutionGate(
      nextGateType,
      session.operatorSessionId,
      graph,
      graph.nodes[graph.nodes.length - 1]?.nodeId ?? '',
      session.artifacts,
      ids.next('gate'),
      now,
      record.gates[0]?.riskSummary,
    );
    const awaiting: OperatorSession = {
      ...session,
      nodeStates: promoted,
      currentState: 'AWAITING_HUMAN',
      currentPhase: `Awaiting ${nextGateType}`,
      openGateId: gate.gateId,
    };
    const withGateOpened = appendJournal(awaiting, {
      timestamp: now,
      eventType: 'GATE_OPENED',
      operatorSessionId: awaiting.operatorSessionId,
      gateId: gate.gateId,
      message: `Opened ${nextGateType} gate for the "${templateId}" workflow after all mandatory nodes succeeded.`,
    });
    return { ...withFolded, session: withGateOpened, gates: [...record.gates, gate] };
  }

  const degradedNodeIds = degradedOptionalNodeIds(graph, promoted);
  const hasDegradedOptionalNodes = degradedNodeIds.length > 0;
  const hasDeferredFindings = dispositionAssessment.deferredFindings.length > 0;
  const hasDeferredItems = hasDegradedOptionalNodes || hasDeferredFindings;
  const resultSession: OperatorSession = { ...session, nodeStates: promoted };
  const terminal = buildFinalResult({
    session: resultSession,
    workflowStatus: hasDeferredItems ? 'COMPLETED_WITH_DEFERRED_ITEMS' : 'COMPLETED',
    executionStatus: hasDeferredItems ? 'PARTIAL' : 'SUCCEEDED',
    recommendation: hasDeferredItems ? 'GO_WITH_DEFERRED_ITEMS' : 'GO',
    recommendationRationale: hasDeferredItems
      ? `Every mandatory node of the "${templateId}" workflow completed successfully after human approval; deferred finding(s) and optional outcomes remain explicitly recorded.`
      : `Every mandatory node of the "${templateId}" workflow completed successfully after human approval; no blockers remain.`,
    workPerformed: graph.nodes.filter((node) => promoted[node.nodeId] === 'SUCCEEDED').map((node) => `Executed node "${node.nodeId}".`),
    changesMade: [],
    actionsNotPerformed: buildActionsNotPerformed(graph, promoted),
    degradedOptionalNodeIds: degradedNodeIds,
    nodeResultRefs: nextNodeResultRefs,
  });
  const completed: OperatorSession = {
    ...resultSession,
    currentState: 'COMPLETED',
    currentPhase: hasDeferredItems ? 'Completed with deferred items' : 'Completed',
    terminalResult: terminal,
  };
  const withCompleteJournal = appendJournal(completed, {
    timestamp: now,
    eventType: 'SESSION_COMPLETED',
    operatorSessionId: completed.operatorSessionId,
    message: hasDeferredItems
      ? `Session completed with deferred item(s): ${[...degradedNodeIds.map((nodeId) => `optional:${nodeId}`), ...dispositionAssessment.deferredFindings].join(', ')}.`
      : 'Session completed successfully after all mandatory nodes succeeded.',
  });
  const completedRecord: StoredOperatorSession = {
    ...withFolded,
    activeAttempts: nextActiveAttempts,
    nodeResultRefs: nextNodeResultRefs,
    session: withCompleteJournal,
  };
  return completedRecord;
}

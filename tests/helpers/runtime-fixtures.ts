import type { AgentResult, ExecutionGraphNode, GateDecisionType, HumanGate, OperatorSession } from '../../src/contracts.js';
import { validateOperatorSession } from '../../src/validators.js';
import { createOperatorRuntime, OperatorRuntime } from '../../src/controller.js';
import { DeterministicMockAdapter, createDeterministicContextProjector } from '../../src/mock.js';
import { createFrozenNodeExecutionAdapterResolver } from '../../src/stage7/adapter-resolver.js';
import type {
  CompilationResult,
  CompiledWorkflow,
  OperatorWorkflowCompiler,
  ResolvedPolicy,
  WorkflowCompilerContext,
} from '../../src/stage3-types.js';
import type {
  NodeExecutionOutcome,
  OperatorClock,
  OperatorCommandOutcome,
  OperatorIdFactory,
  OperatorSessionStore,
  StoredOperatorSession,
} from '../../src/runtime-types.js';
import { MemoryOperatorSessionStore } from '../../src/store.js';

// ---------------------------------------------------------------------------
// Deterministic test fixtures
// ---------------------------------------------------------------------------

export const FIXED_NOW = '2026-01-01T00:00:00.000Z';

export class FixedClock implements OperatorClock {
  now(): string {
    return FIXED_NOW;
  }
}

export class SequentialIds implements OperatorIdFactory {
  readonly #counts: Record<'session' | 'graph' | 'gate' | 'result' | 'batch' | 'providerSession', number> = {
    session: 0,
    graph: 0,
    gate: 0,
    result: 0,
    batch: 0,
    providerSession: 0,
  };
  next(prefix: 'session' | 'graph' | 'gate' | 'result' | 'batch' | 'providerSession'): string {
    this.#counts[prefix] += 1;
    return `${prefix}-${this.#counts[prefix]}`;
  }
}

/** A store wrapper that, when armed, injects one "concurrent writer raced
 * ahead" bump into the underlying record immediately before delegating a
 * CAS-guarded save — so the delegated save observes a stale
 * `expectedUpdatedAt` and throws `StoreConflictError`, exactly like a real
 * racing process would. Used to prove `OperatorRuntime`'s bounded
 * reload-recheck-reduce-CAS retry (plan §6.2) actually retries and, when
 * the race persists beyond its retry budget, surfaces `STORE_CONFLICT`
 * instead of looping forever. */
export class RacingSaveStore implements OperatorSessionStore {
  readonly #inner = new MemoryOperatorSessionStore();
  #racesRemaining = 0;

  armRaces(count: number): void {
    this.#racesRemaining = count;
  }

  async load(operatorSessionId: string): Promise<StoredOperatorSession | undefined> {
    return this.#inner.load(operatorSessionId);
  }

  async save(record: StoredOperatorSession, expectedUpdatedAt?: string): Promise<void> {
    if (this.#racesRemaining > 0 && expectedUpdatedAt !== undefined) {
      this.#racesRemaining -= 1;
      const racingCurrent = await this.#inner.load(record.session.operatorSessionId);
      if (racingCurrent !== undefined) {
        const bumped: StoredOperatorSession = {
          ...racingCurrent,
          session: { ...racingCurrent.session, updatedAt: new Date(Date.parse(racingCurrent.session.updatedAt) + 1).toISOString() },
        };
        await this.#inner.save(bumped);
      }
    }
    await this.#inner.save(record, expectedUpdatedAt);
  }
}

/** Minimal but structurally valid `ResolvedPolicy`. Every deeper field
 * (`config.profile`, overlay resolution, ...) is exercised by
 * `OperatorConfigTrust`/`OperatorPolicyEngine`'s own tests, not here: this
 * runtime slice only ever reads `policy.budgetProfile`/`policy.maxConcurrency`. */
export function makeResolvedPolicy(requiredGates: readonly GateDecisionType[], maxConcurrency: number = 1): ResolvedPolicy {
  return {
    config: {
      profile: {
        schemaVersion: '1.0',
        workflow: 'direct.v1',
        defaultPolicyPacks: [],
        budgetProfile: 'CHEAP',
        maxConcurrency,
        features: {
          automaticRouting: false,
          externalProviders: false,
          councilMode: false,
          autoFallback: false,
          persistentState: true,
          costTracking: false,
        },
        rules: {
          humanIsFinalApprover: true,
          implementerSelfApproval: false,
          automaticCommit: false,
          automaticPush: false,
          automaticMerge: false,
          independentVerification: false,
          adversarialReviewForHighRisk: false,
          scopeFreezeRequired: false,
          maxReviewRounds: 1,
        },
        capabilityAssignments: {},
      },
      globalConfigPath: '/dev/null/agent-operator/operator.json',
      projectOverlay: { status: 'ABSENT', projectRoot: '/dev/null' },
      policyRefs: ['mock@1:config.fixed'],
    },
    packs: [],
    effectiveRules: {
      humanIsFinalApprover: true,
      implementerSelfApproval: false,
      automaticCommit: false,
      automaticPush: false,
      automaticMerge: false,
      independentVerification: false,
      adversarialReviewForHighRisk: false,
      scopeFreezeRequired: false,
      maxReviewRounds: 1,
    },
    budgetProfile: 'CHEAP',
    maxConcurrency,
    requiredGates,
    policyRefs: ['mock@1:policy.fixed'],
    decisions: [],
  };
}

export interface FixtureNode {
  readonly nodeId: string;
  readonly mandatory: boolean;
  readonly dependsOn: readonly string[];
  readonly groupId?: string;
  readonly role?: string;
  readonly synthesisOwner?: boolean;
}

export function makeCompiledWorkflow(
  context: WorkflowCompilerContext,
  options: {
    readonly templateId: string;
    readonly nodes: readonly FixtureNode[];
    readonly requiredGates: readonly GateDecisionType[];
    readonly executionShape?: 'SINGLE' | 'PARALLEL' | 'PIPELINE';
    readonly maxConcurrency?: number;
  },
): CompiledWorkflow {
  const executionShape = options.executionShape ?? 'PIPELINE';
  const nodes: ExecutionGraphNode[] = options.nodes.map((node) => ({
    nodeId: node.nodeId,
    capabilityId: 'mock-read-capability',
    role: node.role ?? 'mock-reader',
    mandatory: node.mandatory,
    dependsOn: node.dependsOn,
    contextPolicy: 'isolated',
    consumes: [],
    produces: [],
    ...(node.groupId !== undefined ? { groupId: node.groupId } : {}),
    ...(node.synthesisOwner !== undefined ? { synthesisOwner: node.synthesisOwner } : {}),
  }));
  const executionGraph = {
    graphId: context.graphId,
    graphRevision: 1,
    workflowTemplateId: options.templateId,
    executionShape,
    nodes,
    graphHash: 'a'.repeat(64),
  };
  const routeDecision = {
    requestClassification: 'DIRECT' as const,
    riskClassification: 'LOW' as const,
    selectedWorkflow: options.templateId,
    selectedRolesProviders: [{ role: 'mock-reader', capabilityId: 'mock-read-capability', provider: 'mock' }],
    rejectedAlternatives: [],
    requiredGates: options.requiredGates,
    budgetEffect: { profile: 'CHEAP' as const },
    fallbackDecisions: [],
    reasonCodes: ['MOCK_FIXTURE_ROUTE'],
    policyRefs: ['mock@1:route.fixed'],
    confidence: 'HIGH' as const,
    abstention: { abstained: false },
  };
  const template = {
    templateId: options.templateId,
    version: 1,
    taskFamilies: ['DIRECT' as const],
    executionShape,
    description: 'Test fixture template.',
    nodes: options.nodes.map((node) => ({ nodeId: node.nodeId, role: node.role ?? 'mock-reader', mandatory: node.mandatory, dependsOn: node.dependsOn })),
    requiredGateTypes: options.requiredGates,
  };
  const firstGateType = options.requiredGates[0];
  const initialGate: HumanGate | null =
    firstGateType === undefined
      ? null
      : {
          gateId: context.gateId,
          operatorSessionId: context.operatorSessionId,
          reason: `Fixture requires ${firstGateType} before dispatch.`,
          decisionType: firstGateType,
          requestedDecision: `Approve ${firstGateType} for "${options.templateId}"?`,
          availableOptions: ['APPROVE', 'REJECT'],
          recommendedOption: 'APPROVE',
          evidenceRefs: [],
          consequences: { APPROVE: 'Execution proceeds.', REJECT: 'The session is declined.' },
          resumeNode: options.nodes[0]?.nodeId ?? 'none',
          graphRevision: 1,
          graphHash: executionGraph.graphHash,
          artifactRefs: [],
          artifactHashes: [],
          policyRefs: ['mock@1:gate.fixed'],
          createdAt: context.now,
          status: 'OPEN',
        };
  return {
    classification: {
      requestClassification: 'DIRECT',
      riskClassification: 'LOW',
      confidence: 'HIGH',
      decomposable: false,
      semanticCapabilities: ['read'],
      rationale: 'Fixture classification.',
    },
    policy: makeResolvedPolicy(options.requiredGates, options.maxConcurrency),
    template,
    routeDecision,
    executionGraph,
    initialGate,
  };
}

/** A deterministic `OperatorWorkflowCompiler` test double. Every request
 * compiles to the same fixed single-node `mock.v1` route unless `flavor`
 * routes it differently, or the request contains the literal substring
 * `FAIL_COMPILE` (compilation failure path). */
export class FakeCompiler implements OperatorWorkflowCompiler {
  readonly #flavor: 'single-gate' | 'two-node' | 'multi-gate' | 'optional-node' | 'parallel' | 'reviewer';

  constructor(flavor: 'single-gate' | 'two-node' | 'multi-gate' | 'optional-node' | 'parallel' | 'reviewer' = 'single-gate') {
    this.#flavor = flavor;
  }

  async compile(request: string, context: WorkflowCompilerContext): Promise<CompilationResult> {
    if (request.includes('FAIL_COMPILE')) {
      return { ok: false, code: 'CLASSIFICATION_INVALID', message: 'Fixture-forced compilation failure.', policyRefs: ['mock@1:compile.rejected'] };
    }
    if (this.#flavor === 'parallel') {
      return {
        ok: true,
        compiled: makeCompiledWorkflow(context, {
          templateId: 'mock-parallel.v1',
          nodes: [
            { nodeId: 'p-a', mandatory: true, dependsOn: [], groupId: 'parallel-checks', synthesisOwner: true },
            { nodeId: 'p-b', mandatory: true, dependsOn: [], groupId: 'parallel-checks' },
            { nodeId: 'p-c', mandatory: true, dependsOn: [], groupId: 'parallel-checks' },
          ],
          requiredGates: ['EXECUTION_APPROVAL'],
          executionShape: 'PARALLEL',
          maxConcurrency: 2,
        }),
      };
    }
    if (this.#flavor === 'optional-node') {
      return {
        ok: true,
        compiled: makeCompiledWorkflow(context, {
          templateId: 'mock-optional-node.v1',
          nodes: [
            { nodeId: 'mandatory-start', mandatory: true, dependsOn: [] },
            { nodeId: 'optional-node', mandatory: false, dependsOn: ['mandatory-start'] },
            { nodeId: 'mandatory-synthesis', mandatory: true, dependsOn: ['optional-node'] },
          ],
          requiredGates: ['EXECUTION_APPROVAL'],
        }),
      };
    }
    if (this.#flavor === 'two-node') {
      return {
        ok: true,
        compiled: makeCompiledWorkflow(context, {
          templateId: 'mock-two-node.v1',
          nodes: [
            { nodeId: 'mock-node-a', mandatory: true, dependsOn: [] },
            { nodeId: 'mock-node-b', mandatory: true, dependsOn: ['mock-node-a'] },
          ],
          requiredGates: ['EXECUTION_APPROVAL'],
        }),
      };
    }
    if (this.#flavor === 'multi-gate') {
      return {
        ok: true,
        compiled: makeCompiledWorkflow(context, {
          templateId: 'mock-multi-gate.v1',
          nodes: [{ nodeId: 'mock-read-node', mandatory: true, dependsOn: [] }],
          requiredGates: ['EXECUTION_APPROVAL', 'RESULT_APPROVAL'],
        }),
      };
    }
    if (this.#flavor === 'reviewer') {
      return {
        ok: true,
        compiled: makeCompiledWorkflow(context, {
          templateId: 'mock-reviewer.v1',
          nodes: [{ nodeId: 'independent-review', role: 'independent-reviewer', mandatory: true, dependsOn: [] }],
          requiredGates: ['EXECUTION_APPROVAL'],
        }),
      };
    }
    return {
      ok: true,
      compiled: makeCompiledWorkflow(context, {
        templateId: 'mock.v1',
        nodes: [{ nodeId: 'mock-read-node', mandatory: true, dependsOn: [] }],
        requiredGates: ['EXECUTION_APPROVAL'],
      }),
    };
  }
}

export function makeRuntime(
  adapter: DeterministicMockAdapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false }),
  compiler: OperatorWorkflowCompiler = new FakeCompiler(),
  store: OperatorSessionStore = new MemoryOperatorSessionStore(),
): {
  runtime: OperatorRuntime;
  store: OperatorSessionStore;
  adapter: DeterministicMockAdapter;
} {
  const runtime = createOperatorRuntime({
    store,
    clock: new FixedClock(),
    ids: new SequentialIds(),
    nodeExecutionAdapterResolver: createFrozenNodeExecutionAdapterResolver(adapter, true),
    contextProjector: createDeterministicContextProjector(),
    nodeTimeoutMs: () => 60_000,
    compiler,
    projectRoot: '/dev/null',
  });
  return { runtime, store, adapter };
}

export function expectValidSession(session: OperatorSession): void {
  const result = validateOperatorSession(session);
  if (!result.ok) {
    throw new Error(`invalid OperatorSession: ${result.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
  }
}

/** Drives exactly one `continue` to completion against a `DeterministicMockAdapter`:
 * launches the batch, resolves every one of its attempts (per-node `resolutions`
 * override the default `SUCCEEDED`, matching the `autoResolve:false` adapters every
 * test in this file constructs), awaits `batch.completion`, and folds it via
 * `completeBatch` — exactly the sequence the extension-owned task supervisor
 * (`execution-coordinator.ts`) performs in production via `registerActiveBatch`. If
 * `continue` itself fails (e.g. `EXECUTION_ACTIVE`), that failure is returned directly. */
export async function dispatchOneBatch(
  runtime: OperatorRuntime,
  operatorSessionId: string,
  adapter: DeterministicMockAdapter,
  resolutions: Readonly<Record<string, Partial<Pick<AgentResult, 'status' | 'summary' | 'findingIds' | 'recommendedDisposition'>>>> = {},
): Promise<{ outcome: OperatorCommandOutcome; batchId: string; outcomes: readonly NodeExecutionOutcome[] }> {
  const continued = await runtime.handle('continue');
  if (!continued.ok) {
    return { outcome: continued, batchId: '', outcomes: [] };
  }
  const batch = runtime.getActiveBatch(operatorSessionId);
  if (batch === undefined) {
    throw new Error('expected an active batch after a successful continue');
  }
  for (const attempt of batch.attempts) {
    adapter.resolveNode(batch.batchId, attempt.nodeId, resolutions[attempt.nodeId]);
  }
  const outcomes = await batch.completion;
  const outcome = await runtime.completeBatch(operatorSessionId, batch.batchId, outcomes);
  return { outcome, batchId: batch.batchId, outcomes };
}

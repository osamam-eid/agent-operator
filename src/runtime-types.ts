import type {
  AgentResult,
  AgentResultStatus,
  FindingEffectiveDisposition,
  ArtifactManifest,
  Evidence,
  ExecutionGraph,
  ExecutionGraphNode,
  HumanGate,
  MutationClass,
  OperatorSession,
  PolicyRef,
  RouteDecision,
  TaskFamily,
} from './contracts.js';
import type { ClassificationProposal, CompiledCapabilitySummary, CompiledWorkflow, OperatorWorkflowCompiler, WorkflowCompilerContext } from './stage3-types.js';
import type { DecisionTrace, RuntimeDisclosureDecision } from './intelligence.js';
import type { ShadowObservation, ShadowRoutingPort } from './shadow-routing.js';
import type { FailureFingerprint, ProviderFallbackJournal } from './execution-safety.js';
import type { ProviderIntelligencePort } from './provider-intelligence.js';
import type { ExecutionEstimate, PolicyDiffReport, PolicySimulationPort } from './policy-simulation.js';
import type { ProviderCanaryCommandPort } from './intelligence-activation.js';

/** Typed `/operator` commands implemented by the runtime. Simulation is a
 * distinct command so it can never enter the session persistence path. */
export type OperatorCommand =
  | { readonly kind: 'START'; readonly request: string; readonly mode: 'EXECUTE' | 'EXPLAIN'; readonly familyOverride?: Exclude<TaskFamily, 'DIRECT'> }
  | { readonly kind: 'SIMULATE'; readonly request: string; readonly familyOverride?: Exclude<TaskFamily, 'DIRECT'> }
  | { readonly kind: 'EXPLAIN' }
  | { readonly kind: 'WHY' }
  | { readonly kind: 'STATUS' }
  | { readonly kind: 'GRAPH' }
  | { readonly kind: 'APPROVE'; readonly gateId: string }
  | { readonly kind: 'REJECT'; readonly gateId: string }
  | { readonly kind: 'CONTINUE' }
  | { readonly kind: 'CANCEL' }
  | { readonly kind: 'RESUME'; readonly operatorSessionId: string }
  | { readonly kind: 'IMPROVE'; readonly subcommand: string; readonly args: readonly string[] }
  | { readonly kind: 'POLICY_TEST'; readonly proposedPath: string; readonly request: string; readonly familyOverride?: Exclude<TaskFamily, 'DIRECT'> }
  | { readonly kind: 'CANARY'; readonly providerId: string; readonly modelId?: string }
  | { readonly kind: 'COMPETENCE'; readonly subcommand: 'STATUS' | 'SHOW'; readonly providerId?: string; readonly modelId?: string }
  | { readonly kind: 'SHADOW'; readonly subcommand: 'ON' | 'OFF' | 'STATUS' | 'EVALUATE'; readonly request?: string; readonly familyOverride?: Exclude<TaskFamily, 'DIRECT'> }
  | { readonly kind: 'FLEET'; readonly subcommand: string; readonly args: readonly string[] };

export type OperatorCommandErrorCode =
  | 'INVALID_COMMAND'
  | 'NO_ACTIVE_SESSION'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_ACTIVE'
  | 'INVALID_TRANSITION'
  | 'GATE_NOT_FOUND'
  | 'GATE_NOT_OPEN'
  | 'GATE_MISMATCH'
  | 'CONTRACT_INVALID'
  | 'STORE_CONFLICT'
  | 'NODE_EXECUTION_FAILED'
  | 'COMPILATION_FAILED'
  | 'ADAPTER_UNAVAILABLE'
  | 'EXECUTION_ACTIVE'
  | 'EXECUTION_TIMEOUT'
  | 'INVALID_OUTPUT'
  | 'BLOCKED_REQUIRED_CONTEXT'
  | 'BLOCKED_PROVIDER_UNAVAILABLE'
  | 'BLOCKED_CAPABILITY'
  | 'BLOCKED_SECURITY'
  | 'FEATURE_SET_MISMATCH'
  | 'STAGE7_ROUTE_UNAVAILABLE'
  | 'STAGE7_CAPABILITY_UNAVAILABLE'
  | 'FEATURE_DISABLED'
  | 'EVALUATOR_ERROR';

export interface SimulationResultEnvelope {
  readonly schemaVersion: '1.0';
  readonly request: string;
  readonly generatedAt: string;
  readonly classification: ClassificationProposal;
  readonly disclosureDecision: RuntimeDisclosureDecision;
  readonly routeDecision: RouteDecision;
  readonly executionGraph: ExecutionGraph;
  readonly executionEstimate: ExecutionEstimate;
  readonly capabilities: readonly CompiledCapabilitySummary[];
  readonly decisionTrace: DecisionTrace;
  readonly preflight: 'PASSED' | 'NOT_CONFIGURED';
}

export interface OperatorCommandOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly errorCode?: OperatorCommandErrorCode;
  readonly operatorSessionId?: string;
  readonly session?: OperatorSession;
  readonly policyDiff?: PolicyDiffReport;
  readonly gate?: HumanGate;
  readonly simulation?: SimulationResultEnvelope;
  readonly shadowObservation?: ShadowObservation;
}

// ---------------------------------------------------------------------------
// Stage 4 runtime execution seam
// ---------------------------------------------------------------------------

/** The only two adapters this rollout ever wires: the deterministic
 * in-process mock (tests/fixtures only) and the native OMP child-session
 * adapter. Production wiring must reject a compiled route that selects
 * `'mock'`. */
import type { NodeExecutionAdapterResolver, ProductionNodeExecutionAdapterId, Stage7FeatureSet } from './stage7/types.js';

export type { NodeExecutionAdapterResolver } from './stage7/types.js';
export type NodeExecutionAdapterId = 'mock' | ProductionNodeExecutionAdapterId;

/** Pre-dispatch identity for one node attempt. Allocated and persisted by
 * the controller (`activeAttempts`, keyed by `nodeId`) before the adapter
 * is ever called, so a crash between persistence and dispatch is always
 * recoverable via `reconcileExecutionBatch` — never guessed, never retried
 * automatically. `attemptId` is a deterministic hash of
 * (`operatorSessionId`, `graphRevision`, `nodeId`, `providerSessionId`);
 * see `deriveAttemptId` in `state.ts`. It is replay protection, not a
 * retry token: Stage 4 permits exactly one attempt per node. */
export interface NodeExecutionAttemptAllocation {
  readonly attemptId: string;
  readonly batchId: string;
  readonly operatorSessionId: string;
  readonly graphRevision: number;
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly adapterId: NodeExecutionAdapterId;
  readonly providerSessionId: string;
  readonly startedAt: string;
  readonly timeoutAt: string;
}

/** Full attempt identity bound to a dispatched child and echoed back on its
 * `NodeExecutionOutcome`. The adapter fills `modelProvider`/`modelId` with
 * the exact model it actually used (no silent fallback); every other field
 * must equal the corresponding `NodeExecutionAttemptAllocation` unchanged. */
export interface NodeExecutionAttempt extends NodeExecutionAttemptAllocation {
  readonly modelProvider: string;
  readonly modelId: string;
}

/** One dependency's terminal outcome, projected for a downstream node's
 * prompt (never the dependency's raw reasoning or transcript). */
export interface DependencyResultSummary {
  readonly nodeId: string;
  readonly status: AgentResultStatus;
  readonly summary: string;
}

/** Immutable, already-materialized read-only projection root for one node's
 * dispatch (Stage 4 §5.1/§3.2): a deterministic file/count/size/hash
 * manifest under a directory the adapter's tool guard treats as the only
 * allowed local root. */
export interface NodeContextProjection {
  readonly projectionRoot: string;
  readonly allowedPaths: readonly string[];
  readonly manifestHash: string;
  readonly sourceLabels: readonly string[];
}

/** The complete, minimized context boundary handed to one child session
 * (Stage 4 §5.1). Never the full `OperatorSession`. */
export interface NodeExecutionRequest {
  readonly allocation: NodeExecutionAttemptAllocation;
  readonly node: ExecutionGraphNode;
  /** The exact approved user request, or an approved summary per
   * `node.contextPolicy`. */
  readonly requestOrSummary: string;
  readonly consumedArtifacts: readonly ArtifactManifest[];
  readonly consumedEvidence: readonly Evidence[];
  readonly dependencyResultSummaries: readonly DependencyResultSummary[];
  readonly projection: NodeContextProjection;
  readonly policyRefs: readonly PolicyRef[];
  readonly instructions: string;
  readonly acceptanceCriteria: readonly string[];
  readonly toolGrant: readonly string[];
  readonly mutationClass: MutationClass;
  readonly outputSchemaId: string;
}

/** Builds the per-node context boundary. The only shipped implementation
 * that materializes real project content lives in `context-projection.ts`;
 * this package's own tests use a trivial deterministic fake (`mock.ts`). */
export interface NodeContextProjector {
  project(params: {
    readonly record: StoredOperatorSession;
    readonly node: ExecutionGraphNode;
    readonly allocation: NodeExecutionAttemptAllocation;
  }): Promise<NodeExecutionRequest> | NodeExecutionRequest;
}

export interface ExecutionBatchRequest {
  readonly batchId: string;
  readonly operatorSessionId: string;
  readonly graphRevision: number;
  readonly executionShape: 'SINGLE' | 'PARALLEL' | 'PIPELINE';
  readonly nodes: readonly NodeExecutionRequest[];
}

export interface NodeExecutionUsage {
  readonly tokens: number;
  readonly cost: number | null;
}

export interface NodeExecutionOutcome {
  readonly attempt: NodeExecutionAttempt;
  readonly result: AgentResult;
  readonly usage?: NodeExecutionUsage;
  readonly failureFingerprint?: FailureFingerprint;
  readonly fallbackJournal?: ProviderFallbackJournal;
}

/** An in-flight, extension-owned execution handle. `launchBatch` starts
 * work and returns immediately (synchronously); `completion` resolves once
 * every attempt in the batch has a terminal `NodeExecutionOutcome`. Stage 4
 * never redispatches: exactly one attempt per node, ever. */
export interface ActiveExecutionBatch {
  readonly batchId: string;
  readonly attempts: readonly NodeExecutionAttempt[];
  readonly completion: Promise<readonly NodeExecutionOutcome[]>;
  cancel(reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN'): Promise<void>;
}

/** The generalized node-execution seam. Its only two implementations are
 * the deterministic mock (tests/fixtures) and the native OMP adapter
 * (`omp-task`, `src/adapters/omp-task.ts`). No parallel production path
 * bypasses this contract. */
export interface NodeExecutionAdapter {
  readonly adapterId: NodeExecutionAdapterId;
  launchBatch(request: ExecutionBatchRequest): ActiveExecutionBatch;
}

/** Registration hook the controller calls synchronously, once, immediately
 * after a batch is successfully launched. The extension-owned task
 * supervisor (`ExtensionTaskSupervisor` / `execution-coordinator.ts`) uses
 * it to wire `batch.completion` and a per-batch timeout without the runtime
 * ever creating a raw detached promise itself. Omit in tests that drive
 * `completeBatch`/`timeoutBatch` manually. */
export interface ActiveBatchRegistration {
  readonly operatorSessionId: string;
  readonly batch: ActiveExecutionBatch;
  /** Earliest `timeoutAt` across the batch's attempts. */
  readonly earliestTimeoutAt: string;
}
export type ActiveBatchRegistrar = (registration: ActiveBatchRegistration) => void;

/** Non-dispatching preflight for `SIMULATE` beyond what `compiler.compile`
 * already validates: adapter availability, exact model availability,
 * package role path/hash, tool-grant/context-projection validity, output
 * schema availability, filesystem permissions. Omit in tests/mock-only
 * wiring, where it is a no-op success. */
export type PreflightResult = { readonly ok: true } | { readonly ok: false; readonly code: OperatorCommandErrorCode; readonly message: string };

/** Store envelope. Gates remain separate from the Stage 1 OperatorSession
 * contract, alongside two further Stage 4 runtime-only ledgers that are
 * never part of the 12 foundational contracts: `activeAttempts` (the exact
 * and `nodeResultRefs` (the validated status, summary, timestamps,
 * disposition, and artifact/evidence/finding/policy refs every terminal
 * node actually reported, so downstream context and the terminal
 * `FinalOperatorResult` can be built truthfully). */
export interface StoredOperatorSession {
  readonly schemaVersion: '1.0';
  /** Present for sessions started under Stage-7 startup configuration. */
  readonly startupFeatureSetHash?: string;
  /** WP12 runtime intelligence evidence. Absent on legacy sessions. */
  readonly disclosureDecision?: RuntimeDisclosureDecision;
  readonly decisionTrace?: DecisionTrace;
  readonly session: OperatorSession;
  readonly gates: readonly HumanGate[];
  /** Resolved once at START from `ResolvedPolicy.maxConcurrency`; the upper
   * bound `selectReadyBatch` applies to a `PARALLEL` group before any
   * per-capability/adapter ceiling further narrows it. */
  readonly maxConcurrency: number;
  readonly activeAttempts: Readonly<Record<string, NodeExecutionAttemptAllocation>>;
  readonly nodeResultRefs: Readonly<Record<string, NodeResultRefs>>;
}
/** The validated observable result fields one terminal node reported,
 * enriched with provider/model/timestamps from the trusted attempt
 * envelope. Child-reported provider identity and timestamps are never
 * persisted as authority. */
export interface NodeResultRefs {
  readonly status: AgentResultStatus;
  readonly summary: string;
  readonly producedArtifactRefs: readonly string[];
  readonly consumedArtifactRefs: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly findingIds: readonly string[];
  readonly policyRefs: readonly PolicyRef[];
  readonly recommendedDisposition?: FindingEffectiveDisposition;
  readonly providerSessionId: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly startedAt: string;
  readonly failureFingerprint?: FailureFingerprint;
  readonly fallbackJournal?: ProviderFallbackJournal;
  readonly completedAt: string;
  readonly usage?: NodeExecutionUsage;
}

export interface OperatorSessionStore {
  load(operatorSessionId: string): Promise<StoredOperatorSession | undefined>;
  save(record: StoredOperatorSession, expectedUpdatedAt?: string): Promise<void>;
}

/** Optional enumeration capability (Stage 10): implemented only by stores
 * that can list session ids safely. The base OperatorSessionStore contract
 * is unchanged. */
export interface OperatorSessionStoreLister {
  listSessionIds(): Promise<readonly string[]>;
}

export interface OperatorClock {
  now(): string;
}

export interface OperatorIdFactory {
  next(prefix: 'session' | 'graph' | 'gate' | 'result' | 'batch' | 'providerSession'): string;
}

export interface OperatorRuntimeDependencies {
  readonly store: OperatorSessionStore;
  readonly clock: OperatorClock;
  readonly ids: OperatorIdFactory;
  /** Exact tuple resolver. Frozen mode must return the exact existing adapter
   * object for every non-v2 tuple. */
  readonly nodeExecutionAdapterResolver: NodeExecutionAdapterResolver;
  /** Startup feature set captured once by extension activation. */
  readonly stage7FeatureSet?: Stage7FeatureSet;
  readonly contextProjector: NodeContextProjector;
  /** Concrete, positive per-node timeout (Stage 4 §6.4): a zero or absent
   * timeout is invalid in production mode, so this is required rather than
   * defaulted. */
  readonly nodeTimeoutMs: (node: ExecutionGraphNode) => number;
  /** Optional per-capability concurrency ceiling (`CapabilityRecord.concurrency`);
   * omitted (or returning `undefined`) means unbounded for that capability,
   * leaving `StoredOperatorSession.maxConcurrency` as the only cap. */
  readonly capabilityConcurrency?: (capabilityId: string) => number | undefined;
  /** Compiles a request into a `CompiledWorkflow` (classifier -> config/trust
   * -> packs/policy -> template -> registry -> graph -> RouteDecision/gate).
   * The controller allocates session/graph/gate ids and calls this once per
   * START before ever persisting a session. */
  readonly compiler: OperatorWorkflowCompiler;
  /** Stage-10 evaluator command handler (offline evaluation subsystem).
   * Omit to fail every `/operator improve …` invocation closed with
   * `FEATURE_DISABLED`. The active runtime never imports evaluator
   * implementation modules; the handler is injected by the extension. */
  readonly evaluatorHandler?: (subcommand: string, args: readonly string[]) => Promise<OperatorCommandOutcome>;
  /** Optional WP13 semantic shadow-routing service. Omit to fail closed. */
  readonly shadowRouting?: ShadowRoutingPort;
  /** Optional WP15 evidence/scorecard service. It has no routing authority. */
  readonly providerIntelligence?: ProviderIntelligencePort;
  /** Optional WP16 policy-diff service. It never applies proposed policy. */
  readonly policySimulation?: PolicySimulationPort;
  /** Optional WP18 fixed-corpus canary runner. */
  readonly providerCanary?: ProviderCanaryCommandPort;
  /** Passed as `WorkflowCompilerContext.projectRoot` on every `compile()`
   * call: the project directory this runtime instance operates against
   * (config/trust resolution root). */
  readonly projectRoot: string;
  readonly registerActiveBatch?: ActiveBatchRegistrar;
  /** Proven terminal outcomes for RUNNING nodes discovered out-of-band
   * (e.g. a file-backed child session already holding a strict terminal
   * result). Omitted or returning `[]` preserves the Stage 1-3 RESUME
   * behavior: every RUNNING node becomes `UNKNOWN` and the session BLOCKS,
   * never guessing and never retrying automatically. */
  readonly resumeEvidence?: (record: StoredOperatorSession) => Promise<readonly NodeExecutionOutcome[]>;
  readonly preflight?: (compiled: CompiledWorkflow, context: WorkflowCompilerContext) => Promise<PreflightResult>;
}

/** Minimal structural API used by extension/index.ts; avoids a runtime SDK dependency. */
export interface OperatorCommandContext {
  readonly ui: {
    notify(text: string, level?: 'info' | 'warning' | 'error'): void;
  };
}

export interface OperatorExtensionApi {
  registerCommand(
    name: string,
    command: {
      readonly description: string;
      readonly handler: (args: string, ctx: OperatorCommandContext) => void | Promise<void>;
    },
  ): void;
}

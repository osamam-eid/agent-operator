import type {
  BudgetProfile,
  CapabilityRecord,
  Confidence,
  ExecutionGraph,
  GateDecisionType,
  HumanGate,
  MutationClass,
  PolicyDecision,
  PolicyRef,
  RiskLevel,
  RouteDecision,
  TaskFamily,
  WorkflowTemplate,
} from './contracts.js';
import type { DecisionTrace, RuntimeDisclosureDecision } from './intelligence.js';

/** Stage 3 remains mock-only. These flags describe future capabilities but
 * every dispatch-bearing flag is rejected while compiling this rollout. */
export interface OperatorFeatureFlags {
  readonly automaticRouting: boolean;
  readonly externalProviders: boolean;
  readonly councilMode: boolean;
  readonly autoFallback: boolean;
  readonly persistentState: boolean;
  readonly costTracking: boolean;
}

export interface OperatorRules {
  readonly humanIsFinalApprover: boolean;
  readonly implementerSelfApproval: boolean;
  readonly automaticCommit: boolean;
  readonly automaticPush: boolean;
  readonly automaticMerge: boolean;
  readonly independentVerification: boolean;
  readonly adversarialReviewForHighRisk: boolean;
  readonly scopeFreezeRequired: boolean;
  readonly maxReviewRounds: number;
}

export interface CapabilityPreference {
  readonly preferred: string;
  readonly fallbacks: readonly string[];
  readonly fallbackPolicy: 'COMPATIBLE_ONLY' | 'HUMAN_REQUIRED' | 'DISABLED';
}

export interface OperatorProfile {
  readonly schemaVersion: '1.0';
  readonly workflow: string;
  readonly defaultPolicyPacks: readonly string[];
  readonly budgetProfile: BudgetProfile;
  readonly maxConcurrency: number;
  readonly features: OperatorFeatureFlags;
  readonly rules: OperatorRules;
  readonly capabilityAssignments: Readonly<Record<string, CapabilityPreference>>;
}

/** Project overlays are partial, but may only narrow safety or select already
 * registered packs/capabilities. Validation and precedence live in config.ts. */
export interface ProjectOperatorOverlay {
  readonly schemaVersion: '1.0';
  readonly workflow?: string;
  readonly policyPacks?: readonly string[];
  readonly budgetProfile?: BudgetProfile;
  readonly maxConcurrency?: number;
  readonly features?: Partial<OperatorFeatureFlags>;
  readonly rules?: Partial<OperatorRules>;
  readonly capabilityAssignments?: Readonly<Record<string, CapabilityPreference>>;
}

export type ProjectTrustStatus = 'ABSENT' | 'TRUSTED' | 'UNTRUSTED' | 'INVALID';

export interface ProjectOverlayResolution {
  readonly status: ProjectTrustStatus;
  readonly projectRoot: string;
  readonly policyPath?: string;
  readonly trustRecordPath?: string;
  readonly expectedHash?: string;
  readonly actualHash?: string;
  readonly overlay?: ProjectOperatorOverlay;
  readonly reason?: string;
}

export interface ResolvedOperatorConfig {
  readonly profile: OperatorProfile;
  readonly globalConfigPath: string;
  readonly projectOverlay: ProjectOverlayResolution;
  readonly policyRefs: readonly PolicyRef[];
}

export interface PolicyPackRules {
  readonly requireIndependentReview?: boolean;
  readonly requireAdversarialReview?: boolean;
  readonly requireScopeFreeze?: boolean;
  readonly requireHumanFinalApproval?: boolean;
  readonly requireExecutionApprovalForMutation?: boolean;
  readonly maximumMutationClass?: MutationClass;
  readonly maxReviewRounds?: number;
}

export interface PolicyPack {
  readonly schemaVersion: '1.0';
  readonly id: string;
  readonly version: number;
  readonly description: string;
  readonly incompatibleWith: readonly string[];
  readonly appliesTo: readonly TaskFamily[];
  readonly rules: PolicyPackRules;
}

export interface ClassificationProposal {
  readonly requestClassification: TaskFamily;
  readonly riskClassification: RiskLevel;
  readonly confidence: Confidence;
  readonly abstentionReason?: string;
  readonly decomposable: boolean;
  readonly semanticCapabilities: readonly string[];
  readonly requestedExecutionShape?: 'DIRECT' | 'SINGLE' | 'PARALLEL' | 'PIPELINE' | 'COUNCIL';
  readonly requestedBudgetProfile?: BudgetProfile;
  readonly rationale: string;
}

export interface OperatorClassifier {
  classify(request: string): ClassificationProposal | Promise<ClassificationProposal>;
}

export interface ResolvedPolicy {
  readonly config: ResolvedOperatorConfig;
  readonly packs: readonly PolicyPack[];
  readonly effectiveRules: OperatorRules;
  readonly budgetProfile: BudgetProfile;
  readonly maxConcurrency: number;
  readonly requiredGates: readonly GateDecisionType[];
  readonly policyRefs: readonly PolicyRef[];
  readonly decisions: readonly PolicyDecision[];
}

export interface CapabilityRequirement {
  readonly role: string;
  readonly capability: string;
  readonly executionShape: 'SINGLE' | 'PARALLEL' | 'PIPELINE';
  readonly mutationClass: MutationClass;
  readonly independentFromRoles: readonly string[];
}

export interface CapabilitySelection {
  readonly requirement: CapabilityRequirement;
  readonly selected: CapabilityRecord;
  readonly provider: string;
  readonly fallbackFrom?: string;
  readonly reasonCode: string;
}

export interface CapabilityRegistry {
  readonly records: readonly CapabilityRecord[];
  select(requirement: CapabilityRequirement, policy: ResolvedPolicy): CapabilitySelection;
}

export interface WorkflowNodeContract {
  readonly contextPolicy: 'shared' | 'isolated' | 'summary-only' | 'artifact-only' | 'evidence-only';
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
  readonly requiredCapability: string;
}

export interface RegisteredWorkflowTemplate {
  readonly template: WorkflowTemplate;
  readonly nodeContracts: Readonly<Record<string, WorkflowNodeContract>>;
}

export interface CompiledCapabilitySummary {
  readonly nodeId: string;
  readonly role: string;
  readonly capabilityId: string;
  readonly provider: string;
  readonly tools: readonly string[];
  readonly mutationClass: MutationClass;
}

export interface CompiledWorkflow {
  readonly classification: ClassificationProposal;
  readonly disclosureDecision: RuntimeDisclosureDecision;
  readonly decisionTrace: DecisionTrace;
  readonly capabilitySummaries: readonly CompiledCapabilitySummary[];
  readonly policy: ResolvedPolicy;
  readonly template: WorkflowTemplate;
  readonly routeDecision: RouteDecision;
  readonly executionGraph: ExecutionGraph;
  readonly initialGate: HumanGate | null;
}

export type CompilationFailureCode =
  | 'CLASSIFICATION_INVALID'
  | 'DISCLOSURE_BLOCKED'
  | 'CONFIG_INVALID'
  | 'PROJECT_POLICY_UNTRUSTED'
  | 'POLICY_CONFLICT'
  | 'BUDGET_EXCEEDED'
  | 'CAPABILITY_UNAVAILABLE'
  | 'GRAPH_INVALID'
  | 'FEATURE_DISABLED';

export type CompilationResult =
  | { readonly ok: true; readonly compiled: CompiledWorkflow }
  | {
      readonly ok: false;
      readonly code: CompilationFailureCode;
      readonly message: string;
      readonly policyRefs: readonly PolicyRef[];
    };

export interface WorkflowCompilerContext {
  readonly projectRoot: string;
  readonly operatorSessionId: string;
  readonly graphId: string;
  readonly gateId: string;
  readonly now: string;
  /** Set only by explicit fleet invocation (e.g. a leading "--fleet" token); never by classification. */
  readonly fleetRoute?: true;
  /** Explicit user-selected task family. This bypasses inference only. */
  readonly familyOverride?: Exclude<TaskFamily, 'DIRECT'>;
  /** Set by the runtime when a promoted, digest-verified intelligence
   * candidate enables semantic-primary routing. Disclosure still gates the
   * model call and any semantic failure fails compilation closed. */
  readonly semanticPrimary?: true;
  /** Set by shadow evaluation / policy simulation so nested compilations
   * never trigger a second semantic model call. */
  readonly disableSemanticPrimary?: true;
}

export interface OperatorWorkflowCompiler {
  compile(request: string, context: WorkflowCompilerContext): Promise<CompilationResult>;
}

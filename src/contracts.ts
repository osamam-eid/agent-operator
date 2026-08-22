/**
 * Agent Operator — Stage 1 domain contracts.
 *
 * Pure TypeScript type declarations for the 12 approved Stage 1 contracts and
 * their supporting nested data, per the approved plan
 * (skill-coach-agent-operator-plan-final-2026-08-13.md, sections 4, 6, 7, 8,
 * 9, 10, 11, 14, 18). This file declares shapes only: no I/O, no dispatch,
 * no persistence, no provider calls.
 *
 * None of these types carry raw chain-of-thought / hidden-reasoning fields.
 * Only decisions, evidence, artifacts, structured findings, and concise
 * human-facing summaries cross node boundaries, per plan section 11.
 */

// ---------------------------------------------------------------------------
// Shared enums / unions
// ---------------------------------------------------------------------------

/** V1 task families (plan section 6). */
export type TaskFamily =
  | 'DIRECT'
  | 'RESEARCH'
  | 'PLAN'
  | 'IMPLEMENT'
  | 'REVIEW'
  | 'UI'
  | 'QA'
  | 'SECURITY'
  | 'OPERATIONS';

/** V1 execution shapes (plan section 6). */
export type ExecutionShape =
  | 'DIRECT'
  | 'SINGLE'
  | 'PARALLEL'
  | 'PIPELINE'
  | 'COUNCIL'
  | 'EXTERNAL';

/** Confidence and abstention levels (plan section 6). */
export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

/** Risk classification carried by a RouteDecision. */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/** Budget profiles (plan section 10). */
export type BudgetProfile = 'CHEAP' | 'BALANCED' | 'QUALITY' | 'CRITICAL';

/** Operator session states (plan section 3). */
export type SessionState =
  | 'IDLE'
  | 'CLASSIFYING'
  | 'PLANNING'
  | 'AWAITING_HUMAN'
  | 'READY'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'BLOCKED'
  | 'NEEDS_REPLAN'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

/** Execution graph node states (plan section 3). */
export type NodeState =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'BLOCKED'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'UNKNOWN';

/** Typed stop and disposition reason codes (plan section 3). */
export type StopReasonCode =
  | 'BLOCKED_HUMAN_DECISION'
  | 'BLOCKED_REQUIRED_CONTEXT'
  | 'BLOCKED_CAPABILITY'
  | 'BLOCKED_POLICY'
  | 'BLOCKED_SECURITY'
  | 'BLOCKED_TEST_FAILURE'
  | 'BLOCKED_REVIEW_FAILURE'
  | 'BLOCKED_PROVIDER_UNAVAILABLE'
  | 'NEEDS_REPLAN'
  | 'PLAN_APPROVAL_REQUIRED'
  | 'EXECUTION_APPROVAL_REQUIRED'
  | 'FUNDAMENTAL_BLOCKER'
  | 'NON_BLOCKING_FINDING'
  | 'DEFERRED_FINDING';

/**
 * Structured stop/disposition detail. Populated on an OperatorSession
 * whenever `currentState` is `BLOCKED` or `NEEDS_REPLAN` (plan section 3:
 * "Every stop includes: reason, affected node, evidence, retry eligibility,
 * required decision or missing prerequisite, and next allowed action.").
 */
export interface StopDetail {
  readonly reason: StopReasonCode;
  readonly affectedNodeId: string;
  readonly evidenceRefs: readonly string[];
  readonly retryEligible: boolean;
  readonly requiredDecisionOrPrerequisite: string;
  readonly nextAllowedActions: readonly string[];
}

/** Context isolation policy for a node's inputs (plan section 11). */
export type ContextPolicy =
  | 'shared'
  | 'isolated'
  | 'summary-only'
  | 'artifact-only'
  | 'evidence-only';

/** Declared/instantiated mutation class for a node (plan section 4). */
export type MutationClass = 'READ_ONLY' | 'LOCAL' | 'EXTERNAL' | 'DESTRUCTIVE';

/** Adapter-declared retry policy for a mutation node (plan section 4). */
export type RetryPolicy =
  | 'AUTOMATIC'
  | 'RECONCILE_FIRST'
  | 'NEVER_AUTOMATIC'
  | 'REQUIRES_HUMAN_GATE';

/** Concrete mutation metadata attached to an instantiated graph node. */
export interface MutationMetadata {
  readonly mutationId: string;
  readonly mutationClass: MutationClass;
  readonly retryPolicy: RetryPolicy;
}

/** Human-gate decision categories (plan sections 9, 18). */
export type GateDecisionType =
  | 'PLAN_APPROVAL'
  | 'EXECUTION_APPROVAL'
  | 'RESULT_APPROVAL'
  | 'PUBLICATION_APPROVAL'
  | 'APPROVE_PROGRESSION'
  | 'CUSTOM_DECISION';

/** Lifecycle status of a HumanGate. */
export type GateStatus = 'OPEN' | 'APPROVED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED';

/** A versioned policy reference, e.g. `masar@3:review.maxRounds`. */
export type PolicyRef = string;

// ---------------------------------------------------------------------------
// 1. CapabilityRecord.v1 (plan section 10)
// ---------------------------------------------------------------------------

export type CapabilityKind = 'omp-role' | 'external-cli';
export type Mutability = 'READ_ONLY' | 'MUTATING';
export type ModelTier = 'LOW' | 'MEDIUM' | 'HIGH';
export type CostClass = 'LOW' | 'MEDIUM' | 'HIGH';
export type LatencyClass = 'LOW' | 'MEDIUM' | 'HIGH';
export type HealthStatus = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'UNKNOWN';

export interface CapabilityRecord {
  readonly id: string;
  readonly kind: CapabilityKind;
  readonly capabilities: readonly string[];
  readonly mutability: Mutability;
  readonly modelTiers: readonly ModelTier[];
  readonly tools: readonly string[];
  readonly spawns: boolean;
  readonly supports: readonly ExecutionShape[];
  /** Required and non-empty when `kind === 'external-cli'`. */
  readonly binary?: string;
  /** Required 64-hex SHA-256 pin of the external-cli binary; absent for omp-role. */
  readonly sha256?: string;
  readonly versionProbe?: string;
  readonly authProbe?: string;
  readonly modelProbe?: string;
  readonly costClass: CostClass;
  readonly latencyClass: LatencyClass;
  readonly concurrency: number;
  readonly health: HealthStatus;
  readonly source: string;
}

// ---------------------------------------------------------------------------
// 2. RouteDecision.v1 (plan section 6)
// ---------------------------------------------------------------------------

export interface RoleAssignment {
  readonly role: string;
  readonly capabilityId: string;
  readonly provider: string;
}

export interface RejectedAlternative {
  readonly option: string;
  readonly reasonCode: string;
  readonly details?: string;
}

export interface BudgetEffect {
  readonly profile: BudgetProfile;
  readonly estimatedTokens?: number;
  readonly estimatedCost?: number;
  readonly estimatedDurationMs?: number;
}

export interface FallbackDecision {
  readonly role: string;
  readonly from: string;
  readonly to: string;
  readonly reasonCode: string;
}

export interface Abstention {
  readonly abstained: boolean;
  /** Required and non-empty when `abstained === true`. */
  readonly reason?: string;
}

export interface RouteDecision {
  readonly requestClassification: TaskFamily;
  readonly riskClassification: RiskLevel;
  readonly selectedWorkflow: string;
  readonly selectedRolesProviders: readonly RoleAssignment[];
  readonly rejectedAlternatives: readonly RejectedAlternative[];
  readonly requiredGates: readonly GateDecisionType[];
  readonly budgetEffect: BudgetEffect;
  readonly fallbackDecisions: readonly FallbackDecision[];
  readonly reasonCodes: readonly string[];
  readonly policyRefs: readonly PolicyRef[];
  readonly confidence: Confidence;
  readonly abstention: Abstention;
}

// ---------------------------------------------------------------------------
// 3. WorkflowTemplate.v1 (plan section 7)
// ---------------------------------------------------------------------------

export interface WorkflowTemplateNode {
  readonly nodeId: string;
  /** Capability role label, e.g. "planner", "independent-reviewer". */
  readonly role: string;
  readonly mandatory: boolean;
  readonly dependsOn: readonly string[];
  readonly groupId?: string;
  readonly synthesisOwner?: boolean;
  readonly mutationClass?: MutationClass;
}

export interface WorkflowTemplate {
  /** e.g. "plan.v1" */
  readonly templateId: string;
  readonly version: number;
  readonly taskFamilies: readonly TaskFamily[];
  readonly executionShape: ExecutionShape;
  readonly description: string;
  readonly nodes: readonly WorkflowTemplateNode[];
  readonly requiredGateTypes: readonly GateDecisionType[];
}

// ---------------------------------------------------------------------------
// 4. ExecutionGraph.v1 (plan sections 4, 7)
// ---------------------------------------------------------------------------

export interface ExecutionGraphNode {
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly role: string;
  /** Stage-7 v2-only required capability identity; omitted for frozen v1 graphs. */
  readonly requiredCapability?: string;
  readonly mandatory: boolean;
  readonly dependsOn: readonly string[];
  readonly groupId?: string;
  readonly synthesisOwner?: boolean;
  /** Required and distinct from `nodeId` whenever `mutation` is present. */
  readonly verificationOwnerNodeId?: string;
  readonly mutation?: MutationMetadata;
  readonly contextPolicy: ContextPolicy;
  readonly consumes: readonly string[];
  readonly produces: readonly string[];
}

export interface ExecutionGraph {
  readonly graphId: string;
  readonly graphRevision: number;
  readonly workflowTemplateId: string;
  readonly executionShape: ExecutionShape;
  readonly nodes: readonly ExecutionGraphNode[];
  readonly graphHash: string;
}

// ---------------------------------------------------------------------------
// 5. AgentResult.v1 (plan sections 4, 11)
// ---------------------------------------------------------------------------

export type AgentResultStatus = 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'CANCELLED' | 'UNKNOWN';

export interface AgentResult {
  readonly resultId: string;
  readonly operatorSessionId: string;
  readonly nodeId: string;
  readonly capabilityId: string;
  readonly status: AgentResultStatus;
  /** Concise human-facing outcome summary. Never a reasoning trace. */
  readonly summary: string;
  readonly producedArtifactRefs: readonly string[];
  readonly consumedArtifactRefs: readonly string[];
  readonly findingIds: readonly string[];
  readonly evidenceIds: readonly string[];
  /** The node's own recommendation for its findings; distinct from the
   * operator-level `FinalOperatorResult.decision.recommendation`. */
  readonly recommendedDisposition?: FindingEffectiveDisposition;
  readonly providerSessionId?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly policyRefs: readonly PolicyRef[];
}

// ---------------------------------------------------------------------------
// 6. OperatorSession.v1 (plan section 4)
// ---------------------------------------------------------------------------

export type VerificationOutcome = 'NOT_APPLICABLE' | 'NOT_STARTED' | 'IN_PROGRESS' | 'PASSED' | 'FAILED';

export interface VerificationState {
  readonly behavioralVerification: VerificationOutcome;
  readonly conformanceVerification: VerificationOutcome;
  readonly independentReview: VerificationOutcome;
  readonly adversarialReview: VerificationOutcome;
}

export interface BudgetState {
  readonly profile: BudgetProfile;
  readonly tokensUsed: number;
  readonly costUsed: number;
  readonly tokensLimit?: number;
  readonly costLimit?: number;
}

export interface JournalEntry {
  readonly timestamp: string;
  /** Short uppercase-snake event token, e.g. "CLASSIFIED", "GATE_APPROVED". */
  readonly eventType: string;
  readonly operatorSessionId: string;
  readonly nodeId?: string;
  readonly gateId?: string;
  readonly reasonCode?: string;
  readonly artifactRefs?: readonly string[];
  readonly evidenceRefs?: readonly string[];
  readonly message: string;
}

export interface HumanDecisionRecord {
  readonly gateId: string;
  readonly decisionType: GateDecisionType;
  readonly optionSelected: string;
  /** Deterministic disposition of the decision itself, distinct from
   * `optionSelected` (the human-facing option label). A successful terminal
   * completion requires exactly one APPROVED record per
   * `RouteDecision.requiredGates` entry (plan sections 9, 14, 18: required
   * gates cannot be modeled as bypassed). */
  readonly outcome: 'APPROVED' | 'REJECTED';
  readonly decidedAt: string;
  /** Must equal the session's `executionGraph.graphHash` at decision time
   * (plan section 9: approval binds exactly to session/gate/graphHash). */
  readonly graphHashAtDecision: string;
  readonly artifactHashesAtDecision: readonly string[];
}

export interface OperatorSession {
  readonly operatorSessionId: string;
  readonly schemaVersion: string;
  readonly originalRequest: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly currentState: SessionState;
  readonly currentPhase: string;
  /** The `HumanGate.gateId` currently awaiting a decision. Required exactly
   * when `currentState` is `AWAITING_HUMAN`; must be absent otherwise. */
  readonly openGateId?: string;
  readonly routeDecision: RouteDecision | null;
  readonly workflowTemplateId: string | null;
  readonly executionGraph: ExecutionGraph | null;
  readonly nodeStates: Readonly<Record<string, NodeState>>;
  readonly providerSessionIds: Readonly<Record<string, string>>;
  readonly humanDecisions: readonly HumanDecisionRecord[];
  readonly artifacts: readonly ArtifactManifest[];
  readonly evidence: readonly Evidence[];
  readonly verificationState: VerificationState;
  readonly budgetState: BudgetState;
  readonly journal: readonly JournalEntry[];
  readonly terminalResult: FinalOperatorResult | null;
  /** Required when `currentState` is `BLOCKED` or `NEEDS_REPLAN`; must be
   * absent otherwise. */
  readonly stopDetail?: StopDetail;
}

// ---------------------------------------------------------------------------
// 7. HumanGate.v1 (plan section 9)
// ---------------------------------------------------------------------------

export interface HumanGate {
  readonly gateId: string;
  readonly operatorSessionId: string;
  readonly reason: string;
  readonly decisionType: GateDecisionType;
  readonly requestedDecision: string;
  readonly availableOptions: readonly string[];
  readonly recommendedOption: string;
  readonly evidenceRefs: readonly string[];
  /** Keyed exactly by the members of `availableOptions`; each option must
   * carry an explicit consequence description. */
  readonly consequences: Readonly<Record<string, string>>;
  readonly resumeNode: string;
  readonly graphRevision: number;
  readonly graphHash: string;
  readonly artifactRefs: readonly string[];
  /** Index-aligned with `artifactRefs`. */
  readonly artifactHashes: readonly string[];
  readonly policyRefs: readonly PolicyRef[];
  readonly createdAt: string;
  readonly expiresAt?: string;
  readonly status: GateStatus;
}

// ---------------------------------------------------------------------------
// 8. Evidence.v1 (plan section 11)
// ---------------------------------------------------------------------------

export type EvidenceType =
  | 'TEST_RESULT'
  | 'COMMAND_OUTPUT'
  | 'FILE_DIFF'
  | 'SCREENSHOT'
  | 'LOG_EXCERPT'
  | 'EXTERNAL_SOURCE'
  | 'HUMAN_STATEMENT'
  | 'OTHER';

export type EvidenceVerificationStatus = 'UNVERIFIED' | 'VERIFIED' | 'CONTRADICTED' | 'INCONCLUSIVE';

export interface Evidence {
  readonly evidenceId: string;
  readonly type: EvidenceType;
  readonly source: string;
  readonly artifact?: string;
  readonly claim: string;
  readonly timestamp: string;
  readonly producer: string;
  readonly verificationStatus: EvidenceVerificationStatus;
  /** Required and non-empty whenever `verificationStatus !== 'UNVERIFIED'`;
   * must be absent when `verificationStatus === 'UNVERIFIED'`. */
  readonly verifiedBy?: string;
}

// ---------------------------------------------------------------------------
// 9. ArtifactManifest.v1 (plan section 11)
// ---------------------------------------------------------------------------

export interface ArtifactManifest {
  readonly artifactId: string;
  /** e.g. "implementation-plan.v1", "patch.v1", "test-evidence.v1". */
  readonly artifactType: string;
  readonly producedByNodeId: string;
  readonly operatorSessionId: string;
  readonly hash: string;
  readonly location: string;
  readonly sizeBytes?: number;
  readonly createdAt: string;
  readonly contentSummary: string;
  readonly policyRefs: readonly PolicyRef[];
}

// ---------------------------------------------------------------------------
// 10. Finding.v1 (plan section 8)
// ---------------------------------------------------------------------------

export type FindingCategory =
  | 'SECURITY'
  | 'CORRECTNESS'
  | 'PERFORMANCE'
  | 'MAINTAINABILITY'
  | 'SCOPE'
  | 'POLICY'
  | 'PROCESS'
  | 'OTHER';

export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';

/** Reviewer-owned classification (plan section 8). */
export type FindingReportedClassification =
  | 'FUNDAMENTAL_BLOCKER'
  | 'BLOCKING'
  | 'NON_BLOCKING'
  | 'OBSERVATION';

/** Deterministic-policy-owned disposition (plan section 8). Distinct from
 * `reportedClassification`: the reviewer never sets this field's meaning. */
export type FindingEffectiveDisposition =
  | 'BLOCK'
  | 'CORRECT'
  | 'HUMAN_DECISION'
  | 'CONTINUE'
  | 'DEFER'
  | 'RECORD';

export type FindingStatus = 'OPEN' | 'RESOLVED' | 'DEFERRED' | 'WONT_FIX';

export interface Finding {
  readonly findingId: string;
  readonly producer: string;
  readonly category: FindingCategory;
  readonly severity: Severity;
  readonly reportedClassification: FindingReportedClassification;
  readonly effectiveDisposition: FindingEffectiveDisposition;
  readonly summary: string;
  readonly impact: string;
  readonly evidenceRefs: readonly string[];
  readonly recommendedAction: string;
  readonly blocksProgression: boolean;
  readonly introducedAtRound: number;
  readonly status: FindingStatus;
  readonly policyRefs: readonly PolicyRef[];
  /** Links the auditable `PolicyDecision.v1` that produced
   * `effectiveDisposition`. */
  readonly policyDecisionId: string;
}

// ---------------------------------------------------------------------------
// 11. PolicyDecision.v1 (plan section 8)
// ---------------------------------------------------------------------------

export type PolicySubjectType = 'finding' | 'route' | 'node' | 'gate' | 'workflow';

export interface PolicyDecision {
  readonly decisionId: string;
  readonly subjectType: PolicySubjectType;
  readonly subjectId: string;
  readonly decision: FindingEffectiveDisposition;
  /** Who produced this decision: deterministic policy evaluation, or a
   * human overriding policy at an open gate. */
  readonly decisionSource: 'POLICY' | 'HUMAN_OVERRIDE';
  /** Required and non-empty when `decisionSource === 'HUMAN_OVERRIDE'`;
   * must be absent when `decisionSource === 'POLICY'`. */
  readonly overrideGateId?: string;
  readonly reasonCodes: readonly string[];
  readonly policyRefs: readonly PolicyRef[];
  readonly inputs: Readonly<Record<string, string>>;
  readonly timestamp: string;
}

// ---------------------------------------------------------------------------
// 12. FinalOperatorResult.v1 (plan section 14)
// ---------------------------------------------------------------------------

export type ExecutionStatus =
  | 'NOT_STARTED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'PARTIAL'
  | 'FAILED'
  | 'CANCELLED'
  | 'UNKNOWN';

export type WorkflowStatus =
  | 'COMPLETED'
  | 'COMPLETED_WITH_DEFERRED_ITEMS'
  | 'HUMAN_DECISION_REQUIRED'
  | 'BLOCKED'
  | 'NEEDS_REPLAN'
  | 'FAILED'
  | 'CANCELLED'
  | 'DECLINED';

export type Recommendation = 'GO' | 'GO_WITH_DEFERRED_ITEMS' | 'HOLD' | 'REPLAN' | 'RETRY' | 'ESCALATE' | 'STOP';

export type ScopeStatus = 'IN_SCOPE' | 'IN_SCOPE_WITH_APPROVED_DEVIATION' | 'SCOPE_DRIFT_DETECTED';

export type RequirementCoverageStatus = 'SATISFIED' | 'UNSATISFIED' | 'DEFERRED';

export interface RequirementCoverageItem {
  readonly requirementId: string;
  readonly description: string;
  readonly status: RequirementCoverageStatus;
}

export interface RequirementCoverage {
  readonly items: readonly RequirementCoverageItem[];
  readonly requiredCount: number;
  readonly satisfiedCount: number;
  readonly unsatisfiedCount: number;
  readonly deferredCount: number;
}

export interface ScopeDeviation {
  readonly deviationId: string;
  readonly description: string;
  readonly approved: boolean;
  readonly policyRefs: readonly PolicyRef[];
}

export interface FinalOperatorResultIdentity {
  readonly operatorSessionId: string;
  readonly workflowTemplate: string;
  readonly graphRevision: number;
}

export interface FinalOperatorResultStatus {
  readonly executionStatus: ExecutionStatus;
  readonly workflowStatus: WorkflowStatus;
}

export interface FinalOperatorResultDecision {
  readonly recommendation: Recommendation;
  /** Mandatory. Must cite: conditions satisfied, conditions unsatisfied,
   * blockers considered, deferred findings considered, remaining risk, and
   * the policy rules producing the recommendation (plan section 14). */
  readonly recommendationRationale: string;
  readonly confidence: Confidence;
}

export interface FinalOperatorResultHumanDecision {
  readonly required: boolean;
  readonly gateId?: string;
  readonly decisionType?: GateDecisionType;
  readonly options?: readonly string[];
  readonly recommendedOption?: string;
}

export interface FinalOperatorResultScope {
  readonly scopeStatus: ScopeStatus;
  readonly requirementCoverage: RequirementCoverage;
  readonly deviations: readonly ScopeDeviation[];
}

export interface FinalOperatorResultExecution {
  readonly workPerformed: readonly string[];
  readonly changesMade: readonly string[];
  /** Explicitly names omitted actions (commit, push, merge, Jira transition,
   * deployment, production mutation, publication, ...). */
  readonly actionsNotPerformed: readonly string[];
}

export interface FinalOperatorResultVerification {
  readonly behavioralVerification: VerificationOutcome;
  readonly conformanceVerification: VerificationOutcome;
  readonly independentReview: VerificationOutcome;
  readonly adversarialReview: VerificationOutcome;
}

export interface FinalOperatorResultFindings {
  readonly fundamentalBlockers: readonly string[];
  readonly blockingFindings: readonly string[];
  readonly nonBlockingFindings: readonly string[];
  readonly deferredFindings: readonly string[];
  readonly observations: readonly string[];
}

export interface FinalOperatorResultRisk {
  readonly remainingRisks: readonly string[];
}

export interface FinalOperatorResultEvidence {
  readonly evidenceRefs: readonly string[];
}

export interface FinalOperatorResultArtifacts {
  readonly artifactRefs: readonly string[];
}

export interface FinalOperatorResultPolicy {
  readonly policyRefs: readonly PolicyRef[];
}

export interface UsageStats {
  readonly providers: readonly string[];
  readonly models: readonly string[];
  readonly tokens: number | null;
  readonly cost: number | null;
  /** Milliseconds. */
  readonly duration: number;
}

export interface FinalOperatorResultNext {
  readonly allowedActions: readonly string[];
  /** At most one action; must be a member of `allowedActions` when present.
   * Permission (`allowedActions`) and recommendation are never conflated. */
  readonly recommendedAction?: string;
}

export interface FinalOperatorResult {
  readonly identity: FinalOperatorResultIdentity;
  readonly status: FinalOperatorResultStatus;
  readonly decision: FinalOperatorResultDecision;
  readonly humanDecision: FinalOperatorResultHumanDecision;
  readonly scope: FinalOperatorResultScope;
  readonly execution: FinalOperatorResultExecution;
  readonly verification: FinalOperatorResultVerification;
  readonly findings: FinalOperatorResultFindings;
  readonly risk: FinalOperatorResultRisk;
  readonly evidence: FinalOperatorResultEvidence;
  readonly artifacts: FinalOperatorResultArtifacts;
  readonly policy: FinalOperatorResultPolicy;
  readonly usage: UsageStats;
  readonly next: FinalOperatorResultNext;
}

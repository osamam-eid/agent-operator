/**
 * Agent Operator — Stage 1 deterministic contract validators: enumerated
 * value vocabulary.
 *
 * The closed literal-value sets (and the two finding-disposition lookup
 * tables derived from them) that back every `requireEnum()` call across the
 * domain validator modules. Kept separate from src/validation/primitives.ts
 * because, unlike the generic engine, every entry here is typed against a
 * specific contracts.ts union and is shared across more than one domain
 * module (for example GATE_DECISION_TYPES is used by core-contracts.ts,
 * session.ts, and results.ts).
 */

import type {
  AgentResultStatus,
  BudgetProfile,
  CapabilityKind,
  Confidence,
  ContextPolicy,
  CostClass,
  EvidenceType,
  EvidenceVerificationStatus,
  ExecutionShape,
  ExecutionStatus,
  FindingCategory,
  FindingEffectiveDisposition,
  FindingReportedClassification,
  FindingStatus,
  GateDecisionType,
  GateStatus,
  HealthStatus,
  LatencyClass,
  ModelTier,
  Mutability,
  MutationClass,
  NodeState,
  PolicySubjectType,
  Recommendation,
  RequirementCoverageStatus,
  RetryPolicy,
  RiskLevel,
  ScopeStatus,
  SessionState,
  Severity,
  StopReasonCode,
  TaskFamily,
  VerificationOutcome,
  WorkflowStatus,
} from '../contracts.js';

export const TASK_FAMILIES: readonly TaskFamily[] = [
  'DIRECT',
  'RESEARCH',
  'PLAN',
  'IMPLEMENT',
  'REVIEW',
  'UI',
  'QA',
  'SECURITY',
  'OPERATIONS',
];

export const EXECUTION_SHAPES: readonly ExecutionShape[] = ['DIRECT', 'SINGLE', 'PARALLEL', 'PIPELINE', 'COUNCIL', 'EXTERNAL'];

export const CONFIDENCE_LEVELS: readonly Confidence[] = ['HIGH', 'MEDIUM', 'LOW'];

export const RISK_LEVELS: readonly RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export const BUDGET_PROFILES: readonly BudgetProfile[] = ['CHEAP', 'BALANCED', 'QUALITY', 'CRITICAL'];

export const SESSION_STATES: readonly SessionState[] = [
  'IDLE',
  'CLASSIFYING',
  'PLANNING',
  'AWAITING_HUMAN',
  'READY',
  'EXECUTING',
  'VERIFYING',
  'BLOCKED',
  'NEEDS_REPLAN',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

/** Session states from which the session will never resume execution. */
export const TERMINAL_SESSION_STATES: readonly SessionState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

export const NODE_STATES: readonly NodeState[] = [
  'PENDING',
  'READY',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'SKIPPED',
  'CANCELLED',
  'UNKNOWN',
];

export const STOP_REASON_CODES: readonly StopReasonCode[] = [
  'BLOCKED_HUMAN_DECISION',
  'BLOCKED_REQUIRED_CONTEXT',
  'BLOCKED_CAPABILITY',
  'BLOCKED_POLICY',
  'BLOCKED_SECURITY',
  'BLOCKED_TEST_FAILURE',
  'BLOCKED_REVIEW_FAILURE',
  'BLOCKED_PROVIDER_UNAVAILABLE',
  'NEEDS_REPLAN',
  'PLAN_APPROVAL_REQUIRED',
  'EXECUTION_APPROVAL_REQUIRED',
  'FUNDAMENTAL_BLOCKER',
  'NON_BLOCKING_FINDING',
  'DEFERRED_FINDING',
];

export const CONTEXT_POLICIES: readonly ContextPolicy[] = ['shared', 'isolated', 'summary-only', 'artifact-only', 'evidence-only'];

export const MUTATION_CLASSES: readonly MutationClass[] = ['READ_ONLY', 'LOCAL', 'EXTERNAL', 'DESTRUCTIVE'];

export const RETRY_POLICIES: readonly RetryPolicy[] = ['AUTOMATIC', 'RECONCILE_FIRST', 'NEVER_AUTOMATIC', 'REQUIRES_HUMAN_GATE'];

export const GATE_DECISION_TYPES: readonly GateDecisionType[] = [
  'PLAN_APPROVAL',
  'EXECUTION_APPROVAL',
  'RESULT_APPROVAL',
  'PUBLICATION_APPROVAL',
  'APPROVE_PROGRESSION',
  'CUSTOM_DECISION',
];

export const GATE_STATUSES: readonly GateStatus[] = ['OPEN', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUPERSEDED'];

/** Outcome of a recorded human gate decision (distinct from the human-facing
 * `optionSelected` label). */
export const HUMAN_DECISION_OUTCOMES = ['APPROVED', 'REJECTED'] as const;

export const CAPABILITY_KINDS: readonly CapabilityKind[] = ['omp-role', 'external-cli'];
export const MUTABILITY_VALUES: readonly Mutability[] = ['READ_ONLY', 'MUTATING'];
export const MODEL_TIERS: readonly ModelTier[] = ['LOW', 'MEDIUM', 'HIGH'];
export const COST_CLASSES: readonly CostClass[] = ['LOW', 'MEDIUM', 'HIGH'];
export const LATENCY_CLASSES: readonly LatencyClass[] = ['LOW', 'MEDIUM', 'HIGH'];
export const HEALTH_STATUSES: readonly HealthStatus[] = ['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN'];

export const AGENT_RESULT_STATUSES: readonly AgentResultStatus[] = ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'UNKNOWN'];

export const VERIFICATION_OUTCOMES: readonly VerificationOutcome[] = ['NOT_APPLICABLE', 'NOT_STARTED', 'IN_PROGRESS', 'PASSED', 'FAILED'];

export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  'TEST_RESULT',
  'COMMAND_OUTPUT',
  'FILE_DIFF',
  'SCREENSHOT',
  'LOG_EXCERPT',
  'EXTERNAL_SOURCE',
  'HUMAN_STATEMENT',
  'OTHER',
];

export const EVIDENCE_VERIFICATION_STATUSES: readonly EvidenceVerificationStatus[] = ['UNVERIFIED', 'VERIFIED', 'CONTRADICTED', 'INCONCLUSIVE'];

export const FINDING_CATEGORIES: readonly FindingCategory[] = [
  'SECURITY',
  'CORRECTNESS',
  'PERFORMANCE',
  'MAINTAINABILITY',
  'SCOPE',
  'POLICY',
  'PROCESS',
  'OTHER',
];

export const SEVERITIES: readonly Severity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'];

export const FINDING_REPORTED_CLASSIFICATIONS: readonly FindingReportedClassification[] = [
  'FUNDAMENTAL_BLOCKER',
  'BLOCKING',
  'NON_BLOCKING',
  'OBSERVATION',
];

export const FINDING_EFFECTIVE_DISPOSITIONS: readonly FindingEffectiveDisposition[] = ['BLOCK', 'CORRECT', 'HUMAN_DECISION', 'CONTINUE', 'DEFER', 'RECORD'];

export const FINDING_STATUSES: readonly FindingStatus[] = ['OPEN', 'RESOLVED', 'DEFERRED', 'WONT_FIX'];

export const POLICY_SUBJECT_TYPES: readonly PolicySubjectType[] = ['finding', 'route', 'node', 'gate', 'workflow'];

/** Who produced a PolicyDecision: deterministic policy evaluation, or a
 * human overriding policy at an open gate. */
export const POLICY_DECISION_SOURCES = ['POLICY', 'HUMAN_OVERRIDE'] as const;

export const EXECUTION_STATUSES: readonly ExecutionStatus[] = ['NOT_STARTED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN'];

export const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
  'COMPLETED',
  'COMPLETED_WITH_DEFERRED_ITEMS',
  'HUMAN_DECISION_REQUIRED',
  'BLOCKED',
  'NEEDS_REPLAN',
  'FAILED',
  'CANCELLED',
  'DECLINED',
];

export const RECOMMENDATIONS: readonly Recommendation[] = ['GO', 'GO_WITH_DEFERRED_ITEMS', 'HOLD', 'REPLAN', 'RETRY', 'ESCALATE', 'STOP'];

export const SCOPE_STATUSES: readonly ScopeStatus[] = ['IN_SCOPE', 'IN_SCOPE_WITH_APPROVED_DEVIATION', 'SCOPE_DRIFT_DETECTED'];

export const REQUIREMENT_COVERAGE_STATUSES: readonly RequirementCoverageStatus[] = ['SATISFIED', 'UNSATISFIED', 'DEFERRED'];

/** Deterministic disposition table (plan section 8, "Findings and
 * deterministic disposition"). Only the classifications with a single
 * possible effective disposition are enforced as an exact match; the two
 * context-dependent rows are enforced as membership in the allowed set. */
export const ALLOWED_DISPOSITIONS_BY_CLASSIFICATION: Readonly<Record<FindingReportedClassification, readonly FindingEffectiveDisposition[]>> = {
  FUNDAMENTAL_BLOCKER: ['BLOCK'],
  BLOCKING: ['CORRECT', 'HUMAN_DECISION'],
  NON_BLOCKING: ['CONTINUE', 'DEFER'],
  OBSERVATION: ['RECORD'],
};

/** Whether a given effective disposition implies the finding currently
 * blocks progression to the next mandatory step. */
export const DISPOSITIONS_THAT_BLOCK_PROGRESSION: ReadonlySet<FindingEffectiveDisposition> = new Set(['BLOCK', 'HUMAN_DECISION', 'CORRECT']);

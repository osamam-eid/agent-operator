/** Stage-10 evaluator domain contracts. Offline evaluation of a frozen
 * baseline against an immutable candidate under frozen scoring. The active
 * runtime never imports this module's implementations. */

/** Disclosure vocabulary. Only EXTERNAL_REPLAY_APPROVED cases may reach a
 * networked provider seam, and only after an automated secret scan passed at
 * BOTH curation-upgrade and replay-dispatch time. */
export type EvalDisclosure = 'LOCAL_ONLY' | 'REDACTED_INTERNAL' | 'EXTERNAL_REPLAY_APPROVED';

declare const __brandTrain: unique symbol;
declare const __brandHeldOut: unique symbol;
/** Case ids typed for generator/comparator separation: candidate generation
 * accepts only train ids; held-out ids are structurally unrepresentable
 * there. */
export type TrainCaseId = string & { readonly [__brandTrain]: true };
export type HeldOutCaseId = string & { readonly [__brandHeldOut]: true };

export interface EvalCaseContent {
  readonly caseId: string;
  readonly sourceSessionId: string;
  readonly originalRequest: string;
  readonly observed: {
    readonly requestClassification: string;
    readonly riskClassification: string;
    readonly selectedWorkflow: string;
    readonly requiredGates: readonly string[];
    readonly nodeSummaries: readonly { readonly nodeId: string; readonly summary: string }[];
    readonly humanOverrideSignals: readonly string[];
  };
  readonly expected?: {
    readonly requestClassification?: string;
    readonly selectedWorkflow?: string;
    readonly notes?: string;
  };
}

export interface LocalOnlyEvalCase extends EvalCaseContent {
  readonly disclosure: 'LOCAL_ONLY';
}
export interface RedactedInternalEvalCase extends EvalCaseContent {
  readonly disclosure: 'REDACTED_INTERNAL';
}
export interface ExternalReplayApprovedCase extends EvalCaseContent {
  readonly disclosure: 'EXTERNAL_REPLAY_APPROVED';
  readonly approvedBy: string;
  readonly approvedAt: string;
}
export type EvalCase = LocalOnlyEvalCase | RedactedInternalEvalCase | ExternalReplayApprovedCase;

export interface OperatorEvalCorpus {
  readonly corpusId: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly cases: readonly { readonly caseId: string; readonly disclosure: EvalDisclosure; readonly partition: 'TRAIN' | 'HELD_OUT' }[];
  readonly trainManifestHash: string;
  readonly heldOutManifestHash: string;
}

/** All fields required — fail closed when any bounding field is missing. */
export interface EvalBudget {
  readonly maxCases: number;
  readonly maxReplaysPerCase: number;
  readonly maxProviderTier: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly maxTokensPerCase: number;
  readonly maxTotalCostUsd: number;
  readonly maxWallClockMs: number;
  readonly maxConcurrency: number;
}

export interface MutationAllowlist {
  readonly autoProposablePaths: readonly string[];
  readonly prohibitedComponents: readonly ('hardInvariants' | 'permissionModel' | 'humanApprovalRules' | 'mutationClasses' | 'providerTrustBoundaries' | 'disclosureRules' | 'publicationAuthority' | 'promotionAuthority' | 'evalTrustBoundaries')[];
}

export type ComponentStatus = 'UNCHANGED' | 'CHANGED' | 'PROHIBITED';

export interface OperatorCandidateManifest {
  readonly candidateId: string;
  readonly baseVersion: 'stage9-sealed';
  readonly baseDigest: string;
  readonly components: readonly { readonly component: string; readonly status: ComponentStatus }[];
  readonly createdAt: string;
}

export interface ScoringSpec {
  readonly specHash: string;
  readonly hardGates: readonly string[];
  readonly softWeights: Readonly<Record<string, number>>;
  readonly tolerance: number;
}

export interface CaseScore {
  readonly caseId: string;
  readonly hardGateFailures: readonly string[];
  readonly softScores: Readonly<Record<string, number>>;
}

export interface OperatorEvalRun {
  readonly runId: string;
  readonly corpusId: string;
  readonly corpusRevision: number;
  readonly baselineDigest: string;
  readonly featureSetHash: string;
  readonly budget: EvalBudget;
  readonly startedAt: string;
  readonly perCase: readonly { readonly caseId: string; readonly replays: number; readonly status: 'DONE' | 'SKIPPED_BUDGET' | 'ABORTED_SECRET_DETECTED' }[];
  readonly budgetExhausted: boolean;
}

export interface OperatorComparison {
  readonly runId: string;
  readonly verdict: 'PROMOTE_RECOMMENDED' | 'REJECT' | 'HOLD' | 'INSUFFICIENT_EVIDENCE';
  readonly baselineTotal: number;
  readonly candidateTotal: number;
  readonly regressions: readonly string[];
  readonly hardFailures: readonly string[];
  readonly scoredCases: number;
}

export interface OperatorPromotionDecision {
  readonly comparisonRunId: string;
  readonly recommendation: OperatorComparison['verdict'];
  readonly promotedBySystem: false;
  readonly evidencePackagePath: string;
}

/** Version of the deterministic scorer that produced a trusted scores
 * envelope. A score made under another scorer or policy version never
 * silently compares. */
export const SCORER_VERSION = 'deterministic-structural-v1';

export interface BaselineScoresEnvelope {
  readonly kind: 'BASELINE';
  readonly evalRunId: string;
  readonly corpusId: string;
  readonly corpusRevision: number;
  readonly trainManifestHash: string;
  readonly heldOutManifestHash: string;
  readonly baselineDigest: string;
  readonly specHash: string;
  readonly scorerVersion: typeof SCORER_VERSION;
  readonly budgetHash: string;
  readonly scores: readonly (CaseScore & { readonly partition: 'TRAIN' | 'HELD_OUT' })[];
}

export interface CandidateScoresEnvelope extends Omit<BaselineScoresEnvelope, 'kind' | 'baselineDigest'> {
  readonly kind: 'CANDIDATE';
  readonly candidateId: string;
  /** Canonical digest of the verified bundle this evidence was produced
   * against; a score for one candidate is not reusable for another. */
  readonly candidateDigest: string;
  readonly attemptId: string;
}

export function asTrain(id: string): TrainCaseId { return id as TrainCaseId; }
export function asHeldOut(id: string): HeldOutCaseId { return id as HeldOutCaseId; }

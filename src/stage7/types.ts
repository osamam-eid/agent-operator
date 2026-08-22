import type { ArtifactManifest, MutationClass } from '../contracts.js';
import type { ActiveExecutionBatch, ExecutionBatchRequest, NodeExecutionAdapter, StoredOperatorSession } from '../runtime-types.js';
import type { GovernedMutationExecutor } from '../mutation/governed.js';
import type { GovernedMutationRequest, GovernedMutationResult, WorktreePort, WorktreeHandle, WorktreeSnapshot, MutationScope } from '../mutation/worktree.js';

export type Stage7AdapterId =
  | 'stage7-qa-preflight'
  | 'stage7-qa-execution'
  | 'stage7-qa-evidence'
  | 'stage7-qa-review'
  | 'stage7-qa-synthesis'
  | 'stage7-impeccable'
  | 'stage7-ui-implementation'
  | 'stage7-sol-assurance'
  | 'stage7-visual'
  | 'stage7-ui-synthesis';

export type ProductionNodeExecutionAdapterId = 'omp-task' | 'external-cli' | Stage7AdapterId;

export interface Stage7FeatureSet {
  readonly stage7Enabled: boolean;
  readonly stage8PublicationEnabled: false;
  readonly stage9ExternalProvidersEnabled: boolean;
  readonly stage10EvaluatorEnabled: boolean;
  readonly stage11QualificationEnabled: false;
  readonly hash: string;
}

export interface NodeExecutionTuple {
  readonly workflowTemplateId: string;
  readonly nodeId: string;
  readonly role: string;
  readonly capabilityId: string;
  readonly requiredCapability: string;
  readonly mutationClass: MutationClass;
}

export interface NodeExecutionBinding {
  readonly tuple: NodeExecutionTuple;
  readonly adapterId: ProductionNodeExecutionAdapterId;
  readonly assuranceRole?: 'ui-v2-sol-assurance';
  readonly runtimeImplementation?: string;
}

export interface NodeExecutionAdapterResolver {
  resolve(tuple: NodeExecutionTuple): NodeExecutionAdapter;
}

export type Stage7RouteErrorCode =
  | 'STAGE7_ROUTE_MISMATCH'
  | 'STAGE7_ROUTE_COLLISION'
  | 'STAGE7_CAPABILITY_UNAVAILABLE'
  | 'STAGE7_FEATURE_DISABLED'
  | 'UNSUPPORTED_ADAPTER_ID';

export type QaApplicationDataAuthorityEntry =
  | {
      readonly kind: 'CREATE';
      readonly entityType: string;
      readonly allowedFields: readonly string[];
    }
  | {
      readonly kind: 'FIXTURE_MUTATION';
      readonly recordId: string;
      readonly entityType: string;
      readonly action: 'UPDATE' | 'DELETE';
      readonly allowedFields: readonly string[];
    };

export interface QaExecutionGrant {
  readonly qaEnvironmentApprovalRef: string;
  readonly qaEnvironmentApprovalHash: string;
  readonly environmentIdentity: string;
  readonly repositoryMutationClass: 'READ_ONLY';
  readonly applicationDataAuthority: 'NONE' | 'TRACKED_DISPOSABLE_ONLY';
  readonly exactApprovedFixtureIds: readonly string[];
  readonly applicationDataAuthorities: readonly QaApplicationDataAuthorityEntry[];
  readonly qaRunId: string;
  readonly cleanupRequired: boolean;
  readonly evidenceRoot: string;
}

export interface UiExecutionGrant {
  readonly projectRoot: string;
  readonly approvedWorktreeParent: string;
  readonly worktreeId: string;
  readonly scopeHash: string;
  readonly contractHash: string;
  readonly baselineIdentity: string;
  readonly allowedPaths: readonly string[];
  readonly mutationClass: 'LOCAL';
  readonly publicationAuthority: 'NONE';
  readonly visualEvidenceRequired: true;
  readonly assuranceRole: 'ui-v2-sol-assurance';
}

export type QaCleanupDisposition =
  | {
      readonly kind: 'UNAUTHORIZED_OR_UNSAFE_RESIDUAL';
      readonly residualIds: readonly string[];
      readonly reason: string;
    }
  | {
      readonly kind: 'APPROVED_RETAINED_RESIDUAL';
      readonly residualIds: readonly string[];
      readonly owner: string;
      readonly scope: string;
      readonly retentionUntil: string;
      readonly rollback: string;
    }
  | {
      readonly kind: 'UNPROVEN_CLEANUP';
      readonly evidenceRefs: readonly string[];
      readonly reason: string;
    };

export type QaCleanupOutcome = 'BLOCKING' | 'PROCEED_BY_POLICY' | 'HUMAN_DECISION_HOLD';

export interface QaAuthorityEnvelope {
  readonly repositoryMutationClass: 'READ_ONLY';
  readonly applicationDataAuthority: 'NONE' | 'TRACKED_DISPOSABLE_ONLY';
  readonly exactApprovedFixtureIds: readonly string[];
  readonly applicationDataAuthorities: readonly QaApplicationDataAuthorityEntry[];
}

export interface QaCleanupFindingEnvelope extends QaAuthorityEnvelope {
  readonly cleanupDisposition: QaCleanupDisposition;
  readonly cleanupOutcome: QaCleanupOutcome;
}

export interface QaEvidenceAuthorityEnvelope extends QaAuthorityEnvelope {
  readonly evidenceIds: readonly string[];
}

export interface QaFinalResultAuthorityEnvelope extends QaAuthorityEnvelope {
  readonly workflowStatus: 'COMPLETED' | 'HUMAN_DECISION_REQUIRED' | 'BLOCKED' | 'FAILED';
  readonly cleanupOutcome: QaCleanupOutcome;
}

export interface QaWhyAuthorityEnvelope extends QaAuthorityEnvelope {
  readonly qaRunId: string;
  readonly cleanupOutcome: QaCleanupOutcome;
}

export interface Stage7SecretScanCoverage {
  readonly filesScanned: number;
  readonly bytesScanned: number;
}

export interface Stage7SecretScan {
  readonly status: 'CLEAN';
  readonly scannerVersion: string;
  readonly scannedAt: string;
  readonly coverage: Stage7SecretScanCoverage;
}

export interface Stage7ArtifactEnvelope {
  readonly artifactId: string;
  readonly artifactType: Stage7ArtifactType;
  readonly producedByNodeId: string;
  readonly operatorSessionId: string;
  readonly hash: string;
  readonly location: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly contentSummary: string;
  readonly policyRefs: readonly string[];
  readonly producer: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export type Stage7ArtifactType =
  | 'qa-environment-approval.v1'
  | 'deployment-context.v1'
  | 'qa-execution-log.v1'
  | 'qa-evidence.v1'
  | 'qa-review.v1'
  | 'qa-report.v1'
  | 'ui-design-spec.v1'
  | 'ui-implementation-diff.v1'
  | 'ui-candidate-bundle.v1'
  | 'design-review.v1'
  | 'ui-visual-verification.v1';

export interface Stage7ArtifactRegistry {
  register(artifact: Stage7ArtifactEnvelope): void;
  get(artifactId: string): Stage7ArtifactEnvelope | undefined;
  list(): readonly Stage7ArtifactEnvelope[];
}

export interface GatePresentation {
  readonly lane: 'QA' | 'UI';
  readonly artifactIds: readonly string[];
  readonly candidateHash?: string;
  readonly actionsNotPerformed: readonly string[];
  readonly assuranceRole?: 'ui-v2-sol-assurance';
}

export interface ProvisionalCandidateStore {
  quarantine(candidate: ProvisionalCandidate): void;
  promote(candidateId: string): Stage7ArtifactEnvelope;
  invalidate(candidateId: string, reason: string): void;
  get(candidateId: string): ProvisionalCandidate | undefined;
}

export interface ProvisionalCandidate {
  readonly candidateId: string;
  readonly bundle: Stage7ArtifactEnvelope;
  readonly baselineIdentity: string;
  readonly changedPaths: readonly string[];
  readonly status: 'QUARANTINED' | 'PROMOTED' | 'INVALIDATED';
  readonly invalidationReason?: string;
}

export interface CandidateCaptureRequest {
  readonly worktree: WorktreeHandle;
  readonly baseline: WorktreeSnapshot;
  readonly changedPaths: readonly string[];
  readonly scope: MutationScope;
  readonly operatorSessionId: string;
  readonly nodeId: string;
}

export interface CandidateCaptureResult {
  readonly candidate: ProvisionalCandidate;
}

export interface CandidateCapturingWorktreePort extends WorktreePort {
  readonly lastCandidateId: string | undefined;
}

export interface CandidateCapturePort extends WorktreePort {
  capture(request: CandidateCaptureRequest): Promise<CandidateCaptureResult>;
}

export interface GovernedUiImplementationPort {
  execute(request: GovernedMutationRequest & { readonly grant: UiExecutionGrant }): Promise<GovernedMutationResult & { readonly candidate: Stage7ArtifactEnvelope }>;
}

export interface CleanupLedgerEntry {
  readonly ledgerId: string;
  readonly operatorSessionId: string;
  readonly worktreeId: string;
  readonly approvedWorktreeParent: string;
  readonly worktreePath?: string;
  readonly provisionalCandidateId?: string;
  readonly state: 'PREPARED' | 'WORKTREE_CREATED' | 'PROVISIONAL_QUARANTINED' | 'PROMOTED' | 'CLEANED' | 'UNKNOWN';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CleanupLedger {
  preCreate(entry: Omit<CleanupLedgerEntry, 'state' | 'updatedAt'> & { readonly updatedAt?: string }): CleanupLedgerEntry;
  update(ledgerId: string, patch: Partial<Pick<CleanupLedgerEntry, 'worktreePath' | 'provisionalCandidateId' | 'state' | 'updatedAt'>>): CleanupLedgerEntry;
  get(ledgerId: string): CleanupLedgerEntry | undefined;
  list(): readonly CleanupLedgerEntry[];
}

export interface CleanupReconciliation {
  readonly ledgerId: string;
  readonly status: 'CLEANED' | 'UNKNOWN';
  readonly redispatchAllowed: false;
  readonly evidence: readonly string[];
}

export interface CleanupReconciler {
  reconcile(entries: readonly CleanupLedgerEntry[]): Promise<readonly CleanupReconciliation[]>;
}

export interface Stage7AdapterFactory {
  readonly adapterId: Stage7AdapterId;
  readonly adapter?: NodeExecutionAdapter;
}

export type Stage7PortUnavailable = {
  readonly code: 'STAGE7_CAPABILITY_UNAVAILABLE';
  readonly adapterId: Stage7AdapterId;
  readonly tuple: NodeExecutionTuple;
};

export type Stage7Batch = ActiveExecutionBatch;
export type Stage7BatchRequest = ExecutionBatchRequest;
export type Stage7StoredSession = StoredOperatorSession;
export type Stage7ArtifactManifest = ArtifactManifest;
export type Stage7Executor = GovernedMutationExecutor;

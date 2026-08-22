import type { AgentResult, ArtifactManifest } from '../../contracts.js';
import type { ActiveExecutionBatch, ExecutionBatchRequest, NodeExecutionAdapter, NodeExecutionOutcome, NodeExecutionRequest, NodeExecutionUsage } from '../../runtime-types.js';
import type { QaCleanupDisposition, QaExecutionGrant, QaAuthorityEnvelope } from '../types.js';
export type { QaCleanupDisposition } from '../types.js';
import type { OmpChildSession, OmpChildSessionHandle, OmpSelectedModel, OmpSessionFactory } from '../../adapters/omp-task.js';

export type QaAdapterId = 'stage7-qa-execution' | 'stage7-qa-review';
export type QaAgentName = 'qa' | 'qa-review';
export type QaModelId = 'gpt-5.6-luna' | 'gpt-5.6-terra';
export type QaAgentProvider = 'kiro';

export interface QaNativeBinding {
  readonly adapterId: QaAdapterId;
  readonly workflowTemplateId: 'qa.v2';
  readonly nodeId: 'qa-v2-execution' | 'qa-v2-terra-review';
  readonly role: 'qa-v2-executor' | 'qa-v2-terra-reviewer';
  readonly capabilityId: QaAdapterId;
  readonly requiredCapability: 'qa-v2-execution' | 'qa-v2-independent-review';
  readonly mutationClass: 'READ_ONLY';
  readonly agentName: QaAgentName;
  readonly provider: QaAgentProvider;
  readonly modelId: QaModelId;
  readonly roleContentSha256: string;
  readonly requiredRoleTools: readonly string[];
  readonly allowedDispatchTools: readonly string[];
  readonly outputSchemaId: 'agent-result.v1';
}

export interface QaEnvironmentApproval {
  readonly approvalId: string;
  readonly artifactHash: string;
  readonly humanApproved: true;
  readonly environmentType: string;
  readonly environmentUrl: string;
  readonly database: string;
  readonly tenant: string;
  readonly permittedActions: readonly string[];
  readonly exactFixtureIds: readonly string[];
  readonly expiresAt: string;
  readonly scopeHash: string;
}

export interface QaActualEnvironment {
  readonly environmentType: string;
  readonly environmentUrl: string;
  readonly database: string;
  readonly tenant: string;
}

export interface QaDeploymentContext {
  readonly environment: QaActualEnvironment;
  readonly buildIdentity: string;
  readonly enabledFeatureFlags: readonly string[];
  readonly browser: string;
  readonly personas: readonly string[];
  readonly capturedAt: string;
  readonly timezone: string;
  readonly ticketOrSpecRevision: string;
  readonly acceptanceCriteriaRetrievedAt: string;
}

export interface QaPreflightInput {
  readonly approval: QaEnvironmentApproval;
  readonly actual: QaDeploymentContext;
  readonly expectedBuildIdentity: string;
  readonly expectedSpecRevision: string;
  readonly now: string;
}

export interface QaPreflightRecord {
  readonly status: 'APPROVED' | 'BLOCKED_ENVIRONMENT';
  readonly approvalId: string;
  readonly approvalHash: string;
  readonly checkedAt: string;
  readonly deploymentContext: QaDeploymentContext;
  readonly mismatches: readonly string[];
}

export type QaDataMutationKind = 'CREATE' | 'UPDATE' | 'DELETE';

export interface QaDataMutationRequest {
  readonly operationId: string;
  readonly kind: QaDataMutationKind;
  readonly entityType: string;
  readonly recordId?: string;
  readonly fields: readonly string[];
  readonly qaRunId: string;
  readonly runTag?: string;
  readonly exactFixtureId?: string;
}

export type QaDataLedgerStatus = 'AUTHORIZED' | 'COMPLETED' | 'DENIED';

export interface QaDataLedgerEntry {
  readonly operationId: string;
  readonly kind: QaDataMutationKind;
  readonly entityType: string;
  readonly recordId?: string;
  readonly fields: readonly string[];
  readonly qaRunId: string;
  readonly status: QaDataLedgerStatus;
  readonly reason?: string;
  readonly findingId: string;
  readonly evidenceId: string;
  readonly authority: QaAuthorityEnvelope;
  readonly recordedAt: string;
}

export interface QaDataAuthorizationDecision {
  readonly allowed: true;
  readonly operationId: string;
  readonly findingId: string;
  readonly evidenceId: string;
}

export interface QaDataMutationPort {
  authorize(request: QaDataMutationRequest): QaDataAuthorizationDecision;
  complete(operationId: string, recordId: string): QaDataLedgerEntry;
  entries(): readonly QaDataLedgerEntry[];
}

export interface QaFindingAuthorityEnvelope extends QaAuthorityEnvelope {
  readonly findingId: string;
}

export interface QaDataAuthorizationPort extends QaDataMutationPort {
  preDispatch(): void;
}

export interface QaCleanupRecord {
  readonly disposition: QaCleanupDisposition;
  readonly outcome: 'BLOCKING' | 'PROCEED_BY_POLICY' | 'HUMAN_DECISION_HOLD';
  readonly residualIds: readonly string[];
  readonly recordedAt: string;
}

export interface QaEvidenceFile {
  readonly evidenceId: string;
  readonly relativePath: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly kind: 'IMAGE' | 'NETWORK' | 'LOG' | 'BACKEND' | 'REPORT' | 'MATRIX' | 'OTHER';
}

export interface QaEvidenceBundle {
  readonly qaRunId: string;
  readonly root: string;
  readonly files: readonly QaEvidenceFile[];
  readonly reportReferences: readonly string[];
  readonly executionLogReference: string;
  readonly authority: QaAuthorityEnvelope;
  readonly dataLedger: readonly QaDataLedgerEntry[];
  readonly cleanup: QaCleanupRecord;
  readonly flakyAttempts: readonly QaCriterionAttempt[];
}

export type QaCriterionStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'FLAKY';

export interface QaCriterionAttempt {
  readonly criterionId: string;
  readonly attempt: 1 | 2;
  readonly status: Exclude<QaCriterionStatus, 'FLAKY'>;
  readonly evidenceIds: readonly string[];
}

export interface QaFlakyClassification {
  readonly criterionId: string;
  readonly status: QaCriterionStatus;
  readonly attempts: readonly QaCriterionAttempt[];
}

export interface QaRunArtifacts {
  readonly runId: string;
  readonly preflight: QaPreflightRecord;
  readonly deploymentContext: QaDeploymentContext;
  readonly executionLogReference: string;
  readonly evidence?: QaEvidenceBundle;
  readonly evidenceVerified: boolean;
  readonly qaReportReferences: readonly string[];
  readonly authority: QaAuthorityEnvelope;
  readonly dataLedger: readonly QaDataLedgerEntry[];
  readonly cleanup?: QaCleanupRecord;
  readonly finalGateStatus: 'NOT_READY' | 'REVIEW_COMPLETE_HUMAN_PENDING' | 'BLOCKED' | 'HUMAN_DECISION_REQUIRED';
}

export interface QaExecutionContext {
  readonly grant: QaExecutionGrant;
  readonly approval: QaEnvironmentApproval;
  readonly preflight: QaPreflightRecord;
  readonly dataAuthorization: QaDataAuthorizationPort;
  readonly validateOutput: (result: AgentResult, request: NodeExecutionRequest) => Promise<void>;
}

export interface QaExecutionContextResolver {
  resolve(request: NodeExecutionRequest): Promise<QaExecutionContext>;
}

export interface QaReviewContext {
  readonly authority: QaAuthorityEnvelope;
  readonly lunaProviderSessionId: string;
  readonly lunaAgentIdentity: string;
  readonly validateArtifacts: (request: NodeExecutionRequest) => Promise<void>;
}

export interface QaReviewContextResolver {
  resolve(request: NodeExecutionRequest): Promise<QaReviewContext>;
}

export interface QaSessionRunInput {
  readonly request: NodeExecutionRequest;
  readonly binding: QaNativeBinding;
  readonly systemPrompt: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly toolNames: readonly string[];
  readonly prompt: string;
  readonly signal: AbortSignal;
}

export interface QaSessionRunResult {
  readonly result: AgentResult;
  readonly usage?: NodeExecutionUsage;
}

export interface QaNativeSessionRunner {
  run(input: QaSessionRunInput): Promise<QaSessionRunResult>;
}

export interface QaExecutionAdapterDeps {
  readonly sessionFactory: OmpSessionFactory;
  readonly roleRoot: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly context: QaExecutionContextResolver;
  readonly now?: () => string;
}

export interface QaReviewAdapterDeps {
  readonly sessionFactory: OmpSessionFactory;
  readonly roleRoot: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly context: QaReviewContextResolver;
  readonly now?: () => string;
}

export interface QaAgentIdentity {
  readonly agentName: QaAgentName;
  readonly provider: QaAgentProvider;
  readonly modelId: QaModelId;
  readonly providerSessionId: string;
  readonly agentSessionId: string;
}

export interface QaAdapterBatch extends ActiveExecutionBatch {}
export type QaBatchRequest = ExecutionBatchRequest;
export type QaBatchOutcome = NodeExecutionOutcome;
export type QaSessionHandle = OmpChildSessionHandle;
export type QaSession = OmpChildSession;
export type QaModel = OmpSelectedModel;
export type QaNodeAdapter = NodeExecutionAdapter;

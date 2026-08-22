import { describe, expect, test } from 'bun:test';

import {
  assertStage7FeatureSetMatch,
  createFrozenNodeExecutionAdapterResolver,
  createNodeExecutionAdapterResolver,
  createProvisionalCandidateStore,
  createStage7ArtifactRegistry,
  createStage7FeatureSet,
  cleanupDispositionOutcome,
  STAGE7_BINDINGS,
  validateQaCleanupDisposition,
  validateQaExecutionGrant,
  validateStage7Artifact,
  validateUiExecutionGrant,
  Stage7FeatureSetMismatchError,
  Stage7RouteResolutionError,
} from '../src/stage7/index.js';
import type { Stage7ArtifactEnvelope } from '../src/stage7/types.js';
import type { ActiveExecutionBatch, ExecutionBatchRequest, NodeExecutionAdapter } from '../src/runtime-types.js';

const frozen: NodeExecutionAdapter = {
  adapterId: 'omp-task',
  launchBatch(_request: ExecutionBatchRequest): ActiveExecutionBatch { throw new Error('test adapter must not launch'); },
};

const tuple = STAGE7_BINDINGS[0]?.tuple;
if (tuple === undefined) throw new Error('Stage-7 binding manifest is empty');

function artifact(type: string): Record<string, unknown> {
  const payload: Record<string, unknown> = type === 'qa-environment-approval.v1'
    ? { approvalId: 'approval-1', environmentType: 'disposable', environmentUrl: 'https://example.test', tenant: 'tenant-1', permittedActions: ['create'], fixtureIds: [], expiresAt: '2026-08-22T00:00:00.000Z', scopeHash: 'a'.repeat(64) }
    : type === 'ui-candidate-bundle.v1'
      ? { baselineIdentity: 'baseline-1', changedPaths: ['src/ui.ts'], materializationManifest: {}, dependencyInputs: [], fileHashes: {}, secretScan: { status: 'CLEAN', scannerVersion: 'test-scanner-1', scannedAt: '2026-08-21T00:00:00.000Z', coverage: { filesScanned: 1, bytesScanned: 10 } }, capturedAt: '2026-08-21T00:00:00.000Z', producer: 'stage7-test' }
      : {};
  return { artifactId: 'artifact-1', artifactType: type, producedByNodeId: 'node-1', operatorSessionId: 'session-1', hash: 'b'.repeat(64), location: '/quarantine/artifact-1', sizeBytes: 1, createdAt: '2026-08-21T00:00:00.000Z', contentSummary: 'bounded artifact', policyRefs: [], producer: 'stage7-test', payload };
}

describe('Stage-7 shared foundation', () => {
  test('disabled resolver returns the exact frozen adapter object', () => {
    const resolver = createFrozenNodeExecutionAdapterResolver(frozen);
    expect(resolver.resolve({ workflowTemplateId: 'plan.v1', nodeId: 'planner', role: 'planner', capabilityId: 'omp-task-native-planner-v1', requiredCapability: 'planning', mutationClass: 'READ_ONLY' })).toBe(frozen);
  });

  test('v2 is unavailable when Stage 7 is disabled and tuple mismatches are rejected', () => {
    const disabled = createNodeExecutionAdapterResolver({ frozenAdapter: frozen, bindings: STAGE7_BINDINGS, featureSet: createStage7FeatureSet(false, true), implementations: new Map() });
    expect(() => disabled.resolve(tuple)).toThrow(Stage7RouteResolutionError);
    const enabled = createNodeExecutionAdapterResolver({ frozenAdapter: frozen, bindings: STAGE7_BINDINGS, featureSet: createStage7FeatureSet(true, true), implementations: new Map() });
    expect(() => enabled.resolve({ ...tuple, nodeId: 'wrong-node' })).toThrow(Stage7RouteResolutionError);
    expect(() => enabled.resolve(tuple)).toThrow(/no concrete 7B\/7C executor/);
  });

  test('startup feature hashes are immutable across resume', () => {
    const enabled = createStage7FeatureSet(true, true);
    expect(() => assertStage7FeatureSetMatch(enabled.hash, createStage7FeatureSet(false, true))).toThrow(Stage7FeatureSetMismatchError);
    expect(() => assertStage7FeatureSetMatch(enabled.hash, enabled)).not.toThrow();
  });

  test('grants preserve independent authority dimensions and cleanup dispositions', () => {
    const qa = validateQaExecutionGrant({ qaEnvironmentApprovalRef: 'approval-1', qaEnvironmentApprovalHash: 'a'.repeat(64), environmentIdentity: 'disposable-1', repositoryMutationClass: 'READ_ONLY', applicationDataAuthority: 'TRACKED_DISPOSABLE_ONLY', exactApprovedFixtureIds: ['fixture-1'], applicationDataAuthorities: [{ kind: 'CREATE', entityType: 'record', allowedFields: ['name', 'status'] }, { kind: 'FIXTURE_MUTATION', recordId: 'fixture-1', entityType: 'record', action: 'UPDATE', allowedFields: ['status'] }], qaRunId: 'run-1', cleanupRequired: true, evidenceRoot: '/evidence/run-1' });
    expect(qa.ok).toBe(true);
    const rejectedBroad = validateQaExecutionGrant({ qaEnvironmentApprovalRef: 'approval-1', qaEnvironmentApprovalHash: 'a'.repeat(64), environmentIdentity: 'disposable-1', repositoryMutationClass: 'READ_ONLY', applicationDataAuthority: 'TRACKED_DISPOSABLE_ONLY', exactApprovedFixtureIds: ['fixture-1'], applicationDataAuthorities: [{ kind: 'FIXTURE_MUTATION', recordId: 'fixture-2', entityType: 'record', action: 'UPDATE', allowedFields: ['status'] }], qaRunId: 'run-1', cleanupRequired: true, evidenceRoot: '/evidence/run-1' });
    expect(rejectedBroad.ok).toBe(false);
    const rejectedNone = validateQaExecutionGrant({ qaEnvironmentApprovalRef: 'approval-1', qaEnvironmentApprovalHash: 'a'.repeat(64), environmentIdentity: 'disposable-1', repositoryMutationClass: 'READ_ONLY', applicationDataAuthority: 'NONE', exactApprovedFixtureIds: [], applicationDataAuthorities: [{ kind: 'CREATE', entityType: 'record', allowedFields: [] }], qaRunId: 'run-1', cleanupRequired: true, evidenceRoot: '/evidence/run-1' });
    expect(rejectedNone.ok).toBe(false);
    const ui = validateUiExecutionGrant({ projectRoot: '/project', approvedWorktreeParent: '/tmp/worktrees', worktreeId: 'worktree-1', scopeHash: 'a'.repeat(64), contractHash: 'b'.repeat(64), baselineIdentity: 'baseline-1', allowedPaths: ['src/ui.ts'], mutationClass: 'LOCAL', publicationAuthority: 'NONE', visualEvidenceRequired: true, assuranceRole: 'ui-v2-sol-assurance' });
    expect(ui.ok).toBe(true);
    expect(cleanupDispositionOutcome({ kind: 'UNAUTHORIZED_OR_UNSAFE_RESIDUAL', residualIds: ['record-1'], reason: 'not approved' })).toBe('BLOCKING');
    expect(cleanupDispositionOutcome({ kind: 'APPROVED_RETAINED_RESIDUAL', residualIds: ['record-1'], owner: 'owner', scope: 'exact record', retentionUntil: '2026-08-22T00:00:00.000Z', rollback: 'delete record-1' })).toBe('PROCEED_BY_POLICY');
    expect(cleanupDispositionOutcome({ kind: 'UNPROVEN_CLEANUP', evidenceRefs: [], reason: 'no proof' })).toBe('HUMAN_DECISION_HOLD');
    expect(validateQaCleanupDisposition({ kind: 'UNPROVEN_CLEANUP', evidenceRefs: [], reason: 'no proof', extra: true }).ok).toBe(false);
  });

  test('artifact validator rejects unknown and secret-bearing fields', () => {
    const valid = validateStage7Artifact(artifact('qa-environment-approval.v1'));
    expect(valid.ok).toBe(true);
    const unknown = validateStage7Artifact({ ...artifact('qa-environment-approval.v1'), extra: true });
    expect(unknown.ok).toBe(false);
    const secret = validateStage7Artifact({ ...artifact('qa-environment-approval.v1'), payload: { ...(artifact('qa-environment-approval.v1').payload as Record<string, unknown>), authorization: 'redacted' } });
    expect(secret.ok).toBe(false);
  });

  test('provisional candidates remain quarantined until promotion', () => {
    const store = createProvisionalCandidateStore();
    const candidate = { candidateId: 'candidate-1', bundle: artifact('ui-candidate-bundle.v1') as unknown as Stage7ArtifactEnvelope, baselineIdentity: 'baseline-1', changedPaths: ['src/ui.ts'], status: 'QUARANTINED' as const };
    store.quarantine(candidate);
    expect(store.get('candidate-1')?.status).toBe('QUARANTINED');
    expect(store.promote('candidate-1').artifactType).toBe('ui-candidate-bundle.v1');
  });

  test('artifact validator requires an affirmative structured clean scan for UI candidates', () => {
    const valid = artifact('ui-candidate-bundle.v1');
    expect(validateStage7Artifact(valid).ok).toBe(true);
    const malformed = { ...valid, payload: { ...(valid.payload as Record<string, unknown>), secretScan: 'clean' } };
    expect(validateStage7Artifact(malformed).ok).toBe(false);
    const finding = { ...valid, payload: { ...(valid.payload as Record<string, unknown>), secretScan: { status: 'FINDINGS', scannerVersion: 'test-scanner-1', scannedAt: '2026-08-21T00:00:00.000Z', coverage: { filesScanned: 1, bytesScanned: 10 } } } };
    expect(validateStage7Artifact(finding).ok).toBe(false);
    const registry = createStage7ArtifactRegistry();
    expect(() => registry.register(malformed as never)).toThrow(/Artifact rejected/);
  });

  test('provisional promotion keeps malformed candidates quarantined', () => {
    const store = createProvisionalCandidateStore();
    const bundle = artifact('ui-candidate-bundle.v1');
    const candidate = { candidateId: 'candidate-invalid-scan', bundle: { ...bundle, payload: { ...(bundle.payload as Record<string, unknown>), secretScan: { status: 'ERROR', scannerVersion: 'test-scanner-1', scannedAt: '2026-08-21T00:00:00.000Z', coverage: { filesScanned: 1, bytesScanned: 10 } } } } as unknown as Stage7ArtifactEnvelope, baselineIdentity: 'baseline-1', changedPaths: ['src/ui.ts'], status: 'QUARANTINED' as const };
    store.quarantine(candidate);
    expect(() => store.promote(candidate.candidateId)).toThrow(/promotion validation/);
    expect(store.get(candidate.candidateId)?.status).toBe('QUARANTINED');
  });

  test('registry rejects duplicate durable artifact ids', () => {
    const registry = createStage7ArtifactRegistry();
    const candidate = artifact('qa-environment-approval.v1');
    registry.register(candidate as never);
    expect(() => registry.register(candidate as never)).toThrow(/already registered/);
  });
});

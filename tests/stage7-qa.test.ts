import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { AgentResult } from '../src/contracts.js';
import { authorityEnvelope } from '../src/stage7/grants.js';
import type { QaExecutionGrant } from '../src/stage7/types.js';
import { QA_BINDING_ARTIFACT_HASH, QA_EXECUTION_BINDING, QA_REVIEW_BINDING, assertQaBindingArtifactIntegrity } from '../src/stage7/qa/bindings.js';
import { assertQaRequest, normalizeAdapterResult } from '../src/stage7/qa/adapter-common.js';
import { QaAuthorizationError, createQaDataAuthorization } from '../src/stage7/qa/authority.js';
import { classifyQaFlakyAttempts, validateQaEvidenceManifest, verifyQaEvidenceBundle } from '../src/stage7/qa/evidence.js';
import { createQaEnvironmentApproval, validateQaPreflight } from '../src/stage7/qa/preflight.js';
import { NativeQaSessionRunner } from '../src/stage7/qa/native-session.js';
import { qaCleanupRecord, QaRunOrchestrator } from '../src/stage7/qa/orchestration.js';
import type { QaCleanupDisposition, QaEvidenceBundle } from '../src/stage7/qa/types.js';

const grant: QaExecutionGrant = {
  qaEnvironmentApprovalRef: 'approval-1', qaEnvironmentApprovalHash: 'a'.repeat(64), environmentIdentity: 'disposable|https://qa.test|db|tenant', repositoryMutationClass: 'READ_ONLY', applicationDataAuthority: 'TRACKED_DISPOSABLE_ONLY', exactApprovedFixtureIds: ['fixture-1'], applicationDataAuthorities: [{ kind: 'CREATE', entityType: 'record', allowedFields: ['status'] }, { kind: 'FIXTURE_MUTATION', recordId: 'fixture-1', entityType: 'record', action: 'UPDATE', allowedFields: ['status'] }], qaRunId: 'run-1', cleanupRequired: true, evidenceRoot: '/tmp/qa/run-1',
};

function approval(): ReturnType<typeof createQaEnvironmentApproval> { return createQaEnvironmentApproval({ approvalId: 'approval-1', artifactHash: 'a'.repeat(64), humanApproved: true, environmentType: 'disposable', environmentUrl: 'https://qa.test', database: 'db', tenant: 'tenant', permittedActions: ['CREATE|record|status'], exactFixtureIds: ['fixture-1'], expiresAt: '2026-08-22T00:00:00.000Z' }); }

function cleanup(kind: QaCleanupDisposition['kind']): QaCleanupDisposition {
  if (kind === 'UNAUTHORIZED_OR_UNSAFE_RESIDUAL') return { kind, residualIds: ['r-1'], reason: 'unsafe' };
  if (kind === 'APPROVED_RETAINED_RESIDUAL') return { kind, residualIds: ['r-1'], owner: 'human', scope: 'exact record', retentionUntil: '2026-08-23T00:00:00.000Z', rollback: 'delete r-1' };
  return { kind, evidenceRefs: ['e-1'], reason: 'not proven' };
}

function evidenceBundle(content: Uint8Array, sha256 = createHash('sha256').update(content).digest('hex')): QaEvidenceBundle {
  return { qaRunId: 'run-1', root: '/evidence/run-1', files: [{ evidenceId: 'log-1', relativePath: 'logs/output.txt', sha256, sizeBytes: content.byteLength, kind: 'LOG' }], reportReferences: ['log-1'], executionLogReference: 'log-1', authority: authorityEnvelope(grant), dataLedger: [], cleanup: qaCleanupRecord(cleanup('APPROVED_RETAINED_RESIDUAL'), '2026-08-21T20:00:00.000Z'), flakyAttempts: [] };
}

describe('Stage-7B governed QA lane', () => {
  test('binding artifact is fixed and Luna/Terra identities are distinct', () => {
    expect(QA_EXECUTION_BINDING.modelId).toBe('gpt-5.6-luna');
    expect(QA_REVIEW_BINDING.modelId).toBe('gpt-5.6-terra');
    expect(() => assertQaBindingArtifactIntegrity()).not.toThrow();
    expect(QA_BINDING_ARTIFACT_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  test('preflight blocks deployment identity mismatch and source mutation is denied', () => {
    const checked = validateQaPreflight({ approval: approval(), actual: { environment: { environmentType: 'shared-staging', environmentUrl: 'https://qa.test', database: 'db', tenant: 'tenant' }, buildIdentity: 'wrong', enabledFeatureFlags: [], browser: 'fake', personas: [], capturedAt: '2026-08-21T20:00:00.000Z', timezone: 'UTC', ticketOrSpecRevision: 'spec-1', acceptanceCriteriaRetrievedAt: '2026-08-21T20:00:00.000Z' }, expectedBuildIdentity: 'build-1', expectedSpecRevision: 'spec-1', now: '2026-08-21T20:00:00.000Z' });
    expect(checked.status).toBe('BLOCKED_ENVIRONMENT');
    const authority = createQaDataAuthorization(grant);
    authority.preDispatch();
    expect(() => authority.authorize({ operationId: 'source', kind: 'UPDATE', entityType: 'source', recordId: 'src-1', fields: ['content'], qaRunId: 'run-1' })).toThrow(QaAuthorizationError);
    expect(authority.entries()[0]?.status).toBe('DENIED');
  });

  test('exact fixture and same-run authority are allowed while unrelated records are denied', () => {
    const authority = createQaDataAuthorization(grant);
    authority.preDispatch();
    const created = authority.authorize({ operationId: 'create', kind: 'CREATE', entityType: 'record', fields: ['status'], qaRunId: 'run-1', runTag: 'run-1' });
    expect(created.allowed).toBe(true);
    authority.complete('create', 'new-1');
    expect(authority.authorize({ operationId: 'update', kind: 'UPDATE', entityType: 'record', recordId: 'new-1', fields: ['status'], qaRunId: 'run-1' }).allowed).toBe(true);
    expect(() => authority.authorize({ operationId: 'unrelated', kind: 'UPDATE', entityType: 'record', recordId: 'other', fields: ['status'], qaRunId: 'run-1' })).toThrow(QaAuthorizationError);
    expect(() => authority.authorize({ operationId: 'wrong-fixture', kind: 'UPDATE', entityType: 'record', recordId: 'fixture-1', exactFixtureId: 'fixture-1', fields: ['name'], qaRunId: 'run-1' })).toThrow(QaAuthorizationError);
  });

  test('ledger records authorization, completion, and denial evidence', () => {
    const authority = createQaDataAuthorization(grant);
    authority.preDispatch();
    authority.authorize({ operationId: 'create-ledger', kind: 'CREATE', entityType: 'record', fields: ['status'], qaRunId: 'run-1', runTag: 'run-1' });
    authority.complete('create-ledger', 'new-ledger');
    expect(authority.entries().map((entry) => entry.status)).toEqual(['COMPLETED']);
    expect(authority.entries()[0]?.authority.applicationDataAuthority).toBe('TRACKED_DISPOSABLE_ONLY');
    expect(() => authority.complete('missing', 'x')).toThrow(QaAuthorizationError);
  });

  test('cleanup dispositions are closed and never turn unproven cleanup into pass', () => {
    expect(qaCleanupRecord(cleanup('UNAUTHORIZED_OR_UNSAFE_RESIDUAL'), '2026-08-21T20:00:00.000Z').outcome).toBe('BLOCKING');
    expect(qaCleanupRecord(cleanup('APPROVED_RETAINED_RESIDUAL'), '2026-08-21T20:00:00.000Z').outcome).toBe('PROCEED_BY_POLICY');
    expect(qaCleanupRecord(cleanup('UNPROVEN_CLEANUP'), '2026-08-21T20:00:00.000Z').outcome).toBe('HUMAN_DECISION_HOLD');
  });

  test('evidence checksum, reference, and secret failures are blocking', async () => {
    const bytes = new TextEncoder().encode('safe evidence');
    await expect(verifyQaEvidenceBundle(evidenceBundle(bytes), async () => bytes)).resolves.toBeUndefined();
    await expect(verifyQaEvidenceBundle(evidenceBundle(bytes, 'b'.repeat(64)), async () => bytes)).rejects.toThrow();
    expect(() => validateQaEvidenceManifest({ ...evidenceBundle(bytes), reportReferences: ['missing'] })).toThrow();
    const secret = new TextEncoder().encode('authorization: Bearer hidden');
    await expect(verifyQaEvidenceBundle(evidenceBundle(secret), async () => secret)).rejects.toThrow();
  });

  test('FLAKY is represented by one initial attempt and one rerun', () => {
    const classified = classifyQaFlakyAttempts([{ criterionId: 'AC-1', attempt: 1, status: 'FAIL', evidenceIds: ['e1'] }, { criterionId: 'AC-1', attempt: 2, status: 'PASS', evidenceIds: ['e2'] }]);
    expect(classified[0]?.status).toBe('FLAKY');
    expect(classified[0]?.attempts).toHaveLength(2);
  });

  test('Terra tool grants and identity collapse fail closed', () => {
    const request = { mutationClass: 'READ_ONLY', node: { nodeId: 'qa-v2-terra-review', role: 'qa-v2-terra-reviewer', capabilityId: 'stage7-qa-review', requiredCapability: 'qa-v2-independent-review' }, allocation: { adapterId: 'stage7-qa-review' }, toolGrant: ['browser'], outputSchemaId: 'agent-result.v1' } as never;
    expect(() => assertQaRequest(request, QA_REVIEW_BINDING)).toThrow();
    expect(() => new QaRunOrchestrator({ runId: 'run-1', grant, preflight: { status: 'APPROVED', approvalId: 'approval-1', approvalHash: 'a'.repeat(64), checkedAt: '2026-08-21T20:00:00.000Z', deploymentContext: { environment: { environmentType: 'disposable', environmentUrl: 'https://qa.test', database: 'db', tenant: 'tenant' }, buildIdentity: 'build', enabledFeatureFlags: [], browser: 'browser', personas: [], capturedAt: '2026-08-21T20:00:00.000Z', timezone: 'UTC', ticketOrSpecRevision: 'spec', acceptanceCriteriaRetrievedAt: '2026-08-21T20:00:00.000Z' }, mismatches: [] }, deploymentContext: { environment: { environmentType: 'disposable', environmentUrl: 'https://qa.test', database: 'db', tenant: 'tenant' }, buildIdentity: 'build', enabledFeatureFlags: [], browser: 'browser', personas: [], capturedAt: '2026-08-21T20:00:00.000Z', timezone: 'UTC', ticketOrSpecRevision: 'spec', acceptanceCriteriaRetrievedAt: '2026-08-21T20:00:00.000Z' }, executionLogReference: 'log-1', now: '2026-08-21T20:00:00.000Z' })).not.toThrow();
  });

  test('normalized outcomes preserve null usage and explicit Terra pending status', () => {
    const result: AgentResult = { resultId: 'r', operatorSessionId: 's', nodeId: 'qa-v2-terra-review', capabilityId: 'stage7-qa-review', status: 'SUCCEEDED', summary: 'reviewed evidence', producedArtifactRefs: [], consumedArtifactRefs: [], findingIds: [], evidenceIds: [], startedAt: '2026-08-21T20:00:00.000Z', completedAt: '2026-08-21T20:00:01.000Z', policyRefs: [] };
    const normalized = normalizeAdapterResult({ result, usage: { tokens: 4, cost: null } }, true);
    expect(normalized.usage?.cost).toBeNull();
    expect(normalized.result.summary).toContain('REVIEW_COMPLETE_HUMAN_PENDING');
  });

  test('native QA runner uses a deterministic fake OMP session and disposes it', async () => {
    const result = { resultId: 'attempt-1', operatorSessionId: 'session-1', nodeId: 'qa-v2-execution', capabilityId: 'stage7-qa-execution', status: 'SUCCEEDED', summary: 'fixture result', producedArtifactRefs: [], consumedArtifactRefs: [], findingIds: [], evidenceIds: [], providerSessionId: 'luna-provider-1', startedAt: '2026-08-21T20:00:00.000Z', completedAt: '2026-08-21T20:00:01.000Z', policyRefs: [] };
    let disposed = false;
    const session = { prompt: async () => undefined, getLastAssistantText: () => JSON.stringify(result), getLastAssistantMessage: () => ({ stopReason: 'stop' }), getUsage: () => ({ tokens: 3 }), subscribe: () => () => undefined, abort: async () => undefined, beginDispose: () => undefined, dispose: async () => { disposed = true; } };
    const runner = new NativeQaSessionRunner({ roleRoot: join(homedir(), '.omp', 'agent', 'agents'), sessionFactory: { createSession: async () => ({ session }) } });
    const run = await runner.run({ request: { allocation: { attemptId: 'attempt-1', batchId: 'batch-1', operatorSessionId: 'session-1', graphRevision: 1, nodeId: 'qa-v2-execution', capabilityId: 'stage7-qa-execution', adapterId: 'stage7-qa-execution', providerSessionId: 'luna-provider-1', startedAt: '2026-08-21T20:00:00.000Z', timeoutAt: '2026-08-21T20:05:00.000Z' }, node: { nodeId: 'qa-v2-execution', role: 'qa-v2-executor', capabilityId: 'stage7-qa-execution', requiredCapability: 'qa-v2-execution', mandatory: true, dependsOn: [], contextPolicy: 'FULL_REQUEST', consumes: [], produces: [] }, requestOrSummary: 'fixture', consumedArtifacts: [], consumedEvidence: [], dependencyResultSummaries: [], projection: { projectionRoot: '/tmp/fixture', allowedPaths: [], manifestHash: 'a'.repeat(64), sourceLabels: [] }, policyRefs: [], instructions: 'fixture', acceptanceCriteria: [], toolGrant: [], mutationClass: 'READ_ONLY', outputSchemaId: 'agent-result.v1' } as never, binding: QA_EXECUTION_BINDING, systemPrompt: '', outputSchema: {}, toolNames: [], prompt: 'fixture prompt', signal: new AbortController().signal });
    expect(run.result.providerSessionId).toBe('luna-provider-1');
    expect(run.usage?.cost).toBeNull();
    expect(disposed).toBe(true);
  });
  test('same-run authority is bound to the creation entityType and denies cross-entityType escalation', () => {
    const scopedGrant: QaExecutionGrant = { ...grant, applicationDataAuthorities: [{ kind: 'CREATE', entityType: 'record', allowedFields: ['status'] }, { kind: 'CREATE', entityType: 'widget', allowedFields: ['status'] }] };
    const authority = createQaDataAuthorization(scopedGrant);
    authority.preDispatch();
    authority.authorize({ operationId: 'create-record', kind: 'CREATE', entityType: 'record', fields: ['status'], qaRunId: 'run-1', runTag: 'run-1' });
    authority.complete('create-record', 'pre-existing-1');
    expect(() => authority.authorize({ operationId: 'escalate', kind: 'UPDATE', entityType: 'widget', recordId: 'pre-existing-1', fields: ['status'], qaRunId: 'run-1' })).toThrow(QaAuthorizationError);
    expect(authority.authorize({ operationId: 'scoped', kind: 'UPDATE', entityType: 'record', recordId: 'pre-existing-1', fields: ['status'], qaRunId: 'run-1' }).allowed).toBe(true);
    expect(() => authority.complete('create-record', 'pre-existing-1')).toThrow(QaAuthorizationError);
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';

import {
  assessScopeDrift,
  createFailureFingerprint,
  createRecoveryPackagePort,
  MemoryRecoveryPackageStore,
  validateFailureFingerprint,
  validateProviderFallbackJournal,
  type ProviderFallbackJournal,
} from '../src/execution-safety.js';
import type { NodeExecutionOutcome } from '../src/runtime-types.js';

function failedOutcome(summary: string): NodeExecutionOutcome {
  return {
    attempt: {
      attemptId: 'attempt-1', batchId: 'batch-1', operatorSessionId: 'session-1', graphRevision: 1,
      nodeId: 'node-1', capabilityId: 'capability-1', adapterId: 'external-cli', providerSessionId: 'provider-session-1',
      startedAt: '2026-01-01T00:00:00.000Z', timeoutAt: '2026-01-01T00:01:00.000Z', modelProvider: 'provider-a', modelId: 'model-a',
    },
    result: {
      resultId: 'attempt-1', operatorSessionId: 'session-1', nodeId: 'node-1', capabilityId: 'capability-1', status: 'FAILED',
      summary, producedArtifactRefs: [], consumedArtifactRefs: [], findingIds: [], evidenceIds: [],
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:01.000Z', policyRefs: [],
    },
  };
}

describe('execution safety intelligence', () => {
  test('normalizes equivalent failures without retaining raw sensitive text', () => {
    const first = createFailureFingerprint(failedOutcome('provider auth failed for password=fixture-secret'));
    const second = createFailureFingerprint(failedOutcome('login credential rejected for another value'));
    expect(first?.reasonCode).toBe('PROVIDER_AUTH_FAILURE');
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(JSON.stringify(first)).not.toContain('fixture-secret');
    expect(validateFailureFingerprint(first)).toBe(true);
  });

  test('keeps mutation contexts distinct', () => {
    const outcome = failedOutcome('provider timed out');
    const readOnly = createFailureFingerprint(outcome, 'READ_ONLY');
    const local = createFailureFingerprint(outcome, 'LOCAL');
    expect(readOnly?.reasonCode).toBe('PROVIDER_TIMEOUT');
    expect(readOnly?.fingerprint).not.toBe(local?.fingerprint);
  });

  test('detects changed paths and authorized-operation drift', () => {
    const approved = 'perform bounded update';
    const operationHash = createHash('sha256').update(approved).digest('hex');
    expect(assessScopeDrift({ allowedPaths: ['src/a.ts'], changedPaths: ['src/a.ts'], authorizedOperationHash: operationHash, proposedOperation: approved }).status).toBe('IN_SCOPE');
    const drift = assessScopeDrift({ allowedPaths: ['src/a.ts'], changedPaths: ['src/b.ts'], authorizedOperationHash: operationHash, proposedOperation: 'refactor everything' });
    expect(drift.status).toBe('SCOPE_DRIFT_DETECTED');
    expect(drift.reasonCodes).toEqual(['PATH_SCOPE_EXPANDED', 'AUTHORIZED_OPERATION_CHANGED']);
  });

  test('prepares and advances a digest-bound recovery package', async () => {
    const store = new MemoryRecoveryPackageStore();
    const recovery = createRecoveryPackagePort(store);
    const prepared = await recovery.prepare({
      projectRoot: '/project', approvedWorktreeParent: '/worktrees', worktreeId: 'wt-1', operation: 'bounded update',
      scope: { scopeHash: 'scope', contractHash: 'contract', allowedPaths: ['src/a.ts'], baselineIdentity: 'baseline', mutationClass: 'LOCAL' },
      gate: { approved: true, gateId: 'gate-1', graphHash: 'g'.repeat(64), approvedAt: '2026-01-01T00:00:00.000Z' },
    }, { worktreeId: 'wt-1', path: '/worktrees/wt-1', projectRoot: '/project' }, { identity: 'baseline', digest: 'digest', capturedAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z');
    expect(prepared.status).toBe('PREPARED');
    const cleaned = await recovery.update(prepared, { status: 'CLEANED', changedPaths: ['src/a.ts'], now: '2026-01-01T00:00:01.000Z' });
    expect((await store.load(cleaned.recoveryId))?.changedPaths).toEqual(['src/a.ts']);
    expect(cleaned.status).toBe('CLEANED');
  });

  test('validates complete fallback journals', () => {
    const journal: ProviderFallbackJournal = {
      schemaVersion: '1.0', policy: 'COMPATIBLE_ONLY', initialProvider: 'a', selectedProvider: 'b',
      attempts: [
        { providerId: 'a', modelId: 'a1', phase: 'BINARY_VERIFICATION', outcome: 'FAILED', reasonCode: 'BINARY_VERIFY_FAILED', disclosureCompatible: true, mutationSafe: true },
        { providerId: 'b', modelId: 'b1', phase: 'DISPATCH', outcome: 'SUCCEEDED', reasonCode: 'TERMINAL_SUCCEEDED', disclosureCompatible: true, mutationSafe: true },
      ],
      finalOutcome: 'SUCCEEDED',
    };
    expect(validateProviderFallbackJournal(journal)).toBe(true);
  });
});

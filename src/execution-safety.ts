import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentResultStatus, MutationClass } from './contracts.js';
import type { NodeExecutionOutcome } from './runtime-types.js';
import type { GovernedMutationRequest, WorktreeHandle, WorktreeSnapshot } from './mutation/worktree.js';
import { isPlainObject } from './validation/primitives.js';

export type FailureReasonCode =
  | 'PROVIDER_AUTH_FAILURE'
  | 'MODEL_CAPABILITY_MISMATCH'
  | 'TOOL_PERMISSION_DENIED'
  | 'TEST_REGRESSION'
  | 'PLAN_CONFORMANCE_FAILURE'
  | 'CONTEXT_OVERFLOW'
  | 'MUTATION_RECONCILIATION_REQUIRED'
  | 'PROVIDER_TIMEOUT'
  | 'REPEATED_VERIFICATION_FAILURE'
  | 'NODE_EXECUTION_FAILURE';

export interface FailureFingerprint {
  readonly schemaVersion: '1.0';
  readonly fingerprint: string;
  readonly reasonCode: FailureReasonCode;
  readonly status: Exclude<AgentResultStatus, 'SUCCEEDED'>;
  readonly adapterId: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly capabilityId: string;
  readonly nodeId: string;
  readonly mutationClass: MutationClass;
}

export interface ProviderFallbackAttempt {
  readonly providerId: string;
  readonly modelId: string;
  readonly phase: 'ELIGIBILITY' | 'BINARY_VERIFICATION' | 'DISPATCH';
  readonly outcome: 'REJECTED' | 'FAILED' | 'SELECTED' | 'SUCCEEDED';
  readonly reasonCode: string;
  readonly disclosureCompatible: boolean;
  readonly mutationSafe: boolean;
}

export interface ProviderFallbackJournal {
  readonly schemaVersion: '1.0';
  readonly policy: 'COMPATIBLE_ONLY' | 'HUMAN_REQUIRED' | 'DISABLED';
  readonly initialProvider?: string;
  readonly selectedProvider?: string;
  readonly attempts: readonly ProviderFallbackAttempt[];
  readonly finalOutcome: 'SUCCEEDED' | 'FAILED' | 'BLOCKED' | 'EXHAUSTED' | 'UNKNOWN';
}

export type RecoveryStatus = 'PREPARED' | 'MUTATED' | 'VERIFIED' | 'CLEANED' | 'REQUIRES_HUMAN';

export interface RecoveryPackage {
  readonly schemaVersion: '1.0';
  readonly recoveryId: string;
  readonly worktreeId: string;
  readonly worktreeIdentity: string;
  readonly baselineIdentity: string;
  readonly baselineDigest: string;
  readonly scopeHash: string;
  readonly contractHash: string;
  readonly graphHash: string;
  readonly allowedPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly mutationClass: Exclude<MutationClass, 'READ_ONLY'>;
  readonly status: RecoveryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecoveryPackageStore {
  save(recovery: RecoveryPackage): Promise<void>;
  load(recoveryId: string): Promise<RecoveryPackage | undefined>;
}

export interface RecoveryPackagePort {
  prepare(request: GovernedMutationRequest, worktree: WorktreeHandle, baseline: WorktreeSnapshot, now: string): Promise<RecoveryPackage>;
  update(recovery: RecoveryPackage, input: { readonly status: RecoveryStatus; readonly changedPaths?: readonly string[]; readonly now: string }): Promise<RecoveryPackage>;
}

export interface ScopeDriftInput {
  readonly allowedPaths: readonly string[];
  readonly changedPaths: readonly string[];
  readonly authorizedOperationHash?: string;
  readonly proposedOperation: string;
}

export interface ScopeDriftRecord {
  readonly schemaVersion: '1.0';
  readonly status: 'IN_SCOPE' | 'SCOPE_DRIFT_DETECTED';
  readonly reasonCodes: readonly string[];
  readonly outsidePaths: readonly string[];
  readonly proposedOperationHash: string;
}

function failureReason(summary: string): FailureReasonCode {
  const normalized = summary.toLowerCase();
  if (/auth|credential|login/.test(normalized)) return 'PROVIDER_AUTH_FAILURE';
  if (/timeout|timed out/.test(normalized)) return 'PROVIDER_TIMEOUT';
  if (/tool|permission|denied/.test(normalized)) return 'TOOL_PERMISSION_DENIED';
  if (/context|overflow|token limit/.test(normalized)) return 'CONTEXT_OVERFLOW';
  if (/test|regression/.test(normalized)) return 'TEST_REGRESSION';
  if (/conformance|plan/.test(normalized)) return 'PLAN_CONFORMANCE_FAILURE';
  if (/verification/.test(normalized)) return 'REPEATED_VERIFICATION_FAILURE';
  if (/reconcil|unknown mutation/.test(normalized)) return 'MUTATION_RECONCILIATION_REQUIRED';
  if (/capability|model/.test(normalized)) return 'MODEL_CAPABILITY_MISMATCH';
  return 'NODE_EXECUTION_FAILURE';
}

export function createFailureFingerprint(outcome: NodeExecutionOutcome, mutationClass: MutationClass = 'READ_ONLY'): FailureFingerprint | undefined {
  if (outcome.result.status === 'SUCCEEDED') return undefined;
  const reasonCode = failureReason(outcome.result.summary);
  const canonical = [reasonCode, outcome.result.status, outcome.attempt.adapterId, outcome.attempt.modelProvider, outcome.attempt.modelId, outcome.attempt.capabilityId, outcome.attempt.nodeId, mutationClass].join('\n');
  return {
    schemaVersion: '1.0',
    fingerprint: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    reasonCode,
    status: outcome.result.status,
    adapterId: outcome.attempt.adapterId,
    modelProvider: outcome.attempt.modelProvider,
    modelId: outcome.attempt.modelId,
    capabilityId: outcome.attempt.capabilityId,
    nodeId: outcome.attempt.nodeId,
    mutationClass,
  };
}

export function assessScopeDrift(input: ScopeDriftInput): ScopeDriftRecord {
  const outsidePaths = input.changedPaths.filter((path) => !input.allowedPaths.includes(path)).sort();
  const proposedOperationHash = createHash('sha256').update(input.proposedOperation, 'utf8').digest('hex');
  const reasonCodes: string[] = [];
  if (outsidePaths.length > 0) reasonCodes.push('PATH_SCOPE_EXPANDED');
  if (input.authorizedOperationHash !== undefined && input.authorizedOperationHash !== proposedOperationHash) reasonCodes.push('AUTHORIZED_OPERATION_CHANGED');
  return {
    schemaVersion: '1.0',
    status: reasonCodes.length === 0 ? 'IN_SCOPE' : 'SCOPE_DRIFT_DETECTED',
    reasonCodes,
    outsidePaths,
    proposedOperationHash,
  };
}

export function validateFailureFingerprint(value: unknown): value is FailureFingerprint {
  if (!isPlainObject(value)) return false;
  return value['schemaVersion'] === '1.0' && typeof value['fingerprint'] === 'string' && /^[0-9a-f]{64}$/.test(value['fingerprint']) && typeof value['reasonCode'] === 'string' && typeof value['status'] === 'string' && value['status'] !== 'SUCCEEDED' && typeof value['adapterId'] === 'string' && typeof value['modelProvider'] === 'string' && typeof value['modelId'] === 'string' && typeof value['capabilityId'] === 'string' && typeof value['nodeId'] === 'string' && typeof value['mutationClass'] === 'string';
}

export function validateProviderFallbackJournal(value: unknown): value is ProviderFallbackJournal {
  if (!isPlainObject(value) || value['schemaVersion'] !== '1.0' || !Array.isArray(value['attempts']) || typeof value['policy'] !== 'string' || typeof value['finalOutcome'] !== 'string') return false;
  return value['attempts'].every((attempt) => isPlainObject(attempt) && typeof attempt['providerId'] === 'string' && typeof attempt['modelId'] === 'string' && typeof attempt['phase'] === 'string' && typeof attempt['outcome'] === 'string' && typeof attempt['reasonCode'] === 'string' && typeof attempt['disclosureCompatible'] === 'boolean' && typeof attempt['mutationSafe'] === 'boolean');
}

export class MemoryRecoveryPackageStore implements RecoveryPackageStore {
  readonly #records = new Map<string, RecoveryPackage>();
  async save(recovery: RecoveryPackage): Promise<void> { this.#records.set(recovery.recoveryId, structuredClone(recovery)); }
  async load(recoveryId: string): Promise<RecoveryPackage | undefined> { const value = this.#records.get(recoveryId); return value === undefined ? undefined : structuredClone(value); }
}

export class FileRecoveryPackageStore implements RecoveryPackageStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  async save(recovery: RecoveryPackage): Promise<void> {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.root, `${recovery.recoveryId}.json`), `${JSON.stringify(recovery, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  async load(recoveryId: string): Promise<RecoveryPackage | undefined> {
    if (!/^[0-9a-f]{64}$/.test(recoveryId)) throw new Error('Invalid recovery id.');
    const name = `${recoveryId}.json`;
    if (!readdirSync(this.root).includes(name)) return undefined;
    const parsed = JSON.parse(readFileSync(join(this.root, name), 'utf8')) as RecoveryPackage;
    return parsed;
  }
}

export function createRecoveryPackagePort(store: RecoveryPackageStore): RecoveryPackagePort {
  return {
    async prepare(request, worktree, baseline, now): Promise<RecoveryPackage> {
      const recoveryId = createHash('sha256').update(`${request.worktreeId}\n${request.gate.graphHash}\n${request.scope.scopeHash}\n${now}`, 'utf8').digest('hex');
      const recovery: RecoveryPackage = {
        schemaVersion: '1.0', recoveryId, worktreeId: request.worktreeId, worktreeIdentity: worktree.worktreeId,
        baselineIdentity: baseline.identity, baselineDigest: baseline.digest, scopeHash: request.scope.scopeHash,
        contractHash: request.scope.contractHash, graphHash: request.gate.graphHash, allowedPaths: [...request.scope.allowedPaths],
        changedPaths: [], mutationClass: request.scope.mutationClass, status: 'PREPARED', createdAt: now, updatedAt: now,
      };
      await store.save(recovery);
      return recovery;
    },
    async update(recovery, input): Promise<RecoveryPackage> {
      const next = { ...recovery, status: input.status, changedPaths: input.changedPaths === undefined ? recovery.changedPaths : [...input.changedPaths], updatedAt: input.now };
      await store.save(next);
      return next;
    },
  };
}

import { createHash } from 'node:crypto';
import type { Stage7ArtifactEnvelope } from '../types.js';
import type { QaActualEnvironment, QaDeploymentContext, QaEnvironmentApproval, QaPreflightInput, QaPreflightRecord } from './types.js';

export class QaPreflightError extends Error {
  readonly code: 'APPROVAL_INVALID' | 'APPROVAL_EXPIRED' | 'BLOCKED_ENVIRONMENT';
  readonly mismatches: readonly string[];
  constructor(code: QaPreflightError['code'], message: string, mismatches: readonly string[] = []) { super(message); this.name = 'QaPreflightError'; this.code = code; this.mismatches = mismatches; }
}

function scopeHash(approval: Omit<QaEnvironmentApproval, 'scopeHash' | 'artifactHash'>): string {
  const material = JSON.stringify({ approvalId: approval.approvalId, environmentType: approval.environmentType, environmentUrl: approval.environmentUrl, database: approval.database, tenant: approval.tenant, permittedActions: [...approval.permittedActions], exactFixtureIds: [...approval.exactFixtureIds], expiresAt: approval.expiresAt });
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export function createQaEnvironmentApproval(input: Omit<QaEnvironmentApproval, 'scopeHash'>): QaEnvironmentApproval {
  return { ...input, scopeHash: scopeHash(input) };
}

export function assertQaApprovalArtifact(artifact: Stage7ArtifactEnvelope, approval: QaEnvironmentApproval): void {
  if (artifact.artifactType !== 'qa-environment-approval.v1' || artifact.hash !== approval.artifactHash) throw new QaPreflightError('APPROVAL_INVALID', 'Human-bound QA environment approval artifact identity does not match.', ['approval artifact hash']);
  const payload = artifact.payload;
  if (payload['approvalId'] !== approval.approvalId || payload['environmentType'] !== approval.environmentType || payload['environmentUrl'] !== approval.environmentUrl || payload['tenant'] !== approval.tenant || payload['expiresAt'] !== approval.expiresAt || payload['scopeHash'] !== approval.scopeHash || JSON.stringify(payload['fixtureIds']) !== JSON.stringify(approval.exactFixtureIds)) throw new QaPreflightError('APPROVAL_INVALID', 'Human-bound QA environment approval payload does not match the bound approval.', ['approval payload']);
}

function mismatch(actual: QaDeploymentContext, approval: QaEnvironmentApproval, input: QaPreflightInput): string[] {
  const pairs: readonly [string, string, string][] = [
    ['environmentType', actual.environment.environmentType, approval.environmentType],
    ['environmentUrl', actual.environment.environmentUrl, approval.environmentUrl],
    ['database', actual.environment.database, approval.database],
    ['tenant', actual.environment.tenant, approval.tenant],
    ['buildIdentity', actual.buildIdentity, input.expectedBuildIdentity],
    ['specRevision', actual.ticketOrSpecRevision, input.expectedSpecRevision],
  ];
  return pairs.filter(([, observed, expected]) => observed !== expected).map(([field, observed, expected]) => `${field}: observed ${observed === '' ? '<empty>' : '<mismatch>'}, expected ${expected === '' ? '<empty>' : '<approved>'}`);
}

export function validateQaPreflight(input: QaPreflightInput): QaPreflightRecord {
  if (input.approval.humanApproved !== true || input.approval.artifactHash.length !== 64 || input.approval.scopeHash.length !== 64 || scopeHash(input.approval) !== input.approval.scopeHash) throw new QaPreflightError('APPROVAL_INVALID', 'QA requires a human-approved, hash-bound environment approval.');
  const expiry = Date.parse(input.approval.expiresAt);
  const checkedAt = input.now;
  if (!Number.isFinite(expiry) || Date.parse(checkedAt) >= expiry) throw new QaPreflightError('APPROVAL_EXPIRED', 'QA environment approval is expired or has an invalid expiry.');
  const mismatches = mismatch(input.actual, input.approval, input);
  return { status: mismatches.length === 0 ? 'APPROVED' : 'BLOCKED_ENVIRONMENT', approvalId: input.approval.approvalId, approvalHash: input.approval.artifactHash, checkedAt, deploymentContext: input.actual, mismatches };
}

export function assertApprovedPreflight(record: QaPreflightRecord): void {
  if (record.status !== 'APPROVED') throw new QaPreflightError('BLOCKED_ENVIRONMENT', 'QA execution is blocked because deployment identity did not match the human approval.', record.mismatches);
}

export function qaEnvironmentIdentity(actual: QaActualEnvironment): string {
  return `${actual.environmentType}|${actual.environmentUrl}|${actual.database}|${actual.tenant}`;
}

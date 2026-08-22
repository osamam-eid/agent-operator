import { createHash } from 'node:crypto';

import type { QaApplicationDataAuthorityEntry, QaAuthorityEnvelope, QaCleanupDisposition, QaCleanupFindingEnvelope, QaExecutionGrant, QaCleanupOutcome, UiExecutionGrant } from './types.js';

export interface Stage7ValidationError { readonly path: string; readonly message: string; }
export type Stage7ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly Stage7ValidationError[] };

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function errors<T>(list: Stage7ValidationError[]): Stage7ValidationResult<T> { return { ok: false, errors: list }; }
function stringValue(raw: Record<string, unknown>, key: string, path: string, list: Stage7ValidationError[], hash = false): string | undefined {
  const value = raw[key];
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || (hash && !/^[0-9a-f]{64}$/.test(value))) {
    list.push({ path: `${path}.${key}`, message: hash ? 'must be a non-empty sha256 hash' : 'must be a non-empty string' });
    return undefined;
  }
  return value;
}
function arrayValue(raw: Record<string, unknown>, key: string, path: string, list: Stage7ValidationError[]): readonly string[] | undefined {
  const value = raw[key];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.length === 0)) {
    list.push({ path: `${path}.${key}`, message: 'must be an array of non-empty strings' });
    return undefined;
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) list.push({ path: `${path}.${key}`, message: 'must contain unique values' });
  return strings;
}
function strictKeys(raw: Record<string, unknown>, allowed: readonly string[], path: string, list: Stage7ValidationError[]): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(raw)) if (!permitted.has(key)) list.push({ path: `${path}.${key}`, message: 'unknown property' });
}

function exactIdentifier(raw: unknown, path: string, list: Stage7ValidationError[], label: string): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(raw) || /(?:^|[-_.:])(all|wildcard|query|filter|runtime-discovered|tenant-wide|tenant-selector)(?:$|[-_.:])/i.test(raw)) {
    list.push({ path, message: `${label} must be a non-empty exact identifier` });
    return undefined;
  }
  return raw;
}
function exactIdentifierArray(raw: unknown, path: string, list: Stage7ValidationError[], allowEmpty = true): readonly string[] | undefined {
  if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0)) {
    list.push({ path, message: 'must be an array of exact identifiers' });
    return undefined;
  }
  const out: string[] = [];
  raw.forEach((value, index) => {
    const identifier = exactIdentifier(value, `${path}[${index}]`, list, 'identifier');
    if (identifier !== undefined) out.push(identifier);
  });
  if (new Set(out).size !== out.length) list.push({ path, message: 'must contain unique values' });
  return out;
}
function validateApplicationDataAuthorities(
  raw: unknown,
  path: string,
  applicationDataAuthority: QaExecutionGrant['applicationDataAuthority'],
  exactApprovedFixtureIds: readonly string[],
  qaRunId: string | undefined,
  list: Stage7ValidationError[],
): readonly QaApplicationDataAuthorityEntry[] | undefined {
  if (!Array.isArray(raw)) {
    list.push({ path, message: 'must be an array of closed exact authorization entries' });
    return undefined;
  }
  const fixtureIds = new Set(exactApprovedFixtureIds);
  const entries: QaApplicationDataAuthorityEntry[] = [];
  const targetCanonical = new Map<string, string>();
  raw.forEach((value, index) => {
    const entryPath = `${path}[${index}]`;
    if (!object(value)) {
      list.push({ path: entryPath, message: 'must be an object' });
      return;
    }
    const kind = value.kind;
    if (kind === 'CREATE') {
      strictKeys(value, ['kind', 'entityType', 'allowedFields'], entryPath, list);
      const entityType = exactIdentifier(value.entityType, `${entryPath}.entityType`, list, 'entityType');
      const allowedFields = exactIdentifierArray(value.allowedFields, `${entryPath}.allowedFields`, list);
      if (applicationDataAuthority !== 'TRACKED_DISPOSABLE_ONLY') list.push({ path: entryPath, message: 'CREATE is allowed only with TRACKED_DISPOSABLE_ONLY application data authority' });
      if (qaRunId !== undefined && qaRunId.length === 0) list.push({ path: entryPath, message: 'CREATE requires a non-empty qaRunId for same-run tracking' });
      if (entityType === undefined || allowedFields === undefined) return;
      const canonical = `CREATE|${entityType}|${[...allowedFields].sort().join(',')}`;
      const target = `CREATE|${entityType}`;
      const previous = targetCanonical.get(target);
      if (previous !== undefined) list.push({ path: entryPath, message: previous === canonical ? 'duplicate authorization entry' : 'conflicting authorization entry' });
      else targetCanonical.set(target, canonical);
      entries.push({ kind, entityType, allowedFields });
      return;
    }
    if (kind === 'FIXTURE_MUTATION') {
      strictKeys(value, ['kind', 'recordId', 'entityType', 'action', 'allowedFields'], entryPath, list);
      const recordId = exactIdentifier(value.recordId, `${entryPath}.recordId`, list, 'recordId');
      const entityType = exactIdentifier(value.entityType, `${entryPath}.entityType`, list, 'entityType');
      const action = value.action === 'UPDATE' || value.action === 'DELETE' ? value.action : undefined;
      if (action === undefined) list.push({ path: `${entryPath}.action`, message: 'must be UPDATE or DELETE' });
      const allowedFields = exactIdentifierArray(value.allowedFields, `${entryPath}.allowedFields`, list);
      if (recordId !== undefined && !fixtureIds.has(recordId)) list.push({ path: `${entryPath}.recordId`, message: 'must be in exactApprovedFixtureIds' });
      if (recordId === undefined || entityType === undefined || action === undefined || allowedFields === undefined) return;
      const canonical = `FIXTURE_MUTATION|${recordId}|${entityType}|${action}|${[...allowedFields].sort().join(',')}`;
      const target = `FIXTURE_MUTATION|${recordId}`;
      const previous = targetCanonical.get(target);
      if (previous !== undefined) list.push({ path: entryPath, message: previous === canonical ? 'duplicate authorization entry' : 'conflicting authorization entry' });
      else targetCanonical.set(target, canonical);
      entries.push({ kind, recordId, entityType, action, allowedFields });
      return;
    }
    list.push({ path: `${entryPath}.kind`, message: 'must be CREATE or FIXTURE_MUTATION' });
  });
  if (applicationDataAuthority === 'NONE' && (entries.length > 0 || exactApprovedFixtureIds.length > 0)) list.push({ path, message: 'NONE requires empty application data authorities and fixture ids' });
  return entries;
}

const GRANT_KEYS = ['qaEnvironmentApprovalRef', 'qaEnvironmentApprovalHash', 'environmentIdentity', 'repositoryMutationClass', 'applicationDataAuthority', 'exactApprovedFixtureIds', 'applicationDataAuthorities', 'qaRunId', 'cleanupRequired', 'evidenceRoot'] as const;
export function validateQaExecutionGrant(input: unknown): Stage7ValidationResult<QaExecutionGrant> {
  const list: Stage7ValidationError[] = [];
  if (!object(input)) return errors([{ path: '<root>', message: 'must be an object' }]);
  strictKeys(input, GRANT_KEYS, '<root>', list);
  const qaEnvironmentApprovalRef = stringValue(input, 'qaEnvironmentApprovalRef', '<root>', list);
  const qaEnvironmentApprovalHash = stringValue(input, 'qaEnvironmentApprovalHash', '<root>', list, true);
  const environmentIdentity = stringValue(input, 'environmentIdentity', '<root>', list);
  const repositoryMutationClass = input.repositoryMutationClass;
  const applicationDataAuthority = input.applicationDataAuthority;
  const exactApprovedFixtureIds = exactIdentifierArray(input.exactApprovedFixtureIds, '<root>.exactApprovedFixtureIds', list);
  const qaRunId = stringValue(input, 'qaRunId', '<root>', list);
  const applicationDataAuthorities = applicationDataAuthority === 'NONE' || applicationDataAuthority === 'TRACKED_DISPOSABLE_ONLY'
    ? validateApplicationDataAuthorities(input.applicationDataAuthorities, '<root>.applicationDataAuthorities', applicationDataAuthority, exactApprovedFixtureIds ?? [], qaRunId, list)
    : undefined;
  const cleanupRequired = input.cleanupRequired;
  const evidenceRoot = stringValue(input, 'evidenceRoot', '<root>', list);
  if (repositoryMutationClass !== 'READ_ONLY') list.push({ path: '<root>.repositoryMutationClass', message: 'must be READ_ONLY' });
  if (applicationDataAuthority !== 'NONE' && applicationDataAuthority !== 'TRACKED_DISPOSABLE_ONLY') list.push({ path: '<root>.applicationDataAuthority', message: 'has an invalid authority' });
  if (typeof cleanupRequired !== 'boolean') list.push({ path: '<root>.cleanupRequired', message: 'must be boolean' });
  if (list.length > 0 || !qaEnvironmentApprovalRef || !qaEnvironmentApprovalHash || !environmentIdentity || !exactApprovedFixtureIds || !applicationDataAuthorities || !qaRunId || !evidenceRoot || typeof applicationDataAuthority !== 'string' || typeof cleanupRequired !== 'boolean') return errors(list);
  return { ok: true, value: { qaEnvironmentApprovalRef, qaEnvironmentApprovalHash, environmentIdentity, repositoryMutationClass: 'READ_ONLY', applicationDataAuthority: applicationDataAuthority as QaExecutionGrant['applicationDataAuthority'], exactApprovedFixtureIds, applicationDataAuthorities, qaRunId, cleanupRequired, evidenceRoot } };
}

export function validateQaAuthorityEnvelope(input: unknown): Stage7ValidationResult<QaAuthorityEnvelope> {
  const list: Stage7ValidationError[] = [];
  if (!object(input)) return errors([{ path: '<root>', message: 'must be an object' }]);
  strictKeys(input, ['repositoryMutationClass', 'applicationDataAuthority', 'exactApprovedFixtureIds', 'applicationDataAuthorities'], '<root>', list);
  const exactApprovedFixtureIds = exactIdentifierArray(input.exactApprovedFixtureIds, '<root>.exactApprovedFixtureIds', list);
  const applicationDataAuthority = input.applicationDataAuthority;
  const applicationDataAuthorities = applicationDataAuthority === 'NONE' || applicationDataAuthority === 'TRACKED_DISPOSABLE_ONLY'
    ? validateApplicationDataAuthorities(input.applicationDataAuthorities, '<root>.applicationDataAuthorities', applicationDataAuthority, exactApprovedFixtureIds ?? [], undefined, list)
    : undefined;
  if (input.repositoryMutationClass !== 'READ_ONLY') list.push({ path: '<root>.repositoryMutationClass', message: 'must be READ_ONLY' });
  if (applicationDataAuthority !== 'NONE' && applicationDataAuthority !== 'TRACKED_DISPOSABLE_ONLY') list.push({ path: '<root>.applicationDataAuthority', message: 'has an invalid authority' });
  if (list.length > 0 || !exactApprovedFixtureIds || !applicationDataAuthorities || typeof applicationDataAuthority !== 'string') return errors(list);
  return { ok: true, value: { repositoryMutationClass: 'READ_ONLY', applicationDataAuthority: applicationDataAuthority as QaAuthorityEnvelope['applicationDataAuthority'], exactApprovedFixtureIds, applicationDataAuthorities } };
}

const UI_GRANT_KEYS = ['projectRoot', 'approvedWorktreeParent', 'worktreeId', 'scopeHash', 'contractHash', 'baselineIdentity', 'allowedPaths', 'mutationClass', 'publicationAuthority', 'visualEvidenceRequired', 'assuranceRole'] as const;
export function validateUiExecutionGrant(input: unknown): Stage7ValidationResult<UiExecutionGrant> {
  const list: Stage7ValidationError[] = [];
  if (!object(input)) return errors([{ path: '<root>', message: 'must be an object' }]);
  strictKeys(input, UI_GRANT_KEYS, '<root>', list);
  const projectRoot = stringValue(input, 'projectRoot', '<root>', list);
  const approvedWorktreeParent = stringValue(input, 'approvedWorktreeParent', '<root>', list);
  const worktreeId = stringValue(input, 'worktreeId', '<root>', list);
  const scopeHash = stringValue(input, 'scopeHash', '<root>', list, true);
  const contractHash = stringValue(input, 'contractHash', '<root>', list, true);
  const baselineIdentity = stringValue(input, 'baselineIdentity', '<root>', list);
  const allowedPaths = arrayValue(input, 'allowedPaths', '<root>', list);
  if (input.mutationClass !== 'LOCAL') list.push({ path: '<root>.mutationClass', message: 'must be LOCAL' });
  if (input.publicationAuthority !== 'NONE') list.push({ path: '<root>.publicationAuthority', message: 'must be NONE' });
  if (input.visualEvidenceRequired !== true) list.push({ path: '<root>.visualEvidenceRequired', message: 'must be true' });
  if (input.assuranceRole !== 'ui-v2-sol-assurance') list.push({ path: '<root>.assuranceRole', message: 'must be ui-v2-sol-assurance' });
  if (list.length > 0 || !projectRoot || !approvedWorktreeParent || !worktreeId || !scopeHash || !contractHash || !baselineIdentity || !allowedPaths) return errors(list);
  return { ok: true, value: { projectRoot, approvedWorktreeParent, worktreeId, scopeHash, contractHash, baselineIdentity, allowedPaths, mutationClass: 'LOCAL', publicationAuthority: 'NONE', visualEvidenceRequired: true, assuranceRole: 'ui-v2-sol-assurance' } };
}

export function cleanupDispositionOutcome(disposition: QaCleanupDisposition): QaCleanupOutcome {
  switch (disposition.kind) {
    case 'UNAUTHORIZED_OR_UNSAFE_RESIDUAL': return 'BLOCKING';
    case 'APPROVED_RETAINED_RESIDUAL': return 'PROCEED_BY_POLICY';
    case 'UNPROVEN_CLEANUP': return 'HUMAN_DECISION_HOLD';
  }
}

export function validateQaCleanupDisposition(input: unknown): Stage7ValidationResult<QaCleanupDisposition> {
  const list: Stage7ValidationError[] = [];
  if (!object(input)) return errors([{ path: '<root>', message: 'must be an object' }]);
  const kind = input.kind;
  if (kind === 'UNAUTHORIZED_OR_UNSAFE_RESIDUAL') {
    strictKeys(input, ['kind', 'residualIds', 'reason'], '<root>', list);
    const residualIds = arrayValue(input, 'residualIds', '<root>', list);
    const reason = stringValue(input, 'reason', '<root>', list);
    if (list.length > 0 || !residualIds || !reason) return errors(list);
    return { ok: true, value: { kind, residualIds, reason } };
  }
  if (kind === 'APPROVED_RETAINED_RESIDUAL') {
    strictKeys(input, ['kind', 'residualIds', 'owner', 'scope', 'retentionUntil', 'rollback'], '<root>', list);
    const residualIds = arrayValue(input, 'residualIds', '<root>', list);
    const owner = stringValue(input, 'owner', '<root>', list);
    const scope = stringValue(input, 'scope', '<root>', list);
    const retentionUntil = stringValue(input, 'retentionUntil', '<root>', list);
    const rollback = stringValue(input, 'rollback', '<root>', list);
    if (list.length > 0 || !residualIds || !owner || !scope || !retentionUntil || !rollback) return errors(list);
    if (!Number.isFinite(Date.parse(retentionUntil))) list.push({ path: '<root>.retentionUntil', message: 'must be an ISO timestamp' });
    return list.length > 0 ? errors(list) : { ok: true, value: { kind, residualIds, owner, scope, retentionUntil, rollback } };
  }
  if (kind === 'UNPROVEN_CLEANUP') {
    strictKeys(input, ['kind', 'evidenceRefs', 'reason'], '<root>', list);
    const evidenceRefs = arrayValue(input, 'evidenceRefs', '<root>', list);
    const reason = stringValue(input, 'reason', '<root>', list);
    if (list.length > 0 || !evidenceRefs || !reason) return errors(list);
    return { ok: true, value: { kind, evidenceRefs, reason } };
  }
  return errors([{ path: '<root>.kind', message: 'must be one of the three closed cleanup dispositions' }]);
}

export function authorityEnvelope(grant: QaExecutionGrant): QaAuthorityEnvelope {
  return { repositoryMutationClass: grant.repositoryMutationClass, applicationDataAuthority: grant.applicationDataAuthority, exactApprovedFixtureIds: grant.exactApprovedFixtureIds, applicationDataAuthorities: grant.applicationDataAuthorities };
}

export function cleanupFindingEnvelope(grant: QaExecutionGrant, cleanupDisposition: QaCleanupDisposition): QaCleanupFindingEnvelope {
  return { ...authorityEnvelope(grant), cleanupDisposition, cleanupOutcome: cleanupDispositionOutcome(cleanupDisposition) };
}

export function hashGrant(grant: QaExecutionGrant | UiExecutionGrant): string {
  return createHash('sha256').update(JSON.stringify(grant), 'utf8').digest('hex');
}

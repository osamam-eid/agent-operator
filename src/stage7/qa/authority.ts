import { createHash } from 'node:crypto';
import { authorityEnvelope, validateQaExecutionGrant } from '../grants.js';
import type { QaExecutionGrant } from '../types.js';
import type { QaDataAuthorizationPort, QaDataLedgerEntry, QaDataMutationRequest } from './types.js';

export class QaAuthorizationError extends Error {
  readonly code: 'GRANT_INVALID' | 'MUTATION_DENIED' | 'LEDGER_MISMATCH';
  readonly findingId: string;
  readonly evidenceId: string;
  constructor(code: QaAuthorizationError['code'], message: string, findingId: string, evidenceId: string) { super(message); this.name = 'QaAuthorizationError'; this.code = code; this.findingId = findingId; this.evidenceId = evidenceId; }
}

function exactFields(request: readonly string[], allowed: readonly string[]): boolean {
  return request.length === allowed.length && request.every((field) => allowed.includes(field));
}
function ref(prefix: string, operationId: string): string { return `${prefix}-${createHash('sha256').update(operationId, 'utf8').digest('hex').slice(0, 16)}`; }

export class QaDataAuthorization implements QaDataAuthorizationPort {
  #preflighted = false;
  readonly #entries: QaDataLedgerEntry[] = [];
  readonly #created = new Map<string, string>();
  constructor(private readonly grant: QaExecutionGrant, private readonly now: () => string = () => new Date().toISOString()) {}

  preDispatch(): void {
    const validated = validateQaExecutionGrant(this.grant);
    if (!validated.ok) throw new QaAuthorizationError('GRANT_INVALID', 'QA execution grant is not dispatchable.', 'QA-AUTHORITY-GRANT', 'QA-AUTHORITY-GRANT');
    if (this.grant.repositoryMutationClass !== 'READ_ONLY' || this.grant.qaRunId.trim() === '' || this.grant.qaEnvironmentApprovalHash.length !== 64) {
      throw new QaAuthorizationError('GRANT_INVALID', 'QA execution grant is not dispatchable.', 'QA-AUTHORITY-GRANT', 'QA-AUTHORITY-GRANT');
    }
    if (this.grant.applicationDataAuthority === 'NONE' && (this.grant.exactApprovedFixtureIds.length > 0 || this.grant.applicationDataAuthorities.length > 0)) {
      throw new QaAuthorizationError('GRANT_INVALID', 'NONE application-data authority cannot carry mutation scope.', 'QA-AUTHORITY-GRANT', 'QA-AUTHORITY-GRANT');
    }
    this.#preflighted = true;
  }

  authorize(request: QaDataMutationRequest): { readonly allowed: true; readonly operationId: string; readonly findingId: string; readonly evidenceId: string } {
    const findingId = ref('QA-AUTH-DENIAL', request.operationId);
    const evidenceId = ref('QA-AUTH-EVIDENCE', request.operationId);
    const deny = (reason: string): never => {
      this.#entries.push({ operationId: request.operationId, kind: request.kind, entityType: request.entityType, ...(request.recordId === undefined ? {} : { recordId: request.recordId }), fields: [...request.fields], qaRunId: request.qaRunId, status: 'DENIED', reason, findingId, evidenceId, authority: authorityEnvelope(this.grant), recordedAt: this.now() });
      throw new QaAuthorizationError('MUTATION_DENIED', 'QA application-data mutation was denied before action.', findingId, evidenceId);
    };
    if (!this.#preflighted) return deny('PRE_DISPATCH_REQUIRED');
    if (request.qaRunId !== this.grant.qaRunId) return deny('QA_RUN_ID_MISMATCH');
    if (this.grant.applicationDataAuthority === 'NONE') return deny('APPLICATION_DATA_AUTHORITY_NONE');
    const matching = this.grant.applicationDataAuthorities.filter((entry) => entry.kind === 'CREATE'
      ? ((request.kind === 'CREATE' || (request.exactFixtureId === undefined && this.#created.get(request.recordId ?? '') === request.entityType)) && entry.entityType === request.entityType && exactFields(request.fields, entry.allowedFields))
      : request.kind !== 'CREATE' && request.exactFixtureId === entry.recordId && request.recordId === entry.recordId && entry.entityType === request.entityType && entry.action === request.kind && exactFields(request.fields, entry.allowedFields));
    if (matching.length !== 1) return deny('EXACT_SCOPE_MISMATCH');
    if (request.kind === 'CREATE' && request.runTag !== request.qaRunId) return deny('RUN_TAG_REQUIRED');
    if (request.kind !== 'CREATE' && request.exactFixtureId === undefined && this.#created.get(request.recordId ?? '') !== request.entityType) return deny('RECORD_NOT_CREATED_BY_THIS_RUN');
    const entry: QaDataLedgerEntry = { operationId: request.operationId, kind: request.kind, entityType: request.entityType, ...(request.recordId === undefined ? {} : { recordId: request.recordId }), fields: [...request.fields], qaRunId: request.qaRunId, status: 'AUTHORIZED', findingId, evidenceId, authority: authorityEnvelope(this.grant), recordedAt: this.now() };
    this.#entries.push(entry);
    return { allowed: true, operationId: request.operationId, findingId, evidenceId };
  }

  complete(operationId: string, recordId: string): QaDataLedgerEntry {
    const index = this.#entries.findIndex((entry) => entry.operationId === operationId && entry.status === 'AUTHORIZED');
    if (index < 0) throw new QaAuthorizationError('LEDGER_MISMATCH', 'QA mutation completion did not match an authorized operation.', 'QA-LEDGER-MISMATCH', 'QA-LEDGER-MISMATCH');
    const current = this.#entries[index];
    if (current === undefined) throw new QaAuthorizationError('LEDGER_MISMATCH', 'QA mutation ledger entry is unavailable.', 'QA-LEDGER-MISMATCH', 'QA-LEDGER-MISMATCH');
    if (current.kind !== 'CREATE' && current.recordId !== recordId) throw new QaAuthorizationError('LEDGER_MISMATCH', 'QA mutation completion changed the authorized record identity.', current.findingId, current.evidenceId);
    if (current.kind === 'CREATE' && recordId.trim() === '') throw new QaAuthorizationError('LEDGER_MISMATCH', 'QA mutation completion requires a non-empty created record identity.', current.findingId, current.evidenceId);
    const completed: QaDataLedgerEntry = {
      ...current,
      recordId,
      status: 'COMPLETED',
      recordedAt: this.now(),
    };
    this.#entries[index] = completed;
    if (current.kind === 'CREATE') this.#created.set(recordId, current.entityType);
    return structuredClone(completed);
  }

  entries(): readonly QaDataLedgerEntry[] { return this.#entries.map((entry) => structuredClone(entry)); }
}

export function createQaDataAuthorization(grant: QaExecutionGrant, now?: () => string): QaDataAuthorizationPort { return new QaDataAuthorization(grant, now); }

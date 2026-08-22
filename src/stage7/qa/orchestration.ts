import { validateQaCleanupDisposition, cleanupDispositionOutcome, authorityEnvelope } from '../grants.js';
import type { QaCleanupDisposition, QaExecutionGrant, QaFinalResultAuthorityEnvelope, QaWhyAuthorityEnvelope } from '../types.js';
import type { QaCleanupRecord, QaDataLedgerEntry, QaDeploymentContext, QaEvidenceBundle, QaFindingAuthorityEnvelope, QaPreflightRecord, QaRunArtifacts } from './types.js';
import { assertApprovedPreflight } from './preflight.js';
import { validateQaEvidenceManifest, verifyQaEvidenceBundle } from './evidence.js';

export interface QaRunStartInput {
  readonly runId: string;
  readonly grant: QaExecutionGrant;
  readonly preflight: QaPreflightRecord;
  readonly deploymentContext: QaDeploymentContext;
  readonly executionLogReference: string;
  readonly now: string;
}

export class QaRunOrchestrationError extends Error {
  readonly code: 'PREFLIGHT_BLOCKED' | 'EVIDENCE_BLOCKED' | 'REVIEW_NOT_READY' | 'CLEANUP_HOLD';
  constructor(code: QaRunOrchestrationError['code'], message: string) { super(message); this.name = 'QaRunOrchestrationError'; this.code = code; }
}

export function qaCleanupRecord(disposition: QaCleanupDisposition, recordedAt: string): QaCleanupRecord {
  const checked = validateQaCleanupDisposition(disposition);
  if (!checked.ok) throw new QaRunOrchestrationError('CLEANUP_HOLD', 'QA cleanup disposition failed closed validation.');
  return { disposition: checked.value, outcome: cleanupDispositionOutcome(checked.value), residualIds: 'residualIds' in checked.value ? checked.value.residualIds : [], recordedAt };
}

export function qaAuthorityForWhy(grant: QaExecutionGrant, runId: string, cleanup: QaCleanupRecord): QaWhyAuthorityEnvelope {
  return { ...authorityEnvelope(grant), qaRunId: runId, cleanupOutcome: cleanup.outcome };
}
export function qaAuthorityForFinding(grant: QaExecutionGrant, findingId: string): QaFindingAuthorityEnvelope {
  return { ...authorityEnvelope(grant), findingId };
}


export function qaAuthorityForFinalResult(grant: QaExecutionGrant, cleanup: QaCleanupRecord, workflowStatus: QaFinalResultAuthorityEnvelope['workflowStatus']): QaFinalResultAuthorityEnvelope {
  return { ...authorityEnvelope(grant), workflowStatus, cleanupOutcome: cleanup.outcome };
}

export function buildQaExecutionLogPayload(runId: string, grant: QaExecutionGrant, entries: readonly unknown[], cleanup: QaCleanupRecord): Readonly<Record<string, unknown>> {
  return { qaRunId: runId, authority: authorityEnvelope(grant), entries: [...entries], cleanupDisposition: cleanup.disposition };
}

export function buildQaEvidencePayload(runId: string, grant: QaExecutionGrant, bundle: QaEvidenceBundle): Readonly<Record<string, unknown>> {
  return { qaRunId: runId, evidenceRefs: bundle.files.map((file) => file.evidenceId), checksumManifest: Object.fromEntries(bundle.files.map((file) => [file.evidenceId, { path: file.relativePath, sha256: file.sha256, sizeBytes: file.sizeBytes }])), roleCoverage: [], authority: authorityEnvelope(grant), cleanupDisposition: bundle.cleanup.disposition };
}

export function buildQaReviewPayload(grant: QaExecutionGrant, reviewOutcome: string, challengedEvidenceRefs: readonly string[], cleanup: QaCleanupRecord): Readonly<Record<string, unknown>> {
  return { reviewerRole: 'qa-v2-terra-reviewer', reviewOutcome, challengedEvidenceRefs: [...challengedEvidenceRefs], authority: authorityEnvelope(grant), cleanupDisposition: cleanup.disposition };
}

export function buildQaReportPayload(runId: string, grant: QaExecutionGrant, finalStatus: string, findingIds: readonly string[], cleanup: QaCleanupRecord): Readonly<Record<string, unknown>> {
  return { qaRunId: runId, finalStatus, findingIds: [...findingIds], authority: authorityEnvelope(grant), cleanupDisposition: cleanup.disposition };
}

export class QaRunOrchestrator {
  #state: QaRunArtifacts;
  constructor(input: QaRunStartInput) {
    assertApprovedPreflight(input.preflight);
    this.#state = { runId: input.runId, preflight: input.preflight, deploymentContext: input.deploymentContext, executionLogReference: input.executionLogReference, evidenceVerified: false, qaReportReferences: [], authority: authorityEnvelope(input.grant), dataLedger: [], finalGateStatus: 'NOT_READY' };
  }

  attachEvidence(bundle: QaEvidenceBundle, now: string): QaRunArtifacts {
    validateQaEvidenceManifest(bundle);
    if (bundle.qaRunId !== this.#state.runId || bundle.executionLogReference !== this.#state.executionLogReference) throw new QaRunOrchestrationError('EVIDENCE_BLOCKED', 'QA evidence bundle is not bound to this run.');
    this.#state = { ...this.#state, evidence: bundle, evidenceVerified: false, dataLedger: [...bundle.dataLedger], cleanup: bundle.cleanup, finalGateStatus: bundle.cleanup.outcome === 'HUMAN_DECISION_HOLD' ? 'HUMAN_DECISION_REQUIRED' : 'NOT_READY' };
    return structuredClone(this.#state);
  }

  async verifyEvidence(bundle: QaEvidenceBundle): Promise<QaRunArtifacts> {
    validateQaEvidenceManifest(bundle);
    if (bundle.qaRunId !== this.#state.runId || bundle.executionLogReference !== this.#state.executionLogReference) throw new QaRunOrchestrationError('EVIDENCE_BLOCKED', 'QA evidence bundle is not bound to this run.');
    try { await verifyQaEvidenceBundle(bundle); } catch { throw new QaRunOrchestrationError('EVIDENCE_BLOCKED', 'QA evidence bundle failed checksum, reference, secret, or cleanup validation.'); }
    this.#state = { ...this.#state, evidence: bundle, evidenceVerified: true, dataLedger: [...bundle.dataLedger], cleanup: bundle.cleanup, finalGateStatus: bundle.cleanup.outcome === 'HUMAN_DECISION_HOLD' ? 'HUMAN_DECISION_REQUIRED' : 'NOT_READY' };
    return structuredClone(this.#state);
  }

  completeTerraReview(lunaProviderSessionId: string, terraProviderSessionId: string, terraAgentIdentity: string, reviewReference: string): QaRunArtifacts {
    if (!this.#state.evidenceVerified || this.#state.evidence === undefined || this.#state.cleanup === undefined) throw new QaRunOrchestrationError('REVIEW_NOT_READY', 'Terra review cannot begin before evidence verification and cleanup are recorded.');
    if (lunaProviderSessionId === terraProviderSessionId || terraProviderSessionId.trim() === '' || terraAgentIdentity !== 'qa-review' || lunaProviderSessionId.trim() === '') throw new QaRunOrchestrationError('REVIEW_NOT_READY', 'Luna and Terra provider/agent identities must remain distinct.');
    if (reviewReference.trim() === '') throw new QaRunOrchestrationError('REVIEW_NOT_READY', 'Terra review reference is required.');
    this.#state = { ...this.#state, qaReportReferences: [...this.#state.qaReportReferences, reviewReference], finalGateStatus: this.#state.cleanup.outcome === 'HUMAN_DECISION_HOLD' ? 'HUMAN_DECISION_REQUIRED' : 'REVIEW_COMPLETE_HUMAN_PENDING' };
    return structuredClone(this.#state);
  }

  recordDataLedger(entries: readonly QaDataLedgerEntry[]): QaRunArtifacts {
    this.#state = { ...this.#state, dataLedger: entries.map((entry) => structuredClone(entry)) };
    return structuredClone(this.#state);
  }

  state(): QaRunArtifacts { return structuredClone(this.#state); }
}

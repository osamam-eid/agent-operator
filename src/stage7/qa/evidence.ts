import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { AgentResult } from '../../contracts.js';
import { cleanupDispositionOutcome } from '../grants.js';
import type { QaCleanupRecord, QaCriterionAttempt, QaEvidenceBundle, QaEvidenceFile, QaFlakyClassification } from './types.js';

export class QaEvidenceError extends Error {
  readonly code: 'INVALID_MANIFEST' | 'MISSING_REFERENCE' | 'CHECKSUM_MISMATCH' | 'SECRET_DETECTED' | 'CLEANUP_NOT_SETTLED';
  constructor(code: QaEvidenceError['code'], message: string) { super(message); this.name = 'QaEvidenceError'; this.code = code; }
}

export const SECRET_PATTERN = /(authorization\s*[:=]|bearer\s+[a-z0-9._-]+|password\s*[:=]|api[_-]?key\s*[:=]|secret\s*[:=]|cookie\s*[:=]|private[_ -]?key)/i;
const SECRET_PATH_PATTERN = /(password|token|secret|credential|cookie|auth)/i;

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validHash(value: string): boolean { return /^[0-9a-f]{64}$/.test(value); }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }

export function validateQaEvidenceManifest(bundle: QaEvidenceBundle): void {
  if (bundle.qaRunId.trim() === '' || bundle.root.trim() === '' || bundle.executionLogReference.trim() === '') throw new QaEvidenceError('INVALID_MANIFEST', 'QA evidence bundle identity is incomplete.');
  if (!unique(bundle.files.map((file) => file.evidenceId)) || !unique(bundle.files.map((file) => file.relativePath))) throw new QaEvidenceError('INVALID_MANIFEST', 'QA evidence references and paths must be unique.');
  for (const file of bundle.files) {
    if (file.relativePath.trim() === '' || path.isAbsolute(file.relativePath) || file.relativePath.split(/[\\/]/u).includes('..') || !validHash(file.sha256) || !Number.isInteger(file.sizeBytes) || file.sizeBytes < 0 || SECRET_PATH_PATTERN.test(file.relativePath)) throw new QaEvidenceError('INVALID_MANIFEST', 'QA evidence file manifest contains an unsafe or invalid entry.');
  }
  const refs = new Set(bundle.files.map((file) => file.evidenceId));
  if (!refs.has(bundle.executionLogReference) || bundle.reportReferences.some((ref) => !refs.has(ref)) || !unique(bundle.reportReferences)) throw new QaEvidenceError('MISSING_REFERENCE', 'QA report or execution-log evidence reference is not present in the checksum manifest.');
  if (bundle.authority.repositoryMutationClass !== 'READ_ONLY') throw new QaEvidenceError('INVALID_MANIFEST', 'QA evidence authority must declare READ_ONLY repository mutation.');
  if (bundle.cleanup.outcome !== cleanupDispositionOutcome(bundle.cleanup.disposition)) throw new QaEvidenceError('INVALID_MANIFEST', 'QA cleanup outcome does not match its closed disposition.');
  if (bundle.cleanup.outcome === 'HUMAN_DECISION_HOLD' && bundle.cleanup.disposition.kind !== 'UNPROVEN_CLEANUP') throw new QaEvidenceError('CLEANUP_NOT_SETTLED', 'Unproven cleanup must remain human decision hold.');
  if (bundle.cleanup.outcome === 'BLOCKING') throw new QaEvidenceError('CLEANUP_NOT_SETTLED', 'Unsafe residual application data blocks evidence completion.');
  if (bundle.dataLedger.some((entry) => JSON.stringify(entry.authority) !== JSON.stringify(bundle.authority))) throw new QaEvidenceError('INVALID_MANIFEST', 'QA data-ledger authority dimensions do not match the evidence authority envelope.');
}

async function readEvidence(root: string, file: QaEvidenceFile, readFile: (path: string) => Promise<Uint8Array>): Promise<void> {
  const canonicalRoot = path.resolve(root);
  const candidate = path.resolve(canonicalRoot, file.relativePath);
  if (!contained(canonicalRoot, candidate)) throw new QaEvidenceError('INVALID_MANIFEST', 'QA evidence path escaped the approved evidence root.');
  let content: Uint8Array;
  try { content = await readFile(candidate); } catch { throw new QaEvidenceError('MISSING_REFERENCE', 'A referenced QA evidence file is unavailable.'); }
  if (content.byteLength !== file.sizeBytes) throw new QaEvidenceError('CHECKSUM_MISMATCH', 'A referenced QA evidence file has an unexpected size.');
  if (createHash('sha256').update(content).digest('hex') !== file.sha256) throw new QaEvidenceError('CHECKSUM_MISMATCH', 'A referenced QA evidence checksum does not match.');
  const text = new TextDecoder().decode(content);
  if (SECRET_PATTERN.test(text)) throw new QaEvidenceError('SECRET_DETECTED', 'QA evidence contains a credential-bearing pattern.');
}

export async function verifyQaEvidenceBundle(bundle: QaEvidenceBundle, readFile: (filePath: string) => Promise<Uint8Array> = async (filePath) => fs.readFile(filePath)): Promise<void> {
  validateQaEvidenceManifest(bundle);
  for (const file of bundle.files) await readEvidence(bundle.root, file, readFile);
}

export function classifyQaFlakyAttempts(attempts: readonly QaCriterionAttempt[]): readonly QaFlakyClassification[] {
  const byCriterion = new Map<string, QaCriterionAttempt[]>();
  for (const attempt of attempts) {
    const list = byCriterion.get(attempt.criterionId) ?? [];
    if (attempt.attempt !== 1 && attempt.attempt !== 2) throw new QaEvidenceError('INVALID_MANIFEST', 'QA flakiness permits at most one rerun.');
    list.push(attempt);
    byCriterion.set(attempt.criterionId, list);
  }
  const output: QaFlakyClassification[] = [];
  for (const [criterionId, list] of byCriterion) {
    list.sort((left, right) => left.attempt - right.attempt);
    if (list.length === 1) {
      const only = list[0];
      if (only === undefined) throw new QaEvidenceError('INVALID_MANIFEST', 'QA criterion attempt is unavailable.');
      output.push({ criterionId, status: only.status, attempts: [only] });
      continue;
    }
    if (list.length !== 2 || list[0]?.attempt !== 1 || list[1]?.attempt !== 2) throw new QaEvidenceError('INVALID_MANIFEST', 'QA criterion attempts must be a first attempt and one rerun.');
    const first = list[0];
    const second = list[1];
    if (first === undefined || second === undefined) throw new QaEvidenceError('INVALID_MANIFEST', 'QA criterion attempts are unavailable.');
    const status = first.status !== 'PASS' && second.status === 'PASS' ? 'FLAKY' : second.status;
    output.push({ criterionId, status, attempts: [first, second] });
  }
  return output;
}

export function cleanupRecord(disposition: QaCleanupRecord['disposition'], recordedAt: string): QaCleanupRecord {
  return { disposition, outcome: cleanupDispositionOutcome(disposition), residualIds: 'residualIds' in disposition ? disposition.residualIds : [], recordedAt };
}

export function validateQaAgentArtifactReferences(result: AgentResult, availableArtifactIds: readonly string[], availableEvidenceIds: readonly string[]): void {
  const artifacts = new Set(availableArtifactIds);
  const evidence = new Set(availableEvidenceIds);
  if (result.producedArtifactRefs.some((reference) => !artifacts.has(reference)) || result.consumedArtifactRefs.some((reference) => !artifacts.has(reference)) || result.evidenceIds.some((reference) => !evidence.has(reference))) throw new QaEvidenceError('MISSING_REFERENCE', 'QA AgentResult contains an artifact or evidence reference that is not registered.');
}

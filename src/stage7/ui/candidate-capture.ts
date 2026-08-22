import * as path from 'node:path';
import { createProvisionalCandidateStore } from '../provisional-candidate-store.js';
import type { CandidateCaptureRequest, CandidateCaptureResult, CleanupLedger, ProvisionalCandidateStore, ProvisionalCandidate, Stage7ArtifactEnvelope } from '../types.js';
import type { WorktreeHandle, WorktreePort, WorktreeSnapshot } from '../../mutation/worktree.js';
import { assertCandidateArtifact, createUiArtifact, sha256 } from './artifacts.js';
import type { CandidateCaptureFilesystem, CandidateFile, UiCandidateCapturePort } from './contracts.js';

function relativePath(value: string): void {
  if (value.length === 0 || path.isAbsolute(value) || value === '..' || value.startsWith(`..${path.sep}`) || value.includes('\\')) throw new Error(`UI candidate path is outside the granted scope: ${value}`);
}
function assertMetadataSafe(value: unknown, pathLabel: string): void {
  if (Array.isArray(value)) { value.forEach((entry, index) => assertMetadataSafe(entry, `${pathLabel}[${index}]`)); return; }
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/secret|token|password|cookie|authorization|authheader|private.?reasoning|chain.?of.?thought/i.test(key)) throw new Error(`UI candidate metadata contains a forbidden field at ${pathLabel}.${key}.`);
    assertMetadataSafe(child, `${pathLabel}.${key}`);
  }
}

export class LocalCandidateCapturePort implements UiCandidateCapturePort {
  constructor(private readonly delegate: WorktreePort, private readonly filesystem: CandidateCaptureFilesystem, private readonly now: () => string, private readonly producer = 'stage7-ui-implementation') {}
  createIsolated(projectRoot: string, worktreeId: string): Promise<WorktreeHandle> { return this.delegate.createIsolated(projectRoot, worktreeId); }
  realpath(candidate: string): Promise<string> { return this.delegate.realpath(candidate); }
  remove(worktree: WorktreeHandle): Promise<void> { return this.delegate.remove(worktree); }
  snapshot(worktree: WorktreeHandle): Promise<WorktreeSnapshot> { return this.delegate.snapshot(worktree); }
  executeMutation(worktree: WorktreeHandle, mutationClass: Parameters<WorktreePort['executeMutation']>[1], allowedPaths: readonly string[], operation: string): Promise<void> { return this.delegate.executeMutation(worktree, mutationClass, allowedPaths, operation); }
  diff(worktree: WorktreeHandle, baseline: WorktreeSnapshot): Promise<readonly string[]> { return this.delegate.diff(worktree, baseline); }
  async capture(request: CandidateCaptureRequest & { readonly signal?: AbortSignal }): Promise<CandidateCaptureResult> {
    if (request.signal?.aborted) throw new Error('Candidate capture cancelled.');
    for (const changedPath of request.changedPaths) relativePath(changedPath);
    const files = await this.filesystem.collect(request.worktree, request.changedPaths, request.baseline, request.signal ?? new AbortController().signal);
    if (request.changedPaths.length === 0 || files.length !== request.changedPaths.length || new Set(files.map((file) => file.path)).size !== request.changedPaths.length || files.some((file) => !request.changedPaths.includes(file.path))) throw new Error('Candidate capture did not return the exact changed-path set.');
    const fileHashes: Record<string, string> = {};
    const changedFiles: Record<string, unknown>[] = [];
    for (const file of files) {
      relativePath(file.path);
      const hash = sha256(file.content);
      fileHashes[file.path] = hash;
      changedFiles.push({ path: file.path, mode: file.mode, hash, location: file.location, sizeBytes: file.content.byteLength });
    }
    const scan = await this.filesystem.secretScan(files, request.signal ?? new AbortController().signal);
    if (scan.status !== 'CLEAN') {
      const categories = scan.findings.map((finding) => `${finding.category}:${finding.path}`).join(', ');
      throw new Error(`UI candidate secret scan blocked capture (${scan.status}; redacted findings: ${categories || 'scanner failure'}).`);
    }
    const candidateId = `candidate-${request.nodeId}-${sha256(JSON.stringify({ baseline: request.baseline.identity, changedPaths: request.changedPaths, fileHashes })).slice(0, 24)}`;
    const manifest = await this.filesystem.materializationManifest(request.worktree, request.changedPaths);
    const dependencies = await this.filesystem.dependencyInputs(request.worktree);
    assertMetadataSafe(manifest, 'materializationManifest');
    assertMetadataSafe(dependencies, 'dependencyInputs');
    const payload = {
      baselineIdentity: request.baseline.identity,
      changedPaths: [...request.changedPaths],
      materializationManifest: { ...manifest, baseline: request.baseline.identity, changedFiles },
      dependencyInputs: dependencies,
      fileHashes,
      secretScan: { status: 'CLEAN' as const, scannerVersion: scan.scannerVersion, scannedAt: scan.scannedAt, coverage: scan.coverage },
      capturedAt: this.now(),
      producer: this.producer,
    };
    const bundle = createUiArtifact('ui-candidate-bundle.v1', payload, { artifactId: candidateId, nodeId: request.nodeId, sessionId: request.operatorSessionId, producer: this.producer, location: `/quarantine/${candidateId}`, createdAt: payload.capturedAt });
    assertCandidateArtifact(bundle);
    const candidate: ProvisionalCandidate = { candidateId, bundle, baselineIdentity: request.baseline.identity, changedPaths: [...request.changedPaths], status: 'QUARANTINED' };
    return { candidate };
  }
}

export function createLocalCandidateCapturePort(delegate: WorktreePort, filesystem: CandidateCaptureFilesystem, now: () => string): UiCandidateCapturePort {
  return new LocalCandidateCapturePort(delegate, filesystem, now);
}

export function createLedgerAwareProvisionalCandidateStore(delegate: ProvisionalCandidateStore, ledger: CleanupLedger, ledgerId: string, now: () => string): ProvisionalCandidateStore {
  return {
    quarantine(candidate): void {
      delegate.quarantine(candidate);
      ledger.update(ledgerId, { provisionalCandidateId: candidate.candidateId, state: 'PROVISIONAL_QUARANTINED', updatedAt: now() });
    },
    promote(candidateId): Stage7ArtifactEnvelope {
      const promoted = delegate.promote(candidateId);
      ledger.update(ledgerId, { provisionalCandidateId: candidateId, state: 'PROMOTED', updatedAt: now() });
      return promoted;
    },
    invalidate(candidateId, reason): void {
      delegate.invalidate(candidateId, reason);
      ledger.update(ledgerId, { provisionalCandidateId: candidateId, state: 'CLEANED', updatedAt: now() });
    },
    get(candidateId): ProvisionalCandidate | undefined { return delegate.get(candidateId); },
  };
}

export { createProvisionalCandidateStore };

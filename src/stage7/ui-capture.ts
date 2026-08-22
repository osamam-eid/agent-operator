import { GovernedMutationExecutor } from '../mutation/governed.js';
import type { MutationClock } from '../mutation/governed.js';
import type { GovernedMutationRequest, GovernedMutationResult, WorktreePort, WorktreeSnapshot, WorktreeHandle } from '../mutation/worktree.js';
import type { CandidateCapturePort, CandidateCaptureRequest, CandidateCapturingWorktreePort, GovernedUiImplementationPort, ProvisionalCandidateStore, Stage7ArtifactEnvelope, UiExecutionGrant } from './types.js';

export class CapturingWorktreePort implements CandidateCapturingWorktreePort {
  #lastCandidateId: string | undefined = undefined;
  constructor(private readonly delegate: WorktreePort, private readonly capture: CandidateCapturePort, private readonly store: ProvisionalCandidateStore, private readonly requestContext: () => Omit<CandidateCaptureRequest, 'worktree' | 'baseline' | 'changedPaths'>) {}
  get lastCandidateId(): string | undefined { return this.#lastCandidateId; }
  createIsolated(projectRoot: string, worktreeId: string): Promise<WorktreeHandle> { return this.delegate.createIsolated(projectRoot, worktreeId); }
  realpath(candidate: string): Promise<string> { return this.delegate.realpath(candidate); }
  remove(worktree: WorktreeHandle): Promise<void> { return this.delegate.remove(worktree); }
  snapshot(worktree: WorktreeHandle): Promise<WorktreeSnapshot> { return this.delegate.snapshot(worktree); }
  executeMutation(worktree: WorktreeHandle, mutationClass: Parameters<WorktreePort['executeMutation']>[1], allowedPaths: readonly string[], operation: string): Promise<void> { return this.delegate.executeMutation(worktree, mutationClass, allowedPaths, operation); }
  async diff(worktree: WorktreeHandle, baseline: WorktreeSnapshot): Promise<readonly string[]> {
    const changedPaths = await this.delegate.diff(worktree, baseline);
    const captured = await this.capture.capture({ ...this.requestContext(), worktree, baseline, changedPaths });
    this.store.quarantine(captured.candidate);
    this.#lastCandidateId = captured.candidate.candidateId;
    return changedPaths;
  }
}

export class GovernedUiImplementationAdapter implements GovernedUiImplementationPort {
  constructor(private readonly executor: GovernedMutationExecutor, private readonly provisional: ProvisionalCandidateStore, private readonly candidateId: () => string | undefined, private readonly registry: { register(artifact: Stage7ArtifactEnvelope): void }) {}
  async execute(request: GovernedMutationRequest & { readonly grant: UiExecutionGrant }): Promise<GovernedMutationResult & { readonly candidate: Stage7ArtifactEnvelope }> {
    let result: GovernedMutationResult;
    try {
      result = await this.executor.execute(request);
    } catch (error) {
      const candidateId = this.candidateId();
      if (candidateId !== undefined) this.provisional.invalidate(candidateId, error instanceof Error ? error.message : String(error));
      throw error;
    }
    if (result.worktreeRemoved !== true) {
      const candidateId = this.candidateId();
      if (candidateId !== undefined) this.provisional.invalidate(candidateId, 'Governed executor did not prove worktree removal.');
      throw new Error('Governed UI implementation did not prove worktreeRemoved=true.');
    }
    const candidateId = this.candidateId();
    if (candidateId === undefined) throw new Error('Governed UI implementation completed without a provisional candidate.');
    try {
      const candidate = this.provisional.promote(candidateId);
      if (candidate.payload['baselineIdentity'] !== result.baseline.identity || JSON.stringify(candidate.payload['changedPaths']) !== JSON.stringify(result.changedPaths)) {
        throw new Error('Provisional candidate does not match governed executor evidence.');
      }
      this.registry.register(candidate);
      return { ...result, candidate };
    } catch (error) {
      this.provisional.invalidate(candidateId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}

export type CandidateCaptureClock = MutationClock;

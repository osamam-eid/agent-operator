import {
  assertIsolatedWorktree,
  MutationGovernanceError,
  type GovernedMutationRequest,
  type GovernedMutationResult,
  type MutationScope,
  type VerificationPorts,
  type WorktreePort,
} from './worktree.js';

export interface MutationClock { now(): string; }

function validateScope(scope: MutationScope): void {
  if (scope.scopeHash.trim() === '' || scope.contractHash.trim() === '') throw new MutationGovernanceError('SCOPE_NOT_FROZEN', 'Mutation scope and contract hashes are required.');
  if (scope.allowedPaths.length === 0 || scope.allowedPaths.some((path) => path.trim() === '')) throw new MutationGovernanceError('SCOPE_NOT_FROZEN', 'Mutation scope must contain non-empty allowed paths.');
  if (scope.baselineIdentity.trim() === '') throw new MutationGovernanceError('BASELINE_REQUIRED', 'Mutation scope must identify its baseline.');
}

function validateGate(request: GovernedMutationRequest): void {
  if (!request.gate.approved) throw new MutationGovernanceError('HUMAN_GATE_REQUIRED', 'Mutation requires an approved human gate.');
  if (request.gate.gateId.trim() === '' || request.gate.graphHash.trim() === '') throw new MutationGovernanceError('HUMAN_GATE_INVALID', 'Approved mutation gate must identify its gate and graph.');
}

function asGovernanceError(error: unknown): MutationGovernanceError {
  if (error instanceof MutationGovernanceError) return error;
  return new MutationGovernanceError('MUTATION_FAILED', error instanceof Error ? error.message : 'Mutation failed without a typed error.');
}

/** Executes only the governed local mutation path; it intentionally exposes no commit, push, merge, deploy, or external-action port. */
export class GovernedMutationExecutor {
  constructor(private readonly worktrees: WorktreePort, private readonly verification: VerificationPorts, private readonly clock: MutationClock) {}

  async execute(request: GovernedMutationRequest): Promise<GovernedMutationResult> {
    validateScope(request.scope);
    validateGate(request);
    const worktree = await this.worktrees.createIsolated(request.projectRoot, request.worktreeId);
    let removed = false;
    try {
      await assertIsolatedWorktree(worktree, request.projectRoot, request.approvedWorktreeParent, (candidate) => this.worktrees.realpath(candidate));
      const baseline = await this.worktrees.snapshot(worktree);
      if (baseline.identity !== request.scope.baselineIdentity) throw new MutationGovernanceError('BASELINE_MISMATCH', 'Worktree baseline does not match the frozen mutation scope.');
      await this.worktrees.executeMutation(worktree, request.scope.mutationClass, request.scope.allowedPaths, request.operation);
      const changedPaths = await this.worktrees.diff(worktree, baseline);
      if (changedPaths.some((changedPath) => !request.scope.allowedPaths.includes(changedPath))) throw new MutationGovernanceError('SCOPE_VIOLATION', 'Mutation produced a path outside the frozen scope.');
      const behavioral = await this.verification.behavioral(request.scope, worktree);
      const conformance = await this.verification.conformance(request.scope, worktree);
      if (!behavioral.passed || !conformance.passed) throw new MutationGovernanceError('VERIFICATION_FAILED', 'Behavioral and conformance verification are both required to pass.');
      const result = { worktree, worktreeRemoved: true as const, baseline, changedPaths, behavioral, conformance, completedAt: this.clock.now() };
      await this.worktrees.remove(worktree);
      removed = true;
      return result;
    } catch (error) {
      const governanceError = asGovernanceError(error);
      if (!removed) {
        try {
          await this.worktrees.remove(worktree);
          removed = true;
        } catch (cleanupError) {
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new MutationGovernanceError('CLEANUP_FAILED', `${governanceError.message} Cleanup of isolated worktree also failed: ${cleanupMessage}`);
        }
      }
      throw governanceError;
    }
  }
}

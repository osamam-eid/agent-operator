import {
  assertIsolatedWorktree,
  MutationGovernanceError,
  type GovernedMutationRequest,
  type GovernedMutationResult,
  type MutationScope,
  type VerificationPorts,
  type WorktreePort,
} from './worktree.js';
import { assessScopeDrift, type RecoveryPackage, type RecoveryPackagePort } from '../execution-safety.js';

export interface MutationClock { now(): string; }

function validateScope(scope: MutationScope): void {
  if (scope.scopeHash.trim() === '' || scope.contractHash.trim() === '') throw new MutationGovernanceError('SCOPE_NOT_FROZEN', 'Mutation scope and contract hashes are required.');
  if (scope.allowedPaths.length === 0 || scope.allowedPaths.some((path) => path.trim() === '')) throw new MutationGovernanceError('SCOPE_NOT_FROZEN', 'Mutation scope must contain non-empty allowed paths.');
  if (scope.baselineIdentity.trim() === '') throw new MutationGovernanceError('BASELINE_REQUIRED', 'Mutation scope must identify its baseline.');
  if (scope.authorizedOperationHash !== undefined && !/^[0-9a-f]{64}$/.test(scope.authorizedOperationHash)) throw new MutationGovernanceError('SCOPE_NOT_FROZEN', 'Authorized operation hash must be 64 lowercase hex characters.');
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
  constructor(
    private readonly worktrees: WorktreePort,
    private readonly verification: VerificationPorts,
    private readonly clock: MutationClock,
    private readonly recovery: RecoveryPackagePort,
  ) {}

  async execute(request: GovernedMutationRequest): Promise<GovernedMutationResult> {
    validateScope(request.scope);
    validateGate(request);
    const worktree = await this.worktrees.createIsolated(request.projectRoot, request.worktreeId);
    let removed = false;
    let recoveryPackage: RecoveryPackage | undefined;
    let observedChangedPaths: readonly string[] = [];
    try {
      await assertIsolatedWorktree(worktree, request.projectRoot, request.approvedWorktreeParent, (candidate) => this.worktrees.realpath(candidate));
      const baseline = await this.worktrees.snapshot(worktree);
      if (baseline.identity !== request.scope.baselineIdentity) throw new MutationGovernanceError('BASELINE_MISMATCH', 'Worktree baseline does not match the frozen mutation scope.');
      if (this.recovery !== undefined) recoveryPackage = await this.recovery.prepare(request, worktree, baseline, this.clock.now());
      const beforeMutation = assessScopeDrift({ allowedPaths: request.scope.allowedPaths, changedPaths: [], ...(request.scope.authorizedOperationHash === undefined ? {} : { authorizedOperationHash: request.scope.authorizedOperationHash }), proposedOperation: request.operation });
      if (beforeMutation.status === 'SCOPE_DRIFT_DETECTED') throw new MutationGovernanceError('SCOPE_DRIFT_DETECTED', `Proposed mutation diverges from its authorization: ${beforeMutation.reasonCodes.join(', ')}.`);
      await this.worktrees.executeMutation(worktree, request.scope.mutationClass, request.scope.allowedPaths, request.operation);
      const changedPaths = await this.worktrees.diff(worktree, baseline);
      observedChangedPaths = changedPaths;
      const drift = assessScopeDrift({ allowedPaths: request.scope.allowedPaths, changedPaths, ...(request.scope.authorizedOperationHash === undefined ? {} : { authorizedOperationHash: request.scope.authorizedOperationHash }), proposedOperation: request.operation });
      if (drift.status === 'SCOPE_DRIFT_DETECTED') throw new MutationGovernanceError('SCOPE_DRIFT_DETECTED', `Mutation diverged from frozen scope: ${drift.reasonCodes.join(', ')}.`);
      if (recoveryPackage !== undefined && this.recovery !== undefined) recoveryPackage = await this.recovery.update(recoveryPackage, { status: 'MUTATED', changedPaths, now: this.clock.now() });
      const behavioral = await this.verification.behavioral(request.scope, worktree);
      const conformance = await this.verification.conformance(request.scope, worktree);
      if (!behavioral.passed || !conformance.passed) throw new MutationGovernanceError('VERIFICATION_FAILED', 'Behavioral and conformance verification are both required to pass.');
      if (recoveryPackage !== undefined && this.recovery !== undefined) recoveryPackage = await this.recovery.update(recoveryPackage, { status: 'VERIFIED', changedPaths, now: this.clock.now() });
      const result = { worktree, worktreeRemoved: true as const, baseline, changedPaths, behavioral, conformance, completedAt: this.clock.now() };
      await this.worktrees.remove(worktree);
      removed = true;
      if (recoveryPackage !== undefined && this.recovery !== undefined) await this.recovery.update(recoveryPackage, { status: 'CLEANED', changedPaths: observedChangedPaths, now: this.clock.now() });
      return result;
    } catch (error) {
      const governanceError = asGovernanceError(error);
      if (!removed) {
        try {
          await this.worktrees.remove(worktree);
          removed = true;
          if (recoveryPackage !== undefined && this.recovery !== undefined) await this.recovery.update(recoveryPackage, { status: 'CLEANED', changedPaths: observedChangedPaths, now: this.clock.now() });
        } catch (cleanupError) {
          if (recoveryPackage !== undefined && this.recovery !== undefined) await this.recovery.update(recoveryPackage, { status: 'REQUIRES_HUMAN', changedPaths: observedChangedPaths, now: this.clock.now() });
          const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
          throw new MutationGovernanceError('CLEANUP_FAILED', `${governanceError.message} Cleanup of isolated worktree also failed: ${cleanupMessage}`);
        }
      }
      throw governanceError;
    }
  }
}

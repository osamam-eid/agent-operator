import * as path from 'node:path';

import type { MutationClass } from '../contracts.js';

export interface WorktreeSnapshot {
  readonly identity: string;
  readonly digest: string;
  readonly capturedAt: string;
}

export interface WorktreeHandle {
  readonly worktreeId: string;
  readonly path: string;
  readonly projectRoot: string;
}

export interface WorktreePort {
  createIsolated(projectRoot: string, worktreeId: string): Promise<WorktreeHandle>;
  /** Resolves a path through the port's authoritative filesystem seam. The
   * executor never trusts lexical path strings for containment decisions. */
  realpath(path: string): Promise<string>;
  remove(worktree: WorktreeHandle): Promise<void>;
  snapshot(worktree: WorktreeHandle): Promise<WorktreeSnapshot>;
  executeMutation(worktree: WorktreeHandle, mutationClass: Exclude<MutationClass, 'READ_ONLY'>, allowedPaths: readonly string[], operation: string): Promise<void>;
  diff(worktree: WorktreeHandle, baseline: WorktreeSnapshot): Promise<readonly string[]>;
}

export interface MutationScope {
  readonly scopeHash: string;
  readonly contractHash: string;
  readonly allowedPaths: readonly string[];
  readonly baselineIdentity: string;
  readonly mutationClass: Exclude<MutationClass, 'READ_ONLY'>;
  /** Optional exact hash of the approved operation text. When present, any
   * semantic operation change blocks before mutation. */
  readonly authorizedOperationHash?: string;
}

export interface MutationGate {
  readonly approved: boolean;
  readonly gateId: string;
  readonly graphHash: string;
  readonly approvedAt: string;
}

export interface VerificationPorts {
  behavioral(scope: MutationScope, worktree: WorktreeHandle): Promise<VerificationReport>;
  conformance(scope: MutationScope, worktree: WorktreeHandle): Promise<VerificationReport>;
}

export interface VerificationReport {
  readonly passed: boolean;
  readonly evidence: readonly string[];
  readonly reason?: string;
}

export interface GovernedMutationRequest {
  readonly projectRoot: string;
  /** The only parent under which the isolated worktree may be created. */
  readonly approvedWorktreeParent: string;
  readonly worktreeId: string;
  readonly scope: MutationScope;
  readonly gate: MutationGate;
  readonly operation: string;
}

export interface GovernedMutationResult {
  /** The handle is retained for evidence identity; its filesystem has already
   * been removed before this result is returned. */
  readonly worktree: WorktreeHandle;
  readonly worktreeRemoved: true;
  readonly baseline: WorktreeSnapshot;
  readonly changedPaths: readonly string[];
  readonly behavioral: VerificationReport;
  readonly conformance: VerificationReport;
  readonly completedAt: string;
}

export class MutationGovernanceError extends Error {
  readonly reasonCode: string;
  constructor(reasonCode: string, message: string) { super(message); this.name = 'MutationGovernanceError'; this.reasonCode = reasonCode; }
}

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isWithin(parent: string, candidate: string): boolean {
  return isContained(parent, candidate) && path.relative(parent, candidate) !== '';
}

/** Validates canonical containment and project identity after the port has
 * created the handle. Realpath resolution rejects symlink escapes that lexical
 * prefix/equality checks cannot see. */
export async function assertIsolatedWorktree(
  worktree: WorktreeHandle,
  projectRoot: string,
  approvedWorktreeParent: string,
  realpath: (candidate: string) => Promise<string>,
): Promise<void> {
  const [canonicalWorktree, canonicalProjectRoot, canonicalHandleRoot, canonicalParent] = await Promise.all([
    realpath(worktree.path),
    realpath(projectRoot),
    realpath(worktree.projectRoot),
    realpath(approvedWorktreeParent),
  ]);
  if (canonicalWorktree === canonicalProjectRoot) {
    throw new MutationGovernanceError('WORKTREE_NOT_ISOLATED', 'Mutation worktree must not equal the project root.');
  }
  if (canonicalHandleRoot !== canonicalProjectRoot) {
    throw new MutationGovernanceError('WORKTREE_PROJECT_ROOT_MISMATCH', 'Mutation worktree reports a project root different from the requested project root.');
  }
  if (!isContained(canonicalParent, canonicalProjectRoot) || !isWithin(canonicalParent, canonicalWorktree)) {
    throw new MutationGovernanceError('WORKTREE_OUTSIDE_APPROVED_PARENT', 'Mutation worktree and project root must both be contained by the approved worktree parent.');
  }
}

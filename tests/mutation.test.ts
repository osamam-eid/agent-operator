import { describe, expect, test } from 'bun:test';

import { GovernedMutationExecutor } from '../src/mutation/governed.js';
import type { MutationScope, WorktreeHandle, WorktreePort } from '../src/mutation/worktree.js';
import type { VerificationPorts } from '../src/mutation/worktree.js';

const scope: MutationScope = {
  scopeHash: 'scope',
  contractHash: 'contract',
  allowedPaths: ['src/file.ts'],
  baselineIdentity: 'baseline',
  mutationClass: 'LOCAL',
};

const request = {
  projectRoot: '/approved/project',
  approvedWorktreeParent: '/approved',
  worktreeId: 'worktree-1',
  scope,
  gate: { approved: true, gateId: 'gate-1', graphHash: 'graph', approvedAt: '2026-01-01T00:00:00.000Z' },
  operation: 'change file',
};

class FakeWorktreePort implements WorktreePort {
  readonly removed: WorktreeHandle[] = [];
  handle: WorktreeHandle = { worktreeId: 'worktree-1', path: '/approved/worktrees/worktree-1', projectRoot: '/approved/project' };
  readonly canonical = new Map<string, string>();
  baselineIdentity = 'baseline';
  changedPaths: readonly string[] = ['src/file.ts'];
  failure: 'mutation' | 'scope' | undefined;
  behavioralPassed = true;
  conformancePassed = true;

  async createIsolated(): Promise<WorktreeHandle> { return this.handle; }
  async realpath(candidate: string): Promise<string> { return this.canonical.get(candidate) ?? candidate; }
  async remove(worktree: WorktreeHandle): Promise<void> { this.removed.push(worktree); }
  async snapshot(): Promise<{ identity: string; digest: string; capturedAt: string }> {
    return { identity: this.baselineIdentity, digest: 'digest', capturedAt: '2026-01-01T00:00:00.000Z' };
  }
  async executeMutation(): Promise<void> {
    if (this.failure === 'mutation') throw new Error('mutation failed');
  }
  async diff(): Promise<readonly string[]> {
    return this.failure === 'scope' ? ['outside.ts'] : this.changedPaths;
  }
}

const verification = (port: FakeWorktreePort): VerificationPorts => ({
  async behavioral() { return { passed: port.behavioralPassed, evidence: [] }; },
  async conformance() { return { passed: port.conformancePassed, evidence: [] }; },
});

function executor(port: FakeWorktreePort): GovernedMutationExecutor {
  return new GovernedMutationExecutor(port, verification(port), { now: () => '2026-01-01T00:00:00.000Z' });
}

describe('GovernedMutationExecutor worktree ownership', () => {
  test('removes the worktree after successful evidence capture', async () => {
    const port = new FakeWorktreePort();
    const result = await executor(port).execute(request);
    expect(result.worktreeRemoved).toBe(true);
    expect(port.removed).toHaveLength(1);
  });

  test('removes the worktree after baseline, scope, mutation, and verification failures', async () => {
    for (const failure of ['baseline', 'scope', 'mutation', 'verification'] as const) {
      const port = new FakeWorktreePort();
      if (failure === 'baseline') port.baselineIdentity = 'different';
      if (failure === 'scope') port.failure = 'scope';
      if (failure === 'mutation') port.failure = 'mutation';
      if (failure === 'verification') port.behavioralPassed = false;
      await expect(executor(port).execute(request)).rejects.toBeDefined();
      expect(port.removed).toHaveLength(1);
    }
  });
});

describe('GovernedMutationExecutor canonical containment', () => {
  test('rejects project-root equality, outside paths, symlink escapes, and mismatched roots using canonical paths', async () => {
    const cases = [
      { path: '/approved/project', reasonCode: 'WORKTREE_NOT_ISOLATED' },
      { path: '/outside/worktree', reasonCode: 'WORKTREE_OUTSIDE_APPROVED_PARENT' },
      { path: '/approved/worktrees/link', canonicalPath: '/outside/escaped', reasonCode: 'WORKTREE_OUTSIDE_APPROVED_PARENT' },
      { projectRoot: '/approved/other', reasonCode: 'WORKTREE_PROJECT_ROOT_MISMATCH' },
    ] as const;
    for (const current of cases) {
      const port = new FakeWorktreePort();
      port.handle = { ...port.handle, ...('projectRoot' in current ? { projectRoot: current.projectRoot } : {}), ...('path' in current ? { path: current.path } : {}) };
      if ('canonicalPath' in current && 'path' in current) port.canonical.set(current.path, current.canonicalPath);
      await expect(executor(port).execute(request)).rejects.toMatchObject({ reasonCode: current.reasonCode });
      expect(port.removed).toHaveLength(1);
    }
  });
});

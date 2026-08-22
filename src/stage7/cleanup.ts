import * as path from 'node:path';
import type { CleanupLedger, CleanupLedgerEntry, CleanupReconciliation, CleanupReconciler } from './types.js';

export function createCleanupLedger(): CleanupLedger {
  const entries = new Map<string, CleanupLedgerEntry>();
  return {
    preCreate(input): CleanupLedgerEntry {
      if (entries.has(input.ledgerId)) throw new Error(`Cleanup ledger id "${input.ledgerId}" already exists.`);
      const entry: CleanupLedgerEntry = { ...input, state: 'PREPARED', updatedAt: input.updatedAt ?? input.createdAt };
      entries.set(entry.ledgerId, entry);
      return structuredClone(entry);
    },
    update(ledgerId, patch): CleanupLedgerEntry {
      const current = entries.get(ledgerId);
      if (current === undefined) throw new Error(`Cleanup ledger id "${ledgerId}" does not exist.`);
      const next = { ...current, ...patch, updatedAt: patch.updatedAt ?? current.updatedAt };
      entries.set(ledgerId, next);
      return structuredClone(next);
    },
    get(ledgerId): CleanupLedgerEntry | undefined { const entry = entries.get(ledgerId); return entry === undefined ? undefined : structuredClone(entry); },
    list(): readonly CleanupLedgerEntry[] { return [...entries.values()].map((entry) => structuredClone(entry)); },
  };
}

export interface CleanupFilesystem {
  realpath(candidate: string): Promise<string>;
  removeKnownWorktree(path: string): Promise<void>;
  deleteProvisional(candidateId: string): Promise<void>;
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function createCleanupReconciler(filesystem: CleanupFilesystem, ledger: CleanupLedger, now: () => string): CleanupReconciler {
  return {
    async reconcile(entries): Promise<readonly CleanupReconciliation[]> {
      const results: CleanupReconciliation[] = [];
      for (const entry of entries) {
        if (entry.state === 'CLEANED' || entry.state === 'PROMOTED') {
          results.push({ ledgerId: entry.ledgerId, status: 'CLEANED', redispatchAllowed: false, evidence: ['No in-flight Stage-7 cleanup remains.'] });
          continue;
        }
        try {
          if (entry.worktreePath !== undefined) {
            const [parent, worktree] = await Promise.all([filesystem.realpath(entry.approvedWorktreeParent), filesystem.realpath(entry.worktreePath)]);
            if (!contained(parent, worktree)) throw new Error('Known worktree is outside the approved parent.');
            await filesystem.removeKnownWorktree(worktree);
          }
          if (entry.provisionalCandidateId !== undefined) await filesystem.deleteProvisional(entry.provisionalCandidateId);
          ledger.update(entry.ledgerId, { state: 'CLEANED', updatedAt: now() });
          results.push({ ledgerId: entry.ledgerId, status: 'CLEANED', redispatchAllowed: false, evidence: ['Known worktree and provisional candidate were reconciled.'] });
        } catch (error) {
          ledger.update(entry.ledgerId, { state: 'UNKNOWN', updatedAt: now() });
          results.push({ ledgerId: entry.ledgerId, status: 'UNKNOWN', redispatchAllowed: false, evidence: [error instanceof Error ? error.message : String(error)] });
        }
      }
      return results;
    },
  };
}

import type { WorktreePort, WorktreeHandle, WorktreeSnapshot } from '../mutation/worktree.js';

export class LedgeredWorktreePort implements WorktreePort {
  constructor(private readonly delegate: WorktreePort, private readonly ledger: CleanupLedger, private readonly ledgerId: () => string, private readonly now: () => string, private readonly operatorSessionId: string, private readonly approvedWorktreeParent: string) {}
  async createIsolated(projectRoot: string, worktreeId: string): Promise<WorktreeHandle> {
    const createdAt = this.now();
    const entry = this.ledger.preCreate({ ledgerId: this.ledgerId(), operatorSessionId: this.operatorSessionId, worktreeId, approvedWorktreeParent: this.approvedWorktreeParent, createdAt });
    try {
      const worktree = await this.delegate.createIsolated(projectRoot, worktreeId);
      this.ledger.update(entry.ledgerId, { worktreePath: worktree.path, state: 'WORKTREE_CREATED', updatedAt: this.now() });
      return worktree;
    } catch (error) {
      this.ledger.update(entry.ledgerId, { state: 'UNKNOWN', updatedAt: this.now() });
      throw error;
    }
  }
  realpath(candidate: string): Promise<string> { return this.delegate.realpath(candidate); }
  remove(worktree: WorktreeHandle): Promise<void> { return this.delegate.remove(worktree); }
  snapshot(worktree: WorktreeHandle): Promise<WorktreeSnapshot> { return this.delegate.snapshot(worktree); }
  executeMutation(worktree: WorktreeHandle, mutationClass: Parameters<WorktreePort['executeMutation']>[1], allowedPaths: readonly string[], operation: string): Promise<void> { return this.delegate.executeMutation(worktree, mutationClass, allowedPaths, operation); }
  diff(worktree: WorktreeHandle, baseline: WorktreeSnapshot): Promise<readonly string[]> { return this.delegate.diff(worktree, baseline); }
}

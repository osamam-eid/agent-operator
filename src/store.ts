/**
 * Agent Operator — Stage 2 session store.
 *
 * Owns persistence of the `StoredOperatorSession` envelope defined in
 * `./runtime-types`: an in-memory store for tests/dry runs, and a
 * local-filesystem store for real `/operator` sessions. Both implement the
 * `OperatorSessionStore` interface unchanged. File writes hold a short-lived
 * per-session filesystem lock across optimistic comparison and atomic replace,
 * preventing duplicate transitions across concurrent processes.
 *
 * The file store never trusts bytes read from disk: every load and save
 * round-trips through the strict Stage 2 envelope validator. Invalid JSON,
 * unknown fields, duplicate/mismatched gates, or identity mismatches are
 * errors, never silently treated as "not found". `appendJournal` is defined
 * in `./journal` and re-exported here so the store slice has one import surface.
 */

import { lstatSync, promises as fs, readdirSync } from 'node:fs';
import * as crypto from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { validateStoredOperatorSession } from './runtime-validators.js';
import type { OperatorSessionStore, OperatorSessionStoreLister, StoredOperatorSession } from './runtime-types.js';

export { appendJournal } from './journal.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Thrown when a `save()` call's `expectedUpdatedAt` no longer matches the
 * stored record (or no stored record exists yet to compare against). */
export class StoreConflictError extends Error {
  readonly operatorSessionId: string;

  constructor(message: string, operatorSessionId: string) {
    super(message);
    this.name = 'StoreConflictError';
    this.operatorSessionId = operatorSessionId;
  }
}

/** Thrown when persisted (or about-to-be-persisted) data cannot be trusted:
 * invalid JSON, a contract-validation failure, or an identity mismatch
 * (e.g. a gate or session whose id disagrees with its file name or its
 * companion record). Distinct from "not found", which is reserved for a
 * genuinely absent file. */
export class StoreCorruptionError extends Error {
  readonly operatorSessionId: string;

  constructor(message: string, operatorSessionId: string) {
    super(message);
    this.name = 'StoreCorruptionError';
    this.operatorSessionId = operatorSessionId;
  }
}


function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Reconstructs a trustworthy `StoredOperatorSession` from parsed JSON or a
 * caller-supplied record. Unknown fields and every nested/cross-field
 * violation are rejected by the Stage 2 envelope validator.
 */
function validateEnvelope(raw: unknown, expectedOperatorSessionId?: string): StoredOperatorSession {
  const fallbackId = expectedOperatorSessionId ?? 'unknown';
  const result = validateStoredOperatorSession(raw);
  if (!result.ok) {
    throw new StoreCorruptionError(
      `stored session envelope for "${fallbackId}" failed contract validation: ${result.errors.map((error) => `${error.path || '<root>'}: ${error.message}`).join('; ')}`,
      fallbackId,
    );
  }
  if (
    expectedOperatorSessionId !== undefined &&
    result.value.session.operatorSessionId !== expectedOperatorSessionId
  ) {
    throw new StoreCorruptionError(
      `stored session identity "${result.value.session.operatorSessionId}" does not match the requested session "${expectedOperatorSessionId}"`,
      expectedOperatorSessionId,
    );
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// MemoryOperatorSessionStore
// ---------------------------------------------------------------------------

/**
 * In-process store backed by a `Map` on the instance (no module-level or
 * global state, no locks). Every `save`/`load` defensively structured-clones
 * its payload so neither the store nor the caller can observe the other's
 * later in-place mutations.
 */
export class MemoryOperatorSessionStore implements OperatorSessionStore {

  async listSessionIds(): Promise<readonly string[]> { return [...this.#records.keys()].sort(); }
  readonly #records = new Map<string, StoredOperatorSession>();

  async load(operatorSessionId: string): Promise<StoredOperatorSession | undefined> {
    const current = this.#records.get(operatorSessionId);
    return current === undefined ? undefined : structuredClone(current);
  }

  async save(record: StoredOperatorSession, expectedUpdatedAt?: string): Promise<void> {
    const operatorSessionId = record.session.operatorSessionId;
    const current = this.#records.get(operatorSessionId);

    if (expectedUpdatedAt !== undefined) {
      if (current === undefined) {
        throw new StoreConflictError(
          `no existing record for operator session "${operatorSessionId}" to compare against expectedUpdatedAt`,
          operatorSessionId,
        );
      }
      if (current.session.updatedAt !== expectedUpdatedAt) {
        throw new StoreConflictError(
          `stale write for operator session "${operatorSessionId}": expected updatedAt "${expectedUpdatedAt}" but stored record has "${current.session.updatedAt}"`,
          operatorSessionId,
        );
      }
    }

    this.#records.set(operatorSessionId, structuredClone(record));
  }
}

// ---------------------------------------------------------------------------
// FileOperatorSessionStore
// ---------------------------------------------------------------------------

/** Session ids gate every filesystem path this store ever touches. Matches
 * the `ID_PATTERN` enforced by `validateOperatorSession`'s `operatorSessionId`
 * field: no `/`, `\`, null bytes, or leading `.`/`-`/`_`, so a valid id can
 * never itself form a `..` path segment or escape the root directory. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface FileOperatorSessionStoreOptions {
  /** Directory holding one `<operatorSessionId>.json` file per session.
   * Defaults to a home-relative path so no environment needs a hardcoded
   * absolute path. Created on first write with mode 0700. */
  readonly rootDir?: string;
}

/** Resolves `operatorSessionId` to a path under `rootDir`, rejecting any id
 * that fails the strict id pattern or whose resolved path would not stay
 * contained within `rootDir` (defense in depth beyond the pattern check). */
function resolveSessionPath(rootDir: string, operatorSessionId: string): string {
  if (typeof operatorSessionId !== 'string' || !SESSION_ID_PATTERN.test(operatorSessionId)) {
    throw new StoreCorruptionError(`invalid operator session id: ${JSON.stringify(operatorSessionId)}`, String(operatorSessionId));
  }
  const target = path.resolve(rootDir, `${operatorSessionId}.json`);
  const relative = path.relative(rootDir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new StoreCorruptionError(`resolved session path escapes the store root directory: ${operatorSessionId}`, operatorSessionId);
  }
  return target;
}

async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(dir, 0o700);
}

const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;

interface WriteLock {
  readonly handle: FileHandle;
  readonly path: string;
}

async function acquireWriteLock(rootDir: string, operatorSessionId: string): Promise<WriteLock> {
  const lockPath = path.join(rootDir, `.${operatorSessionId}.lock`);
  const startedAt = Date.now();
  for (;;) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600);
      if (process.platform !== 'win32') await handle.chmod(0o600);
      return { handle, path: lockPath };
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'EEXIST') throw error;
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw new StoreConflictError(
          `timed out waiting for the write lock for operator session "${operatorSessionId}"`,
          operatorSessionId,
        );
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

/**
 * Local-filesystem store: one JSON file per session under `rootDir`, named
 * `<operatorSessionId>.json`. Writes are atomic (temp file in the same
 * directory, then `rename`) and fail-closed: on any error before the
 * rename, the temp file is removed so a failed write never leaves partial
 * state behind and never leaves a stray temp file after a successful save.
 */
export class FileOperatorSessionStore implements OperatorSessionStore, OperatorSessionStoreLister {
  readonly #rootDir: string;

  constructor(options: FileOperatorSessionStoreOptions = {}) {
    this.#rootDir = path.resolve(options.rootDir ?? path.join(os.homedir(), '.agent-operator', 'sessions'));
  }

  /** Stage-10 enumeration: lists contained session ids only. Symlinked or
   * non-regular entries are rejected rather than surfaced. */
  async listSessionIds(): Promise<readonly string[]> {
    let rawEntries: string[];
    try {
      rawEntries = readdirSync(this.#rootDir);
    } catch {
      return [];
    }
    const entries = rawEntries.filter((entry) => entry.endsWith('.json')).map((entry) => entry.slice(0, -'.json'.length));
    const valid: string[] = [];
    for (const id of entries) {
      if (!SESSION_ID_PATTERN.test(id)) continue;
      const full = resolveSessionPath(this.#rootDir, id);
      try {
        const stats = lstatSync(full);
        if (stats.isFile() && !stats.isSymbolicLink()) valid.push(id);
      } catch {
        // Unreadable entries are skipped; load() re-validates on read.
      }
    }
    return valid.sort();
  }

  async load(operatorSessionId: string): Promise<StoredOperatorSession | undefined> {
    const filePath = resolveSessionPath(this.#rootDir, operatorSessionId);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new StoreCorruptionError(
        `stored session "${operatorSessionId}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        operatorSessionId,
      );
    }

    return validateEnvelope(parsed, operatorSessionId);
  }
  async save(record: StoredOperatorSession, expectedUpdatedAt?: string): Promise<void> {
    const validated = validateEnvelope(record);
    const operatorSessionId = validated.session.operatorSessionId;
    const filePath = resolveSessionPath(this.#rootDir, operatorSessionId);
    await ensureDirectory(this.#rootDir);

    const lock = await acquireWriteLock(this.#rootDir, operatorSessionId);
    try {
      if (expectedUpdatedAt !== undefined) {
        const existing = await this.load(operatorSessionId);
        if (existing === undefined) {
          throw new StoreConflictError(
            `no existing record for operator session "${operatorSessionId}" to compare against expectedUpdatedAt`,
            operatorSessionId,
          );
        }
        if (existing.session.updatedAt !== expectedUpdatedAt) {
          throw new StoreConflictError(
            `stale write for operator session "${operatorSessionId}": expected updatedAt "${expectedUpdatedAt}" but stored record has "${existing.session.updatedAt}"`,
            operatorSessionId,
          );
        }
      }

      const payload = JSON.stringify(validated, null, 2);
      const tmpPath = path.join(this.#rootDir, `.${operatorSessionId}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(tmpPath, payload, { mode: 0o600 });
        if (process.platform !== 'win32') await fs.chmod(tmpPath, 0o600);
        await fs.rename(tmpPath, filePath);
      } catch (error) {
        await fs.rm(tmpPath, { force: true }).catch(() => {});
        throw error;
      }
    } finally {
      try {
        await lock.handle.close();
      } finally {
        await fs.rm(lock.path, { force: true });
      }
    }
  }
}

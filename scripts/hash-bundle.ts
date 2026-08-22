/**
 * Agent Operator — Stage 4 bundle hash gate.
 *
 * Computes a deterministic content digest over a directory tree for use as
 * an exact provenance gate before Stage 4 execution work begins. The
 * algorithm is intentionally small: walk every file under the target root,
 * excluding any path component named `.git` or `node_modules` and any file
 * named `.DS_Store`; normalize each remaining relative path to POSIX UTF-8;
 * sort paths by unsigned UTF-8 byte order; then feed
 * `u64be(pathByteLength) || pathBytes || u64be(contentByteLength) || contentBytes`
 * for each file, in that order, into a single SHA-256 hash.
 *
 * Symlinks and other non-regular entries (sockets, FIFOs, device files) are
 * rejected rather than followed or silently skipped, so the digest can never
 * silently diverge from what a naive directory copy would contain. The
 * target root itself is rejected the same way: missing, not a directory, or
 * a symlink (which `lstat` never reports as a directory) all fail closed.
 *
 * Run directly for a CLI report:
 *   bun scripts/hash-bundle.ts <targetDir> [--manifest]
 *
 * `hashBundle` and `collectBundleFiles` are also exported for direct use
 * (tests, other tooling, the Stage 4 provenance gate) without spawning a
 * subprocess.
 */

import { promises as fs } from 'node:fs';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

const EXCLUDED_PATH_COMPONENTS: Record<string, true> = { '.git': true, node_modules: true };
const EXCLUDED_FILE_NAMES: Record<string, true> = { '.DS_Store': true };

export const HASH_BUNDLE_ALGORITHM = 'sha256-length-prefixed-v1';

/** Thrown when the target root does not exist or is not a real directory
 * (including when it is a symlink: `lstat` never reports a symlink as a
 * directory, so it is rejected rather than followed). */
export class HashBundleTargetError extends Error {
  readonly targetPath: string;
  readonly code: 'ENOENT' | 'ENOTDIR';

  constructor(message: string, targetPath: string, code: 'ENOENT' | 'ENOTDIR') {
    super(message);
    this.name = 'HashBundleTargetError';
    this.targetPath = targetPath;
    this.code = code;
  }
}

/** Thrown when a walked entry is a symlink or another non-regular file type
 * (socket, FIFO, block/character device). The walker checks
 * `Dirent#isSymbolicLink()` before any other type check, so it never
 * dereferences a symlink to decide inclusion. */
export class HashBundleEntryError extends Error {
  readonly entryPath: string;
  readonly code: 'ESYMLINK' | 'EUNSUPPORTED_TYPE';

  constructor(message: string, entryPath: string, code: 'ESYMLINK' | 'EUNSUPPORTED_TYPE') {
    super(message);
    this.name = 'HashBundleEntryError';
    this.entryPath = entryPath;
    this.code = code;
  }
}

export interface BundleFile {
  /** Relative path from the target root, normalized to POSIX ('/'-joined) UTF-8. */
  readonly relativePath: string;
  /** Absolute filesystem path used to read file content. */
  readonly absolutePath: string;
}

export interface BundleFileEntry {
  readonly path: string;
  readonly bytes: number;
}

export interface HashBundleResult {
  readonly algorithm: string;
  readonly root: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly digest: string;
  readonly files: readonly BundleFileEntry[];
}

/**
 * Recursively lists every canonical input file under `root`, sorted by
 * unsigned UTF-8 byte order of their normalized relative path.
 *
 * Excludes any path component named `.git` or `node_modules` (a directory
 * of that name is never descended into) and any file named `.DS_Store`.
 * Rejects the root itself when missing or not a real directory, and rejects
 * any symlink or other non-regular entry encountered during the walk.
 */
export async function collectBundleFiles(root: string): Promise<BundleFile[]> {
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new HashBundleTargetError(`target directory does not exist: ${root}`, root, 'ENOENT');
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    throw new HashBundleTargetError(`target is not a directory: ${root}`, root, 'ENOTDIR');
  }

  const files: BundleFile[] = [];

  async function walk(dirAbs: string, segments: readonly string[]): Promise<void> {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      const name = entry.name;
      if (EXCLUDED_PATH_COMPONENTS[name]) continue;

      const absChild = path.join(dirAbs, name);
      if (entry.isSymbolicLink()) {
        throw new HashBundleEntryError(`refusing to follow symlink: ${absChild}`, absChild, 'ESYMLINK');
      }

      const relSegments = [...segments, name];
      if (entry.isDirectory()) {
        await walk(absChild, relSegments);
      } else if (entry.isFile()) {
        if (EXCLUDED_FILE_NAMES[name]) continue;
        files.push({ relativePath: relSegments.join('/'), absolutePath: absChild });
      } else {
        throw new HashBundleEntryError(`unsupported special file: ${absChild}`, absChild, 'EUNSUPPORTED_TYPE');
      }
    }
  }

  await walk(root, []);
  files.sort((a, b) => Buffer.compare(Buffer.from(a.relativePath, 'utf8'), Buffer.from(b.relativePath, 'utf8')));
  return files;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * Hashes every canonical input file under `root` into one SHA-256 digest:
 * `u64be(pathByteLength) || pathBytes || u64be(contentByteLength) || contentBytes`
 * per file, fed to the hash in ascending unsigned-UTF-8-byte path order.
 */
export async function hashBundle(root: string): Promise<HashBundleResult> {
  const files = await collectBundleFiles(root);
  const hash = crypto.createHash('sha256');
  const entries: BundleFileEntry[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const content = await fs.readFile(file.absolutePath);
    const pathBytes = Buffer.from(file.relativePath, 'utf8');
    const pathLengthPrefix = Buffer.alloc(8);
    pathLengthPrefix.writeBigUInt64BE(BigInt(pathBytes.length));
    const contentLengthPrefix = Buffer.alloc(8);
    contentLengthPrefix.writeBigUInt64BE(BigInt(content.length));
    hash.update(pathLengthPrefix);
    hash.update(pathBytes);
    hash.update(contentLengthPrefix);
    hash.update(content);
    totalBytes += content.length;
    entries.push({ path: file.relativePath, bytes: content.length });
  }

  return {
    algorithm: HASH_BUNDLE_ALGORITHM,
    root,
    fileCount: entries.length,
    totalBytes,
    digest: hash.digest('hex'),
    files: entries,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printUsageAndExit(): never {
  process.stderr.write('usage: hash-bundle <targetDir> [--manifest]\n');
  process.exit(2);
}

async function runCli(argv: readonly string[]): Promise<void> {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const includeManifest = argv.includes('--manifest');
  const targetArg = positional[0];
  if (!targetArg) printUsageAndExit();

  const root = path.resolve(targetArg);
  let result: HashBundleResult;
  try {
    result = await hashBundle(root);
  } catch (error) {
    if (error instanceof HashBundleTargetError || error instanceof HashBundleEntryError) {
      process.stderr.write(`hash-bundle: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const output = includeManifest
    ? result
    : {
        algorithm: result.algorithm,
        root: result.root,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        digest: result.digest,
      };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}
if (import.meta.main) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`hash-bundle: unexpected error: ${message}\n`);
    process.exit(1);
  });
}

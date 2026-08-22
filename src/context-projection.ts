/**
 * Agent Operator — Stage 4 per-node context projection.
 *
 * Materializes a deterministic, read-only filesystem snapshot for exactly
 * one node's declared inputs, and only those inputs. This module never
 * accepts an `OperatorSession`, a graph, or any other whole-session object:
 * its only input is an explicit, caller-resolved list of local file
 * sources (declared `consumes` artifacts/evidence content and applicable
 * `AGENTS.md` content, per plan section 5.1), each already labeled and
 * already resolved to an absolute path by the caller.
 *
 * Every source must:
 *   - resolve to an absolute, local filesystem path (no URL/internal-URI
 *     scheme, no relative path);
 *   - resolve inside one of the caller-declared `allowedRoots` (an
 *     undeclared root is rejected, matching plan section 3.2's
 *     "snapshot root is the only allowed local root");
 *   - be a real regular file, never a symlink or other special file
 *     (socket, FIFO, device) — this repository's existing bundle-hash
 *     walker (`scripts/hash-bundle.ts`) uses the same fail-closed
 *     `lstat`-before-follow convention;
 *   - fit inside the caller-supplied per-file/total-byte/file-count caps.
 *
 * On success, every declared source is copied into a fresh destination
 * directory (which the caller must not have created yet — this module
 * owns snapshot construction, not snapshot placement), the directory is
 * locked to `0500` and every file inside it to `0400` on POSIX platforms,
 * and an immutable manifest (per-entry label/path/size/sha256, plus one
 * combined digest) is returned. `BLOCKED_REQUIRED_CONTEXT` (plan section
 * 5.1's "an oversized required context blocks... rather than silently
 * dropping files") is the caller's responsibility to raise from the typed
 * `ProjectionError` this module throws; this module never drops a
 * declared source silently.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One declared, already-resolved local input the caller wants projected.
 * `label` must be unique across a single `materializeProjection` request;
 * it becomes part of the deterministic on-disk file name and the manifest
 * entry, so a node's prompt can refer to a source by its stable label
 * instead of a filesystem path. */
export interface ProjectionSource {
  readonly label: string;
  readonly absolutePath: string;
}

export interface ProjectionLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
}

export interface ProjectionManifestEntry {
  readonly label: string;
  /** POSIX-relative path from the projection root; deterministic given the
   * same `label` (index-prefixed, sanitized — never the raw source path). */
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export const PROJECTION_MANIFEST_ALGORITHM = 'sha256-per-entry-length-prefixed-v1';

export interface ProjectionManifest {
  readonly algorithm: string;
  readonly projectionRoot: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  /** Sorted by `relativePath` ascending unsigned UTF-8 byte order, so the
   * manifest is deterministic independent of the caller's `sources` order. */
  readonly entries: readonly ProjectionManifestEntry[];
  /** One SHA-256 over every entry in manifest order:
   * `u64be(relativePathByteLength) || relativePathBytes || u64be(sha256ByteLength) || sha256Bytes`
   * per entry — a single stable digest for the whole projection, usable as
   * `NodeExecutionRequest`'s "immutable projection manifest" summary
   * value without re-hashing file content. */
  readonly manifestDigest: string;
}

export interface MaterializeProjectionRequest {
  /** Absolute destination directory. Must not already exist — the caller
   * (the adapter) allocates a fresh, unique per-attempt directory; this
   * module never reuses or merges into an existing directory. */
  readonly destinationRoot: string;
  /** Absolute trusted roots every source must resolve within. Typically
   * `[projectRoot]`, or `[projectRoot, providerSessionDir]` when a source
   * legitimately lives outside the project (e.g. a prior node's artifact
   * under the Agent Operator provider-session directory). */
  readonly allowedRoots: readonly string[];
  readonly sources: readonly ProjectionSource[];
  readonly limits: ProjectionLimits;
}

export interface MaterializeProjectionResult {
  readonly projectionRoot: string;
  readonly manifest: ProjectionManifest;
}

export type ProjectionErrorCode =
  | 'MALFORMED_REQUEST'
  | 'DESTINATION_EXISTS'
  | 'DUPLICATE_LABEL'
  | 'FILE_COUNT_EXCEEDED'
  | 'TOTAL_BYTES_EXCEEDED'
  | 'FILE_BYTES_EXCEEDED'
  | 'NON_LOCAL_SOURCE'
  | 'UNDECLARED_ROOT'
  | 'PATH_ESCAPE'
  | 'SOURCE_NOT_FOUND'
  | 'SYMLINK_REJECTED'
  | 'SPECIAL_FILE_REJECTED';

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;
  readonly label?: string;

  constructor(code: ProjectionErrorCode, message: string, label?: string) {
    super(message);
    this.name = 'ProjectionError';
    this.code = code;
    if (label !== undefined) {
      this.label = label;
    }
  }
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const NON_LOCAL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function isWithinRoot(root: string, target: string): boolean {
  const normalizedRoot = path.normalize(root);
  const normalizedTarget = path.normalize(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
}

/**
 * Expands the explicitly configured shared project root into a stable list
 * of file sources. This is used only for graph nodes whose context policy is
 * `shared`; isolated/summary/evidence-only nodes continue to receive only
 * declared artifacts and evidence. Oversized trees fail closed rather than
 * being silently truncated.
 */
export async function collectSharedProjectSources(projectRoot: string, maxFiles: number): Promise<ProjectionSource[]> {
  if (!path.isAbsolute(projectRoot) || !Number.isInteger(maxFiles) || maxFiles < 0) {
    throw new ProjectionError('MALFORMED_REQUEST', 'shared project root must be absolute and maxFiles must be a non-negative integer');
  }

  let rootStat;
  try {
    rootStat = await fs.lstat(projectRoot);
  } catch (error) {
    throw new ProjectionError('SOURCE_NOT_FOUND', `shared project root could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (rootStat.isSymbolicLink()) {
    throw new ProjectionError('SYMLINK_REJECTED', `shared project root is a symlink: ${projectRoot}`);
  }
  if (!rootStat.isDirectory()) {
    throw new ProjectionError('SPECIAL_FILE_REJECTED', `shared project root is not a directory: ${projectRoot}`);
  }

  const sources: ProjectionSource[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(projectRoot, absolutePath).split(path.sep).join('/');
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new ProjectionError('SYMLINK_REJECTED', `shared project entry is a symlink: ${absolutePath}`, `project:${relativePath}`);
      }
      if (stat.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new ProjectionError('SPECIAL_FILE_REJECTED', `shared project entry is not a regular file: ${absolutePath}`, `project:${relativePath}`);
      }
      sources.push({ label: `project:${relativePath}`, absolutePath });
      if (sources.length > maxFiles) {
        throw new ProjectionError('FILE_COUNT_EXCEEDED', `shared project contains more than the cap of ${maxFiles} files`);
      }
    }
  };

  await walk(projectRoot);
  return sources;
}

function sanitizeLabelSegment(label: string): string {
  const sanitized = label.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return sanitized.length > 0 ? sanitized : 'source';
}

interface ValidatedSource {
  readonly label: string;
  readonly absolutePath: string;
  readonly sizeBytes: number;
}

/** Validates request shape/limits/one source against caps, roots, and
 * type — but performs no filesystem writes. Read-only preflight so a
 * rejected request never leaves a partial destination directory behind. */
async function validateSource(
  source: ProjectionSource,
  allowedRoots: readonly string[],
): Promise<ValidatedSource> {
  const { label, absolutePath } = source;
  if (typeof label !== 'string' || label.length === 0 || typeof absolutePath !== 'string' || absolutePath.length === 0) {
    throw new ProjectionError('MALFORMED_REQUEST', 'every source needs a non-empty string label and absolutePath', label);
  }
  if (NON_LOCAL_SCHEME_PATTERN.test(absolutePath)) {
    throw new ProjectionError('NON_LOCAL_SOURCE', `source "${label}" is a URL/internal URI, not a local path: ${absolutePath}`, label);
  }
  if (!path.isAbsolute(absolutePath)) {
    throw new ProjectionError('PATH_ESCAPE', `source "${label}" is not an absolute path: ${absolutePath}`, label);
  }
  const resolved = path.normalize(absolutePath);
  const withinAnyRoot = allowedRoots.some((root) => isWithinRoot(root, resolved));
  if (!withinAnyRoot) {
    throw new ProjectionError('UNDECLARED_ROOT', `source "${label}" (${resolved}) is outside every declared allowed root`, label);
  }

  let stat;
  try {
    stat = await fs.lstat(resolved);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      throw new ProjectionError('SOURCE_NOT_FOUND', `source "${label}" does not exist: ${resolved}`, label);
    }
    throw new ProjectionError('SOURCE_NOT_FOUND', `source "${label}" could not be inspected: ${error instanceof Error ? error.message : String(error)}`, label);
  }
  if (stat.isSymbolicLink()) {
    throw new ProjectionError('SYMLINK_REJECTED', `source "${label}" is a symlink: ${resolved}`, label);
  }
  if (!stat.isFile()) {
    throw new ProjectionError('SPECIAL_FILE_REJECTED', `source "${label}" is not a regular file: ${resolved}`, label);
  }

  return { label, absolutePath: resolved, sizeBytes: stat.size };
}

/**
 * Materializes exactly the declared `sources` into a fresh read-only
 * snapshot at `destinationRoot`. Fails closed: every source is validated
 * before any file is written, so a rejection never leaves a partial
 * snapshot on disk. Throws a typed `ProjectionError` on any violation.
 */
export async function materializeProjection(
  request: MaterializeProjectionRequest,
): Promise<MaterializeProjectionResult> {
  const { destinationRoot, allowedRoots, sources, limits } = request;

  if (typeof destinationRoot !== 'string' || destinationRoot.length === 0 || !path.isAbsolute(destinationRoot)) {
    throw new ProjectionError('MALFORMED_REQUEST', 'destinationRoot must be a non-empty absolute path');
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0 || !allowedRoots.every((root) => typeof root === 'string' && path.isAbsolute(root))) {
    throw new ProjectionError('MALFORMED_REQUEST', 'allowedRoots must be a non-empty array of absolute paths');
  }
  if (!Array.isArray(sources)) {
    throw new ProjectionError('MALFORMED_REQUEST', 'sources must be an array');
  }
  if (
    typeof limits?.maxFiles !== 'number' ||
    typeof limits?.maxTotalBytes !== 'number' ||
    typeof limits?.maxFileBytes !== 'number' ||
    limits.maxFiles < 0 ||
    limits.maxTotalBytes < 0 ||
    limits.maxFileBytes < 0
  ) {
    throw new ProjectionError('MALFORMED_REQUEST', 'limits.maxFiles/maxTotalBytes/maxFileBytes must be non-negative numbers');
  }

  const normalizedDestination = path.normalize(destinationRoot);
  const destinationStat = await fs.lstat(normalizedDestination).catch((error: unknown) => {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw new ProjectionError('DESTINATION_EXISTS', `destinationRoot could not be inspected: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (destinationStat !== undefined) {
    throw new ProjectionError('DESTINATION_EXISTS', `destinationRoot already exists: ${normalizedDestination}`);
  }

  if (sources.length > limits.maxFiles) {
    throw new ProjectionError('FILE_COUNT_EXCEEDED', `${sources.length} declared sources exceed the cap of ${limits.maxFiles}`);
  }

  const seenLabels = new Set<string>();
  const validated: ValidatedSource[] = [];
  let totalBytes = 0;
  for (const source of sources) {
    if (source === null || typeof source !== 'object') {
      throw new ProjectionError('MALFORMED_REQUEST', 'every source must be an object with a label and absolutePath');
    }
    if (typeof source.label === 'string') {
      if (seenLabels.has(source.label)) {
        throw new ProjectionError('DUPLICATE_LABEL', `duplicate source label: ${source.label}`, source.label);
      }
      seenLabels.add(source.label);
    }
    const one = await validateSource(source, allowedRoots);
    if (one.sizeBytes > limits.maxFileBytes) {
      throw new ProjectionError('FILE_BYTES_EXCEEDED', `source "${one.label}" is ${one.sizeBytes} bytes, exceeding the per-file cap of ${limits.maxFileBytes}`, one.label);
    }
    totalBytes += one.sizeBytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new ProjectionError('TOTAL_BYTES_EXCEEDED', `declared sources total ${totalBytes} bytes, exceeding the cap of ${limits.maxTotalBytes}`);
    }
    validated.push(one);
  }

  // Every source is now validated. Read content once, in declaration
  // order, deriving each entry's stable file name from its (unique)
  // index + label so relativePath is deterministic and collision-free
  // without depending on the source's original basename.
  interface PreparedEntry {
    readonly label: string;
    readonly relativePath: string;
    readonly content: Buffer;
    readonly sha256: string;
  }
  const prepared: PreparedEntry[] = [];
  for (let index = 0; index < validated.length; index += 1) {
    const source = validated[index]!;
    let content: Buffer;
    try {
      content = await fs.readFile(source.absolutePath);
    } catch (error) {
      throw new ProjectionError('SOURCE_NOT_FOUND', `source "${source.label}" could not be read: ${error instanceof Error ? error.message : String(error)}`, source.label);
    }
    // Defends against a TOCTOU swap between the lstat check above and this
    // read: re-check the file wasn't replaced by a symlink/special file.
    const recheck = await fs.lstat(source.absolutePath);
    if (recheck.isSymbolicLink() || !recheck.isFile()) {
      throw new ProjectionError('SYMLINK_REJECTED', `source "${source.label}" changed type between validation and read: ${source.absolutePath}`, source.label);
    }
    const relativePath = `${String(index).padStart(4, '0')}_${sanitizeLabelSegment(source.label)}`;
    prepared.push({
      label: source.label,
      relativePath,
      content,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }

  try {
    await fs.mkdir(normalizedDestination, { recursive: false, mode: 0o700 });
  } catch (error) {
    throw new ProjectionError('DESTINATION_EXISTS', `failed to create destinationRoot: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const entry of prepared) {
    const targetPath = path.join(normalizedDestination, entry.relativePath);
    await fs.writeFile(targetPath, entry.content, { mode: 0o600 });
  }

  if (process.platform !== 'win32') {
    for (const entry of prepared) {
      await fs.chmod(path.join(normalizedDestination, entry.relativePath), 0o400);
    }
    await fs.chmod(normalizedDestination, 0o500);
  }

  const entries = prepared
    .map((entry) => ({ label: entry.label, relativePath: entry.relativePath, sizeBytes: entry.content.length, sha256: entry.sha256 }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.relativePath, 'utf8'), Buffer.from(b.relativePath, 'utf8')));

  const digest = createHash('sha256');
  for (const entry of entries) {
    const pathBytes = Buffer.from(entry.relativePath, 'utf8');
    const hashBytes = Buffer.from(entry.sha256, 'utf8');
    const pathLen = Buffer.alloc(8);
    pathLen.writeBigUInt64BE(BigInt(pathBytes.length));
    const hashLen = Buffer.alloc(8);
    hashLen.writeBigUInt64BE(BigInt(hashBytes.length));
    digest.update(pathLen);
    digest.update(pathBytes);
    digest.update(hashLen);
    digest.update(hashBytes);
  }

  const manifest: ProjectionManifest = {
    algorithm: PROJECTION_MANIFEST_ALGORITHM,
    projectionRoot: normalizedDestination,
    fileCount: entries.length,
    totalBytes,
    entries,
    manifestDigest: digest.digest('hex'),
  };

  return { projectionRoot: normalizedDestination, manifest };
}

/**
 * Agent Operator — Stage 4 safe custom tools.
 *
 * Replaces the approved plan's inline `tool_call`-veto extension
 * (`operatorToolGuard`, plan section 3.2/5.1). A locally verified OMP 17.3.5 API inspection
 * proved a restricted child session (`restrictToolNames: true`) does not
 * load inline extensions at all, so a `tool_call` hook can never run
 * there. The verified working boundary instead is: define package-owned
 * custom tools named `operator_read`, `operator_grep`, and `operator_glob`
 * that wrap the SDK's own `createReadToolDefinition` /
 * `createGrepToolDefinition` / `createFindToolDefinition` (the underlying
 * "find" tool, renamed here to `operator_glob`) and `defineTool` factories,
 * validate every path argument against the node's projection root
 * *before* delegating to the underlying tool's `execute`, and pass them to
 * `createAgentSession` via `customTools` + `allowRestrictedCustomTools:
 * true` alongside `restrictToolNames: true` and an exact `toolNames` list.
 * A live spike of this exact wrapper vetoed a `/etc/hosts` read before the
 * base tool's `execute` ever ran.
 *
 * This module never imports the OMP SDK directly. Only `src/adapters/*`
 * (out of scope for this module) holds that dependency; the real
 * `createReadToolDefinition` / `createGrepToolDefinition` /
 * `createFindToolDefinition` / `defineTool` functions are injected here as
 * `OperatorToolFactories`, matching this repository's existing seam
 * convention of "narrow structural API...tests use a deterministic fake"
 * (see `Stage3WorkflowCompilerOptions.loadConfig` in `compiler.ts` for the
 * same injection pattern applied to config loading).
 */

import * as path from 'node:path';
import { promises as fs, realpathSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Structural mirror of the SDK's `AgentToolDefinition`: a `name`/
 * `description`/`parameters` triple the model sees, plus an `execute`
 * bound to `(callId, args, signal, onUpdate)`. Every field beyond
 * `execute` is opaque here and passed through unchanged from the
 * underlying tool definition (`label`, `approval`, `renderCall`,
 * `renderResult`, ...), so the wrapped tool keeps the original's UI/
 * approval behavior under its new `operator_*` name. */
export interface AgentToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: unknown;
  execute(
    callId: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ): Promise<unknown> | unknown;
  readonly [extra: string]: unknown;
}

/** The four public OMP SDK factories this module wraps. Every factory is
 * bound to `cwd` by the SDK itself; callers pass `projectionRoot` here so
 * the underlying tool's own relative-path resolution already agrees with
 * this module's independent containment check. */
export interface OperatorToolFactories {
  readonly createReadToolDefinition: (cwd: string, options?: Record<string, unknown>) => AgentToolDefinition;
  readonly createGrepToolDefinition: (cwd: string, options?: Record<string, unknown>) => AgentToolDefinition;
  readonly createFindToolDefinition: (cwd: string, options?: Record<string, unknown>) => AgentToolDefinition;
  readonly defineTool: (definition: AgentToolDefinition) => AgentToolDefinition;
}

export interface CreateOperatorSafeToolsOptions {
  /** Absolute path to the node's materialized, locked-down projection
   * directory (see `context-projection.ts`). The only root every
   * `operator_read` / `operator_grep` / `operator_glob` call may touch. */
  readonly projectionRoot: string;
  readonly factories: OperatorToolFactories;
  readonly readOptions?: Record<string, unknown>;
  readonly grepOptions?: Record<string, unknown>;
  readonly globOptions?: Record<string, unknown>;
}

export const OPERATOR_SAFE_TOOL_NAMES = ['operator_read', 'operator_grep', 'operator_glob'] as const;
export type OperatorSafeToolName = (typeof OPERATOR_SAFE_TOOL_NAMES)[number];

export type SafeToolViolationCode = 'MALFORMED_TOOL_INPUT' | 'NON_LOCAL_PATH' | 'PATH_ESCAPE';

export class SafeToolViolation extends Error {
  readonly code: SafeToolViolationCode;
  readonly toolName: string;

  constructor(code: SafeToolViolationCode, toolName: string, message: string) {
    super(message);
    this.name = 'SafeToolViolation';
    this.code = code;
    this.toolName = toolName;
  }
}

// ---------------------------------------------------------------------------
// Path-argument validation
// ---------------------------------------------------------------------------

const NON_LOCAL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function isWithinRoot(root: string, target: string): boolean {
  const normalizedRoot = path.normalize(root);
  const normalizedTarget = path.normalize(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
}

/** Resolves every plausible local interpretation of one raw path segment
 * a model could send, so validation fails closed rather than trusting a
 * single parse. `read` accepts a trailing `:<selector>` (`file.ts:50-200`,
 * `db.sqlite:table:key`); this module cannot re-implement that grammar
 * exactly, so when `stripSelector` is set it checks both the raw segment
 * and the substring before the first `:` — if either interpretation would
 * escape `projectionRoot`, the call is rejected. */
function resolveCandidatePaths(segment: string, projectionRoot: string, stripSelector: boolean): string[] {
  const raw = [segment];
  if (stripSelector) {
    const colonIndex = segment.indexOf(':');
    if (colonIndex > 0) raw.push(segment.slice(0, colonIndex));
  }
  const unique = Array.from(new Set(raw));
  return unique.map((candidate) => (path.isAbsolute(candidate) ? path.normalize(candidate) : path.resolve(projectionRoot, candidate)));
}

async function assertSegmentAllowed(
  toolName: string,
  segment: string,
  projectionRoot: string,
  canonicalRoot: string,
  stripSelector: boolean,
): Promise<void> {
  if (segment.length === 0) {
    throw new SafeToolViolation('MALFORMED_TOOL_INPUT', toolName, 'path segment must not be empty');
  }
  if (segment.includes('\0')) {
    throw new SafeToolViolation('MALFORMED_TOOL_INPUT', toolName, 'path segment contains a NUL byte');
  }
  if (NON_LOCAL_SCHEME_PATTERN.test(segment)) {
    throw new SafeToolViolation('NON_LOCAL_PATH', toolName, `"${segment}" is a URL/internal URI, not a local path`);
  }

  const candidates = resolveCandidatePaths(segment, projectionRoot, stripSelector);
  for (const candidate of candidates) {
    if (!isWithinRoot(projectionRoot, candidate)) {
      throw new SafeToolViolation('PATH_ESCAPE', toolName, `"${segment}" resolves to "${candidate}", outside the projection root`);
    }
    // Defense in depth: even though the projection directory is built with
    // no symlinks, re-check via realpath in case the target exists and
    // some component resolves elsewhere than its literal form suggests.
    // `canonicalRoot` is the realpath of `projectionRoot` itself, computed
    // once at tool-creation time: on macOS `/var` is a symlink to
    // `/private/var`, so comparing a realpath'd candidate against the
    // non-canonical root would reject in-bounds paths whose OS temp
    // directories live under `/var`. Both sides of this comparison must be
    // canonical for it to mean anything.
    let real: string;
    try {
      real = await fs.realpath(candidate);
    } catch {
      continue; // Non-existent target: the underlying tool will report its own not-found error.
    }
    if (!isWithinRoot(canonicalRoot, real)) {
      throw new SafeToolViolation('PATH_ESCAPE', toolName, `"${segment}" resolves (via realpath) to "${real}", outside the projection root`);
    }
  }
}

/** `read` takes exactly one path (with an optional `:selector` suffix).
 * `grep`/`glob` accept a semicolon-delimited list of paths and tolerate an
 * absent `path` (defaulting to `cwd`, which the adapter always sets to
 * `projectionRoot` — already safe, so validation is skipped rather than
 * rewriting the call). */
async function assertPathArgumentAllowed(
  toolName: OperatorSafeToolName,
  rawPath: unknown,
  projectionRoot: string,
  canonicalRoot: string,
): Promise<void> {
  if (toolName === 'operator_read') {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw new SafeToolViolation('MALFORMED_TOOL_INPUT', toolName, 'requires a non-empty string "path"');
    }
    await assertSegmentAllowed(toolName, rawPath, projectionRoot, canonicalRoot, true);
    return;
  }
  if (rawPath === undefined) return;
  if (typeof rawPath !== 'string') {
    throw new SafeToolViolation('MALFORMED_TOOL_INPUT', toolName, '"path" must be a string when provided');
  }
  const segments = rawPath
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new SafeToolViolation('MALFORMED_TOOL_INPUT', toolName, '"path" must not be empty or blank');
  }
  for (const segment of segments) {
    await assertSegmentAllowed(toolName, segment, projectionRoot, canonicalRoot, false);
  }
}

// ---------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------

function wrapToolDefinition(
  name: OperatorSafeToolName,
  underlying: AgentToolDefinition,
  projectionRoot: string,
  canonicalRoot: string,
  defineTool: OperatorToolFactories['defineTool'],
): AgentToolDefinition {
  return defineTool({
    ...underlying,
    name,
    execute: async (callId, args, signal, onUpdate) => {
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new SafeToolViolation('MALFORMED_TOOL_INPUT', name, 'tool arguments must be a plain object');
      }
      await assertPathArgumentAllowed(name, (args as Record<string, unknown>)['path'], projectionRoot, canonicalRoot);
      return underlying.execute(callId, args, signal, onUpdate);
    },
  });
}

/**
 * Builds the exact three read-only custom tools (`operator_read`,
 * `operator_grep`, `operator_glob`) a Stage 4 child session is granted.
 * Every path argument is validated against `projectionRoot` before the
 * underlying SDK tool ever runs; a violation throws `SafeToolViolation`
 * from inside `execute`, which the adapter surfaces as a failed tool call
 * rather than letting it reach the filesystem.
 */
export function createOperatorSafeTools(options: CreateOperatorSafeToolsOptions): readonly AgentToolDefinition[] {
  const { projectionRoot, factories, readOptions, grepOptions, globOptions } = options;
  if (typeof projectionRoot !== 'string' || projectionRoot.length === 0 || !path.isAbsolute(projectionRoot)) {
    throw new SafeToolViolation('MALFORMED_TOOL_INPUT', 'operator_read', 'projectionRoot must be a non-empty absolute path');
  }
  const normalizedRoot = path.normalize(projectionRoot);
  // Canonicalize once, at creation time, so the realpath-based defense in
  // `assertSegmentAllowed` compares like with like. If the root doesn't
  // exist yet (or realpath otherwise fails), fall back to the normalized
  // root — no worse than the pre-canonicalization behavior.
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(normalizedRoot);
  } catch {
    canonicalRoot = normalizedRoot;
  }

  const readTool = factories.createReadToolDefinition(normalizedRoot, readOptions);
  const grepTool = factories.createGrepToolDefinition(normalizedRoot, grepOptions);
  const globTool = factories.createFindToolDefinition(normalizedRoot, globOptions);

  return [
    wrapToolDefinition('operator_read', readTool, normalizedRoot, canonicalRoot, factories.defineTool),
    wrapToolDefinition('operator_grep', grepTool, normalizedRoot, canonicalRoot, factories.defineTool),
    wrapToolDefinition('operator_glob', globTool, normalizedRoot, canonicalRoot, factories.defineTool),
  ];
}

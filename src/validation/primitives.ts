/**
 * Agent Operator — Stage 1 deterministic contract validators: shared
 * validation engine.
 *
 * Pure, synchronous, side-effect-free primitives used by every domain
 * validator module under src/validation/: the accumulating error context,
 * generic field-level requireX() helpers, and the field-name/pattern/limit
 * constants they share. This module has no dependency on any contract type
 * — every domain validator (core-contracts.ts, session.ts, results.ts) and
 * the enum vocabulary in enums.ts builds on it.
 *
 * Normalization is limited to trimming permitted human-facing prose fields
 * in the returned value; every other field is validated and returned
 * byte-for-byte as provided (no type coercion).
 */

// ---------------------------------------------------------------------------
// Public validation API
// ---------------------------------------------------------------------------

export interface ValidationError {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ValidationError[] };

// ---------------------------------------------------------------------------
// Internal validation engine
// ---------------------------------------------------------------------------

export type Path = ReadonlyArray<string | number>;

export interface Ctx {
  readonly errors: ValidationError[];
}

export function newCtx(): Ctx {
  return { errors: [] };
}

export function pathToString(path: Path): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else if (out.length === 0) {
      out += seg;
    } else {
      out += `.${seg}`;
    }
  }
  return out.length === 0 ? '<root>' : out;
}

export function pushErr(ctx: Ctx, path: Path, message: string): void {
  ctx.errors.push({ path: pathToString(path), message });
}

export function finalize<T>(ctx: Ctx, value: Record<string, unknown>): ValidationResult<T> {
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, value: value as T };
}

export const MAX_SHORT_TEXT = 200;
export const MAX_MEDIUM_TEXT = 4000;
export const MAX_LONG_TEXT = 20000;
export const MAX_ARRAY_ITEMS = 500;

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const POLICY_REF_PATTERN = /^[a-z][a-z0-9-]*@\d+:[A-Za-z][A-Za-z0-9_.]*$/;
export const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const JOURNAL_EVENT_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const SEMANTIC_VERSION_PATTERN = /^\d+\.\d+$/;
export const ARTIFACT_TYPE_PATTERN = /^[a-z][a-z0-9-]*\.v\d+$/;

/** Role labels: lowercase, kebab-case-ish tokens (e.g. "planner",
 * "independent-reviewer"). */
export const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Verifies `value` is an object and flags any property not in `allowedKeys`.
 * Returns the raw record regardless (so present known fields can still be
 * validated and every error collected), or undefined if not an object. */
export function checkObjectShape(
  ctx: Ctx,
  path: Path,
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    pushErr(ctx, path, 'must be an object');
    return undefined;
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      pushErr(ctx, [...path, key], 'unknown property');
    }
  }
  return value;
}

export function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

interface StringOpts {
  readonly minLen?: number;
  readonly maxLen?: number;
  readonly pattern?: RegExp;
}

export function requireExactString(ctx: Ctx, path: Path, value: unknown, opts: StringOpts = {}): string | undefined {
  if (typeof value !== 'string') {
    pushErr(ctx, path, 'must be a string');
    return undefined;
  }
  const minLen = opts.minLen ?? 1;
  const maxLen = opts.maxLen ?? MAX_LONG_TEXT;
  if (value.length < minLen) {
    pushErr(ctx, path, `must be at least ${minLen} character(s)`);
    return undefined;
  }
  if (value.length > maxLen) {
    pushErr(ctx, path, `must be at most ${maxLen} character(s)`);
    return undefined;
  }
  if (opts.pattern && !opts.pattern.test(value)) {
    pushErr(ctx, path, `must match pattern ${opts.pattern.source}`);
    return undefined;
  }
  return value;
}

/** Trims permitted human-facing prose. This is the only normalization this
 * module performs. */
export function requireHumanText(ctx: Ctx, path: Path, value: unknown, opts: { maxLen?: number } = {}): string | undefined {
  if (typeof value !== 'string') {
    pushErr(ctx, path, 'must be a string');
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    pushErr(ctx, path, 'must be non-empty after trimming');
    return undefined;
  }
  const maxLen = opts.maxLen ?? MAX_LONG_TEXT;
  if (trimmed.length > maxLen) {
    pushErr(ctx, path, `must be at most ${maxLen} character(s) after trimming`);
    return undefined;
  }
  return trimmed;
}

export function requireId(ctx: Ctx, path: Path, value: unknown): string | undefined {
  return requireExactString(ctx, path, value, { maxLen: 128, pattern: ID_PATTERN });
}

export function requireTimestamp(ctx: Ctx, path: Path, value: unknown): string | undefined {
  const s = requireExactString(ctx, path, value, { maxLen: 40, pattern: TIMESTAMP_PATTERN });
  if (s === undefined) return undefined;
  if (Number.isNaN(Date.parse(s))) {
    pushErr(ctx, path, 'must be a valid timestamp');
    return undefined;
  }
  return s;
}

export function requireHash(ctx: Ctx, path: Path, value: unknown): string | undefined {
  return requireExactString(ctx, path, value, { minLen: 64, maxLen: 64, pattern: HASH_PATTERN });
}

export function requirePolicyRef(ctx: Ctx, path: Path, value: unknown): string | undefined {
  return requireExactString(ctx, path, value, { maxLen: 128, pattern: POLICY_REF_PATTERN });
}

export function requireEnum<T extends string>(ctx: Ctx, path: Path, value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') {
    pushErr(ctx, path, 'must be a string');
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    pushErr(ctx, path, `must be one of: ${allowed.join(', ')}`);
    return undefined;
  }
  return value as T;
}

interface NumberOpts {
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export function requireNumber(ctx: Ctx, path: Path, value: unknown, opts: NumberOpts = {}): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    pushErr(ctx, path, 'must be a finite number');
    return undefined;
  }
  if (opts.integer && !Number.isInteger(value)) {
    pushErr(ctx, path, 'must be an integer');
    return undefined;
  }
  if (opts.min !== undefined && value < opts.min) {
    pushErr(ctx, path, `must be >= ${opts.min}`);
    return undefined;
  }
  if (opts.max !== undefined && value > opts.max) {
    pushErr(ctx, path, `must be <= ${opts.max}`);
    return undefined;
  }
  return value;
}

export function requireBoolean(ctx: Ctx, path: Path, value: unknown): boolean | undefined {
  if (typeof value !== 'boolean') {
    pushErr(ctx, path, 'must be a boolean');
    return undefined;
  }
  return value;
}

interface ArrayOpts {
  readonly minItems?: number;
  readonly maxItems?: number;
}

export function requireArray(ctx: Ctx, path: Path, value: unknown, opts: ArrayOpts = {}): unknown[] | undefined {
  if (!Array.isArray(value)) {
    pushErr(ctx, path, 'must be an array');
    return undefined;
  }
  const minItems = opts.minItems ?? 0;
  const maxItems = opts.maxItems ?? MAX_ARRAY_ITEMS;
  if (value.length < minItems) {
    pushErr(ctx, path, `must have at least ${minItems} item(s)`);
    return undefined;
  }
  if (value.length > maxItems) {
    pushErr(ctx, path, `must have at most ${maxItems} item(s)`);
    return undefined;
  }
  return value;
}

interface StringArrayOpts extends ArrayOpts {
  readonly unique?: boolean;
  readonly itemValidator?: (ctx: Ctx, path: Path, v: unknown) => string | undefined;
}

export function requireStringArray(ctx: Ctx, path: Path, value: unknown, opts: StringArrayOpts = {}): string[] | undefined {
  const arr = requireArray(ctx, path, value, opts);
  if (arr === undefined) return undefined;
  const validator = opts.itemValidator ?? ((c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT }));
  const out: string[] = [];
  let ok = true;
  arr.forEach((item, i) => {
    const v = validator(ctx, [...path, i], item);
    if (v === undefined) {
      ok = false;
    } else {
      out.push(v);
    }
  });
  if (!ok) return undefined;
  if (opts.unique) {
    const seen = new Set<string>();
    for (const v of out) {
      if (seen.has(v)) {
        pushErr(ctx, path, `must contain unique values (duplicate: ${v})`);
        return undefined;
      }
      seen.add(v);
    }
  }
  return out;
}

export function requirePolicyRefsArray(ctx: Ctx, path: Path, value: unknown, opts: ArrayOpts = {}): string[] | undefined {
  return requireStringArray(ctx, path, value, { ...opts, itemValidator: requirePolicyRef });
}

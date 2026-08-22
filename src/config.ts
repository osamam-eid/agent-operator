/**
 * Agent Operator — Stage 3 configuration and trusted project overlay.
 *
 * Resolves the effective `OperatorProfile` from three strictly ordered
 * layers:
 *
 *   1. `config/defaults.json` — bundled with this package. The hard-locked
 *      safety ceiling for the Stage 3 mock rollout. Read fresh every call;
 *      never cached, never written to.
 *   2. an optional global JSON overlay at a portably resolved path (explicit
 *      option, else `$XDG_CONFIG_HOME/agent-operator/operator.json`, else
 *      `~/.config/agent-operator/operator.json`). Present-but-broken global
 *      config fails the whole resolution loudly (`OperatorConfigError`):
 *      it is local, operator-authored configuration, not foreign input.
 *   3. an optional project overlay at `<projectRoot>/.omp/operator.json`,
 *      applied only when a matching trust record is found under the
 *      project's *real* Git metadata directory (resolving `.git` directory
 *      or worktree `gitdir:` files without shelling out) and its declared
 *      hash matches the policy file's current bytes. This stage only reads
 *      trust records; nothing in this module ever writes one. Untrusted or
 *      malformed project policy is reported via `ProjectOverlayResolution`
 *      and never applied — it can never throw or otherwise abort resolution.
 *
 * A fixed set of safety-critical `features`/`rules` fields is hard-locked to
 * the bundled defaults' values: neither the global overlay nor a trusted
 * project overlay may flip them. Attempting to do so is rejected as unsafe
 * broadening (global: throws; project: reported as `INVALID`, never
 * applied). This is what keeps Stage 3 structurally mock-only regardless of
 * what any layer of configuration claims.
 */

import { createHash } from 'node:crypto';
import { constants, promises as fs, type Stats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BudgetProfile, PolicyRef } from './contracts.js';
import type {
  CapabilityPreference,
  OperatorFeatureFlags,
  OperatorProfile,
  OperatorRules,
  ProjectOperatorOverlay,
  ProjectOverlayResolution,
  ResolvedOperatorConfig,
} from './stage3-types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type OperatorConfigErrorCode = 'DEFAULTS_INVALID' | 'GLOBAL_CONFIG_INVALID';

/** Thrown only for the two layers this module treats as trusted-by-default
 * (the bundled defaults and the operator's own global config). Project
 * overlay problems never throw; see `ProjectOverlayResolution.status`. */
export class OperatorConfigError extends Error {
  readonly code: OperatorConfigErrorCode;
  readonly details: readonly string[];

  constructor(code: OperatorConfigErrorCode, message: string, details: readonly string[] = []) {
    super(details.length > 0 ? `${message}: ${details.join('; ')}` : message);
    this.name = 'OperatorConfigError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Public hashing helper
// ---------------------------------------------------------------------------

/** Canonical hash of raw project policy bytes, used both to populate
 * `ProjectOverlayResolution.actualHash` and by whatever later stage writes
 * a trust record's `expectedHash`. Hashes the bytes exactly as read — no
 * parsing, normalization, or re-serialization. */
export function hashProjectPolicyBytes(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

export type ConfigValidationOutcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectObject(raw: unknown, at: string, issues: string[]): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    issues.push(`${at}: must be an object`);
    return undefined;
  }
  return raw;
}

function rejectUnknownKeys(obj: Record<string, unknown>, allowed: readonly string[], at: string, issues: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) issues.push(`${at}.${key}: unknown property`);
  }
}

function readString(obj: Record<string, unknown>, key: string, at: string, issues: string[], pattern?: RegExp): string | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    issues.push(`${at}.${key}: must be a non-empty string`);
    return undefined;
  }
  if (pattern && !pattern.test(value)) {
    issues.push(`${at}.${key}: must match pattern ${pattern.source}`);
    return undefined;
  }
  return value;
}

function readBoolean(obj: Record<string, unknown>, key: string, at: string, issues: string[]): boolean | undefined {
  const value = obj[key];
  if (typeof value !== 'boolean') {
    issues.push(`${at}.${key}: must be a boolean`);
    return undefined;
  }
  return value;
}

function readInt(obj: Record<string, unknown>, key: string, at: string, issues: string[], min: number, max: number): number | undefined {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    issues.push(`${at}.${key}: must be an integer between ${min} and ${max}`);
    return undefined;
  }
  return value;
}

function readEnum<T extends string>(obj: Record<string, unknown>, key: string, at: string, issues: string[], allowed: readonly T[]): T | undefined {
  const value = obj[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    issues.push(`${at}.${key}: must be one of ${allowed.join(', ')}`);
    return undefined;
  }
  return value as T;
}

function readStringArray(obj: Record<string, unknown>, key: string, at: string, issues: string[], pattern: RegExp, maxItems: number): readonly string[] | undefined {
  const value = obj[key];
  if (!Array.isArray(value)) {
    issues.push(`${at}.${key}: must be an array`);
    return undefined;
  }
  if (value.length > maxItems) {
    issues.push(`${at}.${key}: must have at most ${maxItems} item(s)`);
    return undefined;
  }
  const out: string[] = [];
  let ok = true;
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'string' || !pattern.test(item)) {
      issues.push(`${at}.${key}[${i}]: must match pattern ${pattern.source}`);
      ok = false;
      continue;
    }
    out.push(item);
  }
  return ok ? out : undefined;
}

// ---------------------------------------------------------------------------
// OperatorProfile / overlay shape patterns
// ---------------------------------------------------------------------------

const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const POLICY_PACK_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const RELATIVE_POLICY_PATH_PATTERN = /^[^/\\][^\0]*$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const BUDGET_PROFILES: readonly BudgetProfile[] = ['CHEAP', 'BALANCED', 'QUALITY', 'CRITICAL'];
const FALLBACK_POLICIES: readonly CapabilityPreference['fallbackPolicy'][] = ['COMPATIBLE_ONLY', 'HUMAN_REQUIRED', 'DISABLED'];

const MAX_CONCURRENCY_CAP = 32;
const MAX_REVIEW_ROUNDS_CAP = 20;
const MAX_ARRAY_ITEMS = 64;

const FEATURE_KEYS: readonly (keyof OperatorFeatureFlags)[] = [
  'automaticRouting',
  'externalProviders',
  'councilMode',
  'autoFallback',
  'persistentState',
  'costTracking',
];

const RULE_BOOLEAN_KEYS: readonly Exclude<keyof OperatorRules, 'maxReviewRounds'>[] = [
  'humanIsFinalApprover',
  'implementerSelfApproval',
  'automaticCommit',
  'automaticPush',
  'automaticMerge',
  'independentVerification',
  'adversarialReviewForHighRisk',
  'scopeFreezeRequired',
];

/** Fields that may never be broadened past the bundled defaults' value by
 * any overlay layer — the invariant that keeps Stage 3 structurally
 * mock-only no matter what global or (trusted) project config claims. */
const LOCKED_FALSE_FEATURES: readonly (keyof OperatorFeatureFlags)[] = ['automaticRouting', 'externalProviders', 'councilMode', 'autoFallback'];
const LOCKED_FALSE_RULES: readonly Exclude<keyof OperatorRules, 'maxReviewRounds'>[] = ['automaticCommit', 'automaticPush', 'automaticMerge', 'implementerSelfApproval'];

function parseFeatureFlags(raw: unknown, at: string, issues: string[]): OperatorFeatureFlags | undefined {
  const obj = expectObject(raw, at, issues);
  if (!obj) return undefined;
  rejectUnknownKeys(obj, FEATURE_KEYS, at, issues);
  const values = FEATURE_KEYS.map((key) => readBoolean(obj, key, at, issues));
  if (values.some((v) => v === undefined)) return undefined;
  return {
    automaticRouting: values[0] as boolean,
    externalProviders: values[1] as boolean,
    councilMode: values[2] as boolean,
    autoFallback: values[3] as boolean,
    persistentState: values[4] as boolean,
    costTracking: values[5] as boolean,
  };
}

function parsePartialFeatureFlags(raw: unknown, at: string, issues: string[]): Partial<OperatorFeatureFlags> | undefined {
  const obj = expectObject(raw, at, issues);
  if (!obj) return undefined;
  rejectUnknownKeys(obj, FEATURE_KEYS, at, issues);
  const out: Partial<Record<keyof OperatorFeatureFlags, boolean>> = {};
  let ok = true;
  for (const key of FEATURE_KEYS) {
    if (!(key in obj)) continue;
    const value = readBoolean(obj, key, at, issues);
    if (value === undefined) {
      ok = false;
      continue;
    }
    out[key] = value;
  }
  return ok ? (out as Partial<OperatorFeatureFlags>) : undefined;
}

function parseRules(raw: unknown, at: string, issues: string[]): OperatorRules | undefined {
  const obj = expectObject(raw, at, issues);
  if (!obj) return undefined;
  rejectUnknownKeys(obj, [...RULE_BOOLEAN_KEYS, 'maxReviewRounds'], at, issues);
  const booleans = RULE_BOOLEAN_KEYS.map((key) => readBoolean(obj, key, at, issues));
  const maxReviewRounds = readInt(obj, 'maxReviewRounds', at, issues, 0, MAX_REVIEW_ROUNDS_CAP);
  if (booleans.some((v) => v === undefined) || maxReviewRounds === undefined) return undefined;
  return {
    humanIsFinalApprover: booleans[0] as boolean,
    implementerSelfApproval: booleans[1] as boolean,
    automaticCommit: booleans[2] as boolean,
    automaticPush: booleans[3] as boolean,
    automaticMerge: booleans[4] as boolean,
    independentVerification: booleans[5] as boolean,
    adversarialReviewForHighRisk: booleans[6] as boolean,
    scopeFreezeRequired: booleans[7] as boolean,
    maxReviewRounds,
  };
}

function parsePartialRules(raw: unknown, at: string, issues: string[]): Partial<OperatorRules> | undefined {
  const obj = expectObject(raw, at, issues);
  if (!obj) return undefined;
  rejectUnknownKeys(obj, [...RULE_BOOLEAN_KEYS, 'maxReviewRounds'], at, issues);
  const out: Partial<Record<keyof OperatorRules, boolean | number>> = {};
  let ok = true;
  for (const key of RULE_BOOLEAN_KEYS) {
    if (!(key in obj)) continue;
    const value = readBoolean(obj, key, at, issues);
    if (value === undefined) {
      ok = false;
      continue;
    }
    out[key] = value;
  }
  if ('maxReviewRounds' in obj) {
    const value = readInt(obj, 'maxReviewRounds', at, issues, 0, MAX_REVIEW_ROUNDS_CAP);
    if (value === undefined) {
      ok = false;
    } else {
      out.maxReviewRounds = value;
    }
  }
  return ok ? (out as Partial<OperatorRules>) : undefined;
}

function parseCapabilityPreference(raw: unknown, at: string, issues: string[]): CapabilityPreference | undefined {
  const obj = expectObject(raw, at, issues);
  if (!obj) return undefined;
  rejectUnknownKeys(obj, ['preferred', 'fallbacks', 'fallbackPolicy'], at, issues);
  const preferred = readString(obj, 'preferred', at, issues, CAPABILITY_ID_PATTERN);
  const fallbacks = readStringArray(obj, 'fallbacks', at, issues, CAPABILITY_ID_PATTERN, MAX_ARRAY_ITEMS);
  const fallbackPolicy = readEnum(obj, 'fallbackPolicy', at, issues, FALLBACK_POLICIES);
  if (preferred === undefined || fallbacks === undefined || fallbackPolicy === undefined) return undefined;
  return { preferred, fallbacks, fallbackPolicy };
}

function parseCapabilityAssignments(raw: unknown, at: string, issues: string[]): Readonly<Record<string, CapabilityPreference>> | undefined {
  const obj = expectObject(raw, at, issues);
  if (!obj) return undefined;
  const out: Record<string, CapabilityPreference> = {};
  let ok = true;
  for (const [role, value] of Object.entries(obj)) {
    if (!ROLE_PATTERN.test(role)) {
      issues.push(`${at}.${role}: role key must match pattern ${ROLE_PATTERN.source}`);
      ok = false;
      continue;
    }
    const parsed = parseCapabilityPreference(value, `${at}.${role}`, issues);
    if (parsed === undefined) {
      ok = false;
      continue;
    }
    out[role] = parsed;
  }
  return ok ? out : undefined;
}

const PROFILE_KEYS = ['schemaVersion', 'workflow', 'defaultPolicyPacks', 'budgetProfile', 'maxConcurrency', 'features', 'rules', 'capabilityAssignments'] as const;

/** Strict validator for a fully-specified `OperatorProfile` (the bundled
 * defaults, or a defaults-merged profile). Rejects unknown properties at
 * every nested boundary and requires every field. */
export function validateOperatorProfile(raw: unknown): ConfigValidationOutcome<OperatorProfile> {
  const issues: string[] = [];
  const obj = expectObject(raw, '<root>', issues);
  if (!obj) return { ok: false, errors: issues };
  rejectUnknownKeys(obj, PROFILE_KEYS, '<root>', issues);

  if (obj.schemaVersion !== '1.0') {
    issues.push('<root>.schemaVersion: must be exactly "1.0"');
  }
  const workflow = readString(obj, 'workflow', '<root>', issues, WORKFLOW_ID_PATTERN);
  const defaultPolicyPacks = readStringArray(obj, 'defaultPolicyPacks', '<root>', issues, POLICY_PACK_ID_PATTERN, MAX_ARRAY_ITEMS);
  const budgetProfile = readEnum(obj, 'budgetProfile', '<root>', issues, BUDGET_PROFILES);
  const maxConcurrency = readInt(obj, 'maxConcurrency', '<root>', issues, 1, MAX_CONCURRENCY_CAP);
  let features: OperatorFeatureFlags | undefined;
  if ('features' in obj) {
    features = parseFeatureFlags(obj.features, '<root>.features', issues);
  } else {
    issues.push('<root>.features: must be an object');
  }
  let rules: OperatorRules | undefined;
  if ('rules' in obj) {
    rules = parseRules(obj.rules, '<root>.rules', issues);
  } else {
    issues.push('<root>.rules: must be an object');
  }
  let capabilityAssignments: Readonly<Record<string, CapabilityPreference>> | undefined;
  if ('capabilityAssignments' in obj) {
    capabilityAssignments = parseCapabilityAssignments(obj.capabilityAssignments, '<root>.capabilityAssignments', issues);
  } else {
    issues.push('<root>.capabilityAssignments: must be an object');
  }

  if (issues.length > 0 || workflow === undefined || defaultPolicyPacks === undefined || budgetProfile === undefined || maxConcurrency === undefined || features === undefined || rules === undefined || capabilityAssignments === undefined) {
    return { ok: false, errors: issues };
  }
  return {
    ok: true,
    value: { schemaVersion: '1.0', workflow, defaultPolicyPacks, budgetProfile, maxConcurrency, features, rules, capabilityAssignments },
  };
}

const OVERLAY_KEYS = ['schemaVersion', 'workflow', 'policyPacks', 'budgetProfile', 'maxConcurrency', 'features', 'rules', 'capabilityAssignments'] as const;

/** Strict validator shared by the global overlay file and the `.omp`
 * project overlay file: every field is optional, but any field present
 * must be well-formed, and no unknown property is tolerated. */
export function validateProjectOperatorOverlay(raw: unknown): ConfigValidationOutcome<ProjectOperatorOverlay> {
  const issues: string[] = [];
  const obj = expectObject(raw, '<root>', issues);
  if (!obj) return { ok: false, errors: issues };
  rejectUnknownKeys(obj, OVERLAY_KEYS, '<root>', issues);

  if (obj.schemaVersion !== '1.0') {
    issues.push('<root>.schemaVersion: must be exactly "1.0"');
  }
  const workflow = 'workflow' in obj ? readString(obj, 'workflow', '<root>', issues, WORKFLOW_ID_PATTERN) : undefined;
  const policyPacks = 'policyPacks' in obj ? readStringArray(obj, 'policyPacks', '<root>', issues, POLICY_PACK_ID_PATTERN, MAX_ARRAY_ITEMS) : undefined;
  const budgetProfile = 'budgetProfile' in obj ? readEnum(obj, 'budgetProfile', '<root>', issues, BUDGET_PROFILES) : undefined;
  const maxConcurrency = 'maxConcurrency' in obj ? readInt(obj, 'maxConcurrency', '<root>', issues, 1, MAX_CONCURRENCY_CAP) : undefined;
  const features = 'features' in obj ? parsePartialFeatureFlags(obj.features, '<root>.features', issues) : undefined;
  const rules = 'rules' in obj ? parsePartialRules(obj.rules, '<root>.rules', issues) : undefined;
  const capabilityAssignments = 'capabilityAssignments' in obj ? parseCapabilityAssignments(obj.capabilityAssignments, '<root>.capabilityAssignments', issues) : undefined;

  // Every field that was present but failed to parse pushed an issue and
  // yielded `undefined`; every field that was simply absent also yields
  // `undefined` but pushed nothing. Disambiguate by re-checking presence.
  if (issues.length > 0) return { ok: false, errors: issues };

  const value: {
    schemaVersion: '1.0';
    workflow?: string;
    policyPacks?: readonly string[];
    budgetProfile?: BudgetProfile;
    maxConcurrency?: number;
    features?: Partial<OperatorFeatureFlags>;
    rules?: Partial<OperatorRules>;
    capabilityAssignments?: Readonly<Record<string, CapabilityPreference>>;
  } = { schemaVersion: '1.0' };
  if (workflow !== undefined) value.workflow = workflow;
  if (policyPacks !== undefined) value.policyPacks = policyPacks;
  if (budgetProfile !== undefined) value.budgetProfile = budgetProfile;
  if (maxConcurrency !== undefined) value.maxConcurrency = maxConcurrency;
  if (features !== undefined) value.features = features;
  if (rules !== undefined) value.rules = rules;
  if (capabilityAssignments !== undefined) value.capabilityAssignments = capabilityAssignments;
  return { ok: true, value };
}

/** Fields present in `overlay.features`/`overlay.rules` that attempt to
 * flip a hard-locked field away from its safe (`false`) bundled-defaults
 * value. Non-empty result means "reject this overlay layer entirely". */
function findUnsafeBroadening(overlay: { readonly features?: Partial<OperatorFeatureFlags>; readonly rules?: Partial<OperatorRules> }): readonly string[] {
  const violations: string[] = [];
  if (overlay.features) {
    for (const key of LOCKED_FALSE_FEATURES) {
      if (overlay.features[key] === true) violations.push(`features.${key}`);
    }
  }
  if (overlay.rules) {
    for (const key of LOCKED_FALSE_RULES) {
      if (overlay.rules[key] === true) violations.push(`rules.${key}`);
    }
  }
  return violations;
}

/** Explicit field-by-field merge of an overlay onto a base profile. Absent
 * overlay fields keep the base value; `features`/`rules` merge per-flag;
 * `capabilityAssignments` merges per-role so an overlay can override a
 * single role without restating every other assignment. */
function mergeOverlay(base: OperatorProfile, overlay: ProjectOperatorOverlay): OperatorProfile {
  return {
    schemaVersion: '1.0',
    workflow: overlay.workflow ?? base.workflow,
    defaultPolicyPacks: overlay.policyPacks ?? base.defaultPolicyPacks,
    budgetProfile: overlay.budgetProfile ?? base.budgetProfile,
    maxConcurrency: overlay.maxConcurrency ?? base.maxConcurrency,
    features: overlay.features ? { ...base.features, ...overlay.features } : base.features,
    rules: overlay.rules ? { ...base.rules, ...overlay.rules } : base.rules,
    capabilityAssignments: overlay.capabilityAssignments ? { ...base.capabilityAssignments, ...overlay.capabilityAssignments } : base.capabilityAssignments,
  };
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function lstatOrUndefined(target: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Opens the final path component without following a symlink, verifies that
 * the opened descriptor still names the same regular file as the directory
 * entry, then reads through that descriptor. The descriptor comparison is
 * required even where `O_NOFOLLOW` is unavailable: replacing the entry
 * between open and verification cannot redirect the bytes read afterward.
 */
async function readRegularFileNoFollow(target: string): Promise<Buffer>;
async function readRegularFileNoFollow(target: string, encoding: 'utf8'): Promise<string>;
async function readRegularFileNoFollow(target: string, encoding?: 'utf8'): Promise<Buffer | string> {
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const [openedStat, currentStat] = await Promise.all([handle.stat(), fs.lstat(target)]);
    if (
      !openedStat.isFile() ||
      currentStat.isSymbolicLink() ||
      !currentStat.isFile() ||
      openedStat.dev !== currentStat.dev ||
      openedStat.ino !== currentStat.ino
    ) {
      throw new Error(`refusing non-regular, symlinked, or concurrently replaced file "${target}"`);
    }
    return encoding === undefined ? await handle.readFile() : await handle.readFile({ encoding });
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Global config path resolution
// ---------------------------------------------------------------------------

export interface LoadOperatorConfigOptions {
  /** Base directory project-root discovery walks upward from. Defaults to
   * `process.cwd()`. Ignored when `projectRoot` is given. */
  readonly cwd?: string;
  /** Skips upward discovery and treats this directory as the project root. */
  readonly projectRoot?: string;
  /** Skips XDG/home resolution and reads the global overlay from exactly
   * this path. */
  readonly globalConfigPath?: string;
}

/** Explicit option first; otherwise `$XDG_CONFIG_HOME/agent-operator/operator.json`
 * when `XDG_CONFIG_HOME` is set to a non-empty value, else
 * `~/.config/agent-operator/operator.json`. Never touches the filesystem. */
export function resolveGlobalConfigPath(options: LoadOperatorConfigOptions = {}): string {
  if (options.globalConfigPath) return path.resolve(options.globalConfigPath);
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'agent-operator', 'operator.json');
}

/** Explicit option first; otherwise `$XDG_CONFIG_HOME/agent-operator/providers.json`
 * when `XDG_CONFIG_HOME` is set to a non-empty value, else
 * `~/.config/agent-operator/providers.json`. Operator-owned, never
 * project-relative, never derived from any overlay field. Never touches the
 * filesystem. */
export function resolveProviderCatalogPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.trim().length > 0 ? xdg : path.join(os.homedir(), '.config');
  return path.join(base, 'agent-operator', 'providers.json');
}

// ---------------------------------------------------------------------------
// Bundled defaults
// ---------------------------------------------------------------------------

async function loadDefaultsProfile(): Promise<OperatorProfile> {
  const defaultsPath = fileURLToPath(new URL('../config/defaults.json', import.meta.url));
  let raw: unknown;
  try {
    const text = await fs.readFile(defaultsPath, 'utf8');
    raw = JSON.parse(text);
  } catch (error) {
    throw new OperatorConfigError('DEFAULTS_INVALID', `bundled defaults at "${defaultsPath}" could not be read as JSON`, [errorMessage(error)]);
  }
  const result = validateOperatorProfile(raw);
  if (!result.ok) {
    throw new OperatorConfigError('DEFAULTS_INVALID', 'bundled defaults.json failed schema validation', result.errors);
  }
  const violations = findUnsafeBroadening({ features: result.value.features, rules: result.value.rules });
  if (violations.length > 0) {
    throw new OperatorConfigError('DEFAULTS_INVALID', 'bundled defaults.json does not ship every hard-locked field disabled', violations);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Global overlay
// ---------------------------------------------------------------------------

async function loadGlobalOverlay(globalConfigPath: string): Promise<ProjectOperatorOverlay | undefined> {
  const stat = await lstatOrUndefined(globalConfigPath);
  if (!stat) return undefined;
  if (!stat.isFile()) {
    throw new OperatorConfigError('GLOBAL_CONFIG_INVALID', `global config at "${globalConfigPath}" is not a regular file`);
  }
  let raw: unknown;
  try {
    const text = await readRegularFileNoFollow(globalConfigPath, 'utf8');
    raw = JSON.parse(text);
  } catch (error) {
    throw new OperatorConfigError('GLOBAL_CONFIG_INVALID', `global config at "${globalConfigPath}" is not valid JSON`, [errorMessage(error)]);
  }
  const result = validateProjectOperatorOverlay(raw);
  if (!result.ok) {
    throw new OperatorConfigError('GLOBAL_CONFIG_INVALID', 'global config failed schema validation', result.errors);
  }
  const violations = findUnsafeBroadening(result.value);
  if (violations.length > 0) {
    throw new OperatorConfigError('GLOBAL_CONFIG_INVALID', 'global config attempts to unsafely broaden hard-locked defaults', violations);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Git metadata resolution (no shell-out)
// ---------------------------------------------------------------------------

type GitMetadataResult =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly projectRoot: string; readonly reason: string }
  | { readonly kind: 'found'; readonly projectRoot: string; readonly gitDir: string };

const GITDIR_POINTER_PATTERN = /^gitdir:\s*(.+?)\s*$/m;

/** Resolves the real Git metadata directory for both a plain repository
 * (`.git/` is a directory) and a linked worktree (`.git` is a file
 * containing a `gitdir: <path>` pointer). Never shells out to the `git`
 * binary. A symlinked `.git` entry, or a `gitdir:` pointer whose target is
 * missing, is reported as `invalid` at that directory rather than silently
 * continuing the walk upward into an unrelated ancestor repository.
 *
 * `walkUp: true` walks from `startDir` up to the filesystem root looking
 * for the first `.git` entry (the normal "discover the project I'm inside"
 * case). `walkUp: false` checks exactly `startDir` and nowhere else — used
 * when the caller has already pinned an explicit project root and an
 * ancestor's unrelated repository must never be substituted for it. */
async function resolveGitMetadata(startDir: string, walkUp: boolean): Promise<GitMetadataResult> {
  let dir = path.resolve(startDir);
  for (;;) {
    const gitEntry = path.join(dir, '.git');
    const stat = await lstatOrUndefined(gitEntry);
    if (stat) {
      if (stat.isSymbolicLink()) {
        return { kind: 'invalid', projectRoot: dir, reason: 'refusing symlinked .git entry' };
      }
      if (stat.isDirectory()) {
        return { kind: 'found', projectRoot: dir, gitDir: gitEntry };
      }
      if (stat.isFile()) {
        let text: string;
        try {
          text = await readRegularFileNoFollow(gitEntry, 'utf8');
        } catch (error) {
          return { kind: 'invalid', projectRoot: dir, reason: `failed to read .git file: ${errorMessage(error)}` };
        }
        const match = GITDIR_POINTER_PATTERN.exec(text);
        const pointerRaw = match?.[1];
        if (!pointerRaw) {
          return { kind: 'invalid', projectRoot: dir, reason: '.git file is missing a gitdir: pointer' };
        }
        const pointerTarget = path.isAbsolute(pointerRaw) ? path.normalize(pointerRaw) : path.resolve(dir, pointerRaw);
        const targetStat = await lstatOrUndefined(pointerTarget);
        if (!targetStat || !targetStat.isDirectory()) {
          return { kind: 'invalid', projectRoot: dir, reason: 'gitdir: pointer target is not a directory' };
        }
        return { kind: 'found', projectRoot: dir, gitDir: pointerTarget };
      }
      return { kind: 'invalid', projectRoot: dir, reason: '.git entry is neither a directory, file, nor symlink' };
    }
    if (!walkUp) return { kind: 'absent' };
    const parent = path.dirname(dir);
    if (parent === dir) return { kind: 'absent' };
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Trust record
// ---------------------------------------------------------------------------

/** Strict format for the trust record this stage reads (never writes) from
 * `<gitDir>/agent-operator/trust.json`. A later stage is responsible for
 * writing one, via whatever explicit human "trust this project policy"
 * action it implements. */
export interface ProjectPolicyTrustRecord {
  readonly schemaVersion: '1.0';
  /** Project-root-relative, forward-slash-normalized path of the trusted
   * policy file — must equal the actual resolved `.omp/operator.json`
   * path exactly, or the record is rejected as targeting a different file. */
  readonly policyPath: string;
  readonly expectedHash: string;
  readonly trustedAt: string;
}

const TRUST_RECORD_KEYS = ['schemaVersion', 'policyPath', 'expectedHash', 'trustedAt'] as const;

function validateTrustRecord(raw: unknown): ConfigValidationOutcome<ProjectPolicyTrustRecord> {
  const issues: string[] = [];
  const obj = expectObject(raw, '<root>', issues);
  if (!obj) return { ok: false, errors: issues };
  rejectUnknownKeys(obj, TRUST_RECORD_KEYS, '<root>', issues);
  if (obj.schemaVersion !== '1.0') {
    issues.push('<root>.schemaVersion: must be exactly "1.0"');
  }
  const policyPath = readString(obj, 'policyPath', '<root>', issues, RELATIVE_POLICY_PATH_PATTERN);
  if (policyPath !== undefined && policyPath.split('/').includes('..')) {
    issues.push('<root>.policyPath: must not contain ".." segments');
  }
  const expectedHash = readString(obj, 'expectedHash', '<root>', issues, HASH_PATTERN);
  const trustedAt = readString(obj, 'trustedAt', '<root>', issues, TIMESTAMP_PATTERN);
  if (issues.length > 0 || policyPath === undefined || expectedHash === undefined || trustedAt === undefined) {
    return { ok: false, errors: issues };
  }
  return { ok: true, value: { schemaVersion: '1.0', policyPath, expectedHash, trustedAt } };
}

// ---------------------------------------------------------------------------
// Project overlay resolution
// ---------------------------------------------------------------------------

async function resolveProjectOverlay(startDir: string, walkUp: boolean): Promise<ProjectOverlayResolution> {
  const gitMeta = await resolveGitMetadata(startDir, walkUp);
  if (gitMeta.kind === 'absent') {
    return { status: 'ABSENT', projectRoot: path.resolve(startDir), reason: walkUp ? 'no git repository found from the given directory upward' : 'no .git entry present at the given project root' };
  }
  if (gitMeta.kind === 'invalid') {
    return { status: 'INVALID', projectRoot: gitMeta.projectRoot, reason: gitMeta.reason };
  }
  const { projectRoot, gitDir } = gitMeta;

  const omDir = path.join(projectRoot, '.omp');
  const omStat = await lstatOrUndefined(omDir);
  if (!omStat) {
    return { status: 'ABSENT', projectRoot, reason: 'no .omp directory present' };
  }
  if (omStat.isSymbolicLink()) {
    return { status: 'INVALID', projectRoot, reason: 'refusing symlinked .omp directory' };
  }
  if (!omStat.isDirectory()) {
    return { status: 'INVALID', projectRoot, reason: '.omp exists but is not a directory' };
  }

  const policyPath = path.join(omDir, 'operator.json');
  const policyStat = await lstatOrUndefined(policyPath);
  if (!policyStat) {
    return { status: 'ABSENT', projectRoot, reason: 'no .omp/operator.json present' };
  }
  if (policyStat.isSymbolicLink()) {
    return { status: 'INVALID', projectRoot, policyPath, reason: 'refusing symlinked project policy file' };
  }
  if (!policyStat.isFile()) {
    return { status: 'INVALID', projectRoot, policyPath, reason: '.omp/operator.json exists but is not a regular file' };
  }

  let policyBytes: Buffer;
  try {
    policyBytes = await readRegularFileNoFollow(policyPath);
  } catch (error) {
    return { status: 'INVALID', projectRoot, policyPath, reason: `failed to read project policy file: ${errorMessage(error)}` };
  }
  const actualHash = hashProjectPolicyBytes(policyBytes);

  const trustRecordPath = path.join(gitDir, 'agent-operator', 'trust.json');
  const trustStat = await lstatOrUndefined(trustRecordPath);
  if (!trustStat) {
    return { status: 'UNTRUSTED', projectRoot, policyPath, trustRecordPath, actualHash, reason: 'no trust record found for the project policy file' };
  }
  if (trustStat.isSymbolicLink()) {
    return { status: 'INVALID', projectRoot, policyPath, trustRecordPath, actualHash, reason: 'refusing symlinked trust record' };
  }
  if (!trustStat.isFile()) {
    return { status: 'INVALID', projectRoot, policyPath, trustRecordPath, actualHash, reason: 'trust record exists but is not a regular file' };
  }

  let trustRaw: unknown;
  try {
    const trustText = await readRegularFileNoFollow(trustRecordPath, 'utf8');

    trustRaw = JSON.parse(trustText);
  } catch (error) {
    return { status: 'INVALID', projectRoot, policyPath, trustRecordPath, actualHash, reason: `malformed trust record JSON: ${errorMessage(error)}` };
  }

  const trustResult = validateTrustRecord(trustRaw);
  if (!trustResult.ok) {
    return { status: 'INVALID', projectRoot, policyPath, trustRecordPath, actualHash, reason: `invalid trust record: ${trustResult.errors.join('; ')}` };
  }
  const trustRecord = trustResult.value;

  const expectedRelativePolicyPath = path.relative(projectRoot, policyPath).split(path.sep).join('/');
  if (trustRecord.policyPath !== expectedRelativePolicyPath) {
    return {
      status: 'INVALID',
      projectRoot,
      policyPath,
      trustRecordPath,
      expectedHash: trustRecord.expectedHash,
      actualHash,
      reason: `trust record targets "${trustRecord.policyPath}", not the resolved policy path "${expectedRelativePolicyPath}"`,
    };
  }

  if (trustRecord.expectedHash !== actualHash) {
    return {
      status: 'UNTRUSTED',
      projectRoot,
      policyPath,
      trustRecordPath,
      expectedHash: trustRecord.expectedHash,
      actualHash,
      reason: 'project policy bytes do not match the trust record hash',
    };
  }

  let overlayRaw: unknown;
  try {
    overlayRaw = JSON.parse(policyBytes.toString('utf8'));
  } catch (error) {
    return {
      status: 'INVALID',
      projectRoot,
      policyPath,
      trustRecordPath,
      expectedHash: trustRecord.expectedHash,
      actualHash,
      reason: `malformed project policy JSON: ${errorMessage(error)}`,
    };
  }

  const overlayResult = validateProjectOperatorOverlay(overlayRaw);
  if (!overlayResult.ok) {
    return {
      status: 'INVALID',
      projectRoot,
      policyPath,
      trustRecordPath,
      expectedHash: trustRecord.expectedHash,
      actualHash,
      reason: `invalid project policy schema: ${overlayResult.errors.join('; ')}`,
    };
  }

  const violations = findUnsafeBroadening(overlayResult.value);
  if (violations.length > 0) {
    return {
      status: 'INVALID',
      projectRoot,
      policyPath,
      trustRecordPath,
      expectedHash: trustRecord.expectedHash,
      actualHash,
      reason: `unsafe broadening of hard-locked defaults: ${violations.join(', ')}`,
    };
  }

  return {
    status: 'TRUSTED',
    projectRoot,
    policyPath,
    trustRecordPath,
    expectedHash: trustRecord.expectedHash,
    actualHash,
    overlay: overlayResult.value,
    reason: 'project policy bytes match the trust record; overlay applied',
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const POLICY_REF_DEFAULTS: PolicyRef = 'agent-operator@1:config.defaults';
const POLICY_REF_GLOBAL: PolicyRef = 'agent-operator@1:config.global';
const POLICY_REF_PROJECT_TRUSTED: PolicyRef = 'agent-operator@1:config.project.trusted';

/**
 * Resolves the effective `OperatorProfile` from bundled defaults, an
 * optional global overlay, and an optional trusted project overlay.
 *
 * Never throws for a missing, malformed, untrusted, or otherwise unsafe
 * project overlay — that outcome is fully captured in the returned
 * `projectOverlay.status`/`reason`, and such an overlay is guaranteed never
 * to have been applied to `profile`. Throws `OperatorConfigError` only when
 * the bundled defaults or an explicitly-present global config file are
 * themselves broken, since both are treated as trusted-by-construction
 * inputs rather than foreign/untrusted ones.
 */
export async function loadResolvedOperatorConfig(options: LoadOperatorConfigOptions = {}): Promise<ResolvedOperatorConfig> {
  const defaultsProfile = await loadDefaultsProfile();

  const globalConfigPath = resolveGlobalConfigPath(options);
  const globalOverlay = await loadGlobalOverlay(globalConfigPath);

  let profile = defaultsProfile;
  const policyRefs: PolicyRef[] = [POLICY_REF_DEFAULTS];
  if (globalOverlay) {
    profile = mergeOverlay(profile, globalOverlay);
    policyRefs.push(POLICY_REF_GLOBAL);
  }

  const startDir = options.projectRoot ?? options.cwd ?? process.cwd();
  const projectOverlay = await resolveProjectOverlay(startDir, options.projectRoot === undefined);
  if (projectOverlay.status === 'TRUSTED' && projectOverlay.overlay) {
    profile = mergeOverlay(profile, projectOverlay.overlay);
    policyRefs.push(POLICY_REF_PROJECT_TRUSTED);
  }

  return { profile, globalConfigPath, projectOverlay, policyRefs };
}

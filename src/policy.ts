/**
 * Agent Operator — Stage 3 policy and workflow-policy engine.
 *
 * Owns everything that turns a `ClassificationProposal` plus a
 * `ResolvedOperatorConfig` and a set of loaded `PolicyPack`s into one
 * auditable `ResolvedPolicy`: dependency-free JSON-compatible-YAML pack
 * parsing (`loadPolicyPacks`/`parsePolicyPack`), task-family applicability
 * filtering, duplicate/conflict detection, deterministic monotonic rule
 * precedence, bounded max-round resolution, required-gate derivation, and
 * budget-profile enforcement (`resolvePolicy`).
 *
 * Every policy pack rule is a "require" flag, a mutation-class ceiling, or a
 * review-round ceiling — there is no "loosen" primitive in `PolicyPackRules`.
 * `resolvePolicy` merges the profile baseline (`config.profile.rules`, which
 * `config.ts` already resolved from trusted project overlay narrowing per
 * `ProjectOperatorOverlay`'s contract) with every applicable pack's rules by
 * OR (booleans) and MIN (numeric/ordinal ceilings) only, so a policy pack can
 * never loosen a safety rule the profile already set — the "safety rules can
 * only narrow" invariant is structural, not a runtime comparison.
 *
 * `resolvePolicy` never reads a `Finding`: nothing a reviewer or the
 * classifier reports can influence `effectiveRules.maxReviewRounds` or any
 * other derived value, so no reviewer or classifier can self-authorize
 * another review round.
 *
 * `ResolvedPolicy.requiredGates` always includes both `EXECUTION_APPROVAL`
 * (the initial gate) and `RESULT_APPROVAL` (the terminal gate) as hard
 * Stage 3 baselines, unconditionally — never derived solely from
 * `effectiveRules.humanIsFinalApprover`, so no pack combination can silently
 * drop the terminal gate a mock pipeline needs to reach `COMPLETED`. Every
 * derived value is recorded as an immutable `PolicyDecision` with
 * `decisionSource: 'POLICY'`, at least one `ReasonCodeToken`, and at least
 * one versioned `PolicyRef` — never a bare computed value with no audit
 * trail.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  BudgetProfile,
  GateDecisionType,
  MutationClass,
  PolicyDecision,
  PolicyRef,
  PolicySubjectType,
  TaskFamily,
} from './contracts.js';
import type {
  ClassificationProposal,
  OperatorRules,
  PolicyPack,
  PolicyPackRules,
  ResolvedOperatorConfig,
  ResolvedPolicy,
} from './stage3-types.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type PolicyEngineErrorCode =
  | 'UNKNOWN_POLICY_PACK'
  | 'POLICY_PACK_INVALID'
  | 'INCOMPATIBLE_POLICY_PACKS'
  | 'BUDGET_PROFILE_CONFLICT'
  | 'REVIEW_ROUND_CONFLICT'
  | 'POLICY_CONFLICT';

/** Thrown by `loadPolicyPacks`/`parsePolicyPack`/`resolvePolicy`/
 * `resolveNodeTimeoutMs` for every unknown pack, malformed pack file,
 * pack-vs-pack incompatibility, budget-profile conflict, or invalid
 * caller-requested node timeout. `compiler.ts` catches this and maps `code`
 * to a `CompilationFailureCode` (`UNKNOWN_POLICY_PACK` / `POLICY_PACK_INVALID`
 * / `INCOMPATIBLE_POLICY_PACKS` / `REVIEW_ROUND_CONFLICT` / `POLICY_CONFLICT`
 * -> `POLICY_CONFLICT`; `BUDGET_PROFILE_CONFLICT` -> `BUDGET_EXCEEDED`). */
export class PolicyEngineError extends Error {
  readonly code: PolicyEngineErrorCode;
  readonly reasonCodes: readonly string[];
  readonly policyRefs: readonly PolicyRef[];

  constructor(code: PolicyEngineErrorCode, message: string, reasonCodes: readonly string[], policyRefs: readonly PolicyRef[]) {
    super(message);
    this.name = 'PolicyEngineError';
    this.code = code;
    this.reasonCodes = reasonCodes;
    this.policyRefs = policyRefs;
  }
}

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Package-relative bundled policy pack directory: `<packageRoot>/policies`,
 * resolved from this module's own location so no absolute filesystem path is
 * ever hardcoded. */
export const DEFAULT_POLICIES_DIR: string = fileURLToPath(new URL('../policies', import.meta.url));

/** Hard system ceiling on `effectiveRules.maxReviewRounds`, independent of
 * profile/pack configuration: bounded max-round resolution never yields a
 * value above this, defense-in-depth against a misconfigured profile or pack
 * requesting an effectively unbounded review loop. */
export const ABSOLUTE_MAX_REVIEW_ROUNDS = 5;

/** Per-`BudgetProfile` default node execution timeout for Stage 4 native
 * `omp-task` dispatch, in milliseconds. A higher-scrutiny (more expensive)
 * budget profile gets more wall-clock room, never less. */
const NODE_TIMEOUT_MS_BY_BUDGET: Readonly<Record<BudgetProfile, number>> = {
  CHEAP: 3 * 60_000,
  BALANCED: 5 * 60_000,
  QUALITY: 10 * 60_000,
  CRITICAL: 15 * 60_000,
};

/** Hard system ceiling on any resolved node timeout, independent of budget
 * profile or a caller-requested override: no Stage 4 node timeout can ever
 * exceed this, matching the adapter's own hard-maximum requirement (plan
 * §3.2, §6.4: a zero or absent timeout is invalid in production; every
 * timeout is capped, never unbounded). */
export const ABSOLUTE_MAX_NODE_TIMEOUT_MS = 20 * 60_000;

/**
 * Resolves the concrete, finite node-execution timeout (milliseconds) the
 * `omp-task` adapter must use for one dispatched node, given the graph's
 * resolved `budgetProfile` and an optional caller-requested override. This
 * is the single choke point every Stage 4 dispatch path must call — it
 * never returns zero, a negative number, or `Infinity`, and a caller-passed
 * `requestedTimeoutMs` that is not a positive finite number is rejected
 * rather than silently clamped to something plausible-looking.
 */
export function resolveNodeTimeoutMs(budgetProfile: BudgetProfile, requestedTimeoutMs?: number): number {
  const ceiling = Math.min(NODE_TIMEOUT_MS_BY_BUDGET[budgetProfile], ABSOLUTE_MAX_NODE_TIMEOUT_MS);
  if (requestedTimeoutMs === undefined) {
    return ceiling;
  }
  if (!Number.isFinite(requestedTimeoutMs) || requestedTimeoutMs <= 0) {
    throw new PolicyEngineError(
      'POLICY_CONFLICT',
      `node timeout must be a positive finite number of milliseconds; got ${requestedTimeoutMs}.`,
      ['NODE_TIMEOUT_MUST_BE_POSITIVE_FINITE'],
      [engineRef('resolveNodeTimeoutMs')],
    );
  }
  return Math.min(requestedTimeoutMs, ceiling);
}

const PACK_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const POLICY_REF_PATTERN = /^[a-z][a-z0-9-]*@\d+:[A-Za-z][A-Za-z0-9_.]*$/;

const TASK_FAMILY_VALUES: readonly string[] = ['DIRECT', 'RESEARCH', 'PLAN', 'IMPLEMENT', 'REVIEW', 'UI', 'QA', 'SECURITY', 'OPERATIONS'];
const MUTATION_CLASS_VALUES: readonly string[] = ['READ_ONLY', 'LOCAL', 'EXTERNAL', 'DESTRUCTIVE'];
const BUDGET_ORDER: readonly BudgetProfile[] = ['CHEAP', 'BALANCED', 'QUALITY', 'CRITICAL'];

const POLICY_PACK_TOP_KEYS: readonly string[] = ['schemaVersion', 'id', 'version', 'description', 'incompatibleWith', 'appliesTo', 'rules'];
const POLICY_PACK_RULE_KEYS: readonly string[] = [
  'requireIndependentReview',
  'requireAdversarialReview',
  'requireScopeFreeze',
  'requireHumanFinalApproval',
  'requireExecutionApprovalForMutation',
  'maximumMutationClass',
  'maxReviewRounds',
];

function engineRef(field: string): PolicyRef {
  return `policy-engine@1:${field}`;
}

function profileRef(field: string): PolicyRef {
  return `operator-profile@1:${field}`;
}

function packRef(pack: PolicyPack, field: string): PolicyRef {
  return `${pack.id}@${pack.version}:${field}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  return Array.from(new Set(values));
}

function dedupePolicyRefs(values: readonly PolicyRef[]): PolicyRef[] {
  return Array.from(new Set(values));
}

function budgetIndex(profile: BudgetProfile): number {
  return BUDGET_ORDER.indexOf(profile);
}

function mutationClassIndex(mutationClass: MutationClass): number {
  return MUTATION_CLASS_VALUES.indexOf(mutationClass);
}

// ---------------------------------------------------------------------------
// Minimal dependency-free JSON-compatible-YAML parser
//
// Supports exactly the subset `PolicyPack.v1` needs: block mappings, block
// sequences of scalars, 2-space (or any consistent) indentation, `#`
// comments, single/double-quoted strings with minimal escapes, booleans,
// integers/decimals, `null`/`~`, and the empty flow collections `[]`/`{}`.
// Anchors, aliases, tags, non-empty flow collections, multi-document
// markers, and tabs are all rejected rather than silently misparsed.
// ---------------------------------------------------------------------------

type YamlScalar = string | number | boolean | null;
type YamlNode = YamlScalar | YamlNode[] | { [key: string]: YamlNode };

interface YamlLine {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}

function invalidPack(label: string, detail: string): never {
  throw new PolicyEngineError(
    'POLICY_PACK_INVALID',
    `Invalid policy pack "${label}": ${detail}`,
    ['POLICY_PACK_MALFORMED'],
    [engineRef('parsePolicyPack')],
  );
}

function hasOwn(obj: { [key: string]: YamlNode }, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function tokenizeYaml(source: string, label: string): YamlLine[] {
  const rawLines = source.split(/\r\n|\r|\n/);
  const lines: YamlLine[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const original = rawLines[i];
    if (original === undefined) continue;
    if (original.includes('\t')) invalidPack(label, `line ${i + 1}: tab characters are not permitted`);
    const withoutComment = stripYamlComment(original);
    const trimmedRight = withoutComment.replace(/[ \t]+$/, '');
    if (trimmedRight.trim().length === 0) continue;
    if (/^---\s*$/.test(trimmedRight) || /^\.\.\.\s*$/.test(trimmedRight)) {
      invalidPack(label, `line ${i + 1}: multi-document markers are not supported`);
    }
    let indent = 0;
    while (indent < trimmedRight.length && trimmedRight[indent] === ' ') indent += 1;
    const text = trimmedRight.slice(indent);
    lines.push({ indent, text, no: i + 1 });
  }
  return lines;
}

function findKeyColon(text: string, label: string, lineNo: number): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const after = text[i + 1];
      if (after === undefined || after === ' ') return i;
    }
  }
  invalidPack(label, `line ${lineNo}: expected "key: value" mapping entry, got "${text}"`);
}

function parseSingleQuoted(text: string, label: string, lineNo: number): string {
  const inner = text.slice(1, -1);
  if (inner.includes("'")) invalidPack(label, `line ${lineNo}: escaped quotes are not supported in single-quoted scalars`);
  return inner;
}

function parseDoubleQuoted(text: string, label: string, lineNo: number): string {
  const inner = text.slice(1, -1);
  let result = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '\\') {
      const next = inner[i + 1];
      if (next === '"') {
        result += '"';
        i += 1;
      } else if (next === '\\') {
        result += '\\';
        i += 1;
      } else if (next === 'n') {
        result += '\n';
        i += 1;
      } else if (next === 't') {
        result += '\t';
        i += 1;
      } else {
        invalidPack(label, `line ${lineNo}: unsupported escape sequence "\\${next ?? ''}"`);
      }
    } else if (ch === '"') {
      invalidPack(label, `line ${lineNo}: unescaped quote inside double-quoted scalar`);
    } else if (ch !== undefined) {
      result += ch;
    }
  }
  return result;
}

function parseYamlKey(rawKey: string, label: string, lineNo: number): string {
  if (rawKey.length === 0) invalidPack(label, `line ${lineNo}: empty mapping key`);
  if (rawKey.length >= 2 && rawKey.startsWith('"') && rawKey.endsWith('"')) return parseDoubleQuoted(rawKey, label, lineNo);
  if (rawKey.length >= 2 && rawKey.startsWith("'") && rawKey.endsWith("'")) return parseSingleQuoted(rawKey, label, lineNo);
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(rawKey)) invalidPack(label, `line ${lineNo}: unsupported mapping key "${rawKey}"`);
  return rawKey;
}

function parseYamlValue(text: string, label: string, lineNo: number): YamlNode {
  const trimmed = text.trim();
  if (trimmed === '[]') return [];
  if (trimmed === '{}') return {};
  if (/^[[{&*!|>%@`]/.test(trimmed)) {
    invalidPack(label, `line ${lineNo}: unsupported YAML syntax "${trimmed}"`);
  }
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return parseDoubleQuoted(trimmed, label, lineNo);
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return parseSingleQuoted(trimmed, label, lineNo);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (trimmed.includes('"') || trimmed.includes("'")) {
    invalidPack(label, `line ${lineNo}: unquoted scalar must not contain quote characters: "${trimmed}"`);
  }
  return trimmed;
}

function parseBlock(lines: readonly YamlLine[], start: number, indent: number, label: string): readonly [YamlNode, number] {
  const first = lines[start];
  if (first === undefined) invalidPack(label, `unexpected end of input while expecting content at indent ${indent}`);
  if (first.indent !== indent) invalidPack(label, `line ${first.no}: expected content at indent ${indent}, found indent ${first.indent}`);
  if (first.text === '-' || first.text.startsWith('- ')) return parseSequenceBlock(lines, start, indent, label);
  return parseMappingBlock(lines, start, indent, label);
}

function parseSequenceBlock(lines: readonly YamlLine[], start: number, indent: number, label: string): readonly [YamlNode[], number] {
  const result: YamlNode[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent !== indent) break;
    if (!(line.text === '-' || line.text.startsWith('- '))) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    if (rest.length === 0) {
      const next = lines[i + 1];
      if (next !== undefined && next.indent > indent) {
        const [value, nextIndex] = parseBlock(lines, i + 1, next.indent, label);
        result.push(value);
        i = nextIndex;
      } else {
        invalidPack(label, `line ${line.no}: empty sequence item`);
      }
    } else {
      result.push(parseYamlValue(rest, label, line.no));
      i += 1;
    }
  }
  return [result, i];
}

function parseMappingBlock(lines: readonly YamlLine[], start: number, indent: number, label: string): readonly [{ [key: string]: YamlNode }, number] {
  const result: { [key: string]: YamlNode } = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.indent !== indent) break;
    if (line.text === '-' || line.text.startsWith('- ')) break;
    const colonIdx = findKeyColon(line.text, label, line.no);
    const rawKey = line.text.slice(0, colonIdx).trim();
    const key = parseYamlKey(rawKey, label, line.no);
    if (hasOwn(result, key)) invalidPack(label, `line ${line.no}: duplicate key "${key}"`);
    const rest = line.text.slice(colonIdx + 1).trim();
    if (rest.length === 0) {
      const next = lines[i + 1];
      if (next !== undefined && next.indent > indent) {
        const [value, nextIndex] = parseBlock(lines, i + 1, next.indent, label);
        result[key] = value;
        i = nextIndex;
      } else {
        result[key] = null;
        i += 1;
      }
    } else {
      result[key] = parseYamlValue(rest, label, line.no);
      i += 1;
    }
  }
  return [result, i];
}

function parseJsonCompatibleYaml(source: string, label: string): YamlNode {
  const lines = tokenizeYaml(source, label);
  if (lines.length === 0) invalidPack(label, 'document is empty');
  const first = lines[0];
  if (first === undefined) invalidPack(label, 'document is empty');
  const [value, next] = parseBlock(lines, 0, first.indent, label);
  if (next !== lines.length) {
    const trailing = lines[next];
    invalidPack(label, `line ${trailing?.no ?? '(eof)'}: unexpected indentation change`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// PolicyPack structural validation
// ---------------------------------------------------------------------------

function isMapping(node: YamlNode): node is { [key: string]: YamlNode } {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

function isArrayNode(node: YamlNode): node is YamlNode[] {
  return Array.isArray(node);
}

function requireMapping(node: YamlNode, label: string, field: string): { [key: string]: YamlNode } {
  if (isMapping(node)) return node;
  return invalidPack(label, `field "${field}" must be a mapping`);
}

function requireArrayNode(node: YamlNode, label: string, field: string): YamlNode[] {
  if (isArrayNode(node)) return node;
  return invalidPack(label, `field "${field}" must be an array`);
}

function requireStringNode(node: YamlNode, label: string, field: string): string {
  if (typeof node === 'string') return node;
  return invalidPack(label, `field "${field}" must be a string`);
}

function requireNumberNode(node: YamlNode, label: string, field: string): number {
  if (typeof node === 'number' && Number.isFinite(node)) return node;
  return invalidPack(label, `field "${field}" must be a number`);
}

function requireBooleanNode(node: YamlNode, label: string, field: string): boolean {
  if (typeof node === 'boolean') return node;
  return invalidPack(label, `field "${field}" must be a boolean`);
}

function requireMutationClassNode(node: YamlNode, label: string): MutationClass {
  const value = requireStringNode(node, label, 'rules.maximumMutationClass');
  if (!MUTATION_CLASS_VALUES.includes(value)) {
    invalidPack(label, `field "rules.maximumMutationClass" must be one of ${MUTATION_CLASS_VALUES.join(', ')}, got "${value}"`);
  }
  return value as MutationClass;
}

function requireRoundsNode(node: YamlNode, label: string, field: string): number {
  const value = requireNumberNode(node, label, field);
  if (!Number.isInteger(value) || value < 0) invalidPack(label, `field "${field}" must be a non-negative integer, got ${value}`);
  return value;
}

/** Parses one `PolicyPack.v1` document from JSON-compatible-YAML source
 * text. Rejects unknown top-level/`rules` fields, malformed types, and
 * self-referential/duplicate `incompatibleWith`/`appliesTo` entries — fails
 * closed on anything it cannot fully validate rather than defaulting a
 * field. `label` is used only in error messages (typically the source file
 * name). */
export function parsePolicyPack(source: string, label: string): PolicyPack {
  const root = parseJsonCompatibleYaml(source, label);
  const raw = requireMapping(root, label, '(root)');
  for (const key of Object.keys(raw)) {
    if (!POLICY_PACK_TOP_KEYS.includes(key)) invalidPack(label, `unknown top-level field "${key}"`);
  }

  const schemaVersionNode = raw.schemaVersion;
  if (schemaVersionNode === undefined) invalidPack(label, 'missing required field "schemaVersion"');
  const schemaVersion = requireStringNode(schemaVersionNode, label, 'schemaVersion');
  if (schemaVersion !== '1.0') invalidPack(label, `field "schemaVersion" must be exactly "1.0", got "${schemaVersion}"`);

  const idNode = raw.id;
  if (idNode === undefined) invalidPack(label, 'missing required field "id"');
  const id = requireStringNode(idNode, label, 'id');
  if (!PACK_ID_PATTERN.test(id)) invalidPack(label, `field "id" must match ${PACK_ID_PATTERN.source}, got "${id}"`);

  const versionNode = raw.version;
  if (versionNode === undefined) invalidPack(label, 'missing required field "version"');
  const version = requireNumberNode(versionNode, label, 'version');
  if (!Number.isInteger(version) || version < 1) invalidPack(label, `field "version" must be a positive integer, got ${version}`);

  const descriptionNode = raw.description;
  if (descriptionNode === undefined) invalidPack(label, 'missing required field "description"');
  const description = requireStringNode(descriptionNode, label, 'description');
  if (description.trim().length === 0) invalidPack(label, 'field "description" must not be empty');
  if (description.length > 1000) invalidPack(label, 'field "description" exceeds 1000 characters');

  const incompatibleWithNode = raw.incompatibleWith;
  if (incompatibleWithNode === undefined) invalidPack(label, 'missing required field "incompatibleWith"');
  const incompatibleWithArray = requireArrayNode(incompatibleWithNode, label, 'incompatibleWith');
  const incompatibleWith = incompatibleWithArray.map((entry, i) => requireStringNode(entry, label, `incompatibleWith[${i}]`));
  const seenIncompatible = new Set<string>();
  for (const entry of incompatibleWith) {
    if (!PACK_ID_PATTERN.test(entry)) invalidPack(label, `field "incompatibleWith" contains an invalid pack id "${entry}"`);
    if (entry === id) invalidPack(label, `field "incompatibleWith" must not reference its own pack id "${id}"`);
    if (seenIncompatible.has(entry)) invalidPack(label, `field "incompatibleWith" contains duplicate entry "${entry}"`);
    seenIncompatible.add(entry);
  }

  const appliesToNode = raw.appliesTo;
  if (appliesToNode === undefined) invalidPack(label, 'missing required field "appliesTo"');
  const appliesToArray = requireArrayNode(appliesToNode, label, 'appliesTo');
  if (appliesToArray.length === 0) invalidPack(label, 'field "appliesTo" must not be empty');
  const appliesToStrings = appliesToArray.map((entry, i) => requireStringNode(entry, label, `appliesTo[${i}]`));
  const seenFamilies = new Set<string>();
  for (const entry of appliesToStrings) {
    if (!TASK_FAMILY_VALUES.includes(entry)) invalidPack(label, `field "appliesTo" contains an unknown task family "${entry}"`);
    if (seenFamilies.has(entry)) invalidPack(label, `field "appliesTo" contains duplicate entry "${entry}"`);
    seenFamilies.add(entry);
  }
  const appliesTo = appliesToStrings as TaskFamily[];

  const rulesNode = raw.rules;
  if (rulesNode === undefined) invalidPack(label, 'missing required field "rules"');
  const rulesRaw = requireMapping(rulesNode, label, 'rules');
  for (const key of Object.keys(rulesRaw)) {
    if (!POLICY_PACK_RULE_KEYS.includes(key)) invalidPack(label, `unknown field "rules.${key}"`);
  }

  const requireIndependentReviewNode = rulesRaw.requireIndependentReview;
  const requireAdversarialReviewNode = rulesRaw.requireAdversarialReview;
  const requireScopeFreezeNode = rulesRaw.requireScopeFreeze;
  const requireHumanFinalApprovalNode = rulesRaw.requireHumanFinalApproval;
  const requireExecutionApprovalForMutationNode = rulesRaw.requireExecutionApprovalForMutation;
  const maximumMutationClassNode = rulesRaw.maximumMutationClass;
  const maxReviewRoundsNode = rulesRaw.maxReviewRounds;

  const rules: PolicyPackRules = {
    ...(requireIndependentReviewNode !== undefined
      ? { requireIndependentReview: requireBooleanNode(requireIndependentReviewNode, label, 'rules.requireIndependentReview') }
      : {}),
    ...(requireAdversarialReviewNode !== undefined
      ? { requireAdversarialReview: requireBooleanNode(requireAdversarialReviewNode, label, 'rules.requireAdversarialReview') }
      : {}),
    ...(requireScopeFreezeNode !== undefined ? { requireScopeFreeze: requireBooleanNode(requireScopeFreezeNode, label, 'rules.requireScopeFreeze') } : {}),
    ...(requireHumanFinalApprovalNode !== undefined
      ? { requireHumanFinalApproval: requireBooleanNode(requireHumanFinalApprovalNode, label, 'rules.requireHumanFinalApproval') }
      : {}),
    ...(requireExecutionApprovalForMutationNode !== undefined
      ? { requireExecutionApprovalForMutation: requireBooleanNode(requireExecutionApprovalForMutationNode, label, 'rules.requireExecutionApprovalForMutation') }
      : {}),
    ...(maximumMutationClassNode !== undefined ? { maximumMutationClass: requireMutationClassNode(maximumMutationClassNode, label) } : {}),
    ...(maxReviewRoundsNode !== undefined ? { maxReviewRounds: requireRoundsNode(maxReviewRoundsNode, label, 'rules.maxReviewRounds') } : {}),
  };

  return { schemaVersion: '1.0', id, version, description, incompatibleWith, appliesTo, rules };
}

/** Loads and parses one `PolicyPack.v1` file per (deduplicated) requested
 * id from `<policiesDir>/<id>.yaml`. Throws `PolicyEngineError` with code
 * `UNKNOWN_POLICY_PACK` for a missing/unreadable id, or `POLICY_PACK_INVALID`
 * for a malformed file or a file whose declared `id` does not match its own
 * filename (an ambiguous-identity conflict, rejected rather than silently
 * accepted under either name). Load order follows `ids` order, so results
 * are deterministic for a fixed input. */
export async function loadPolicyPacks(ids: readonly string[], policiesDir: string): Promise<PolicyPack[]> {
  const uniqueIds = Array.from(new Set(ids));
  const packs: PolicyPack[] = [];
  for (const id of uniqueIds) {
    if (!PACK_ID_PATTERN.test(id)) {
      throw new PolicyEngineError(
        'UNKNOWN_POLICY_PACK',
        `Policy pack id "${id}" is not a valid pack identifier.`,
        ['UNKNOWN_POLICY_PACK'],
        [engineRef('loadPolicyPacks')],
      );
    }
    const filePath = path.join(policiesDir, `${id}.yaml`);
    let bytes: string;
    try {
      bytes = await fs.readFile(filePath, 'utf8');
    } catch {
      throw new PolicyEngineError(
        'UNKNOWN_POLICY_PACK',
        `Policy pack "${id}" was not found under "${policiesDir}".`,
        ['UNKNOWN_POLICY_PACK'],
        [engineRef('loadPolicyPacks')],
      );
    }
    const pack = parsePolicyPack(bytes, `${id}.yaml`);
    if (pack.id !== id) {
      throw new PolicyEngineError(
        'POLICY_PACK_INVALID',
        `Policy pack file "${id}.yaml" declares id "${pack.id}", which does not match its filename.`,
        ['POLICY_PACK_ID_FILENAME_MISMATCH'],
        [engineRef('loadPolicyPacks')],
      );
    }
    packs.push(pack);
  }
  return packs;
}

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

export interface ResolvePolicyOptions {
  /** ISO-8601 timestamp stamped onto every produced `PolicyDecision`;
   * caller-supplied so `resolvePolicy` stays pure and deterministic (no
   * internal `Date.now()`). */
  readonly now: string;
}

function partitionPacksByApplicability(
  packs: readonly PolicyPack[],
  family: TaskFamily,
): { readonly active: PolicyPack[]; readonly inactive: PolicyPack[] } {
  const active: PolicyPack[] = [];
  const inactive: PolicyPack[] = [];
  for (const pack of packs) {
    if (pack.appliesTo.includes(family)) active.push(pack);
    else inactive.push(pack);
  }
  return { active, inactive };
}

function checkIncompatiblePacks(activePacks: readonly PolicyPack[]): void {
  const byId = new Map(activePacks.map((pack) => [pack.id, pack] as const));
  for (const pack of activePacks) {
    for (const otherId of pack.incompatibleWith) {
      const other = byId.get(otherId);
      if (other !== undefined) {
        throw new PolicyEngineError(
          'INCOMPATIBLE_POLICY_PACKS',
          `Policy pack "${pack.id}" is incompatible with active policy pack "${otherId}".`,
          ['INCOMPATIBLE_POLICY_PACKS_ACTIVE_TOGETHER'],
          [packRef(pack, 'incompatibleWith'), packRef(other, 'id')],
        );
      }
    }
  }
}

interface FieldResult {
  readonly reasonCodes: readonly string[];
  readonly policyRefs: readonly PolicyRef[];
  readonly inputs: Readonly<Record<string, string>>;
}

function resolveMaxReviewRounds(config: ResolvedOperatorConfig, activePacks: readonly PolicyPack[]): FieldResult & { readonly rounds: number } {
  let rounds = Math.min(config.profile.rules.maxReviewRounds, ABSOLUTE_MAX_REVIEW_ROUNDS);
  const reasonCodes = ['PROFILE_MAX_REVIEW_ROUNDS_BASELINE'];
  const policyRefs: PolicyRef[] = [profileRef('rules.maxReviewRounds')];
  if (config.profile.rules.maxReviewRounds > ABSOLUTE_MAX_REVIEW_ROUNDS) {
    reasonCodes.push('ABSOLUTE_MAX_REVIEW_ROUNDS_CEILING_APPLIED');
    policyRefs.push(engineRef('ABSOLUTE_MAX_REVIEW_ROUNDS'));
  }
  for (const pack of activePacks) {
    const packBound = pack.rules.maxReviewRounds;
    if (packBound !== undefined && packBound < rounds) {
      rounds = packBound;
      reasonCodes.push('PACK_MAX_REVIEW_ROUNDS_NARROWED');
      policyRefs.push(packRef(pack, 'rules.maxReviewRounds'));
    }
  }
  return {
    rounds,
    reasonCodes: dedupeStrings(reasonCodes),
    policyRefs: dedupePolicyRefs(policyRefs),
    inputs: { final: String(rounds), profileDefault: String(config.profile.rules.maxReviewRounds) },
  };
}

function mergeEffectiveRules(config: ResolvedOperatorConfig, activePacks: readonly PolicyPack[]): FieldResult & { readonly rules: OperatorRules } {
  const base = config.profile.rules;
  let independentVerification = base.independentVerification;
  let adversarialReviewForHighRisk = base.adversarialReviewForHighRisk;
  let scopeFreezeRequired = base.scopeFreezeRequired;
  let humanIsFinalApprover = base.humanIsFinalApprover;
  let implementerSelfApproval = base.implementerSelfApproval;
  let automaticCommit = base.automaticCommit;
  let automaticPush = base.automaticPush;
  let automaticMerge = base.automaticMerge;

  const reasonCodes: string[] = ['BASELINE_PROFILE_RULES'];
  const policyRefs: PolicyRef[] = [profileRef('rules')];

  for (const pack of activePacks) {
    const r = pack.rules;
    if (r.requireIndependentReview === true && !independentVerification) {
      independentVerification = true;
      reasonCodes.push('RULE_INDEPENDENT_REVIEW_REQUIRED');
      policyRefs.push(packRef(pack, 'rules.requireIndependentReview'));
    }
    if (r.requireAdversarialReview === true && !adversarialReviewForHighRisk) {
      adversarialReviewForHighRisk = true;
      reasonCodes.push('RULE_ADVERSARIAL_REVIEW_REQUIRED');
      policyRefs.push(packRef(pack, 'rules.requireAdversarialReview'));
    }
    if (r.requireScopeFreeze === true && !scopeFreezeRequired) {
      scopeFreezeRequired = true;
      reasonCodes.push('RULE_SCOPE_FREEZE_REQUIRED');
      policyRefs.push(packRef(pack, 'rules.requireScopeFreeze'));
    }
    if (r.requireHumanFinalApproval === true && !humanIsFinalApprover) {
      humanIsFinalApprover = true;
      reasonCodes.push('RULE_HUMAN_FINAL_APPROVAL_REQUIRED');
      policyRefs.push(packRef(pack, 'rules.requireHumanFinalApproval'));
    }
    if (r.requireExecutionApprovalForMutation === true && (implementerSelfApproval || automaticCommit || automaticPush || automaticMerge)) {
      implementerSelfApproval = false;
      automaticCommit = false;
      automaticPush = false;
      automaticMerge = false;
      reasonCodes.push('RULE_EXECUTION_APPROVAL_FOR_MUTATION_REQUIRED');
      policyRefs.push(packRef(pack, 'rules.requireExecutionApprovalForMutation'));
    }
  }

  const rules: OperatorRules = {
    humanIsFinalApprover,
    implementerSelfApproval,
    automaticCommit,
    automaticPush,
    automaticMerge,
    independentVerification,
    adversarialReviewForHighRisk,
    scopeFreezeRequired,
    maxReviewRounds: base.maxReviewRounds,
  };

  return { rules, reasonCodes: dedupeStrings(reasonCodes), policyRefs: dedupePolicyRefs(policyRefs), inputs: {} };
}

function resolveMutationCeiling(activePacks: readonly PolicyPack[]): FieldResult {
  let ceiling: MutationClass | undefined;
  const contributingRefs: PolicyRef[] = [];
  for (const pack of activePacks) {
    const candidate = pack.rules.maximumMutationClass;
    if (candidate === undefined) continue;
    if (ceiling === undefined || mutationClassIndex(candidate) < mutationClassIndex(ceiling)) ceiling = candidate;
    contributingRefs.push(packRef(pack, 'rules.maximumMutationClass'));
  }
  if (ceiling === undefined) {
    return { reasonCodes: ['NO_MUTATION_CEILING_CONFIGURED'], policyRefs: [profileRef('rules')], inputs: {} };
  }
  return {
    reasonCodes: dedupeStrings(['MUTATION_CEILING_APPLIED']),
    policyRefs: dedupePolicyRefs(contributingRefs),
    inputs: { maximumMutationClass: ceiling },
  };
}

/** Stage 3 mock execution always starts behind an exact
 * `EXECUTION_APPROVAL` gate. PLAN workflows end at `PLAN_APPROVAL`; every
 * other supported delegated family ends at `RESULT_APPROVAL`. Independent
 * and adversarial review requirements are graph nodes, not extra human
 * gates, so they never invent an `APPROVE_PROGRESSION` decision. */
function deriveRequiredGates(family: TaskFamily): GateDecisionType[] {
  return [
    'EXECUTION_APPROVAL',
    family === 'PLAN' ? 'PLAN_APPROVAL' : 'RESULT_APPROVAL',
  ];
}

function resolveBudgetProfile(
  classification: ClassificationProposal,
  config: ResolvedOperatorConfig,
  effectiveRules: OperatorRules,
): FieldResult & { readonly profile: BudgetProfile } {
  const requiresReview = effectiveRules.independentVerification || effectiveRules.adversarialReviewForHighRisk;
  let hardSafetyFloor: BudgetProfile | undefined;
  const reasonCodes: string[] = [];

  if (classification.riskClassification === 'CRITICAL') {
    hardSafetyFloor = 'CRITICAL';
    reasonCodes.push('HARD_SAFETY_CRITICAL_RISK_REQUIRES_CRITICAL_BUDGET');
  } else if (classification.riskClassification === 'HIGH' && effectiveRules.adversarialReviewForHighRisk) {
    hardSafetyFloor = 'QUALITY';
    reasonCodes.push('HARD_SAFETY_HIGH_RISK_ADVERSARIAL_REVIEW_REQUIRES_QUALITY_BUDGET');
  } else if (requiresReview) {
    hardSafetyFloor = 'QUALITY';
    reasonCodes.push('HARD_SAFETY_REVIEW_REQUIREMENT_REQUIRES_QUALITY_BUDGET');
  }

  let chosen: BudgetProfile;
  if (classification.requestedBudgetProfile !== undefined) {
    chosen = classification.requestedBudgetProfile;
    reasonCodes.push('BUDGET_FROM_EXPLICIT_INTENT');
  } else {
    chosen = config.profile.budgetProfile;
    reasonCodes.push('BUDGET_FROM_TRUSTED_POLICY');
  }

  let final = chosen;
  if (hardSafetyFloor !== undefined && budgetIndex(hardSafetyFloor) > budgetIndex(chosen)) {
    final = hardSafetyFloor;
    reasonCodes.push('BUDGET_ESCALATED_BY_HARD_SAFETY');
  }

  if (final === 'CHEAP' && classification.requestedExecutionShape === 'COUNCIL') {
    throw new PolicyEngineError(
      'BUDGET_PROFILE_CONFLICT',
      `CHEAP budget profile forbids COUNCIL execution shape for request classification "${classification.requestClassification}".`,
      ['CHEAP_FORBIDS_COUNCIL_EXECUTION_SHAPE'],
      [profileRef('budgetProfile'), engineRef('classification.requestedExecutionShape')],
    );
  }

  const policyRefs: PolicyRef[] = [profileRef('budgetProfile')];
  if (classification.requestedBudgetProfile !== undefined) policyRefs.push(engineRef('classification.requestedBudgetProfile'));

  return {
    profile: final,
    reasonCodes: dedupeStrings(reasonCodes),
    policyRefs: dedupePolicyRefs(policyRefs),
    inputs: {
      requested: classification.requestedBudgetProfile ?? '(none)',
      trustedPolicyDefault: config.profile.budgetProfile,
      hardSafetyFloor: hardSafetyFloor ?? '(none)',
      final,
    },
  };
}

function assertDecisionShape(reasonCodes: readonly string[], policyRefs: readonly PolicyRef[]): void {
  if (reasonCodes.length === 0) throw new Error('internal: PolicyDecision requires at least one reason code');
  if (policyRefs.length === 0) throw new Error('internal: PolicyDecision requires at least one policy ref');
  for (const code of reasonCodes) {
    if (!REASON_CODE_PATTERN.test(code)) throw new Error(`internal: invalid reason code "${code}"`);
  }
  for (const ref of policyRefs) {
    if (!POLICY_REF_PATTERN.test(ref)) throw new Error(`internal: invalid policy ref "${ref}"`);
  }
}

/** Resolves one `ClassificationProposal` against `config` and the packs
 * already loaded for it (see `loadPolicyPacks`) into a fully auditable
 * `ResolvedPolicy`. Pure and synchronous: every input is an argument, every
 * output is either the returned `ResolvedPolicy` or a thrown
 * `PolicyEngineError` — there is no partial success. Filters `packs` to
 * those whose `appliesTo` includes `classification.requestClassification`
 * (`ResolvedPolicy.packs` is that active subset); every other derivation
 * (`effectiveRules`, `maxReviewRounds`, `requiredGates`, `budgetProfile`) is
 * a monotonic merge over that active subset plus the profile baseline, and
 * every one is recorded as a `PolicyDecision` in `ResolvedPolicy.decisions`. */
export function resolvePolicy(
  classification: ClassificationProposal,
  config: ResolvedOperatorConfig,
  packs: readonly PolicyPack[],
  options: ResolvePolicyOptions,
): ResolvedPolicy {
  const family = classification.requestClassification;
  const { active: activePacks, inactive: inactivePacks } = partitionPacksByApplicability(packs, family);

  checkIncompatiblePacks(activePacks);

  let sequence = 0;
  const decisions: PolicyDecision[] = [];
  const record = (
    subjectType: PolicySubjectType,
    subjectId: string,
    reasonCodes: readonly string[],
    policyRefs: readonly PolicyRef[],
    inputs: Readonly<Record<string, string>>,
  ): void => {
    const uniqueReasonCodes = dedupeStrings(reasonCodes);
    const uniquePolicyRefs = dedupePolicyRefs(policyRefs);
    assertDecisionShape(uniqueReasonCodes, uniquePolicyRefs);
    sequence += 1;
    decisions.push({
      decisionId: `policy:${subjectType}:${subjectId}:${sequence}`,
      subjectType,
      subjectId,
      decision: 'RECORD',
      decisionSource: 'POLICY',
      reasonCodes: uniqueReasonCodes,
      policyRefs: uniquePolicyRefs,
      inputs,
      timestamp: options.now,
    });
  };

  for (const pack of activePacks) {
    record('workflow', `pack:${pack.id}`, ['PACK_APPLIED'], [packRef(pack, 'appliesTo')], { taskFamily: family });
  }
  for (const pack of inactivePacks) {
    record('workflow', `pack:${pack.id}`, ['PACK_NOT_APPLICABLE_TASK_FAMILY'], [packRef(pack, 'appliesTo')], { taskFamily: family });
  }

  const roundsResult = resolveMaxReviewRounds(config, activePacks);
  record('workflow', 'max-review-rounds', roundsResult.reasonCodes, roundsResult.policyRefs, roundsResult.inputs);

  const rulesResult = mergeEffectiveRules(config, activePacks);
  const effectiveRules: OperatorRules = { ...rulesResult.rules, maxReviewRounds: roundsResult.rounds };
  record('workflow', 'effective-rules', rulesResult.reasonCodes, rulesResult.policyRefs, { maxReviewRounds: String(roundsResult.rounds) });

  const ceilingResult = resolveMutationCeiling(activePacks);
  record('workflow', 'mutation-ceiling', ceilingResult.reasonCodes, ceilingResult.policyRefs, ceilingResult.inputs);

  const budgetResult = resolveBudgetProfile(classification, config, effectiveRules);
  record('route', 'budget-profile', budgetResult.reasonCodes, budgetResult.policyRefs, budgetResult.inputs);

  const requiredGates = deriveRequiredGates(family);

  record('gate', 'required-gates', ['REQUIRED_GATES_DERIVED'], [profileRef('rules')], { gates: requiredGates.join(',') });

  const policyRefs = dedupePolicyRefs(decisions.flatMap((decision) => decision.policyRefs));

  return {
    config,
    packs: activePacks,
    effectiveRules,
    budgetProfile: budgetResult.profile,
    maxConcurrency: config.profile.maxConcurrency,
    requiredGates,
    policyRefs,
    decisions,
  };
}

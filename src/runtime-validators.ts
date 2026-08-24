/**
 * Agent Operator — Stage 2 runtime contract validators.
 *
 * Pure, synchronous, side-effect-free validation for the Stage 2 store
 * envelope (`StoredOperatorSession`) and the `/operator` command outcome
 * (`OperatorCommandOutcome`). Nested `OperatorSession` and `HumanGate`
 * records are validated by re-invoking the public Stage 1 validators; this
 * module owns only the envelope-level shape and the cross-field invariants
 * specific to Stage 2's storage and command surface. Every property not
 * declared by a contract is rejected, and no input is ever mutated.
 */

import type { AgentResultStatus, FindingEffectiveDisposition, HumanGate, NodeState, OperatorSession, PolicyRef } from './contracts.js';
import type {
  NodeExecutionAdapterId,
  NodeExecutionAttemptAllocation,
  NodeExecutionUsage,
  NodeResultRefs,
  OperatorCommandErrorCode,
  OperatorCommandOutcome,
  SimulationResultEnvelope,
  StoredOperatorSession,
} from './runtime-types.js';
import { validateHumanGate, validateOperatorSession } from './validation/session.js';
import { validateExecutionGraph, validateRouteDecision } from './validation/core-contracts.js';
import { validateDecisionTrace, validateRuntimeDisclosureDecision, type DecisionTrace, type RuntimeDisclosureDecision } from './intelligence.js';
import { requireHash, type ValidationError, type ValidationResult } from './validation/primitives.js';
import { validateShadowObservation, type ShadowObservation } from './shadow-routing.js';
import {
  validateFailureFingerprint,
  validateProviderFallbackJournal,
  type FailureFingerprint,
  type ProviderFallbackJournal,
} from './execution-safety.js';
import { validateExecutionEstimate, validatePolicyDiffReport, type PolicyDiffReport } from './policy-simulation.js';
// ---------------------------------------------------------------------------
// Internal validation engine (mirrors the Stage 1 engine in validators.ts;
// that module's helpers are not exported, so this module owns its own
// minimal copy scoped to the two Stage 2 envelope shapes below).
// ---------------------------------------------------------------------------

type Path = ReadonlyArray<string | number>;

interface Ctx {
  readonly errors: ValidationError[];
}

function newCtx(): Ctx {
  return { errors: [] };
}

function pathToString(path: Path): string {
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

function pushErr(ctx: Ctx, path: Path, message: string): void {
  ctx.errors.push({ path: pathToString(path), message });
}

function finalize<T>(ctx: Ctx, value: Record<string, unknown>): ValidationResult<T> {
  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors };
  }
  return { ok: true, value: value as T };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkObjectShape(ctx: Ctx, path: Path, value: unknown, allowedKeys: readonly string[]): Record<string, unknown> | undefined {
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

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function requireBoolean(ctx: Ctx, path: Path, value: unknown): boolean | undefined {
  if (typeof value !== 'boolean') {
    pushErr(ctx, path, 'must be a boolean');
    return undefined;
  }
  return value;
}

const MAX_OUTCOME_TEXT = 20000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function requireNonEmptyString(ctx: Ctx, path: Path, value: unknown, maxLen: number): string | undefined {
  if (typeof value !== 'string') {
    pushErr(ctx, path, 'must be a string');
    return undefined;
  }
  if (value.length === 0) {
    pushErr(ctx, path, 'must be non-empty');
    return undefined;
  }
  if (value.length > maxLen) {
    pushErr(ctx, path, `must be at most ${maxLen} character(s)`);
    return undefined;
  }
  return value;
}

function requireId(ctx: Ctx, path: Path, value: unknown): string | undefined {
  if (typeof value !== 'string') {
    pushErr(ctx, path, 'must be a string');
    return undefined;
  }
  if (value.length > 128 || !ID_PATTERN.test(value)) {
    pushErr(ctx, path, `must match pattern ${ID_PATTERN.source}`);
    return undefined;
  }
  return value;
}

function requireEnum<T extends string>(ctx: Ctx, path: Path, value: unknown, allowed: readonly T[]): T | undefined {
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

function requireArray(ctx: Ctx, path: Path, value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) {
    pushErr(ctx, path, 'must be an array');
    return undefined;
  }
  return value;
}

function requireNumber(ctx: Ctx, path: Path, value: unknown, opts: { readonly min?: number; readonly integer?: boolean } = {}): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    pushErr(ctx, path, 'must be a finite number');
    return undefined;
  }
  if (opts.integer === true && !Number.isInteger(value)) {
    pushErr(ctx, path, 'must be an integer');
    return undefined;
  }
  if (opts.min !== undefined && value < opts.min) {
    pushErr(ctx, path, `must be >= ${opts.min}`);
    return undefined;
  }
  return value;
}

const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function requireTimestamp(ctx: Ctx, path: Path, value: unknown): string | undefined {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    pushErr(ctx, path, 'must be an ISO-8601 timestamp');
    return undefined;
  }
  return value;
}

const POLICY_REF_PATTERN = /^[a-z][a-z0-9-]*@\d+:[A-Za-z][A-Za-z0-9_.]*$/;

function requirePolicyRef(ctx: Ctx, path: Path, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 128 || !POLICY_REF_PATTERN.test(value)) {
    pushErr(ctx, path, `must match pattern ${POLICY_REF_PATTERN.source}`);
    return undefined;
  }
  return value;
}

function requireIdArray(ctx: Ctx, path: Path, value: unknown): string[] | undefined {
  const items = requireArray(ctx, path, value);
  if (items === undefined) return undefined;
  const out: string[] = [];
  let ok = true;
  items.forEach((item, i) => {
    const id = requireId(ctx, [...path, i], item);
    if (id === undefined) {
      ok = false;
    } else {
      out.push(id);
    }
  });
  return ok ? out : undefined;
}

function requirePolicyRefArray(ctx: Ctx, path: Path, value: unknown): string[] | undefined {
  const items = requireArray(ctx, path, value);
  if (items === undefined) return undefined;
  const out: string[] = [];
  let ok = true;
  items.forEach((item, i) => {
    const ref = requirePolicyRef(ctx, [...path, i], item);
    if (ref === undefined) {
      ok = false;
    } else {
      out.push(ref);
    }
  });
  return ok ? out : undefined;
}

import { STAGE7_BINDINGS } from './stage7/bindings.js';

const NODE_EXECUTION_ADAPTER_IDS: readonly NodeExecutionAdapterId[] = ['mock', 'omp-task', 'external-cli', ...STAGE7_BINDINGS.map((binding) => binding.adapterId).filter((id, index, ids) => ids.indexOf(id) === index)];

const NODE_EXECUTION_ATTEMPT_ALLOCATION_KEYS = [
  'attemptId',
  'batchId',
  'operatorSessionId',
  'graphRevision',
  'nodeId',
  'capabilityId',
  'adapterId',
  'providerSessionId',
  'startedAt',
  'timeoutAt',
] as const;

function validateNodeExecutionAttemptAllocation(ctx: Ctx, path: Path, value: unknown): NodeExecutionAttemptAllocation | undefined {
  const raw = checkObjectShape(ctx, path, value, NODE_EXECUTION_ATTEMPT_ALLOCATION_KEYS);
  if (!raw) return undefined;
  const attemptId = requireId(ctx, [...path, 'attemptId'], raw.attemptId);
  const batchId = requireId(ctx, [...path, 'batchId'], raw.batchId);
  const operatorSessionId = requireId(ctx, [...path, 'operatorSessionId'], raw.operatorSessionId);
  const graphRevision = requireNumber(ctx, [...path, 'graphRevision'], raw.graphRevision, { min: 1, integer: true });
  const nodeId = requireId(ctx, [...path, 'nodeId'], raw.nodeId);
  const capabilityId = requireId(ctx, [...path, 'capabilityId'], raw.capabilityId);
  const adapterId = requireEnum(ctx, [...path, 'adapterId'], raw.adapterId, NODE_EXECUTION_ADAPTER_IDS);
  const providerSessionId = requireId(ctx, [...path, 'providerSessionId'], raw.providerSessionId);
  const startedAt = requireTimestamp(ctx, [...path, 'startedAt'], raw.startedAt);
  const timeoutAt = requireTimestamp(ctx, [...path, 'timeoutAt'], raw.timeoutAt);
  if (
    attemptId === undefined ||
    batchId === undefined ||
    operatorSessionId === undefined ||
    graphRevision === undefined ||
    nodeId === undefined ||
    capabilityId === undefined ||
    adapterId === undefined ||
    providerSessionId === undefined ||
    startedAt === undefined ||
    timeoutAt === undefined
  ) {
    return undefined;
  }
  return { attemptId, batchId, operatorSessionId, graphRevision, nodeId, capabilityId, adapterId, providerSessionId, startedAt, timeoutAt };
}

const NODE_RESULT_REFS_KEYS = [
  'status', 'summary', 'producedArtifactRefs', 'consumedArtifactRefs', 'evidenceIds', 'findingIds', 'policyRefs',
  'recommendedDisposition', 'providerSessionId', 'modelProvider', 'modelId', 'startedAt', 'completedAt', 'failureFingerprint', 'fallbackJournal', 'usage',
] as const;
const AGENT_RESULT_STATUSES: readonly AgentResultStatus[] = ['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'UNKNOWN'];
const FINDING_EFFECTIVE_DISPOSITIONS: readonly FindingEffectiveDisposition[] = ['BLOCK', 'CORRECT', 'HUMAN_DECISION', 'CONTINUE', 'DEFER', 'RECORD'];

function validateNodeResultRefs(ctx: Ctx, path: Path, value: unknown): NodeResultRefs | undefined {
  const raw = checkObjectShape(ctx, path, value, NODE_RESULT_REFS_KEYS);
  if (!raw) return undefined;
  const status = requireEnum(ctx, [...path, 'status'], raw.status, AGENT_RESULT_STATUSES);
  const summary = requireNonEmptyString(ctx, [...path, 'summary'], raw.summary, 4000);
  const producedArtifactRefs = requireIdArray(ctx, [...path, 'producedArtifactRefs'], raw.producedArtifactRefs);
  const consumedArtifactRefs = requireIdArray(ctx, [...path, 'consumedArtifactRefs'], raw.consumedArtifactRefs);
  const evidenceIds = requireIdArray(ctx, [...path, 'evidenceIds'], raw.evidenceIds);
  const findingIds = requireIdArray(ctx, [...path, 'findingIds'], raw.findingIds);
  const policyRefs = requirePolicyRefArray(ctx, [...path, 'policyRefs'], raw.policyRefs);
  const recommendedDisposition = hasOwn(raw, 'recommendedDisposition')
    ? requireEnum(ctx, [...path, 'recommendedDisposition'], raw.recommendedDisposition, FINDING_EFFECTIVE_DISPOSITIONS)
    : undefined;
  const providerSessionId = requireId(ctx, [...path, 'providerSessionId'], raw.providerSessionId);
  const modelProvider = requireNonEmptyString(ctx, [...path, 'modelProvider'], raw.modelProvider, 256);
  const modelId = requireNonEmptyString(ctx, [...path, 'modelId'], raw.modelId, 256);
  const startedAt = requireTimestamp(ctx, [...path, 'startedAt'], raw.startedAt);
  const completedAt = requireTimestamp(ctx, [...path, 'completedAt'], raw.completedAt);
  let failureFingerprint: FailureFingerprint | undefined;
  if (hasOwn(raw, 'failureFingerprint')) {
    if (validateFailureFingerprint(raw.failureFingerprint)) failureFingerprint = raw.failureFingerprint;
    else pushErr(ctx, [...path, 'failureFingerprint'], 'must be a valid FailureFingerprint');
  }
  let fallbackJournal: ProviderFallbackJournal | undefined;
  if (hasOwn(raw, 'fallbackJournal')) {
    if (validateProviderFallbackJournal(raw.fallbackJournal)) fallbackJournal = raw.fallbackJournal;
    else pushErr(ctx, [...path, 'fallbackJournal'], 'must be a valid ProviderFallbackJournal');
  }
  let usage: NodeExecutionUsage | undefined;
  if (hasOwn(raw, 'usage')) {
    const usageRaw = checkObjectShape(ctx, [...path, 'usage'], raw.usage, ['tokens', 'cost']);
    if (usageRaw) {
      const tokens = requireNumber(ctx, [...path, 'usage', 'tokens'], usageRaw.tokens, { min: 0 });
      const cost = usageRaw.cost === null ? null : requireNumber(ctx, [...path, 'usage', 'cost'], usageRaw.cost, { min: 0 });
      if (tokens !== undefined && cost !== undefined) usage = { tokens, cost };
    }
  }
  if (status === undefined || summary === undefined || producedArtifactRefs === undefined || consumedArtifactRefs === undefined || evidenceIds === undefined || findingIds === undefined || policyRefs === undefined || providerSessionId === undefined || modelProvider === undefined || modelId === undefined || startedAt === undefined || completedAt === undefined) return undefined;
  if (hasOwn(raw, 'recommendedDisposition') && recommendedDisposition === undefined) return undefined;
  if (hasOwn(raw, 'failureFingerprint') && failureFingerprint === undefined) return undefined;
  if (hasOwn(raw, 'fallbackJournal') && fallbackJournal === undefined) return undefined;
  return {
    status, summary, producedArtifactRefs, consumedArtifactRefs, evidenceIds, findingIds, policyRefs,
    ...(recommendedDisposition !== undefined ? { recommendedDisposition } : {}),
    providerSessionId, modelProvider, modelId, startedAt, completedAt,
    ...(failureFingerprint !== undefined ? { failureFingerprint } : {}),
    ...(fallbackJournal !== undefined ? { fallbackJournal } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
}

// ---------------------------------------------------------------------------
// StoredOperatorSession
// ---------------------------------------------------------------------------

const STORED_OPERATOR_SESSION_KEYS = ['schemaVersion', 'startupFeatureSetHash', 'disclosureDecision', 'decisionTrace', 'session', 'gates', 'maxConcurrency', 'activeAttempts', 'nodeResultRefs'] as const;

/** Validates the store envelope: one `OperatorSession` plus its
 * separately-stored `HumanGate` records (plan §9), `maxConcurrency`, and
 * the two Stage 4 runtime-only ledgers `activeAttempts`/`nodeResultRefs`.
 * Rejects unknown properties, duplicate `gateId`s, any gate whose
 * `operatorSessionId` does not match `session.operatorSessionId`, any
 * `activeAttempts` entry whose key disagrees with its own `nodeId` or
 * whose identity disagrees with the enclosing session, and any node named
 * by `activeAttempts` that is not currently `RUNNING`. */
export function validateStoredOperatorSession(input: unknown): ValidationResult<StoredOperatorSession> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, STORED_OPERATOR_SESSION_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  let schemaVersion: '1.0' | undefined;
  if (raw.schemaVersion !== '1.0') {
    pushErr(ctx, ['schemaVersion'], 'must be exactly "1.0"');
  } else {
    schemaVersion = '1.0';
  }

  let session: OperatorSession | undefined;
  const sessionResult = validateOperatorSession(raw.session);
  if (sessionResult.ok) {
    session = sessionResult.value;
  } else {
    for (const e of sessionResult.errors) pushErr(ctx, ['session', e.path], e.message);
  }
  let startupFeatureSetHash: string | undefined;
  if (hasOwn(raw, 'startupFeatureSetHash')) startupFeatureSetHash = requireHash(ctx, ['startupFeatureSetHash'], raw.startupFeatureSetHash);
  let disclosureDecision: RuntimeDisclosureDecision | undefined;
  if (hasOwn(raw, 'disclosureDecision')) {
    const result = validateRuntimeDisclosureDecision(raw.disclosureDecision);
    if (result.ok) disclosureDecision = result.value;
    else for (const error of result.errors) pushErr(ctx, ['disclosureDecision', error.path], error.message);
  }
  let decisionTrace: DecisionTrace | undefined;
  if (hasOwn(raw, 'decisionTrace')) {
    const result = validateDecisionTrace(raw.decisionTrace);
    if (result.ok) decisionTrace = result.value;
    else for (const error of result.errors) pushErr(ctx, ['decisionTrace', error.path], error.message);
  }

  let gates: HumanGate[] | undefined;
  const rawGates = requireArray(ctx, ['gates'], raw.gates);
  if (rawGates) {
    const items: HumanGate[] = [];
    let ok = true;
    rawGates.forEach((v, i) => {
      const result = validateHumanGate(v);
      if (result.ok) {
        items.push(result.value);
      } else {
        ok = false;
        for (const e of result.errors) pushErr(ctx, ['gates', i, e.path], e.message);
      }
    });
    if (ok) gates = items;
  }

  const maxConcurrency = requireNumber(ctx, ['maxConcurrency'], raw.maxConcurrency, { min: 1, integer: true });

  let activeAttempts: Record<string, NodeExecutionAttemptAllocation> | undefined;
  if (!isPlainObject(raw.activeAttempts)) {
    pushErr(ctx, ['activeAttempts'], 'must be an object');
  } else {
    const entries: Record<string, NodeExecutionAttemptAllocation> = {};
    let ok = true;
    for (const [key, value] of Object.entries(raw.activeAttempts)) {
      const allocation = validateNodeExecutionAttemptAllocation(ctx, ['activeAttempts', key], value);
      if (allocation === undefined) {
        ok = false;
        continue;
      }
      if (allocation.nodeId !== key) {
        pushErr(ctx, ['activeAttempts', key, 'nodeId'], `must equal its activeAttempts key ("${key}")`);
        ok = false;
        continue;
      }
      entries[key] = allocation;
    }
    if (ok) activeAttempts = entries;
  }

  let nodeResultRefs: Record<string, NodeResultRefs> | undefined;
  if (!isPlainObject(raw.nodeResultRefs)) {
    pushErr(ctx, ['nodeResultRefs'], 'must be an object');
  } else {
    const entries: Record<string, NodeResultRefs> = {};
    let ok = true;
    for (const [key, value] of Object.entries(raw.nodeResultRefs)) {
      const refs = validateNodeResultRefs(ctx, ['nodeResultRefs', key], value);
      if (refs === undefined) {
        ok = false;
        continue;
      }
      entries[key] = refs;
    }
    if (ok) nodeResultRefs = entries;
  }

  // Cross-field: gate ids stored alongside one session must be unique.
  if (gates !== undefined) {
    const gateList: readonly HumanGate[] = gates;
    const seen = new Set<string>();
    gateList.forEach((gate, i) => {
      if (seen.has(gate.gateId)) {
        pushErr(ctx, ['gates', i, 'gateId'], `must be unique across gates (duplicate: ${gate.gateId})`);
      }
      seen.add(gate.gateId);
    });
  }

  // Cross-field: every stored gate must belong to the enclosing session.
  if (gates !== undefined && session !== undefined) {
    const gateList: readonly HumanGate[] = gates;
    const sessionValue: OperatorSession = session;
    gateList.forEach((gate, i) => {
      if (gate.operatorSessionId !== sessionValue.operatorSessionId) {
        pushErr(ctx, ['gates', i, 'operatorSessionId'], `must equal session.operatorSessionId (${sessionValue.operatorSessionId})`);
      }
    });
  }

  // Cross-field: every activeAttempts entry must belong to the enclosing
  // session/graph revision, and its node must currently be RUNNING.
  if (activeAttempts !== undefined && session !== undefined) {
    const sessionValue: OperatorSession = session;
    for (const [nodeId, allocation] of Object.entries(activeAttempts)) {
      if (allocation.operatorSessionId !== sessionValue.operatorSessionId) {
        pushErr(ctx, ['activeAttempts', nodeId, 'operatorSessionId'], 'must equal session.operatorSessionId');
      }
      if (sessionValue.executionGraph !== null && allocation.graphRevision !== sessionValue.executionGraph.graphRevision) {
        pushErr(ctx, ['activeAttempts', nodeId, 'graphRevision'], 'must equal session.executionGraph.graphRevision');
      }
      const nodeState: NodeState | undefined = sessionValue.nodeStates[nodeId];
      if (nodeState !== 'RUNNING') {
        pushErr(ctx, ['activeAttempts', nodeId], `session.nodeStates["${nodeId}"] must be RUNNING while an attempt is active (found ${nodeState ?? 'undefined'})`);
      }
    }
  }

  if (schemaVersion === undefined || session === undefined || gates === undefined || maxConcurrency === undefined || activeAttempts === undefined || nodeResultRefs === undefined) {
    return finalize(ctx, out);
  }

  out.schemaVersion = schemaVersion;
  if (startupFeatureSetHash !== undefined) out.startupFeatureSetHash = startupFeatureSetHash;
  if (disclosureDecision !== undefined) out.disclosureDecision = disclosureDecision;
  if (decisionTrace !== undefined) out.decisionTrace = decisionTrace;
  out.session = session;
  out.gates = gates;
  out.maxConcurrency = maxConcurrency;
  out.activeAttempts = activeAttempts;
  out.nodeResultRefs = nodeResultRefs;

  return finalize<StoredOperatorSession>(ctx, out);
}

// ---------------------------------------------------------------------------
const SIMULATION_RESULT_KEYS = ['schemaVersion', 'request', 'generatedAt', 'classification', 'disclosureDecision', 'routeDecision', 'executionGraph', 'executionEstimate', 'capabilities', 'decisionTrace', 'preflight'] as const;
const CAPABILITY_SUMMARY_KEYS = ['nodeId', 'role', 'capabilityId', 'provider', 'tools', 'mutationClass'] as const;
const CLASSIFICATION_PROPOSAL_KEYS = ['requestClassification', 'riskClassification', 'confidence', 'abstentionReason', 'decomposable', 'semanticCapabilities', 'requestedExecutionShape', 'requestedBudgetProfile', 'rationale'] as const;

function validateSimulationResult(input: unknown): ValidationResult<SimulationResultEnvelope> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, SIMULATION_RESULT_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);
  if (raw.schemaVersion !== '1.0') pushErr(ctx, ['schemaVersion'], 'must be exactly "1.0"');
  const request = requireNonEmptyString(ctx, ['request'], raw.request, MAX_OUTCOME_TEXT);
  const generatedAt = requireTimestamp(ctx, ['generatedAt'], raw.generatedAt);
  const preflight = requireEnum(ctx, ['preflight'], raw.preflight, ['PASSED', 'NOT_CONFIGURED'] as const);
  const classification = checkObjectShape(ctx, ['classification'], raw.classification, CLASSIFICATION_PROPOSAL_KEYS);
  if (classification !== undefined) {
    requireEnum(ctx, ['classification', 'requestClassification'], classification.requestClassification, ['DIRECT', 'RESEARCH', 'PLAN', 'IMPLEMENT', 'REVIEW', 'UI', 'QA', 'SECURITY', 'OPERATIONS'] as const);
    requireEnum(ctx, ['classification', 'riskClassification'], classification.riskClassification, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const);
    requireEnum(ctx, ['classification', 'confidence'], classification.confidence, ['HIGH', 'MEDIUM', 'LOW'] as const);
    requireBoolean(ctx, ['classification', 'decomposable'], classification.decomposable);
    const semanticCapabilities = requireArray(ctx, ['classification', 'semanticCapabilities'], classification.semanticCapabilities);
    if (semanticCapabilities !== undefined) semanticCapabilities.forEach((value, index) => requireNonEmptyString(ctx, ['classification', 'semanticCapabilities', index], value, 256));
    requireNonEmptyString(ctx, ['classification', 'rationale'], classification.rationale, 4000);
    if (hasOwn(classification, 'abstentionReason')) requireNonEmptyString(ctx, ['classification', 'abstentionReason'], classification.abstentionReason, 4000);
    if (hasOwn(classification, 'requestedExecutionShape')) requireEnum(ctx, ['classification', 'requestedExecutionShape'], classification.requestedExecutionShape, ['DIRECT', 'SINGLE', 'PARALLEL', 'PIPELINE', 'COUNCIL'] as const);
    if (hasOwn(classification, 'requestedBudgetProfile')) requireEnum(ctx, ['classification', 'requestedBudgetProfile'], classification.requestedBudgetProfile, ['CHEAP', 'BALANCED', 'QUALITY', 'CRITICAL'] as const);
  }
  const disclosure = validateRuntimeDisclosureDecision(raw.disclosureDecision);
  if (!disclosure.ok) for (const error of disclosure.errors) pushErr(ctx, ['disclosureDecision', error.path], error.message);
  const trace = validateDecisionTrace(raw.decisionTrace);
  if (!trace.ok) for (const error of trace.errors) pushErr(ctx, ['decisionTrace', error.path], error.message);
  const route = validateRouteDecision(raw.routeDecision);
  if (!route.ok) for (const error of route.errors) pushErr(ctx, ['routeDecision', error.path], error.message);
  const graph = validateExecutionGraph(raw.executionGraph);
  if (!graph.ok) for (const error of graph.errors) pushErr(ctx, ['executionGraph', error.path], error.message);
  const executionEstimateValid = validateExecutionEstimate(raw.executionEstimate);
  if (!executionEstimateValid) pushErr(ctx, ['executionEstimate'], 'must be a valid ExecutionEstimate');
  const capabilities = requireArray(ctx, ['capabilities'], raw.capabilities);
  if (capabilities !== undefined) {
    capabilities.forEach((value, index) => {
      const item = checkObjectShape(ctx, ['capabilities', index], value, CAPABILITY_SUMMARY_KEYS);
      if (!item) return;
      requireId(ctx, ['capabilities', index, 'nodeId'], item.nodeId);
      requireNonEmptyString(ctx, ['capabilities', index, 'role'], item.role, 256);
      requireId(ctx, ['capabilities', index, 'capabilityId'], item.capabilityId);
      requireNonEmptyString(ctx, ['capabilities', index, 'provider'], item.provider, 256);
      const tools = requireArray(ctx, ['capabilities', index, 'tools'], item.tools);
      if (tools !== undefined) tools.forEach((tool, toolIndex) => requireNonEmptyString(ctx, ['capabilities', index, 'tools', toolIndex], tool, 256));
      requireEnum(ctx, ['capabilities', index, 'mutationClass'], item.mutationClass, ['READ_ONLY', 'LOCAL', 'EXTERNAL', 'DESTRUCTIVE'] as const);
    });
  }
  if (ctx.errors.length > 0 || request === undefined || generatedAt === undefined || preflight === undefined || classification === undefined || !disclosure.ok || !trace.ok || !route.ok || !graph.ok || !executionEstimateValid || capabilities === undefined) return finalize(ctx, out);
  return { ok: true, value: raw as unknown as SimulationResultEnvelope };
}

// ---------------------------------------------------------------------------
// OperatorCommandOutcome
// ---------------------------------------------------------------------------

const OPERATOR_COMMAND_OUTCOME_KEYS = ['ok', 'text', 'errorCode', 'operatorSessionId', 'session', 'gate', 'simulation', 'shadowObservation', 'policyDiff'] as const;

const OPERATOR_COMMAND_ERROR_CODES: readonly OperatorCommandErrorCode[] = [
  'INVALID_COMMAND',
  'NO_ACTIVE_SESSION',
  'SESSION_NOT_FOUND',
  'SESSION_ALREADY_ACTIVE',
  'INVALID_TRANSITION',
  'GATE_NOT_FOUND',
  'GATE_NOT_OPEN',
  'GATE_MISMATCH',
  'CONTRACT_INVALID',
  'STORE_CONFLICT',
  'NODE_EXECUTION_FAILED',
  'COMPILATION_FAILED',
  'ADAPTER_UNAVAILABLE',
  'EXECUTION_ACTIVE',
  'EXECUTION_TIMEOUT',
  'INVALID_OUTPUT',
  'BLOCKED_REQUIRED_CONTEXT',
  'BLOCKED_PROVIDER_UNAVAILABLE',
  'BLOCKED_CAPABILITY',
  'BLOCKED_SECURITY',
  'FEATURE_SET_MISMATCH',
  'STAGE7_ROUTE_UNAVAILABLE',
  'STAGE7_CAPABILITY_UNAVAILABLE',
  'FEATURE_DISABLED',
  'EVALUATOR_ERROR',
];

/** Validates the result of one `/operator` command invocation. `errorCode`
 * is required exactly when `ok` is `false` and forbidden when `ok` is
 * `true`; every identity field present (`operatorSessionId`,
 * `session.operatorSessionId`, `gate.operatorSessionId`) must agree. */
export function validateOperatorCommandOutcome(input: unknown): ValidationResult<OperatorCommandOutcome> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, OPERATOR_COMMAND_OUTCOME_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const ok = requireBoolean(ctx, ['ok'], raw.ok);
  const text = requireNonEmptyString(ctx, ['text'], raw.text, MAX_OUTCOME_TEXT);

  let errorCode: OperatorCommandErrorCode | undefined;
  if (hasOwn(raw, 'errorCode')) errorCode = requireEnum(ctx, ['errorCode'], raw.errorCode, OPERATOR_COMMAND_ERROR_CODES);

  let operatorSessionId: string | undefined;
  if (hasOwn(raw, 'operatorSessionId')) operatorSessionId = requireId(ctx, ['operatorSessionId'], raw.operatorSessionId);

  let session: OperatorSession | undefined;
  if (hasOwn(raw, 'session')) {
    const result = validateOperatorSession(raw.session);
    if (result.ok) {
      session = result.value;
    } else {
      for (const e of result.errors) pushErr(ctx, ['session', e.path], e.message);
    }
  }

  let gate: HumanGate | undefined;
  if (hasOwn(raw, 'gate')) {
    const result = validateHumanGate(raw.gate);
    if (result.ok) {
      gate = result.value;
    } else {
      for (const e of result.errors) pushErr(ctx, ['gate', e.path], e.message);
    }
  }
  let simulation: SimulationResultEnvelope | undefined;
  if (hasOwn(raw, 'simulation')) {
    const result = validateSimulationResult(raw.simulation);
    if (result.ok) simulation = result.value;
    else for (const error of result.errors) pushErr(ctx, ['simulation', error.path], error.message);
  }
  let shadowObservation: ShadowObservation | undefined;
  if (hasOwn(raw, 'shadowObservation')) {
    if (validateShadowObservation(raw.shadowObservation)) shadowObservation = raw.shadowObservation;
    else pushErr(ctx, ['shadowObservation'], 'must be a valid ShadowObservation');
  }
  let policyDiff: PolicyDiffReport | undefined;
  if (hasOwn(raw, 'policyDiff')) {
    if (validatePolicyDiffReport(raw.policyDiff)) policyDiff = raw.policyDiff;
    else pushErr(ctx, ['policyDiff'], 'must be a valid PolicyDiffReport');
  }

  // Cross-field: ok and errorCode must never contradict each other.
  if (ok === true && hasOwn(raw, 'errorCode')) {
    pushErr(ctx, ['errorCode'], 'must be absent when ok is true');
  }
  if (ok === false && !hasOwn(raw, 'errorCode')) {
    pushErr(ctx, ['errorCode'], 'is required when ok is false');
  }

  // Cross-field: every identity field present must agree with the others.
  if (operatorSessionId !== undefined && session !== undefined && operatorSessionId !== session.operatorSessionId) {
    pushErr(ctx, ['operatorSessionId'], 'must equal session.operatorSessionId');
  }
  if (gate !== undefined && session !== undefined && gate.operatorSessionId !== session.operatorSessionId) {
    pushErr(ctx, ['gate', 'operatorSessionId'], 'must equal session.operatorSessionId');
  }
  if (gate !== undefined && operatorSessionId !== undefined && gate.operatorSessionId !== operatorSessionId) {
    pushErr(ctx, ['gate', 'operatorSessionId'], 'must equal operatorSessionId');
  }
  if (simulation !== undefined && (operatorSessionId !== undefined || session !== undefined || gate !== undefined)) {
    pushErr(ctx, ['simulation'], 'must not be combined with session or gate state');
  }
  if (shadowObservation !== undefined && (operatorSessionId !== undefined || session !== undefined || gate !== undefined || simulation !== undefined)) {
    pushErr(ctx, ['shadowObservation'], 'must not be combined with session, gate, or simulation state');
  }
  if (policyDiff !== undefined && (operatorSessionId !== undefined || session !== undefined || gate !== undefined || simulation !== undefined || shadowObservation !== undefined)) {
    pushErr(ctx, ['policyDiff'], 'must not be combined with session, gate, simulation, or shadow state');
  }

  if (ok === undefined || text === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'errorCode') && errorCode === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'operatorSessionId') && operatorSessionId === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'session') && session === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'gate') && gate === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'simulation') && simulation === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'shadowObservation') && shadowObservation === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'policyDiff') && policyDiff === undefined) return finalize(ctx, out);

  out.ok = ok;
  out.text = text;
  if (errorCode !== undefined) out.errorCode = errorCode;
  if (operatorSessionId !== undefined) out.operatorSessionId = operatorSessionId;
  if (session !== undefined) out.session = session;
  if (gate !== undefined) out.gate = gate;
  if (simulation !== undefined) out.simulation = simulation;
  if (shadowObservation !== undefined) out.shadowObservation = shadowObservation;
  if (policyDiff !== undefined) out.policyDiff = policyDiff;

  return finalize<OperatorCommandOutcome>(ctx, out);
}

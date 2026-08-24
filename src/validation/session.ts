/**
 * Agent Operator — Stage 1 deterministic contract validators: session and
 * gate state.
 *
 * Validates the human-approval gate and the operator session record itself
 * (HumanGate, OperatorSession — plan sections 6-7, 9, 14, 18). OperatorSession
 * is the top of the validation dependency graph: it embeds and cross-checks
 * a RouteDecision and ExecutionGraph (src/validation/core-contracts.ts) plus
 * arrays of ArtifactManifest, Evidence, and a terminal FinalOperatorResult
 * (src/validation/results.ts). Nothing in results.ts or core-contracts.ts
 * depends back on this module, so importing them here introduces no cycle.
 */

import type {
  ArtifactManifest,
  BudgetState,
  Evidence,
  ExecutionGraph,
  FinalOperatorResult,
  HumanDecisionRecord,
  GateRiskSummary,
  HumanGate,
  JournalEntry,
  NodeState,
  OperatorSession,
  RouteDecision,
  StopDetail,
} from '../contracts.js';

import {
  ARTIFACT_TYPE_PATTERN,
  JOURNAL_EVENT_PATTERN,
  MAX_LONG_TEXT,
  MAX_MEDIUM_TEXT,
  MAX_SHORT_TEXT,
  REASON_CODE_PATTERN,
  SEMANTIC_VERSION_PATTERN,
  checkObjectShape,
  finalize,
  hasOwn,
  isPlainObject,
  newCtx,
  pushErr,
  requireArray,
  requireBoolean,
  requireEnum,
  requireExactString,
  requireHash,
  requireHumanText,
  requireId,
  requireNumber,
  requirePolicyRefsArray,
  requireStringArray,
  requireTimestamp,
  type Ctx,
  type Path,
  type ValidationResult,
} from './primitives.js';

import {
  BUDGET_PROFILES,
  GATE_DECISION_TYPES,
  GATE_STATUSES,
  HUMAN_DECISION_OUTCOMES,
  NODE_STATES,
  SESSION_STATES,
  STOP_REASON_CODES,
  TERMINAL_SESSION_STATES,
} from './enums.js';

import { validateExecutionGraph, validateRouteDecision } from './core-contracts.js';

import {
  validateArtifactManifest,
  validateEvidence,
  validateFinalOperatorResult,
  validateVerificationState,
} from './results.js';


// ---------------------------------------------------------------------------
// 7. HumanGate
// ---------------------------------------------------------------------------

const HUMAN_GATE_KEYS = [
  'gateId',
  'operatorSessionId',
  'reason',
  'decisionType',
  'requestedDecision',
  'availableOptions',
  'recommendedOption',
  'evidenceRefs',
  'consequences',
  'resumeNode',
  'graphRevision',
  'graphHash',
  'artifactRefs',
  'artifactHashes',
  'policyRefs',
  'createdAt',
  'expiresAt',
  'status',
  'riskSummary',
] as const;

const GATE_RISK_SUMMARY_KEYS = ['riskLevel', 'disclosureClass', 'mutationClasses', 'providers', 'tools', 'scopedNodes', 'actionsNotPerformed', 'recoveryRequired', 'expectedProviderCalls', 'maximumDepth', 'estimatedCost', 'costConfidence', 'previewReasons'] as const;

function validateGateRiskSummary(ctx: Ctx, path: Path, value: unknown): GateRiskSummary | undefined {
  const raw = checkObjectShape(ctx, path, value, GATE_RISK_SUMMARY_KEYS);
  if (!raw) return undefined;
  const riskLevel = requireEnum(ctx, [...path, 'riskLevel'], raw.riskLevel, ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const);
  const disclosureClass = requireEnum(ctx, [...path, 'disclosureClass'], raw.disclosureClass, ['LOCAL_ONLY', 'INTERNAL_REDACTABLE', 'EXTERNAL_ALLOWED'] as const);
  const mutationClasses = requireStringArray(ctx, [...path, 'mutationClasses'], raw.mutationClasses, { minItems: 1, unique: true, itemValidator: (c, p, v) => requireEnum(c, p, v, ['READ_ONLY', 'LOCAL', 'EXTERNAL', 'DESTRUCTIVE'] as const) });
  const providers = requireStringArray(ctx, [...path, 'providers'], raw.providers, { unique: true, itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT }) });
  const tools = requireStringArray(ctx, [...path, 'tools'], raw.tools, { unique: true, itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT }) });
  const scopedNodes = requireStringArray(ctx, [...path, 'scopedNodes'], raw.scopedNodes, { minItems: 1, unique: true, itemValidator: requireId });
  const actionsNotPerformed = requireStringArray(ctx, [...path, 'actionsNotPerformed'], raw.actionsNotPerformed, { minItems: 1, unique: true, itemValidator: (c, p, v) => requireHumanText(c, p, v, { maxLen: MAX_MEDIUM_TEXT }) });
  const recoveryRequired = requireBoolean(ctx, [...path, 'recoveryRequired'], raw.recoveryRequired);
  const expectedProviderCalls = requireNumber(ctx, [...path, 'expectedProviderCalls'], raw.expectedProviderCalls, { min: 0, integer: true });
  const maximumDepth = requireNumber(ctx, [...path, 'maximumDepth'], raw.maximumDepth, { min: 0, integer: true });
  const estimatedCost = raw.estimatedCost === null ? null : requireNumber(ctx, [...path, 'estimatedCost'], raw.estimatedCost, { min: 0 });
  const costConfidence = requireEnum(ctx, [...path, 'costConfidence'], raw.costConfidence, ['UNAVAILABLE', 'LOW', 'MEDIUM', 'HIGH'] as const);
  const previewReasons = requireStringArray(ctx, [...path, 'previewReasons'], raw.previewReasons, { unique: true, itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }) });
  if (riskLevel === undefined || disclosureClass === undefined || mutationClasses === undefined || providers === undefined || tools === undefined || scopedNodes === undefined || actionsNotPerformed === undefined || recoveryRequired === undefined || expectedProviderCalls === undefined || maximumDepth === undefined || estimatedCost === undefined || costConfidence === undefined || previewReasons === undefined) return undefined;
  return { riskLevel, disclosureClass, mutationClasses: mutationClasses as GateRiskSummary['mutationClasses'], providers, tools, scopedNodes, actionsNotPerformed, recoveryRequired, expectedProviderCalls, maximumDepth, estimatedCost, costConfidence, previewReasons };
}

export function validateHumanGate(input: unknown): ValidationResult<HumanGate> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, HUMAN_GATE_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const gateId = requireId(ctx, ['gateId'], raw.gateId);
  const operatorSessionId = requireId(ctx, ['operatorSessionId'], raw.operatorSessionId);
  const reason = requireHumanText(ctx, ['reason'], raw.reason, { maxLen: MAX_MEDIUM_TEXT });
  const decisionType = requireEnum(ctx, ['decisionType'], raw.decisionType, GATE_DECISION_TYPES);
  const requestedDecision = requireHumanText(ctx, ['requestedDecision'], raw.requestedDecision, { maxLen: MAX_MEDIUM_TEXT });
  const availableOptions = requireStringArray(ctx, ['availableOptions'], raw.availableOptions, {
    minItems: 2,
    unique: true,
    itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }),
  });
  const recommendedOption = requireExactString(ctx, ['recommendedOption'], raw.recommendedOption, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN });
  const evidenceRefs = requireStringArray(ctx, ['evidenceRefs'], raw.evidenceRefs, { unique: true, itemValidator: requireId });

  let consequences: Record<string, string> | undefined;
  if (!isPlainObject(raw.consequences)) {
    pushErr(ctx, ['consequences'], 'must be an object');
  } else {
    const rawConsequences = raw.consequences;
    const entries: Record<string, string> = {};
    let ok = true;
    for (const key of Object.keys(rawConsequences)) {
      const v = requireHumanText(ctx, ['consequences', key], rawConsequences[key], { maxLen: MAX_MEDIUM_TEXT });
      if (v === undefined) {
        ok = false;
      } else {
        entries[key] = v;
      }
    }
    if (ok) consequences = entries;
  }

  const resumeNode = requireId(ctx, ['resumeNode'], raw.resumeNode);
  const graphRevision = requireNumber(ctx, ['graphRevision'], raw.graphRevision, { min: 1, integer: true });
  const graphHash = requireHash(ctx, ['graphHash'], raw.graphHash);
  const artifactRefs = requireStringArray(ctx, ['artifactRefs'], raw.artifactRefs, { unique: true, itemValidator: requireId });
  const artifactHashes = requireStringArray(ctx, ['artifactHashes'], raw.artifactHashes, { itemValidator: requireHash });
  const policyRefs = requirePolicyRefsArray(ctx, ['policyRefs'], raw.policyRefs);
  const createdAt = requireTimestamp(ctx, ['createdAt'], raw.createdAt);
  let expiresAt: string | undefined;
  if (hasOwn(raw, 'expiresAt')) expiresAt = requireTimestamp(ctx, ['expiresAt'], raw.expiresAt);
  const status = requireEnum(ctx, ['status'], raw.status, GATE_STATUSES);
  const riskSummary = hasOwn(raw, 'riskSummary') ? validateGateRiskSummary(ctx, ['riskSummary'], raw.riskSummary) : undefined;

  // Cross-field: the gate binds session/gate/graph/hash together and states
  // exactly what the human is deciding (plan section 9).
  if (recommendedOption !== undefined && availableOptions !== undefined && !availableOptions.includes(recommendedOption)) {
    pushErr(ctx, ['recommendedOption'], 'must be a member of availableOptions');
  }
  if (consequences !== undefined && availableOptions !== undefined) {
    const consequenceKeys = new Set(Object.keys(consequences));
    const optionSet = new Set(availableOptions);
    for (const option of availableOptions) {
      if (!consequenceKeys.has(option)) {
        pushErr(ctx, ['consequences'], `missing consequence entry for option: ${option}`);
      }
    }
    for (const key of consequenceKeys) {
      if (!optionSet.has(key)) {
        pushErr(ctx, ['consequences', key], 'does not correspond to a declared availableOptions entry');
      }
    }
  }
  if (artifactRefs !== undefined && artifactHashes !== undefined && artifactRefs.length !== artifactHashes.length) {
    pushErr(ctx, ['artifactHashes'], 'must be index-aligned with artifactRefs (same length)');
  }
  if (createdAt !== undefined && expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(createdAt)) {
    pushErr(ctx, ['expiresAt'], 'must be later than createdAt');
  }

  if (
    gateId === undefined ||
    operatorSessionId === undefined ||
    reason === undefined ||
    decisionType === undefined ||
    requestedDecision === undefined ||
    availableOptions === undefined ||
    recommendedOption === undefined ||
    evidenceRefs === undefined ||
    consequences === undefined ||
    resumeNode === undefined ||
    graphRevision === undefined ||
    graphHash === undefined ||
    artifactRefs === undefined ||
    artifactHashes === undefined ||
    policyRefs === undefined ||
    createdAt === undefined ||
    status === undefined
  ) {
    return finalize(ctx, out);
  }
  if (hasOwn(raw, 'expiresAt') && expiresAt === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'riskSummary') && riskSummary === undefined) return finalize(ctx, out);

  out.gateId = gateId;
  out.operatorSessionId = operatorSessionId;
  out.reason = reason;
  out.decisionType = decisionType;
  out.requestedDecision = requestedDecision;
  out.availableOptions = availableOptions;
  out.recommendedOption = recommendedOption;
  out.evidenceRefs = evidenceRefs;
  out.consequences = consequences;
  out.resumeNode = resumeNode;
  out.graphRevision = graphRevision;
  out.graphHash = graphHash;
  out.artifactRefs = artifactRefs;
  out.artifactHashes = artifactHashes;
  out.policyRefs = policyRefs;
  if (riskSummary !== undefined) out.riskSummary = riskSummary;
  out.createdAt = createdAt;
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  out.status = status;

  return finalize<HumanGate>(ctx, out);
}


// ---------------------------------------------------------------------------
// 6. OperatorSession
// ---------------------------------------------------------------------------

const BUDGET_STATE_KEYS = ['profile', 'tokensUsed', 'costUsed', 'tokensLimit', 'costLimit'] as const;

function validateBudgetState(ctx: Ctx, path: Path, value: unknown): BudgetState | undefined {
  const raw = checkObjectShape(ctx, path, value, BUDGET_STATE_KEYS);
  if (!raw) return undefined;
  const profile = requireEnum(ctx, [...path, 'profile'], raw.profile, BUDGET_PROFILES);
  const tokensUsed = requireNumber(ctx, [...path, 'tokensUsed'], raw.tokensUsed, { min: 0 });
  const costUsed = requireNumber(ctx, [...path, 'costUsed'], raw.costUsed, { min: 0 });
  let tokensLimit: number | undefined;
  if (hasOwn(raw, 'tokensLimit')) tokensLimit = requireNumber(ctx, [...path, 'tokensLimit'], raw.tokensLimit, { min: 0 });
  let costLimit: number | undefined;
  if (hasOwn(raw, 'costLimit')) costLimit = requireNumber(ctx, [...path, 'costLimit'], raw.costLimit, { min: 0 });
  if (profile === undefined || tokensUsed === undefined || costUsed === undefined) return undefined;
  if (hasOwn(raw, 'tokensLimit') && tokensLimit === undefined) return undefined;
  return {
    profile,
    tokensUsed,
    costUsed,
    ...(tokensLimit !== undefined ? { tokensLimit } : {}),
    ...(costLimit !== undefined ? { costLimit } : {}),
  };
}

const JOURNAL_ENTRY_KEYS = ['timestamp', 'eventType', 'operatorSessionId', 'nodeId', 'gateId', 'reasonCode', 'artifactRefs', 'evidenceRefs', 'message'] as const;

function validateJournalEntry(ctx: Ctx, path: Path, value: unknown): JournalEntry | undefined {
  const raw = checkObjectShape(ctx, path, value, JOURNAL_ENTRY_KEYS);
  if (!raw) return undefined;
  const timestamp = requireTimestamp(ctx, [...path, 'timestamp'], raw.timestamp);
  const eventType = requireExactString(ctx, [...path, 'eventType'], raw.eventType, { maxLen: MAX_SHORT_TEXT, pattern: JOURNAL_EVENT_PATTERN });
  const operatorSessionId = requireId(ctx, [...path, 'operatorSessionId'], raw.operatorSessionId);
  let nodeId: string | undefined;
  if (hasOwn(raw, 'nodeId')) nodeId = requireId(ctx, [...path, 'nodeId'], raw.nodeId);
  let gateId: string | undefined;
  if (hasOwn(raw, 'gateId')) gateId = requireId(ctx, [...path, 'gateId'], raw.gateId);
  let reasonCode: string | undefined;
  if (hasOwn(raw, 'reasonCode')) reasonCode = requireExactString(ctx, [...path, 'reasonCode'], raw.reasonCode, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN });
  let artifactRefs: string[] | undefined;
  if (hasOwn(raw, 'artifactRefs')) artifactRefs = requireStringArray(ctx, [...path, 'artifactRefs'], raw.artifactRefs, { itemValidator: requireId });
  let evidenceRefs: string[] | undefined;
  if (hasOwn(raw, 'evidenceRefs')) evidenceRefs = requireStringArray(ctx, [...path, 'evidenceRefs'], raw.evidenceRefs, { itemValidator: requireId });
  const message = requireHumanText(ctx, [...path, 'message'], raw.message, { maxLen: MAX_MEDIUM_TEXT });

  if (timestamp === undefined || eventType === undefined || operatorSessionId === undefined || message === undefined) return undefined;
  if (hasOwn(raw, 'nodeId') && nodeId === undefined) return undefined;
  if (hasOwn(raw, 'gateId') && gateId === undefined) return undefined;
  if (hasOwn(raw, 'reasonCode') && reasonCode === undefined) return undefined;
  if (hasOwn(raw, 'artifactRefs') && artifactRefs === undefined) return undefined;
  if (hasOwn(raw, 'evidenceRefs') && evidenceRefs === undefined) return undefined;
  return {
    timestamp,
    eventType,
    operatorSessionId,
    ...(nodeId !== undefined ? { nodeId } : {}),
    ...(gateId !== undefined ? { gateId } : {}),
    ...(reasonCode !== undefined ? { reasonCode } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
    message,
  };
}
const HUMAN_DECISION_RECORD_KEYS = ['gateId', 'decisionType', 'optionSelected', 'outcome', 'decidedAt', 'graphHashAtDecision', 'artifactHashesAtDecision'] as const;

function validateHumanDecisionRecord(ctx: Ctx, path: Path, value: unknown): HumanDecisionRecord | undefined {
  const raw = checkObjectShape(ctx, path, value, HUMAN_DECISION_RECORD_KEYS);
  if (!raw) return undefined;
  const gateId = requireId(ctx, [...path, 'gateId'], raw.gateId);
  const decisionType = requireEnum(ctx, [...path, 'decisionType'], raw.decisionType, GATE_DECISION_TYPES);
  const optionSelected = requireExactString(ctx, [...path, 'optionSelected'], raw.optionSelected, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN });
  const outcome = requireEnum(ctx, [...path, 'outcome'], raw.outcome, HUMAN_DECISION_OUTCOMES);
  const decidedAt = requireTimestamp(ctx, [...path, 'decidedAt'], raw.decidedAt);
  const graphHashAtDecision = requireHash(ctx, [...path, 'graphHashAtDecision'], raw.graphHashAtDecision);
  const artifactHashesAtDecision = requireStringArray(ctx, [...path, 'artifactHashesAtDecision'], raw.artifactHashesAtDecision, { itemValidator: requireHash });
  if (
    gateId === undefined ||
    decisionType === undefined ||
    optionSelected === undefined ||
    outcome === undefined ||
    decidedAt === undefined ||
    graphHashAtDecision === undefined ||
    artifactHashesAtDecision === undefined
  ) {
    return undefined;
  }
  return { gateId, decisionType, optionSelected, outcome, decidedAt, graphHashAtDecision, artifactHashesAtDecision };
}

const STOP_DETAIL_KEYS = ['reason', 'affectedNodeId', 'evidenceRefs', 'retryEligible', 'requiredDecisionOrPrerequisite', 'nextAllowedActions'] as const;

function validateStopDetail(ctx: Ctx, path: Path, value: unknown): StopDetail | undefined {
  const raw = checkObjectShape(ctx, path, value, STOP_DETAIL_KEYS);
  if (!raw) return undefined;
  const reason = requireEnum(ctx, [...path, 'reason'], raw.reason, STOP_REASON_CODES);
  const affectedNodeId = requireId(ctx, [...path, 'affectedNodeId'], raw.affectedNodeId);
  const evidenceRefs = requireStringArray(ctx, [...path, 'evidenceRefs'], raw.evidenceRefs, { itemValidator: requireId });
  const retryEligible = requireBoolean(ctx, [...path, 'retryEligible'], raw.retryEligible);
  const requiredDecisionOrPrerequisite = requireHumanText(ctx, [...path, 'requiredDecisionOrPrerequisite'], raw.requiredDecisionOrPrerequisite, { maxLen: MAX_MEDIUM_TEXT });
  const nextAllowedActions = requireStringArray(ctx, [...path, 'nextAllowedActions'], raw.nextAllowedActions, {
    minItems: 1,
    itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }),
  });
  if (
    reason === undefined ||
    affectedNodeId === undefined ||
    evidenceRefs === undefined ||
    retryEligible === undefined ||
    requiredDecisionOrPrerequisite === undefined ||
    nextAllowedActions === undefined
  ) {
    return undefined;
  }
  return { reason, affectedNodeId, evidenceRefs, retryEligible, requiredDecisionOrPrerequisite, nextAllowedActions };
}

const OPERATOR_SESSION_KEYS = [
  'operatorSessionId',
  'schemaVersion',
  'originalRequest',
  'createdAt',
  'updatedAt',
  'currentState',
  'currentPhase',
  'openGateId',
  'routeDecision',
  'workflowTemplateId',
  'executionGraph',
  'nodeStates',
  'providerSessionIds',
  'humanDecisions',
  'artifacts',
  'evidence',
  'verificationState',
  'budgetState',
  'journal',
  'terminalResult',
  'stopDetail',
] as const;

export function validateOperatorSession(input: unknown): ValidationResult<OperatorSession> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, OPERATOR_SESSION_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const operatorSessionId = requireId(ctx, ['operatorSessionId'], raw.operatorSessionId);
  const schemaVersion = requireExactString(ctx, ['schemaVersion'], raw.schemaVersion, { maxLen: 16, pattern: SEMANTIC_VERSION_PATTERN });
  const originalRequest = requireHumanText(ctx, ['originalRequest'], raw.originalRequest, { maxLen: MAX_LONG_TEXT });
  const createdAt = requireTimestamp(ctx, ['createdAt'], raw.createdAt);
  const updatedAt = requireTimestamp(ctx, ['updatedAt'], raw.updatedAt);
  const currentState = requireEnum(ctx, ['currentState'], raw.currentState, SESSION_STATES);
  const currentPhase = requireHumanText(ctx, ['currentPhase'], raw.currentPhase, { maxLen: MAX_SHORT_TEXT });

  let openGateId: string | undefined;
  if (hasOwn(raw, 'openGateId')) openGateId = requireId(ctx, ['openGateId'], raw.openGateId);

  // Cross-field: an open gate exists exactly while the session is waiting
  // on a human decision (plan section 9).
  if (currentState === 'AWAITING_HUMAN') {
    if (!hasOwn(raw, 'openGateId')) {
      pushErr(ctx, ['openGateId'], 'is required when currentState is AWAITING_HUMAN');
    }
  } else if (hasOwn(raw, 'openGateId')) {
    pushErr(ctx, ['openGateId'], 'must be absent unless currentState is AWAITING_HUMAN');
  }

  let routeDecision: RouteDecision | null | undefined;
  if (raw.routeDecision === null) {
    routeDecision = null;
  } else {
    const result = validateRouteDecision(raw.routeDecision);
    if (result.ok) {
      routeDecision = result.value;
    } else {
      for (const e of result.errors) pushErr(ctx, ['routeDecision', e.path], e.message);
    }
  }

  let workflowTemplateId: string | null | undefined;
  if (raw.workflowTemplateId === null) {
    workflowTemplateId = null;
  } else {
    workflowTemplateId = requireExactString(ctx, ['workflowTemplateId'], raw.workflowTemplateId, { maxLen: MAX_SHORT_TEXT, pattern: ARTIFACT_TYPE_PATTERN });
  }

  let executionGraph: ExecutionGraph | null | undefined;
  if (raw.executionGraph === null) {
    executionGraph = null;
  } else {
    const result = validateExecutionGraph(raw.executionGraph);
    if (result.ok) {
      executionGraph = result.value;
    } else {
      for (const e of result.errors) pushErr(ctx, ['executionGraph', e.path], e.message);
    }
  }

  let nodeStates: Record<string, NodeState> | undefined;
  if (!isPlainObject(raw.nodeStates)) {
    pushErr(ctx, ['nodeStates'], 'must be an object');
  } else {
    const rawStates = raw.nodeStates;
    const entries: Record<string, NodeState> = {};
    let ok = true;
    for (const key of Object.keys(rawStates)) {
      const v = requireEnum(ctx, ['nodeStates', key], rawStates[key], NODE_STATES);
      if (v === undefined) {
        ok = false;
      } else {
        entries[key] = v;
      }
    }
    if (ok) nodeStates = entries;
  }

  let providerSessionIds: Record<string, string> | undefined;
  if (!isPlainObject(raw.providerSessionIds)) {
    pushErr(ctx, ['providerSessionIds'], 'must be an object');
  } else {
    const rawIds = raw.providerSessionIds;
    const entries: Record<string, string> = {};
    let ok = true;
    for (const key of Object.keys(rawIds)) {
      const v = requireId(ctx, ['providerSessionIds', key], rawIds[key]);
      if (v === undefined) {
        ok = false;
      } else {
        entries[key] = v;
      }
    }
    if (ok) providerSessionIds = entries;
  }

  let humanDecisions: HumanDecisionRecord[] | undefined;
  const rawHumanDecisions = requireArray(ctx, ['humanDecisions'], raw.humanDecisions);
  if (rawHumanDecisions) {
    const items = rawHumanDecisions.map((v, i) => validateHumanDecisionRecord(ctx, ['humanDecisions', i], v));
    if (items.every((v): v is HumanDecisionRecord => v !== undefined)) humanDecisions = items;
  }

  let artifacts: ArtifactManifest[] | undefined;
  const rawArtifacts = requireArray(ctx, ['artifacts'], raw.artifacts);
  if (rawArtifacts) {
    const items: ArtifactManifest[] = [];
    let ok = true;
    rawArtifacts.forEach((v, i) => {
      const result = validateArtifactManifest(v);
      if (result.ok) {
        items.push(result.value);
      } else {
        ok = false;
        for (const e of result.errors) pushErr(ctx, ['artifacts', i, e.path], e.message);
      }
    });
    if (ok) artifacts = items;
  }

  let evidence: Evidence[] | undefined;
  const rawEvidence = requireArray(ctx, ['evidence'], raw.evidence);
  if (rawEvidence) {
    const items: Evidence[] = [];
    let ok = true;
    rawEvidence.forEach((v, i) => {
      const result = validateEvidence(v);
      if (result.ok) {
        items.push(result.value);
      } else {
        ok = false;
        for (const e of result.errors) pushErr(ctx, ['evidence', i, e.path], e.message);
      }
    });
    if (ok) evidence = items;
  }

  const verificationState = validateVerificationState(ctx, ['verificationState'], raw.verificationState);
  const budgetState = validateBudgetState(ctx, ['budgetState'], raw.budgetState);

  let journal: JournalEntry[] | undefined;
  const rawJournal = requireArray(ctx, ['journal'], raw.journal);
  if (rawJournal) {
    const items = rawJournal.map((v, i) => validateJournalEntry(ctx, ['journal', i], v));
    if (items.every((v): v is JournalEntry => v !== undefined)) {
      journal = items;
      for (let i = 1; i < journal.length; i++) {
        const prevEntry = journal[i - 1];
        const currEntry = journal[i];
        if (prevEntry && currEntry && Date.parse(currEntry.timestamp) < Date.parse(prevEntry.timestamp)) {
          pushErr(ctx, ['journal', i, 'timestamp'], 'journal entries must be chronologically non-decreasing');
        }
      }
    }
  }

  let terminalResult: FinalOperatorResult | null | undefined;
  if (!hasOwn(raw, 'terminalResult')) {
    pushErr(ctx, ['terminalResult'], 'is required');
  } else if (raw.terminalResult === null) {
    terminalResult = null;
  } else {
    const result = validateFinalOperatorResult(raw.terminalResult);
    if (result.ok) {
      terminalResult = result.value;
    } else {
      for (const e of result.errors) pushErr(ctx, ['terminalResult', e.path], e.message);
    }
  }

  let stopDetail: StopDetail | undefined;
  if (hasOwn(raw, 'stopDetail')) stopDetail = validateStopDetail(ctx, ['stopDetail'], raw.stopDetail);

  // Cross-field: stopDetail required exactly when currentState is BLOCKED or
  // NEEDS_REPLAN, and must be absent otherwise.
  if (currentState === 'BLOCKED' || currentState === 'NEEDS_REPLAN') {
    if (!hasOwn(raw, 'stopDetail')) {
      pushErr(ctx, ['stopDetail'], `is required when currentState is ${currentState}`);
    } else if (stopDetail !== undefined) {
      if (currentState === 'NEEDS_REPLAN' && stopDetail.reason !== 'NEEDS_REPLAN') {
        pushErr(ctx, ['stopDetail', 'reason'], 'must be NEEDS_REPLAN when currentState is NEEDS_REPLAN');
      }
      if (currentState === 'BLOCKED' && stopDetail.reason === 'NEEDS_REPLAN') {
        pushErr(ctx, ['stopDetail', 'reason'], 'must not be NEEDS_REPLAN when currentState is BLOCKED');
      }
    }
  } else if (hasOwn(raw, 'stopDetail')) {
    pushErr(ctx, ['stopDetail'], 'must be absent unless currentState is BLOCKED or NEEDS_REPLAN');
  }

  // Cross-field: updatedAt must not precede createdAt.
  if (createdAt !== undefined && updatedAt !== undefined && Date.parse(updatedAt) < Date.parse(createdAt)) {
    pushErr(ctx, ['updatedAt'], 'must not be earlier than createdAt');
  }

  // Cross-field: mandatory nodes cannot be skipped, and every recorded
  // node state must reference a node that actually exists in the graph.
  if (executionGraph !== undefined && executionGraph !== null && nodeStates !== undefined) {
    for (const node of executionGraph.nodes) {
      const state = nodeStates[node.nodeId];
      if (node.mandatory && state === 'SKIPPED') {
        pushErr(ctx, ['nodeStates', node.nodeId], `mandatory node "${node.nodeId}" cannot be SKIPPED`);
      }
    }
    for (const nodeId of Object.keys(nodeStates)) {
      if (!executionGraph.nodes.some((n) => n.nodeId === nodeId)) {
        pushErr(ctx, ['nodeStates', nodeId], `references a node id not present in executionGraph: ${nodeId}`);
      }
    }
  }

  // Cross-field: human approval binds session/gate/graph/hash fields —
  // every recorded decision's graph/artifact hashes must match the
  // session's current execution graph and known artifacts.
  if (humanDecisions !== undefined) {
    const knownArtifactHashes = new Set((artifacts ?? []).map((a) => a.hash));
    humanDecisions.forEach((decision, i) => {
      if (executionGraph !== undefined && executionGraph !== null && decision.graphHashAtDecision !== executionGraph.graphHash) {
        pushErr(
          ctx,
          ['humanDecisions', i, 'graphHashAtDecision'],
          'must equal executionGraph.graphHash (approval binds to the exact graph revision it was granted against)',
        );
      }
      if (artifacts !== undefined) {
        for (const [j, hash] of decision.artifactHashesAtDecision.entries()) {
          if (!knownArtifactHashes.has(hash)) {
            pushErr(ctx, ['humanDecisions', i, 'artifactHashesAtDecision', j], `references an artifact hash not present in session.artifacts: ${hash}`);
          }
        }
      }
    });
  }

  // Cross-field: terminal session states carry a non-null terminalResult;
  // every other state carries null (plan section 14).
  if (currentState !== undefined && terminalResult !== undefined) {
    const isTerminalState = TERMINAL_SESSION_STATES.includes(currentState);
    if (isTerminalState && terminalResult === null) {
      pushErr(ctx, ['terminalResult'], `is required (non-null) when currentState is ${currentState}`);
    }
    if (!isTerminalState && terminalResult !== null) {
      pushErr(ctx, ['terminalResult'], 'must be null unless currentState is COMPLETED, FAILED, or CANCELLED');
    }
  }

  // Cross-field: a non-null terminal result's identity must match the
  // session it belongs to, wherever the corresponding session field is
  // present (plan section 14).
  if (terminalResult !== undefined && terminalResult !== null) {
    if (operatorSessionId !== undefined && terminalResult.identity.operatorSessionId !== operatorSessionId) {
      pushErr(ctx, ['terminalResult', 'identity', 'operatorSessionId'], 'must equal operatorSessionId');
    }
    if (workflowTemplateId !== undefined && workflowTemplateId !== null && terminalResult.identity.workflowTemplate !== workflowTemplateId) {
      pushErr(ctx, ['terminalResult', 'identity', 'workflowTemplate'], 'must equal workflowTemplateId when workflowTemplateId is present');
    }
    if (executionGraph !== undefined && executionGraph !== null && terminalResult.identity.graphRevision !== executionGraph.graphRevision) {
      pushErr(ctx, ['terminalResult', 'identity', 'graphRevision'], 'must equal executionGraph.graphRevision when executionGraph is present');
    }
  }

  // Cross-field: a successful terminal completion cannot bypass any gate
  // the route decision required — every RouteDecision.requiredGates entry
  // must have a matching APPROVED human decision recorded (plan sections 9,
  // 14, 18: required gates cannot be modeled as bypassed).
  if (
    terminalResult !== undefined &&
    terminalResult !== null &&
    (terminalResult.status.workflowStatus === 'COMPLETED' || terminalResult.status.workflowStatus === 'COMPLETED_WITH_DEFERRED_ITEMS') &&
    routeDecision !== undefined &&
    routeDecision !== null &&
    humanDecisions !== undefined
  ) {
    const approvedGateTypes = new Set(humanDecisions.filter((d) => d.outcome === 'APPROVED').map((d) => d.decisionType));
    for (const requiredGate of routeDecision.requiredGates) {
      if (!approvedGateTypes.has(requiredGate)) {
        pushErr(
          ctx,
          ['humanDecisions'],
          `missing an APPROVED human decision for required gate type "${requiredGate}" (required gates cannot be bypassed in a successful terminal session)`,
        );
      }
    }
  }

  if (
    operatorSessionId === undefined ||
    schemaVersion === undefined ||
    originalRequest === undefined ||
    createdAt === undefined ||
    updatedAt === undefined ||
    currentState === undefined ||
    currentPhase === undefined ||
    routeDecision === undefined ||
    workflowTemplateId === undefined ||
    executionGraph === undefined ||
    nodeStates === undefined ||
    providerSessionIds === undefined ||
    humanDecisions === undefined ||
    artifacts === undefined ||
    evidence === undefined ||
    verificationState === undefined ||
    budgetState === undefined ||
    journal === undefined ||
    terminalResult === undefined
  ) {
    return finalize(ctx, out);
  }
  if (hasOwn(raw, 'stopDetail') && stopDetail === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'openGateId') && openGateId === undefined) return finalize(ctx, out);

  out.operatorSessionId = operatorSessionId;
  out.schemaVersion = schemaVersion;
  out.originalRequest = originalRequest;
  out.createdAt = createdAt;
  out.updatedAt = updatedAt;
  out.currentState = currentState;
  out.currentPhase = currentPhase;
  out.routeDecision = routeDecision;
  out.workflowTemplateId = workflowTemplateId;
  out.executionGraph = executionGraph;
  out.nodeStates = nodeStates;
  out.providerSessionIds = providerSessionIds;
  out.humanDecisions = humanDecisions;
  out.artifacts = artifacts;
  out.evidence = evidence;
  out.verificationState = verificationState;
  out.budgetState = budgetState;
  out.journal = journal;
  out.terminalResult = terminalResult;
  if (stopDetail !== undefined) out.stopDetail = stopDetail;
  if (openGateId !== undefined) out.openGateId = openGateId;

  return finalize<OperatorSession>(ctx, out);
}

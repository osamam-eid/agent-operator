/**
 * Agent Operator — Stage 1 deterministic contract validators: agent
 * results, evidence, findings, and the final operator report.
 *
 * Validates every "what happened and what does it mean" contract
 * (AgentResult, Evidence, ArtifactManifest, Finding, PolicyDecision,
 * FinalOperatorResult — plan sections 5, 8-12) plus the VerificationState
 * struct shared by FinalOperatorResult and, via session.ts, OperatorSession.
 * Every validator here is self-contained: none embeds or cross-validates a
 * CapabilityRecord, RouteDecision, WorkflowTemplate, ExecutionGraph,
 * HumanGate, or OperatorSession, so this module has no dependency on
 * src/validation/core-contracts.ts or session.ts — session.ts depends on
 * this module instead, never the reverse.
 */

import type {
  AgentResult,
  ArtifactManifest,
  Confidence,
  Evidence,
  ExecutionStatus,
  FinalOperatorResult,
  Finding,
  FindingEffectiveDisposition,
  GateDecisionType,
  PolicyDecision,
  Recommendation,
  RequirementCoverage,
  RequirementCoverageItem,
  ScopeDeviation,
  ScopeStatus,
  UsageStats,
  VerificationState,
  WorkflowStatus,
} from '../contracts.js';

import {
  ARTIFACT_TYPE_PATTERN,
  MAX_LONG_TEXT,
  MAX_MEDIUM_TEXT,
  MAX_SHORT_TEXT,
  REASON_CODE_PATTERN,
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
  AGENT_RESULT_STATUSES,
  ALLOWED_DISPOSITIONS_BY_CLASSIFICATION,
  CONFIDENCE_LEVELS,
  DISPOSITIONS_THAT_BLOCK_PROGRESSION,
  EVIDENCE_TYPES,
  EVIDENCE_VERIFICATION_STATUSES,
  EXECUTION_STATUSES,
  FINDING_CATEGORIES,
  FINDING_EFFECTIVE_DISPOSITIONS,
  FINDING_REPORTED_CLASSIFICATIONS,
  FINDING_STATUSES,
  GATE_DECISION_TYPES,
  POLICY_DECISION_SOURCES,
  POLICY_SUBJECT_TYPES,
  RECOMMENDATIONS,
  REQUIREMENT_COVERAGE_STATUSES,
  SCOPE_STATUSES,
  SEVERITIES,
  VERIFICATION_OUTCOMES,
  WORKFLOW_STATUSES,
} from './enums.js';


// ---------------------------------------------------------------------------
// 5. AgentResult
// ---------------------------------------------------------------------------

const AGENT_RESULT_KEYS = [
  'resultId',
  'operatorSessionId',
  'nodeId',
  'capabilityId',
  'status',
  'summary',
  'producedArtifactRefs',
  'consumedArtifactRefs',
  'findingIds',
  'evidenceIds',
  'recommendedDisposition',
  'providerSessionId',
  'startedAt',
  'completedAt',
  'policyRefs',
] as const;

export function validateAgentResult(input: unknown): ValidationResult<AgentResult> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, AGENT_RESULT_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const resultId = requireId(ctx, ['resultId'], raw.resultId);
  const operatorSessionId = requireId(ctx, ['operatorSessionId'], raw.operatorSessionId);
  const nodeId = requireId(ctx, ['nodeId'], raw.nodeId);
  const capabilityId = requireId(ctx, ['capabilityId'], raw.capabilityId);
  const status = requireEnum(ctx, ['status'], raw.status, AGENT_RESULT_STATUSES);
  const summary = requireHumanText(ctx, ['summary'], raw.summary, { maxLen: MAX_MEDIUM_TEXT });
  const producedArtifactRefs = requireStringArray(ctx, ['producedArtifactRefs'], raw.producedArtifactRefs, { unique: true, itemValidator: requireId });
  const consumedArtifactRefs = requireStringArray(ctx, ['consumedArtifactRefs'], raw.consumedArtifactRefs, { unique: true, itemValidator: requireId });
  const findingIds = requireStringArray(ctx, ['findingIds'], raw.findingIds, { unique: true, itemValidator: requireId });
  const evidenceIds = requireStringArray(ctx, ['evidenceIds'], raw.evidenceIds, { unique: true, itemValidator: requireId });
  let recommendedDisposition: FindingEffectiveDisposition | undefined;
  if (hasOwn(raw, 'recommendedDisposition')) {
    recommendedDisposition = requireEnum(ctx, ['recommendedDisposition'], raw.recommendedDisposition, FINDING_EFFECTIVE_DISPOSITIONS);
  }
  let providerSessionId: string | undefined;
  if (hasOwn(raw, 'providerSessionId')) providerSessionId = requireId(ctx, ['providerSessionId'], raw.providerSessionId);
  const startedAt = requireTimestamp(ctx, ['startedAt'], raw.startedAt);
  const completedAt = requireTimestamp(ctx, ['completedAt'], raw.completedAt);
  const policyRefs = requirePolicyRefsArray(ctx, ['policyRefs'], raw.policyRefs);

  if (startedAt !== undefined && completedAt !== undefined && Date.parse(completedAt) < Date.parse(startedAt)) {
    pushErr(ctx, ['completedAt'], 'must not be earlier than startedAt');
  }

  if (
    resultId === undefined ||
    operatorSessionId === undefined ||
    nodeId === undefined ||
    capabilityId === undefined ||
    status === undefined ||
    summary === undefined ||
    producedArtifactRefs === undefined ||
    consumedArtifactRefs === undefined ||
    findingIds === undefined ||
    evidenceIds === undefined ||
    startedAt === undefined ||
    completedAt === undefined ||
    policyRefs === undefined
  ) {
    return finalize(ctx, out);
  }
  if (hasOwn(raw, 'recommendedDisposition') && recommendedDisposition === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'providerSessionId') && providerSessionId === undefined) return finalize(ctx, out);

  out.resultId = resultId;
  out.operatorSessionId = operatorSessionId;
  out.nodeId = nodeId;
  out.capabilityId = capabilityId;
  out.status = status;
  out.summary = summary;
  out.producedArtifactRefs = producedArtifactRefs;
  out.consumedArtifactRefs = consumedArtifactRefs;
  out.findingIds = findingIds;
  out.evidenceIds = evidenceIds;
  if (recommendedDisposition !== undefined) out.recommendedDisposition = recommendedDisposition;
  if (providerSessionId !== undefined) out.providerSessionId = providerSessionId;
  out.startedAt = startedAt;
  out.completedAt = completedAt;
  out.policyRefs = policyRefs;

  return finalize<AgentResult>(ctx, out);
}


// ---------------------------------------------------------------------------
// 8. Evidence (validated ahead of OperatorSession, which embeds it)
// ---------------------------------------------------------------------------

const EVIDENCE_KEYS = ['evidenceId', 'type', 'source', 'artifact', 'claim', 'timestamp', 'producer', 'verificationStatus', 'verifiedBy'] as const;

export function validateEvidence(input: unknown): ValidationResult<Evidence> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, EVIDENCE_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const evidenceId = requireId(ctx, ['evidenceId'], raw.evidenceId);
  const type = requireEnum(ctx, ['type'], raw.type, EVIDENCE_TYPES);
  const source = requireHumanText(ctx, ['source'], raw.source, { maxLen: MAX_SHORT_TEXT });
  let artifact: string | undefined;
  if (hasOwn(raw, 'artifact')) artifact = requireId(ctx, ['artifact'], raw.artifact);
  const claim = requireHumanText(ctx, ['claim'], raw.claim, { maxLen: MAX_MEDIUM_TEXT });
  const timestamp = requireTimestamp(ctx, ['timestamp'], raw.timestamp);
  const producer = requireExactString(ctx, ['producer'], raw.producer, { maxLen: MAX_SHORT_TEXT });
  const verificationStatus = requireEnum(ctx, ['verificationStatus'], raw.verificationStatus, EVIDENCE_VERIFICATION_STATUSES);
  let verifiedBy: string | undefined;
  if (hasOwn(raw, 'verifiedBy')) verifiedBy = requireExactString(ctx, ['verifiedBy'], raw.verifiedBy, { maxLen: MAX_SHORT_TEXT });

  if (verificationStatus !== undefined) {
    if (verificationStatus === 'UNVERIFIED' && hasOwn(raw, 'verifiedBy')) {
      pushErr(ctx, ['verifiedBy'], 'must be absent when verificationStatus is UNVERIFIED');
    }
    if (verificationStatus !== 'UNVERIFIED' && !hasOwn(raw, 'verifiedBy')) {
      pushErr(ctx, ['verifiedBy'], 'is required when verificationStatus is not UNVERIFIED');
    }
  }

  if (
    evidenceId === undefined ||
    type === undefined ||
    source === undefined ||
    claim === undefined ||
    timestamp === undefined ||
    producer === undefined ||
    verificationStatus === undefined
  ) {
    return finalize(ctx, out);
  }
  if (hasOwn(raw, 'artifact') && artifact === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'verifiedBy') && verifiedBy === undefined) return finalize(ctx, out);
  if (verificationStatus !== 'UNVERIFIED' && verifiedBy === undefined) return finalize(ctx, out);
  if (verificationStatus === 'UNVERIFIED' && verifiedBy !== undefined) return finalize(ctx, out);

  out.evidenceId = evidenceId;
  out.type = type;
  out.source = source;
  if (artifact !== undefined) out.artifact = artifact;
  out.claim = claim;
  out.timestamp = timestamp;
  out.producer = producer;
  out.verificationStatus = verificationStatus;
  if (verifiedBy !== undefined) out.verifiedBy = verifiedBy;

  return finalize<Evidence>(ctx, out);
}


// ---------------------------------------------------------------------------
// 9. ArtifactManifest (validated ahead of OperatorSession, which embeds it)
// ---------------------------------------------------------------------------

const ARTIFACT_MANIFEST_KEYS = [
  'artifactId',
  'artifactType',
  'producedByNodeId',
  'operatorSessionId',
  'hash',
  'location',
  'sizeBytes',
  'createdAt',
  'contentSummary',
  'policyRefs',
] as const;

export function validateArtifactManifest(input: unknown): ValidationResult<ArtifactManifest> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, ARTIFACT_MANIFEST_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const artifactId = requireId(ctx, ['artifactId'], raw.artifactId);
  const artifactType = requireExactString(ctx, ['artifactType'], raw.artifactType, { maxLen: MAX_SHORT_TEXT, pattern: ARTIFACT_TYPE_PATTERN });
  const producedByNodeId = requireId(ctx, ['producedByNodeId'], raw.producedByNodeId);
  const operatorSessionId = requireId(ctx, ['operatorSessionId'], raw.operatorSessionId);
  const hash = requireHash(ctx, ['hash'], raw.hash);
  const location = requireExactString(ctx, ['location'], raw.location, { maxLen: MAX_MEDIUM_TEXT });
  let sizeBytes: number | undefined;
  if (hasOwn(raw, 'sizeBytes')) sizeBytes = requireNumber(ctx, ['sizeBytes'], raw.sizeBytes, { min: 0, integer: true });
  const createdAt = requireTimestamp(ctx, ['createdAt'], raw.createdAt);
  const contentSummary = requireHumanText(ctx, ['contentSummary'], raw.contentSummary, { maxLen: MAX_MEDIUM_TEXT });
  const policyRefs = requirePolicyRefsArray(ctx, ['policyRefs'], raw.policyRefs);

  if (
    artifactId === undefined ||
    artifactType === undefined ||
    producedByNodeId === undefined ||
    operatorSessionId === undefined ||
    hash === undefined ||
    location === undefined ||
    createdAt === undefined ||
    contentSummary === undefined ||
    policyRefs === undefined
  ) {
    return finalize(ctx, out);
  }
  if (hasOwn(raw, 'sizeBytes') && sizeBytes === undefined) return finalize(ctx, out);

  out.artifactId = artifactId;
  out.artifactType = artifactType;
  out.producedByNodeId = producedByNodeId;
  out.operatorSessionId = operatorSessionId;
  out.hash = hash;
  out.location = location;
  if (sizeBytes !== undefined) out.sizeBytes = sizeBytes;
  out.createdAt = createdAt;
  out.contentSummary = contentSummary;
  out.policyRefs = policyRefs;

  return finalize<ArtifactManifest>(ctx, out);
}


// ---------------------------------------------------------------------------
// 10. Finding
// ---------------------------------------------------------------------------

const FINDING_KEYS = [
  'findingId',
  'producer',
  'category',
  'severity',
  'reportedClassification',
  'effectiveDisposition',
  'summary',
  'impact',
  'evidenceRefs',
  'recommendedAction',
  'blocksProgression',
  'introducedAtRound',
  'status',
  'policyRefs',
  'policyDecisionId',
] as const;

export function validateFinding(input: unknown): ValidationResult<Finding> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, FINDING_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const findingId = requireId(ctx, ['findingId'], raw.findingId);
  const producer = requireExactString(ctx, ['producer'], raw.producer, { maxLen: MAX_SHORT_TEXT });
  const category = requireEnum(ctx, ['category'], raw.category, FINDING_CATEGORIES);
  const severity = requireEnum(ctx, ['severity'], raw.severity, SEVERITIES);
  const reportedClassification = requireEnum(ctx, ['reportedClassification'], raw.reportedClassification, FINDING_REPORTED_CLASSIFICATIONS);
  const effectiveDisposition = requireEnum(ctx, ['effectiveDisposition'], raw.effectiveDisposition, FINDING_EFFECTIVE_DISPOSITIONS);
  const summary = requireHumanText(ctx, ['summary'], raw.summary, { maxLen: MAX_MEDIUM_TEXT });
  const impact = requireHumanText(ctx, ['impact'], raw.impact, { maxLen: MAX_MEDIUM_TEXT });
  const evidenceRefs = requireStringArray(ctx, ['evidenceRefs'], raw.evidenceRefs, { minItems: 1, unique: true, itemValidator: requireId });
  const recommendedAction = requireHumanText(ctx, ['recommendedAction'], raw.recommendedAction, { maxLen: MAX_MEDIUM_TEXT });
  const blocksProgression = requireBoolean(ctx, ['blocksProgression'], raw.blocksProgression);
  const introducedAtRound = requireNumber(ctx, ['introducedAtRound'], raw.introducedAtRound, { min: 1, integer: true });
  const status = requireEnum(ctx, ['status'], raw.status, FINDING_STATUSES);
  const policyRefs = requirePolicyRefsArray(ctx, ['policyRefs'], raw.policyRefs, { minItems: 1 });
  const policyDecisionId = requireId(ctx, ['policyDecisionId'], raw.policyDecisionId);

  // Cross-field: reportedClassification (reviewer-owned) and
  // effectiveDisposition (deterministic-policy-owned) remain distinct
  // concerns, validated against the plan's deterministic disposition table.
  if (reportedClassification !== undefined && effectiveDisposition !== undefined) {
    const allowed = ALLOWED_DISPOSITIONS_BY_CLASSIFICATION[reportedClassification];
    if (!allowed.includes(effectiveDisposition)) {
      pushErr(
        ctx,
        ['effectiveDisposition'],
        `must be one of [${allowed.join(', ')}] when reportedClassification is ${reportedClassification}`,
      );
    }
  }
  if (effectiveDisposition !== undefined && blocksProgression !== undefined) {
    const expectedBlocks = DISPOSITIONS_THAT_BLOCK_PROGRESSION.has(effectiveDisposition);
    if (blocksProgression !== expectedBlocks) {
      pushErr(ctx, ['blocksProgression'], `must be ${expectedBlocks} when effectiveDisposition is ${effectiveDisposition}`);
    }
  }

  if (
    findingId === undefined ||
    producer === undefined ||
    category === undefined ||
    severity === undefined ||
    reportedClassification === undefined ||
    effectiveDisposition === undefined ||
    summary === undefined ||
    impact === undefined ||
    evidenceRefs === undefined ||
    recommendedAction === undefined ||
    blocksProgression === undefined ||
    introducedAtRound === undefined ||
    status === undefined ||
    policyRefs === undefined ||
    policyDecisionId === undefined
  ) {
    return finalize(ctx, out);
  }

  out.findingId = findingId;
  out.producer = producer;
  out.category = category;
  out.severity = severity;
  out.reportedClassification = reportedClassification;
  out.effectiveDisposition = effectiveDisposition;
  out.summary = summary;
  out.impact = impact;
  out.evidenceRefs = evidenceRefs;
  out.recommendedAction = recommendedAction;
  out.blocksProgression = blocksProgression;
  out.introducedAtRound = introducedAtRound;
  out.status = status;
  out.policyRefs = policyRefs;
  out.policyDecisionId = policyDecisionId;

  return finalize<Finding>(ctx, out);
}


// ---------------------------------------------------------------------------
// 11. PolicyDecision
// ---------------------------------------------------------------------------
const POLICY_DECISION_KEYS = ['decisionId', 'subjectType', 'subjectId', 'decision', 'decisionSource', 'overrideGateId', 'reasonCodes', 'policyRefs', 'inputs', 'timestamp'] as const;

export function validatePolicyDecision(input: unknown): ValidationResult<PolicyDecision> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, POLICY_DECISION_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const decisionId = requireId(ctx, ['decisionId'], raw.decisionId);
  const subjectType = requireEnum(ctx, ['subjectType'], raw.subjectType, POLICY_SUBJECT_TYPES);
  const subjectId = requireId(ctx, ['subjectId'], raw.subjectId);
  const decision = requireEnum(ctx, ['decision'], raw.decision, FINDING_EFFECTIVE_DISPOSITIONS);
  const decisionSource = requireEnum(ctx, ['decisionSource'], raw.decisionSource, POLICY_DECISION_SOURCES);
  let overrideGateId: string | undefined;
  if (hasOwn(raw, 'overrideGateId')) overrideGateId = requireId(ctx, ['overrideGateId'], raw.overrideGateId);

  // Cross-field: an override gate id makes sense only when a human actually
  // overrode policy at that gate; deterministic policy decisions cannot
  // reference one (plan section 8).
  if (decisionSource === 'HUMAN_OVERRIDE' && !hasOwn(raw, 'overrideGateId')) {
    pushErr(ctx, ['overrideGateId'], 'is required when decisionSource is "HUMAN_OVERRIDE"');
  }
  if (decisionSource === 'POLICY' && hasOwn(raw, 'overrideGateId')) {
    pushErr(ctx, ['overrideGateId'], 'must be absent when decisionSource is "POLICY"');
  }
  const reasonCodes = requireStringArray(ctx, ['reasonCodes'], raw.reasonCodes, {
    minItems: 1,
    itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }),
  });
  const policyRefs = requirePolicyRefsArray(ctx, ['policyRefs'], raw.policyRefs, { minItems: 1 });

  let inputs: Record<string, string> | undefined;
  if (!isPlainObject(raw.inputs)) {
    pushErr(ctx, ['inputs'], 'must be an object');
  } else {
    const inputsRaw = raw.inputs;
    const entries: Record<string, string> = {};
    let ok = true;
    for (const key of Object.keys(inputsRaw)) {
      const v = requireExactString(ctx, ['inputs', key], inputsRaw[key], { maxLen: MAX_SHORT_TEXT });
      if (v === undefined) {
        ok = false;
      } else {
        entries[key] = v;
      }
    }
    if (ok) inputs = entries;
  }

  const timestamp = requireTimestamp(ctx, ['timestamp'], raw.timestamp);
  if (
    decisionId === undefined ||
    subjectType === undefined ||
    subjectId === undefined ||
    decision === undefined ||
    decisionSource === undefined ||
    reasonCodes === undefined ||
    policyRefs === undefined ||
    inputs === undefined ||
    timestamp === undefined
  ) {
    return finalize(ctx, out);
  }
  if (hasOwn(raw, 'overrideGateId') && overrideGateId === undefined) return finalize(ctx, out);

  out.decisionId = decisionId;
  out.subjectType = subjectType;
  out.subjectId = subjectId;
  out.decision = decision;
  out.decisionSource = decisionSource;
  if (overrideGateId !== undefined) out.overrideGateId = overrideGateId;
  out.reasonCodes = reasonCodes;
  out.policyRefs = policyRefs;
  out.inputs = inputs;
  out.timestamp = timestamp;

  return finalize<PolicyDecision>(ctx, out);
}

// ---------------------------------------------------------------------------
// Shared: VerificationState (used by FinalOperatorResult below and by
// OperatorSession in ./session.ts)
// ---------------------------------------------------------------------------


const VERIFICATION_STATE_KEYS = ['behavioralVerification', 'conformanceVerification', 'independentReview', 'adversarialReview'] as const;

export function validateVerificationState(ctx: Ctx, path: Path, value: unknown): VerificationState | undefined {
  const raw = checkObjectShape(ctx, path, value, VERIFICATION_STATE_KEYS);
  if (!raw) return undefined;
  const behavioralVerification = requireEnum(ctx, [...path, 'behavioralVerification'], raw.behavioralVerification, VERIFICATION_OUTCOMES);
  const conformanceVerification = requireEnum(ctx, [...path, 'conformanceVerification'], raw.conformanceVerification, VERIFICATION_OUTCOMES);
  const independentReview = requireEnum(ctx, [...path, 'independentReview'], raw.independentReview, VERIFICATION_OUTCOMES);
  const adversarialReview = requireEnum(ctx, [...path, 'adversarialReview'], raw.adversarialReview, VERIFICATION_OUTCOMES);
  if (
    behavioralVerification === undefined ||
    conformanceVerification === undefined ||
    independentReview === undefined ||
    adversarialReview === undefined
  ) {
    return undefined;
  }
  return { behavioralVerification, conformanceVerification, independentReview, adversarialReview };
}

// ---------------------------------------------------------------------------
// 12. FinalOperatorResult
// ---------------------------------------------------------------------------

const FOR_IDENTITY_KEYS = ['operatorSessionId', 'workflowTemplate', 'graphRevision'] as const;
const FOR_STATUS_KEYS = ['executionStatus', 'workflowStatus'] as const;
const FOR_DECISION_KEYS = ['recommendation', 'recommendationRationale', 'confidence'] as const;
const FOR_HUMAN_DECISION_KEYS = ['required', 'gateId', 'decisionType', 'options', 'recommendedOption'] as const;
const FOR_SCOPE_KEYS = ['scopeStatus', 'requirementCoverage', 'deviations'] as const;
const FOR_EXECUTION_KEYS = ['workPerformed', 'changesMade', 'actionsNotPerformed'] as const;
const FOR_FINDINGS_KEYS = ['fundamentalBlockers', 'blockingFindings', 'nonBlockingFindings', 'deferredFindings', 'observations'] as const;
const FOR_RISK_KEYS = ['remainingRisks'] as const;
const FOR_EVIDENCE_KEYS = ['evidenceRefs'] as const;
const FOR_ARTIFACTS_KEYS = ['artifactRefs'] as const;
const FOR_POLICY_KEYS = ['policyRefs'] as const;
const FOR_USAGE_KEYS = ['providers', 'models', 'tokens', 'cost', 'duration'] as const;
const FOR_NEXT_KEYS = ['allowedActions', 'recommendedAction'] as const;
const REQUIREMENT_COVERAGE_ITEM_KEYS = ['requirementId', 'description', 'status'] as const;
const REQUIREMENT_COVERAGE_KEYS = ['items', 'requiredCount', 'satisfiedCount', 'unsatisfiedCount', 'deferredCount'] as const;
const SCOPE_DEVIATION_KEYS = ['deviationId', 'description', 'approved', 'policyRefs'] as const;

const FINAL_OPERATOR_RESULT_KEYS = [
  'identity',
  'status',
  'decision',
  'humanDecision',
  'scope',
  'execution',
  'verification',
  'findings',
  'risk',
  'evidence',
  'artifacts',
  'policy',
  'usage',
  'next',
] as const;

function validateRequirementCoverageItem(ctx: Ctx, path: Path, value: unknown): RequirementCoverageItem | undefined {
  const raw = checkObjectShape(ctx, path, value, REQUIREMENT_COVERAGE_ITEM_KEYS);
  if (!raw) return undefined;
  const requirementId = requireId(ctx, [...path, 'requirementId'], raw.requirementId);
  const description = requireHumanText(ctx, [...path, 'description'], raw.description, { maxLen: MAX_MEDIUM_TEXT });
  const status = requireEnum(ctx, [...path, 'status'], raw.status, REQUIREMENT_COVERAGE_STATUSES);
  if (requirementId === undefined || description === undefined || status === undefined) return undefined;
  return { requirementId, description, status };
}

function validateRequirementCoverage(ctx: Ctx, path: Path, value: unknown): RequirementCoverage | undefined {
  const raw = checkObjectShape(ctx, path, value, REQUIREMENT_COVERAGE_KEYS);
  if (!raw) return undefined;
  const rawItems = requireArray(ctx, [...path, 'items'], raw.items);
  let items: RequirementCoverageItem[] | undefined;
  if (rawItems) {
    const parsed = rawItems.map((v, i) => validateRequirementCoverageItem(ctx, [...path, 'items', i], v));
    if (parsed.every((v): v is RequirementCoverageItem => v !== undefined)) items = parsed;
  }
  const requiredCount = requireNumber(ctx, [...path, 'requiredCount'], raw.requiredCount, { min: 0, integer: true });
  const satisfiedCount = requireNumber(ctx, [...path, 'satisfiedCount'], raw.satisfiedCount, { min: 0, integer: true });
  const unsatisfiedCount = requireNumber(ctx, [...path, 'unsatisfiedCount'], raw.unsatisfiedCount, { min: 0, integer: true });
  const deferredCount = requireNumber(ctx, [...path, 'deferredCount'], raw.deferredCount, { min: 0, integer: true });

  if (items === undefined || requiredCount === undefined || satisfiedCount === undefined || unsatisfiedCount === undefined || deferredCount === undefined) {
    return undefined;
  }

  if (satisfiedCount + unsatisfiedCount + deferredCount !== requiredCount) {
    pushErr(ctx, [...path, 'requiredCount'], 'must equal satisfiedCount + unsatisfiedCount + deferredCount');
    return undefined;
  }
  if (items.length !== requiredCount) {
    pushErr(ctx, [...path, 'items'], 'length must equal requiredCount');
    return undefined;
  }
  const actualSatisfied = items.filter((i) => i.status === 'SATISFIED').length;
  const actualUnsatisfied = items.filter((i) => i.status === 'UNSATISFIED').length;
  const actualDeferred = items.filter((i) => i.status === 'DEFERRED').length;
  if (actualSatisfied !== satisfiedCount || actualUnsatisfied !== unsatisfiedCount || actualDeferred !== deferredCount) {
    pushErr(ctx, [...path], 'aggregate counts must match the status breakdown of items');
    return undefined;
  }

  return { items, requiredCount, satisfiedCount, unsatisfiedCount, deferredCount };
}

function validateScopeDeviation(ctx: Ctx, path: Path, value: unknown): ScopeDeviation | undefined {
  const raw = checkObjectShape(ctx, path, value, SCOPE_DEVIATION_KEYS);
  if (!raw) return undefined;
  const deviationId = requireId(ctx, [...path, 'deviationId'], raw.deviationId);
  const description = requireHumanText(ctx, [...path, 'description'], raw.description, { maxLen: MAX_MEDIUM_TEXT });
  const approved = requireBoolean(ctx, [...path, 'approved'], raw.approved);
  const policyRefs = requirePolicyRefsArray(ctx, [...path, 'policyRefs'], raw.policyRefs);
  if (deviationId === undefined || description === undefined || approved === undefined || policyRefs === undefined) return undefined;
  return { deviationId, description, approved, policyRefs };
}

export function validateFinalOperatorResult(input: unknown): ValidationResult<FinalOperatorResult> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, FINAL_OPERATOR_RESULT_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  // identity
  const identityRaw = checkObjectShape(ctx, ['identity'], raw.identity, FOR_IDENTITY_KEYS);
  let identityOperatorSessionId: string | undefined;
  let workflowTemplate: string | undefined;
  let graphRevision: number | undefined;
  if (identityRaw) {
    identityOperatorSessionId = requireId(ctx, ['identity', 'operatorSessionId'], identityRaw.operatorSessionId);
    workflowTemplate = requireExactString(ctx, ['identity', 'workflowTemplate'], identityRaw.workflowTemplate, {
      maxLen: 64,
      pattern: ARTIFACT_TYPE_PATTERN,
    });
    graphRevision = requireNumber(ctx, ['identity', 'graphRevision'], identityRaw.graphRevision, { min: 1, integer: true });
  }

  // status
  const statusRaw = checkObjectShape(ctx, ['status'], raw.status, FOR_STATUS_KEYS);
  let executionStatus: ExecutionStatus | undefined;
  let workflowStatus: WorkflowStatus | undefined;
  if (statusRaw) {
    executionStatus = requireEnum(ctx, ['status', 'executionStatus'], statusRaw.executionStatus, EXECUTION_STATUSES);
    workflowStatus = requireEnum(ctx, ['status', 'workflowStatus'], statusRaw.workflowStatus, WORKFLOW_STATUSES);
  }

  // decision
  const decisionRaw = checkObjectShape(ctx, ['decision'], raw.decision, FOR_DECISION_KEYS);
  let recommendation: Recommendation | undefined;
  let recommendationRationale: string | undefined;
  let confidence: Confidence | undefined;
  if (decisionRaw) {
    recommendation = requireEnum(ctx, ['decision', 'recommendation'], decisionRaw.recommendation, RECOMMENDATIONS);
    recommendationRationale = requireHumanText(ctx, ['decision', 'recommendationRationale'], decisionRaw.recommendationRationale, { maxLen: MAX_LONG_TEXT });
    confidence = requireEnum(ctx, ['decision', 'confidence'], decisionRaw.confidence, CONFIDENCE_LEVELS);
  }

  // humanDecision
  const humanDecisionRaw = checkObjectShape(ctx, ['humanDecision'], raw.humanDecision, FOR_HUMAN_DECISION_KEYS);
  let hdRequired: boolean | undefined;
  let hdGateId: string | undefined;
  let hdDecisionType: GateDecisionType | undefined;
  let hdOptions: string[] | undefined;
  let hdRecommendedOption: string | undefined;
  if (humanDecisionRaw) {
    hdRequired = requireBoolean(ctx, ['humanDecision', 'required'], humanDecisionRaw.required);
    if (hasOwn(humanDecisionRaw, 'gateId')) hdGateId = requireId(ctx, ['humanDecision', 'gateId'], humanDecisionRaw.gateId);
    if (hasOwn(humanDecisionRaw, 'decisionType')) hdDecisionType = requireEnum(ctx, ['humanDecision', 'decisionType'], humanDecisionRaw.decisionType, GATE_DECISION_TYPES);
    if (hasOwn(humanDecisionRaw, 'options')) {
      hdOptions = requireStringArray(ctx, ['humanDecision', 'options'], humanDecisionRaw.options, {
        minItems: 2,
        unique: true,
        itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }),
      });
    }
    if (hasOwn(humanDecisionRaw, 'recommendedOption')) {
      hdRecommendedOption = requireExactString(ctx, ['humanDecision', 'recommendedOption'], humanDecisionRaw.recommendedOption, {
        maxLen: MAX_SHORT_TEXT,
        pattern: REASON_CODE_PATTERN,
      });
    }

    if (hdRequired === true) {
      if (!hasOwn(humanDecisionRaw, 'gateId')) pushErr(ctx, ['humanDecision', 'gateId'], 'is required when humanDecision.required is true');
      if (!hasOwn(humanDecisionRaw, 'decisionType')) pushErr(ctx, ['humanDecision', 'decisionType'], 'is required when humanDecision.required is true');
      if (!hasOwn(humanDecisionRaw, 'options')) pushErr(ctx, ['humanDecision', 'options'], 'is required when humanDecision.required is true');
      if (hdOptions !== undefined && hdRecommendedOption !== undefined && !hdOptions.includes(hdRecommendedOption)) {
        pushErr(ctx, ['humanDecision', 'recommendedOption'], 'must be a member of humanDecision.options');
      }
    } else if (hdRequired === false) {
      if (hasOwn(humanDecisionRaw, 'gateId')) pushErr(ctx, ['humanDecision', 'gateId'], 'must be absent when humanDecision.required is false');
      if (hasOwn(humanDecisionRaw, 'decisionType')) pushErr(ctx, ['humanDecision', 'decisionType'], 'must be absent when humanDecision.required is false');
      if (hasOwn(humanDecisionRaw, 'options')) pushErr(ctx, ['humanDecision', 'options'], 'must be absent when humanDecision.required is false');
      if (hasOwn(humanDecisionRaw, 'recommendedOption')) pushErr(ctx, ['humanDecision', 'recommendedOption'], 'must be absent when humanDecision.required is false');
    }
  }

  // scope
  const scopeRaw = checkObjectShape(ctx, ['scope'], raw.scope, FOR_SCOPE_KEYS);
  let scopeStatus: ScopeStatus | undefined;
  let requirementCoverage: RequirementCoverage | undefined;
  let deviations: ScopeDeviation[] | undefined;
  if (scopeRaw) {
    scopeStatus = requireEnum(ctx, ['scope', 'scopeStatus'], scopeRaw.scopeStatus, SCOPE_STATUSES);
    requirementCoverage = validateRequirementCoverage(ctx, ['scope', 'requirementCoverage'], scopeRaw.requirementCoverage);
    const rawDeviations = requireArray(ctx, ['scope', 'deviations'], scopeRaw.deviations);
    if (rawDeviations) {
      const items = rawDeviations.map((v, i) => validateScopeDeviation(ctx, ['scope', 'deviations', i], v));
      if (items.every((v): v is ScopeDeviation => v !== undefined)) deviations = items;
    if (scopeStatus === 'IN_SCOPE' && deviations !== undefined && deviations.length > 0) {
      pushErr(ctx, ['scope', 'deviations'], 'must be empty when scopeStatus is IN_SCOPE');
    }
    if (scopeStatus === 'IN_SCOPE_WITH_APPROVED_DEVIATION' && deviations !== undefined) {
      if (deviations.length === 0) {
        pushErr(ctx, ['scope', 'deviations'], 'must be non-empty when scopeStatus is IN_SCOPE_WITH_APPROVED_DEVIATION');
      } else if (deviations.some((d) => !d.approved)) {
        pushErr(ctx, ['scope', 'deviations'], 'every deviation must be approved when scopeStatus is IN_SCOPE_WITH_APPROVED_DEVIATION');
      }
    }
    if (scopeStatus === 'SCOPE_DRIFT_DETECTED' && deviations !== undefined) {
      if (deviations.length === 0) {
        pushErr(ctx, ['scope', 'deviations'], 'must be non-empty when scopeStatus is SCOPE_DRIFT_DETECTED');
      } else if (!deviations.some((d) => !d.approved)) {
        pushErr(ctx, ['scope', 'deviations'], 'must contain at least one unapproved deviation when scopeStatus is SCOPE_DRIFT_DETECTED');
      }
    }
    }
  }

  // execution
  const executionRaw = checkObjectShape(ctx, ['execution'], raw.execution, FOR_EXECUTION_KEYS);
  let workPerformed: string[] | undefined;
  let changesMade: string[] | undefined;
  let actionsNotPerformed: string[] | undefined;
  if (executionRaw) {
    workPerformed = requireStringArray(ctx, ['execution', 'workPerformed'], executionRaw.workPerformed, {
      itemValidator: (c, p, v) => requireHumanText(c, p, v, { maxLen: MAX_MEDIUM_TEXT }),
    });
    changesMade = requireStringArray(ctx, ['execution', 'changesMade'], executionRaw.changesMade, {
      itemValidator: (c, p, v) => requireHumanText(c, p, v, { maxLen: MAX_MEDIUM_TEXT }),
    });
    actionsNotPerformed = requireStringArray(ctx, ['execution', 'actionsNotPerformed'], executionRaw.actionsNotPerformed, {
      itemValidator: (c, p, v) => requireHumanText(c, p, v, { maxLen: MAX_MEDIUM_TEXT }),
    });
  }

  // verification
  const verification = validateVerificationState(ctx, ['verification'], raw.verification);

  // findings
  const findingsRaw = checkObjectShape(ctx, ['findings'], raw.findings, FOR_FINDINGS_KEYS);
  let fundamentalBlockers: string[] | undefined;
  let blockingFindings: string[] | undefined;
  let nonBlockingFindings: string[] | undefined;
  let deferredFindings: string[] | undefined;
  let observations: string[] | undefined;
  if (findingsRaw) {
    fundamentalBlockers = requireStringArray(ctx, ['findings', 'fundamentalBlockers'], findingsRaw.fundamentalBlockers, { unique: true, itemValidator: requireId });
    blockingFindings = requireStringArray(ctx, ['findings', 'blockingFindings'], findingsRaw.blockingFindings, { unique: true, itemValidator: requireId });
    nonBlockingFindings = requireStringArray(ctx, ['findings', 'nonBlockingFindings'], findingsRaw.nonBlockingFindings, { unique: true, itemValidator: requireId });
    deferredFindings = requireStringArray(ctx, ['findings', 'deferredFindings'], findingsRaw.deferredFindings, { unique: true, itemValidator: requireId });
    observations = requireStringArray(ctx, ['findings', 'observations'], findingsRaw.observations, { unique: true, itemValidator: (c, p, v) => requireHumanText(c, p, v, { maxLen: MAX_MEDIUM_TEXT }) });
  }

  // risk / evidence / artifacts / policy
  const riskRaw = checkObjectShape(ctx, ['risk'], raw.risk, FOR_RISK_KEYS);
  const remainingRisks = riskRaw
    ? requireStringArray(ctx, ['risk', 'remainingRisks'], riskRaw.remainingRisks, { itemValidator: (c, p, v) => requireHumanText(c, p, v, { maxLen: MAX_MEDIUM_TEXT }) })
    : undefined;

  const evidenceRaw = checkObjectShape(ctx, ['evidence'], raw.evidence, FOR_EVIDENCE_KEYS);
  const evidenceRefs = evidenceRaw ? requireStringArray(ctx, ['evidence', 'evidenceRefs'], evidenceRaw.evidenceRefs, { unique: true, itemValidator: requireId }) : undefined;

  const artifactsRaw = checkObjectShape(ctx, ['artifacts'], raw.artifacts, FOR_ARTIFACTS_KEYS);
  const artifactRefs = artifactsRaw ? requireStringArray(ctx, ['artifacts', 'artifactRefs'], artifactsRaw.artifactRefs, { unique: true, itemValidator: requireId }) : undefined;

  const policyRawSection = checkObjectShape(ctx, ['policy'], raw.policy, FOR_POLICY_KEYS);
  const policyRefs = policyRawSection ? requirePolicyRefsArray(ctx, ['policy', 'policyRefs'], policyRawSection.policyRefs, { minItems: 1 }) : undefined;

  // usage
  const usageRaw = checkObjectShape(ctx, ['usage'], raw.usage, FOR_USAGE_KEYS);
  let usage: UsageStats | undefined;
  if (usageRaw) {
    const providers = requireStringArray(ctx, ['usage', 'providers'], usageRaw.providers, { unique: true });
    const models = requireStringArray(ctx, ['usage', 'models'], usageRaw.models, { unique: true });
    const tokens = usageRaw.tokens === null ? null : requireNumber(ctx, ['usage', 'tokens'], usageRaw.tokens, { min: 0 });
    const cost = usageRaw.cost === null ? null : requireNumber(ctx, ['usage', 'cost'], usageRaw.cost, { min: 0 });
    const duration = requireNumber(ctx, ['usage', 'duration'], usageRaw.duration, { min: 0 });
    if (providers !== undefined && models !== undefined && tokens !== undefined && cost !== undefined && duration !== undefined) {
      usage = { providers, models, tokens, cost, duration };
    }
  }

  // next
  const nextRaw = checkObjectShape(ctx, ['next'], raw.next, FOR_NEXT_KEYS);
  let allowedActions: string[] | undefined;
  let recommendedAction: string | undefined;
  if (nextRaw) {
    allowedActions = requireStringArray(ctx, ['next', 'allowedActions'], nextRaw.allowedActions, {
      unique: true,
      itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }),
    });
    if (hasOwn(nextRaw, 'recommendedAction')) {
      recommendedAction = requireExactString(ctx, ['next', 'recommendedAction'], nextRaw.recommendedAction, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN });
    }
    if (allowedActions !== undefined && recommendedAction !== undefined && !allowedActions.includes(recommendedAction)) {
      pushErr(ctx, ['next', 'recommendedAction'], 'must be a member of next.allowedActions');
    }
  }

  // ---- Cross-field: direct status/decision contradictions -----------------
  if (workflowStatus === 'COMPLETED' && executionStatus !== undefined && executionStatus !== 'SUCCEEDED') {
    pushErr(ctx, ['status', 'executionStatus'], 'must be SUCCEEDED when workflowStatus is COMPLETED');
  }
  if (
    workflowStatus === 'COMPLETED_WITH_DEFERRED_ITEMS' &&
    executionStatus !== undefined &&
    executionStatus !== 'SUCCEEDED' &&
    executionStatus !== 'PARTIAL'
  ) {
    pushErr(ctx, ['status', 'executionStatus'], 'must be SUCCEEDED or PARTIAL when workflowStatus is COMPLETED_WITH_DEFERRED_ITEMS');
  }
  if (executionStatus === 'NOT_STARTED' && (workflowStatus === 'COMPLETED' || workflowStatus === 'COMPLETED_WITH_DEFERRED_ITEMS')) {
    pushErr(ctx, ['status', 'workflowStatus'], 'cannot be a completed status when executionStatus is NOT_STARTED');
  }
  if (executionStatus === 'CANCELLED' && (workflowStatus === 'COMPLETED' || workflowStatus === 'COMPLETED_WITH_DEFERRED_ITEMS')) {
    pushErr(ctx, ['status', 'workflowStatus'], 'cannot be a completed status when executionStatus is CANCELLED');
  }
  if (workflowStatus === 'HUMAN_DECISION_REQUIRED' && hdRequired === false) {
    pushErr(ctx, ['humanDecision', 'required'], 'must be true when workflowStatus is HUMAN_DECISION_REQUIRED');
  }
  if (workflowStatus !== undefined && workflowStatus !== 'HUMAN_DECISION_REQUIRED' && hdRequired === true) {
    pushErr(ctx, ['status', 'workflowStatus'], 'must be HUMAN_DECISION_REQUIRED when humanDecision.required is true');
  }
  if (fundamentalBlockers !== undefined && fundamentalBlockers.length > 0 && (workflowStatus === 'COMPLETED' || workflowStatus === 'COMPLETED_WITH_DEFERRED_ITEMS')) {
    pushErr(ctx, ['findings', 'fundamentalBlockers'], 'cannot be non-empty when workflowStatus is a completed status');
  }
  if (recommendation === 'GO' && fundamentalBlockers !== undefined && fundamentalBlockers.length > 0) {
    pushErr(ctx, ['decision', 'recommendation'], 'cannot be GO when findings.fundamentalBlockers is non-empty');
  }
  const blockedWorkflowStatuses: readonly WorkflowStatus[] = ['BLOCKED', 'FAILED', 'CANCELLED', 'NEEDS_REPLAN', 'DECLINED'];
  if ((recommendation === 'GO' || recommendation === 'GO_WITH_DEFERRED_ITEMS') && workflowStatus !== undefined && blockedWorkflowStatuses.includes(workflowStatus)) {
    pushErr(ctx, ['decision', 'recommendation'], `cannot be ${recommendation} when workflowStatus is ${workflowStatus}`);
  }
  if (recommendation === 'GO_WITH_DEFERRED_ITEMS' && deferredFindings !== undefined && deferredFindings.length === 0) {
    pushErr(ctx, ['decision', 'recommendation'], 'cannot be GO_WITH_DEFERRED_ITEMS when findings.deferredFindings is empty');
  }

  if (
    identityOperatorSessionId === undefined ||
    workflowTemplate === undefined ||
    graphRevision === undefined ||
    executionStatus === undefined ||
    workflowStatus === undefined ||
    recommendation === undefined ||
    recommendationRationale === undefined ||
    confidence === undefined ||
    hdRequired === undefined ||
    scopeStatus === undefined ||
    requirementCoverage === undefined ||
    deviations === undefined ||
    workPerformed === undefined ||
    changesMade === undefined ||
    actionsNotPerformed === undefined ||
    verification === undefined ||
    fundamentalBlockers === undefined ||
    blockingFindings === undefined ||
    nonBlockingFindings === undefined ||
    deferredFindings === undefined ||
    observations === undefined ||
    remainingRisks === undefined ||
    evidenceRefs === undefined ||
    artifactRefs === undefined ||
    policyRefs === undefined ||
    usage === undefined ||
    allowedActions === undefined
  ) {
    return finalize(ctx, out);
  }
  if (hasOwn(humanDecisionRaw ?? {}, 'gateId') && hdGateId === undefined) return finalize(ctx, out);
  if (hasOwn(humanDecisionRaw ?? {}, 'decisionType') && hdDecisionType === undefined) return finalize(ctx, out);
  if (hasOwn(humanDecisionRaw ?? {}, 'options') && hdOptions === undefined) return finalize(ctx, out);
  if (hasOwn(humanDecisionRaw ?? {}, 'recommendedOption') && hdRecommendedOption === undefined) return finalize(ctx, out);
  if (hasOwn(nextRaw ?? {}, 'recommendedAction') && recommendedAction === undefined) return finalize(ctx, out);

  const humanDecision: Record<string, unknown> = { required: hdRequired };
  if (hdGateId !== undefined) humanDecision.gateId = hdGateId;
  if (hdDecisionType !== undefined) humanDecision.decisionType = hdDecisionType;
  if (hdOptions !== undefined) humanDecision.options = hdOptions;
  if (hdRecommendedOption !== undefined) humanDecision.recommendedOption = hdRecommendedOption;

  const next: Record<string, unknown> = { allowedActions };
  if (recommendedAction !== undefined) next.recommendedAction = recommendedAction;

  out.identity = { operatorSessionId: identityOperatorSessionId, workflowTemplate, graphRevision };
  out.status = { executionStatus, workflowStatus };
  out.decision = { recommendation, recommendationRationale, confidence };
  out.humanDecision = humanDecision;
  out.scope = { scopeStatus, requirementCoverage, deviations };
  out.execution = { workPerformed, changesMade, actionsNotPerformed };
  out.verification = verification;
  out.findings = { fundamentalBlockers, blockingFindings, nonBlockingFindings, deferredFindings, observations };
  out.risk = { remainingRisks };
  out.evidence = { evidenceRefs };
  out.artifacts = { artifactRefs };
  out.policy = { policyRefs };
  out.usage = usage;
  out.next = next;

  return finalize<FinalOperatorResult>(ctx, out);
}

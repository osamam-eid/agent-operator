import { createHash } from 'node:crypto';

export type ContextRequirement = 'REQUIRED' | 'RELEVANT' | 'OPTIONAL' | 'FORBIDDEN';
export type ContextRepresentation = 'FULL' | 'SYMBOL_EXCERPT' | 'SUMMARY' | 'ARTIFACT_REFERENCE' | 'EVIDENCE_ONLY';

export interface ContextItem {
  readonly itemId: string;
  readonly sourceRef: string;
  readonly requirement: ContextRequirement;
  readonly allowedRepresentations: readonly ContextRepresentation[];
  readonly preferredRepresentation: ContextRepresentation;
  readonly estimatedTokens: number;
  readonly securityCritical: boolean;
}

export interface ContextPackingPolicy {
  readonly policyId: string;
  readonly maxTokens: number;
}

export interface ContextPackingDecision {
  readonly itemId: string;
  readonly status: 'INCLUDED' | 'EXCLUDED' | 'BLOCKED';
  readonly representation?: ContextRepresentation;
  readonly estimatedTokens: number;
  readonly reasonCode: string;
}

export interface ContextPackingPlan {
  readonly schemaVersion: '1.0';
  readonly planId: string;
  readonly policyId: string;
  readonly maxTokens: number;
  readonly totalEstimatedTokens: number;
  readonly blocked: boolean;
  readonly decisions: readonly ContextPackingDecision[];
}

export interface RawEvidenceReference {
  readonly evidenceId: string;
  readonly sha256: string;
  readonly location: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
  readonly authority: 'OPERATIONAL' | 'AUDIT' | 'PROMOTION' | 'PUBLICATION';
}

export interface NormalizedEvidenceRecord {
  readonly schemaVersion: '1.0';
  readonly normalizedId: string;
  readonly rawEvidenceId: string;
  readonly rawSha256: string;
  readonly claims: readonly string[];
  readonly normalizedSha256: string;
  readonly createdAt: string;
}

export interface DecisionBrief {
  readonly schemaVersion: '1.0';
  readonly briefId: string;
  readonly normalizedEvidenceRefs: readonly string[];
  readonly decision: string;
  readonly reasonCodes: readonly string[];
  readonly briefSha256: string;
  readonly createdAt: string;
}

export type RetentionClass = 'MEMORY_ONLY' | 'EPHEMERAL_30D' | 'FAILURE_90D' | 'HUMAN_180D' | 'INTELLIGENCE_365D' | 'AUTHORITATIVE';

export interface RetentionRecord {
  readonly recordId: string;
  readonly retentionClass: RetentionClass;
  readonly createdAt: string;
  readonly referencedBy: readonly string[];
}

export interface RetentionDecision {
  readonly schemaVersion: '1.0';
  readonly recordId: string;
  readonly action: 'KEEP' | 'ELIGIBLE_FOR_EXPLICIT_DELETION';
  readonly reasonCode: string;
  readonly expiresAt: string | null;
}

const REPRESENTATION_FACTOR: Readonly<Record<ContextRepresentation, number>> = {
  FULL: 1,
  SYMBOL_EXCERPT: 0.35,
  SUMMARY: 0.2,
  ARTIFACT_REFERENCE: 0.05,
  EVIDENCE_ONLY: 0.1,
};

function estimatedRepresentationTokens(item: ContextItem, representation: ContextRepresentation): number {
  return Math.max(1, Math.ceil(item.estimatedTokens * REPRESENTATION_FACTOR[representation]));
}

function chooseRepresentation(item: ContextItem): ContextRepresentation | undefined {
  if (item.securityCritical && item.allowedRepresentations.includes('FULL')) return 'FULL';
  if (item.allowedRepresentations.includes(item.preferredRepresentation)) return item.preferredRepresentation;
  return item.allowedRepresentations[0];
}

export function planAdaptiveContext(items: readonly ContextItem[], policy: ContextPackingPolicy): ContextPackingPlan {
  if (!Number.isInteger(policy.maxTokens) || policy.maxTokens < 1) throw new Error('Context token budget must be a positive integer.');
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.itemId)) throw new Error(`Duplicate context item id: ${item.itemId}`);
    ids.add(item.itemId);
    if (!Number.isInteger(item.estimatedTokens) || item.estimatedTokens < 0 || item.allowedRepresentations.length === 0) throw new Error(`Invalid context item: ${item.itemId}`);
  }
  const decisions = new Map<string, ContextPackingDecision>();
  let total = 0;
  let blocked = false;

  for (const item of items.filter((candidate) => candidate.requirement === 'FORBIDDEN')) {
    decisions.set(item.itemId, { itemId: item.itemId, status: 'EXCLUDED', estimatedTokens: 0, reasonCode: 'FORBIDDEN_BY_POLICY' });
  }
  for (const item of items.filter((candidate) => candidate.requirement === 'REQUIRED').sort((a, b) => a.itemId.localeCompare(b.itemId))) {
    const representation = chooseRepresentation(item);
    if (representation === undefined) throw new Error(`Required context item has no representation: ${item.itemId}`);
    const tokens = estimatedRepresentationTokens(item, representation);
    total += tokens;
    const status = total > policy.maxTokens ? 'BLOCKED' : 'INCLUDED';
    if (status === 'BLOCKED') blocked = true;
    decisions.set(item.itemId, { itemId: item.itemId, status, representation, estimatedTokens: tokens, reasonCode: status === 'BLOCKED' ? 'REQUIRED_CONTEXT_OVERFLOW' : 'REQUIRED_CONTEXT' });
  }

  const candidates = items.filter((item) => item.requirement === 'RELEVANT' || item.requirement === 'OPTIONAL').sort((a, b) => {
    const requirement = (a.requirement === 'RELEVANT' ? 0 : 1) - (b.requirement === 'RELEVANT' ? 0 : 1);
    if (requirement !== 0) return requirement;
    if (a.securityCritical !== b.securityCritical) return a.securityCritical ? -1 : 1;
    return a.itemId.localeCompare(b.itemId);
  });
  for (const item of candidates) {
    const representation = chooseRepresentation(item);
    if (representation === undefined) {
      decisions.set(item.itemId, { itemId: item.itemId, status: 'EXCLUDED', estimatedTokens: 0, reasonCode: 'NO_ALLOWED_REPRESENTATION' });
      continue;
    }
    const tokens = estimatedRepresentationTokens(item, representation);
    if (blocked || total + tokens > policy.maxTokens) {
      decisions.set(item.itemId, { itemId: item.itemId, status: 'EXCLUDED', estimatedTokens: 0, reasonCode: 'BUDGET_EXHAUSTED' });
      continue;
    }
    total += tokens;
    decisions.set(item.itemId, { itemId: item.itemId, status: 'INCLUDED', representation, estimatedTokens: tokens, reasonCode: item.requirement === 'RELEVANT' ? 'RELEVANT_CONTEXT' : 'OPTIONAL_CONTEXT' });
  }

  const ordered = [...decisions.values()].sort((a, b) => a.itemId.localeCompare(b.itemId));
  const planId = createHash('sha256').update(JSON.stringify({ policy, decisions: ordered }), 'utf8').digest('hex');
  return { schemaVersion: '1.0', planId, policyId: policy.policyId, maxTokens: policy.maxTokens, totalEstimatedTokens: total, blocked, decisions: ordered };
}

export function normalizeEvidence(raw: RawEvidenceReference, claims: readonly string[], createdAt: string): NormalizedEvidenceRecord {
  const normalizedClaims = [...new Set(claims.map((claim) => claim.trim()).filter((claim) => claim.length > 0))].sort();
  if (normalizedClaims.length === 0) throw new Error('Normalized evidence requires at least one claim.');
  const normalizedSha256 = createHash('sha256').update(JSON.stringify({ raw: raw.sha256, claims: normalizedClaims }), 'utf8').digest('hex');
  return { schemaVersion: '1.0', normalizedId: normalizedSha256, rawEvidenceId: raw.evidenceId, rawSha256: raw.sha256, claims: normalizedClaims, normalizedSha256, createdAt };
}

export function buildDecisionBrief(records: readonly NormalizedEvidenceRecord[], decision: string, reasonCodes: readonly string[], createdAt: string): DecisionBrief {
  if (records.length === 0 || decision.trim() === '' || reasonCodes.length === 0) throw new Error('Decision brief requires evidence, a decision, and reason codes.');
  const refs = [...new Set(records.map((record) => record.normalizedId))].sort();
  const normalizedReasons = [...new Set(reasonCodes)].sort();
  const briefSha256 = createHash('sha256').update(JSON.stringify({ refs, decision, reasons: normalizedReasons }), 'utf8').digest('hex');
  return { schemaVersion: '1.0', briefId: briefSha256, normalizedEvidenceRefs: refs, decision, reasonCodes: normalizedReasons, briefSha256, createdAt };
}

const RETENTION_DAYS: Readonly<Record<Exclude<RetentionClass, 'MEMORY_ONLY' | 'AUTHORITATIVE'>, number>> = {
  EPHEMERAL_30D: 30,
  FAILURE_90D: 90,
  HUMAN_180D: 180,
  INTELLIGENCE_365D: 365,
};

export function evaluateRetention(records: readonly RetentionRecord[], now: string, activeReferences: ReadonlySet<string>): readonly RetentionDecision[] {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) throw new Error('Retention evaluation requires a valid timestamp.');
  return records.map((record): RetentionDecision => {
    if (record.retentionClass === 'AUTHORITATIVE' || record.referencedBy.some((ref) => activeReferences.has(ref))) return { schemaVersion: '1.0', recordId: record.recordId, action: 'KEEP', reasonCode: 'AUTHORITATIVE_OR_ACTIVE_REFERENCE', expiresAt: null };
    if (record.retentionClass === 'MEMORY_ONLY') return { schemaVersion: '1.0', recordId: record.recordId, action: 'ELIGIBLE_FOR_EXPLICIT_DELETION', reasonCode: 'MEMORY_ONLY', expiresAt: record.createdAt };
    const expiry = new Date(Date.parse(record.createdAt) + RETENTION_DAYS[record.retentionClass] * 86_400_000).toISOString();
    return Date.parse(expiry) <= nowMs
      ? { schemaVersion: '1.0', recordId: record.recordId, action: 'ELIGIBLE_FOR_EXPLICIT_DELETION', reasonCode: 'RETENTION_EXPIRED', expiresAt: expiry }
      : { schemaVersion: '1.0', recordId: record.recordId, action: 'KEEP', reasonCode: 'RETENTION_ACTIVE', expiresAt: expiry };
  }).sort((a, b) => a.recordId.localeCompare(b.recordId));
}

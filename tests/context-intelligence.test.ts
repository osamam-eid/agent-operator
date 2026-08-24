import { describe, expect, test } from 'bun:test';

import { buildDecisionBrief, evaluateRetention, normalizeEvidence, planAdaptiveContext, type ContextItem } from '../src/context-intelligence.js';

const items: readonly ContextItem[] = [
  { itemId: 'required-policy', sourceRef: 'policy', requirement: 'REQUIRED', allowedRepresentations: ['FULL'], preferredRepresentation: 'FULL', estimatedTokens: 40, securityCritical: true },
  { itemId: 'relevant-code', sourceRef: 'src/a.ts', requirement: 'RELEVANT', allowedRepresentations: ['SYMBOL_EXCERPT', 'SUMMARY'], preferredRepresentation: 'SYMBOL_EXCERPT', estimatedTokens: 100, securityCritical: false },
  { itemId: 'optional-log', sourceRef: 'log', requirement: 'OPTIONAL', allowedRepresentations: ['SUMMARY'], preferredRepresentation: 'SUMMARY', estimatedTokens: 100, securityCritical: false },
  { itemId: 'forbidden-secret', sourceRef: 'secret', requirement: 'FORBIDDEN', allowedRepresentations: ['FULL'], preferredRepresentation: 'FULL', estimatedTokens: 1, securityCritical: true },
];

describe('context intelligence', () => {
  test('packs deterministically, preserves required context, and excludes forbidden data', () => {
    const policy = { policyId: 'candidate-1', maxTokens: 100 };
    const first = planAdaptiveContext(items, policy);
    const second = planAdaptiveContext([...items].reverse(), policy);
    expect(first.planId).toBe(second.planId);
    expect(first.blocked).toBe(false);
    expect(first.decisions.find((decision) => decision.itemId === 'required-policy')).toMatchObject({ status: 'INCLUDED', representation: 'FULL', estimatedTokens: 40 });
    expect(first.decisions.find((decision) => decision.itemId === 'forbidden-secret')).toMatchObject({ status: 'EXCLUDED', reasonCode: 'FORBIDDEN_BY_POLICY' });
    expect(first.totalEstimatedTokens).toBeLessThanOrEqual(100);
  });

  test('blocks rather than dropping required context on overflow', () => {
    const plan = planAdaptiveContext(items, { policyId: 'small', maxTokens: 20 });
    expect(plan.blocked).toBe(true);
    expect(plan.decisions.find((decision) => decision.itemId === 'required-policy')?.status).toBe('BLOCKED');
    expect(plan.decisions.find((decision) => decision.itemId === 'relevant-code')?.status).toBe('EXCLUDED');
  });

  test('links normalized evidence and decision briefs back to immutable raw digests', () => {
    const raw = { evidenceId: 'raw-1', sha256: 'a'.repeat(64), location: '/evidence/raw-1', sizeBytes: 100, createdAt: '2026-01-01T00:00:00.000Z', authority: 'AUDIT' as const };
    const normalized = normalizeEvidence(raw, [' test passed ', 'test passed', 'scope stayed frozen'], '2026-01-01T00:00:01.000Z');
    expect(normalized.rawSha256).toBe(raw.sha256);
    expect(normalized.claims).toEqual(['scope stayed frozen', 'test passed']);
    const brief = buildDecisionBrief([normalized], 'APPROVE', ['VERIFIED'], '2026-01-01T00:00:02.000Z');
    expect(brief.normalizedEvidenceRefs).toEqual([normalized.normalizedId]);
    expect(brief.briefId).toBe(brief.briefSha256);
  });

  test('retention decisions never delete authoritative or actively referenced evidence', () => {
    const records = [
      { recordId: 'active', retentionClass: 'EPHEMERAL_30D' as const, createdAt: '2025-01-01T00:00:00.000Z', referencedBy: ['candidate-1'] },
      { recordId: 'expired', retentionClass: 'FAILURE_90D' as const, createdAt: '2025-01-01T00:00:00.000Z', referencedBy: [] },
      { recordId: 'audit', retentionClass: 'AUTHORITATIVE' as const, createdAt: '2020-01-01T00:00:00.000Z', referencedBy: [] },
    ];
    const decisions = evaluateRetention(records, '2026-01-01T00:00:00.000Z', new Set(['candidate-1']));
    expect(decisions.find((decision) => decision.recordId === 'active')?.action).toBe('KEEP');
    expect(decisions.find((decision) => decision.recordId === 'expired')?.action).toBe('ELIGIBLE_FOR_EXPLICIT_DELETION');
    expect(decisions.find((decision) => decision.recordId === 'audit')?.action).toBe('KEEP');
  });
});

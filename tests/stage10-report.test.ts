import { describe, expect, test } from 'bun:test';

import type { OperatorComparison } from '../src/evaluator/contracts.js';
import { buildStage10Report, type Stage10ReportInput } from '../src/evaluator/report.js';

const base: Stage10ReportInput = {
  baselineDigest: 'f'.repeat(64),
  featureSetHash: 'a'.repeat(64),
};

function comparison(verdict: OperatorComparison['verdict'], hardFailures: readonly string[] = []): OperatorComparison {
  return { runId: 'run-1', verdict, baselineTotal: 10, candidateTotal: verdict === 'PROMOTE_RECOMMENDED' ? 12 : 9, regressions: [], hardFailures, scoredCases: 2 };
}

describe('Stage-10 evidence package', () => {
  test('complete input produces a deterministic, fully populated report', () => {
    const first = buildStage10Report({ ...base }, '2026-08-21T00:00:00.000Z');
    const second = buildStage10Report({ ...base }, '2026-08-21T00:00:00.000Z');
    expect(first.packageSha256).toBe(second.packageSha256);
    expect(first.sections.corpus).toBe('absent');
    expect(first.sections.actionsNotPerformed).toContain('installation');
  });

  test('populated sections round-trip verbatim and totals are recorded', () => {
    const report = buildStage10Report({
      ...base,
      budget: { maxCases: 5, maxReplaysPerCase: 1, maxProviderTier: 'MEDIUM', maxTokensPerCase: 1000, maxTotalCostUsd: 2, maxWallClockMs: 60000, maxConcurrency: 2 },
      usage: { tokens: 500, costUsd: 0.5, durationMs: 4_000, externalReplays: 2 },
      replayEvidence: [{ replayId: 'rp1', evalRunId: 'r1', caseId: 'c-1', candidateDigest: 'b'.repeat(64), modelProvider: 'claude-cli', modelId: 'm', tier: 'MEDIUM', tokens: 500, costUsd: 0.5, durationMs: 4_000, status: 'SUCCEEDED', summary: 'ok', completedAt: 'now' }],
      comparison: comparison('INSUFFICIENT_EVIDENCE'),
    }, 't');
    expect(report.sections.budgetAndUsage).not.toBe('absent');
    expect(report.sections.replayEvidence).toHaveLength(1);
    expect(report.sections.disclosureDecisions[0]).toContain('claude-cli');
    expect(report.sections.totals).toEqual({ tokens: 500, costUsd: 0.5, durationMs: 4000 });
  });

  test('hard-gate failures are visible and never hidden behind an aggregate score', () => {
    const report = buildStage10Report({ ...base, comparison: comparison('REJECT', ['h1:humanGateBypass']) }, 't');
    expect(report.verdictConsistency.hardFailureHiddenBehindScore).toBe(false);
    const hidden = buildStage10Report({ ...base, comparison: { ...comparison('PROMOTE_RECOMMENDED'), hardFailures: ['h1:humanGateBypass'] } }, 't');
    expect(hidden.verdictConsistency.hardFailureHiddenBehindScore).toBe(true);
  });

  test('promotion is recommendation-only and cannot be self-executed', () => {
    const report = buildStage10Report({
      ...base,
      comparison: comparison('PROMOTE_RECOMMENDED'),
      promotionDecision: { comparisonRunId: 'run-1', recommendation: 'PROMOTE_RECOMMENDED', promotedBySystem: false, evidencePackagePath: '/pkg' },
    }, 't');
    const section = report.sections.promotionRecommendation as Record<string, unknown>;
    expect(section['promotedBySystem']).toBe(false);
    expect(report.verdictConsistency.selfPromotionPossible).toBe(false);
  });

  test('absent optional evidence is recorded as absent, never invented', () => {
    const report = buildStage10Report(base, 't');
    for (const key of ['corpus', 'candidate', 'allowlist', 'scoringSpec', 'comparison'] as const) {
      expect(report.sections[key]).toBe('absent');
    }
    expect(report.sections.replayEvidence).toBe('absent');
  });

  test('changing any input changes the package hash (tamper-evident)', () => {
    const one = buildStage10Report({ ...base }, 't');
    const two = buildStage10Report({ ...base, unresolvedFindings: ['one open finding'] }, 't');
    expect(one.packageSha256).not.toBe(two.packageSha256);
  });
});

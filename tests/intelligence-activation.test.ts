import { describe, expect, test } from 'bun:test';

import {
  calibratePredictions,
  createIntelligenceActivationService,
  intelligenceCandidateDigest,
  MemoryIntelligenceActivationStore,
  runProviderCanaries,
  toOperatorCandidateManifest,
  type ConfidencePrediction,
  type IntelligenceCandidateManifest,
} from '../src/intelligence-activation.js';
import { createProviderIntelligenceService, MemoryProviderIntelligenceStore } from '../src/provider-intelligence.js';

const now = '2026-01-01T00:00:00.000Z';
const digest = (character: string): string => character.repeat(64);

function candidate(id: string, base: string = digest('a')): IntelligenceCandidateManifest {
  return { schemaVersion: '1.0', candidateId: id, baseDigest: base, semanticClassifierDigest: digest('b'), calibrationDigest: digest('c'), competenceDigest: digest('d'), contextPolicyDigest: digest('e'), evidenceSnapshotDigest: digest('f'), policyDigest: digest('1'), compilerVersion: 'wp18', scorerVersion: 'deterministic-structural-v1', createdAt: now };
}

const comparison = { runId: 'run-1', verdict: 'PROMOTE_RECOMMENDED' as const, baselineTotal: 1, candidateTotal: 2, regressions: [], hardFailures: [], scoredCases: 20 };

describe('intelligence activation', () => {
  test('reports insufficient calibration without fabricating scores', () => {
    const predictions: ConfidencePrediction[] = [{ predictionId: 'p1', dimension: 'CLASSIFICATION', predictionIdentity: 'semantic-v1', rawConfidence: 0.9, correct: true, observedAt: now }];
    const report = calibratePredictions(predictions, 'CLASSIFICATION', 'semantic-v1', now);
    expect(report.status).toBe('INSUFFICIENT');
    expect(report.brierScore).toBeNull();
    expect(report.expectedCalibrationError).toBeNull();
  });

  test('computes Brier and reliability calibration from a compatible sample', () => {
    const predictions: ConfidencePrediction[] = Array.from({ length: 20 }, (_, index) => ({ predictionId: `p${index}`, dimension: 'PROVIDER', predictionIdentity: 'ranker-v1', rawConfidence: index < 10 ? 0.9 : 0.2, correct: index < 10, observedAt: now }));
    const report = calibratePredictions(predictions, 'PROVIDER', 'ranker-v1', now);
    expect(report.status).toBe('CALIBRATED');
    expect(report.sampleCount).toBe(20);
    expect(report.brierScore).toBeCloseTo(0.025, 5);
    expect(report.bins).toHaveLength(2);
  });

  test('runs fixed read-only canaries within budget and stores observations only', async () => {
    const intelligence = createProviderIntelligenceService(new MemoryProviderIntelligenceStore());
    const observations = await runProviderCanaries({
      providerId: 'provider-a', modelId: 'model-a', intelligence, now: () => now,
      cases: [{ caseId: 'plan-1', capabilityId: 'planning', taskFamily: 'PLAN', mutationClass: 'READ_ONLY' }],
      budget: { maxCases: 1, maxTokens: 100, maxCost: 1, maxWallClockMs: 1000 },
      runner: { async run() { return { outcome: 'PASSED', qualityScore: 1, latencyMs: 10, tokens: 10, cost: 0.1, toolReliable: true, evaluatorRunRef: 'run-1' }; } },
    });
    expect(observations).toHaveLength(1);
    expect((await intelligence.status()).canaries).toBe(1);
    expect(await intelligence.scorecards()).toEqual([]);
  });

  test('builds an evaluator-compatible manifest with hard invariants unchanged', () => {
    const manifest = toOperatorCandidateManifest(candidate('candidate-1'));
    expect(manifest.components.find((component) => component.component === 'semantic-classifier')?.status).toBe('CHANGED');
    expect(manifest.components.find((component) => component.component === 'hardInvariants')?.status).toBe('UNCHANGED');
    expect(manifest.components.find((component) => component.component === 'promotionAuthority')?.status).toBe('UNCHANGED');
  });

  test('promotes only exact clean evaluator recommendations with human approval and rolls back explicitly', async () => {
    const store = new MemoryIntelligenceActivationStore();
    const service = createIntelligenceActivationService(store);
    const first = candidate('candidate-1');
    const firstDigest = intelligenceCandidateDigest(first);
    await expect(service.promote({ candidate: first, candidateDigest: digest('0'), comparison, humanApprovalRef: 'approval-1', humanApproved: true, now })).rejects.toThrow(/digest/);
    const promoted = await service.promote({ candidate: first, candidateDigest: firstDigest, comparison, humanApprovalRef: 'approval-1', humanApproved: true, now });
    expect(promoted.promotedBySystem).toBe(false);

    const second = candidate('candidate-2', firstDigest);
    const secondDigest = intelligenceCandidateDigest(second);
    await service.promote({ candidate: second, candidateDigest: secondDigest, comparison: { ...comparison, runId: 'run-2' }, humanApprovalRef: 'approval-2', humanApproved: true, now: '2026-01-02T00:00:00.000Z' });
    const rolledBack = await service.rollback({ humanApprovalRef: 'rollback-approval', humanApproved: true, now: '2026-01-03T00:00:00.000Z' });
    expect(rolledBack.activeCandidateId).toBe('candidate-1');
    expect(rolledBack.activeDigest).toBe(firstDigest);
    expect(rolledBack.promotedBySystem).toBe(false);
  });

  test('rejects evaluator regressions even with a human reference', async () => {
    const service = createIntelligenceActivationService(new MemoryIntelligenceActivationStore());
    const value = candidate('candidate-bad');
    await expect(service.promote({ candidate: value, candidateDigest: intelligenceCandidateDigest(value), comparison: { ...comparison, regressions: ['security'] }, humanApprovalRef: 'approval', humanApproved: true, now })).rejects.toThrow(/does not authorize/);
  });
});

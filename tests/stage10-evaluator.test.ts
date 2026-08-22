import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseOperatorCommand } from '../src/commands.js';
import { MemoryOperatorSessionStore } from '../src/store.js';
import { createStage7FeatureSet } from '../src/stage7/feature-config.js';
import { createEvaluatorHandler } from '../src/evaluator/service.js';
import {
  assertCleanForExternalReplay, buildCorpus, clampTier, compare, harvestDrafts,
  loadScoringSpec, scanForSecrets, validateBudget, verifyCandidateBundle,
  writeCandidateBundle, sha256Of } from '../src/evaluator/engine.js';
import type { EvalBudget, ScoringSpec } from '../src/evaluator/contracts.js';

const budget: EvalBudget = { maxCases: 10, maxReplaysPerCase: 1, maxProviderTier: 'MEDIUM', maxTokensPerCase: 100_000, maxTotalCostUsd: 5, maxWallClockMs: 3_600_000, maxConcurrency: 2 };
const specHash = require('node:crypto').createHash('sha256').update(JSON.stringify({ hardGates: ['humanGateBypass', 'unauthorizedMutation'], softWeights: { classification: 2, routing: 2, completeness: 1 }, tolerance: 0 })).digest('hex');
const spec: ScoringSpec = { specHash, hardGates: ['humanGateBypass', 'unauthorizedMutation'], softWeights: { classification: 2, routing: 2, completeness: 1 }, tolerance: 0 };

describe('Stage-10 activation gate', () => {
  test('stage-10 evaluator requires trusted startup even alone', () => {
    expect(() => createStage7FeatureSet(false, false, false, true)).toThrow(/trusted startup/);
    const enabled = createStage7FeatureSet(false, true, false, true);
    expect(enabled.stage10EvaluatorEnabled).toBe(true);
    expect(enabled.hash).not.toBe(createStage7FeatureSet(true, true, false).hash);
  });

  test('improve commands parse and fail closed without an injected handler', async () => {
    const parsed = parseOperatorCommand('improve status');
    expect(parsed.kind).toBe('IMPROVE');
    expect(parseOperatorCommand('improve').kind).toBe('PARSE_ERROR');
    expect(parseOperatorCommand('improve harvest --max-sessions 5')).toMatchObject({ kind: 'IMPROVE', subcommand: 'harvest' });
    const store = new MemoryOperatorSessionStore();
    const runtimeDeps = { evaluatorHandler: undefined } as never;
    void runtimeDeps;
    const handler = createEvaluatorHandler({ store, evaluatorDir: mkdtempSync(join('/tmp', 'eval-')), featureSet: createStage7FeatureSet(true, true, false, false), baselineDigest: 'f'.repeat(64) });
    const outcome = await handler('status', []);
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('FEATURE_DISABLED');
  });
});

describe('Stage-10 harvest and corpus', () => {
  test('harvest emits LOCAL_ONLY drafts from listed sessions only', async () => {
    const store = new MemoryOperatorSessionStore();
    store.listSessionIds();
    const source = {
      listSessionIds: async () => ['s-1', 's-2'],
      load: async (id: string) => ({
        session: { originalRequest: `request for ${id}`, routeDecision: { requestClassification: 'QA', riskClassification: 'LOW', selectedWorkflow: 'qa.v2' } },
        nodeResultRefs: { n1: { summary: 'node summary text' } },
        gates: [{ decisionType: 'RESULT_APPROVAL', optionSelected: 'APPROVE' }],
      }),
    };
    const drafts = await harvestDrafts(source, 10, () => '2026-08-21T00:00:00.000Z');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]?.disclosure).toBe('LOCAL_ONLY');
    expect(drafts[0]?.observed.humanOverrideSignals).toEqual(['RESULT_APPROVAL=APPROVE']);
    void store;
  });

  test('corpus enforces held-out minimums and disjoint partitions', () => {
    const curated = Array.from({ length: 6 }, (_, index) => ({ caseId: `case-${index}`, disclosure: 'LOCAL_ONLY' as const }));
    expect(() => buildCorpus('c', 1, 'now', curated, 0)).toThrow(/INSUFFICIENT_HELD_OUT/);
    expect(() => buildCorpus('c', 1, 'now', curated, 2)).toThrow(/INSUFFICIENT_HELD_OUT/);
    const corpus = buildCorpus('c', 1, 'now', curated, 3);
    expect(corpus.cases.filter((entry) => entry.partition === 'HELD_OUT')).toHaveLength(3);
    expect(() => buildCorpus('c', 1, 'now', curated, 6)).toThrow(/strictly smaller/);
  });
});

describe('Stage-10 secret floor', () => {
  test('credential-bearing cases cannot be upgraded for external replay', () => {
    const leak = { caseId: 'c1', sourceSessionId: 's', originalRequest: 'deploy with password: hunter2', observed: { requestClassification: 'QA', riskClassification: 'LOW', selectedWorkflow: 'qa.v2', requiredGates: [], nodeSummaries: [{ nodeId: 'n', summary: 'fine' }], humanOverrideSignals: [] }, disclosure: 'LOCAL_ONLY' } as const;
    expect(scanForSecrets('password: hunter2').clean).toBe(false);
    expect(() => assertCleanForExternalReplay(leak)).toThrow(/SECRET_DETECTED/);
  });
});

describe('Stage-10 budget and candidate bundles', () => {
  test('budget validation fails closed on missing fields', () => {
    expect(() => validateBudget({ ...budget, maxCases: undefined })).toThrow(/maxCases/);
    expect(() => validateBudget({ ...budget, maxReplaysPerCase: 9 })).toThrow(/maxReplaysPerCase/);
    expect(validateBudget(budget)).toEqual(budget);
  });

  test('tier clamp respects the budget ceiling', () => {
    expect(clampTier('HIGH', budget)).toBe('MEDIUM');
    expect(clampTier('LOW', budget)).toBe('LOW');
  });

  test('candidate bundles are write-once and reject prohibited components', () => {
    const dir = mkdtempSync(join('/tmp', 'eval-candidate-'));
    const manifest = { candidateId: 'cand-1', baseVersion: 'stage9-sealed' as const, baseDigest: 'f'.repeat(64), components: [{ component: 'classifier', status: 'CHANGED' as const }, { component: 'hardInvariants', status: 'PROHIBITED' as const }], createdAt: 'now' };
    writeCandidateBundle(dir, manifest, { 'classifier.txt': 'tweaked wording' });
    expect(() => verifyCandidateBundle(dir)).toThrow(/prohibited component "hardInvariants" is present/);
    const clean = { ...manifest, components: [{ component: 'classifier', status: 'CHANGED' as const }] };
    const dirClean = mkdtempSync(join('/tmp', 'eval-candidate-'));
    writeCandidateBundle(dirClean, clean, { 'classifier.txt': 'tweaked wording' });
    expect(verifyCandidateBundle(dirClean).candidateId).toBe('cand-1');
    writeFileSync(join(dirClean, 'classifier.txt'), 'tampered');
    expect(() => verifyCandidateBundle(dirClean)).toThrow(/ARTIFACT_TAMPERED/);
    rmSync(dirClean, { recursive: true, force: true });
    const bad = { ...manifest, components: [{ component: 'hardInvariants', status: 'CHANGED' as const }] };
    const dir2 = mkdtempSync(join('/tmp', 'eval-candidate-'));
    writeCandidateBundle(dir2, bad, { 'x.txt': 'x' });
    expect(() => verifyCandidateBundle(dir2)).toThrow(/prohibited component "hardInvariants" is present/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe('Stage-10 comparison', () => {
  const base = (caseId: string, classification: number, partition: 'TRAIN' | 'HELD_OUT', hard: readonly string[] = []) => ({ caseId, partition, hardGateFailures: hard, softScores: { classification, routing: 1, completeness: 1 } });

  test('hard-gate failures reject regardless of weighted totals', () => {
    const run = { runId: 'r1', corpusId: 'c', corpusRevision: 1, baselineDigest: 'f'.repeat(64), featureSetHash: 'a'.repeat(64), budget, startedAt: 'now', perCase: [], budgetExhausted: false };
    const comparison = compare([base('c1', 5, 'HELD_OUT')], [base('c1', 99, 'HELD_OUT', ['humanGateBypass'])], spec, run);
    expect(comparison.verdict).toBe('REJECT');
    expect(comparison.hardFailures).toContain('c1:humanGateBypass');
  });

  test('strict held-out improvement is required for a promotion recommendation', () => {
    const run = { runId: 'r2', corpusId: 'c', corpusRevision: 1, baselineDigest: 'f'.repeat(64), featureSetHash: 'a'.repeat(64), budget, startedAt: 'now', perCase: [], budgetExhausted: false };
    expect(compare([base('h1', 2, 'HELD_OUT')], [base('h1', 2, 'HELD_OUT')], spec, run).verdict).toBe('INSUFFICIENT_EVIDENCE');
    expect(compare([base('h1', 2, 'HELD_OUT')], [base('h1', 3, 'HELD_OUT')], spec, run).verdict).toBe('PROMOTE_RECOMMENDED');
  });

  test('adaptive-leakage cap stops the fourth campaign on the same corpus', async () => {
    const dir = mkdtempSync(join('/tmp', 'eval-cap-'));
    const corpusDir = join(dir, 'corpora');
    mkdirSync(corpusDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(corpusDir, 'corpus-cap.json'), JSON.stringify({ corpusId: 'corpus-cap', revision: 1, createdAt: 'now', cases: [], trainManifestHash: 'a'.repeat(64), heldOutManifestHash: 'b'.repeat(64) }));
    writeFileSync(join(dir, 'budget.json'), JSON.stringify(budget));
    const emptySpec = { specHash: sha256Of({ hardGates: [], softWeights: {}, tolerance: 0 }), hardGates: [] as string[], softWeights: {} as Record<string, number>, tolerance: 0 };
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(emptySpec));
    const handler = createEvaluatorHandler({
      store: { listSessionIds: async () => [], load: async () => undefined },
      evaluatorDir: dir,
      featureSet: createStage7FeatureSet(true, true, false, true),
      baselineDigest: 'f'.repeat(64),
      now: () => new Date(Date.now() + Math.random()).toISOString(),
    });
    for (let index = 0; index < 3; index += 1) {
      const outcome = await handler('evaluate', ['--corpus', 'corpus-cap', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json')]);
      expect(outcome.ok).toBe(true);
    }
    const fourth = await handler('evaluate', ['--corpus', 'corpus-cap', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json')]);
    expect(fourth.ok).toBe(false);
    expect(fourth.text).toContain('ADAPTIVE_LEAKAGE_CAP');
    rmSync(dir, { recursive: true, force: true });
  });

  test('scoring spec tampering fails closed', () => {
    expect(() => loadScoringSpec({ ...spec, specHash: 'deadbeef' })).toThrow(/SCORING_SPEC_TAMPERED/);
    expect(loadScoringSpec(spec).specHash).toBe(spec.specHash);
  });
});

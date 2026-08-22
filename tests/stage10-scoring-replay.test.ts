import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createStage7FeatureSet } from '../src/stage7/feature-config.js';
import { createEvaluatorHandler } from '../src/evaluator/service.js';
import { candidateDigestFor, DETERMINISTIC_HARD_GATES, scoreCase, sha256Of, writeCandidateBundle } from '../src/evaluator/engine.js';
import { executeLiveReplay, replayIdFor } from '../src/evaluator/live-replay.js';
import type { EvalBudget, EvalCase, ExternalReplayApprovedCase, ScoringSpec } from '../src/evaluator/contracts.js';

const budget: EvalBudget = { maxCases: 10, maxReplaysPerCase: 1, maxProviderTier: 'MEDIUM', maxTokensPerCase: 100_000, maxTotalCostUsd: 5, maxWallClockMs: 3_600_000, maxConcurrency: 2 };

const SPEC: ScoringSpec = {
  specHash: sha256Of({ hardGates: ['expected-classification', 'secret-free'], softWeights: { gateCoverage: 1, summaryDepth: 0.5 }, tolerance: 0 }),
  hardGates: ['expected-classification', 'secret-free'],
  softWeights: { gateCoverage: 1, summaryDepth: 0.5 },
  tolerance: 0,
};

function evalFixture(caseId: string, overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    caseId,
    sourceSessionId: 's-1',
    disclosure: 'LOCAL_ONLY',
    originalRequest: `request ${caseId}`,
    observed: {
      requestClassification: 'QA',
      riskClassification: 'LOW',
      selectedWorkflow: 'qa.v2',
      requiredGates: ['RESULT_APPROVAL', 'DESTRUCTIVE_CONFIRM'],
      nodeSummaries: [{ nodeId: 'n1', summary: 'did the thing' }],
      humanOverrideSignals: [],
    },
    ...overrides,
  } as EvalCase;
}

function approvedFixture(caseId: string): ExternalReplayApprovedCase {
  const base = evalFixture(caseId);
  return {
    caseId: base.caseId,
    sourceSessionId: base.sourceSessionId,
    originalRequest: base.originalRequest,
    observed: base.observed,
    ...(base.expected === undefined ? {} : { expected: base.expected }),
    disclosure: 'EXTERNAL_REPLAY_APPROVED',
    approvedBy: 'operator',
    approvedAt: '2026-08-21T00:00:00.000Z',
  };
}

describe('Deterministic structural scoring', () => {
  test('expected-classification gate fires on mismatch and passes on match', () => {
    const pass = scoreCase(evalFixture('c-pass'), SPEC);
    expect(pass.hardGateFailures).toEqual([]);
    const fail = scoreCase(evalFixture('c-fail', { expected: { requestClassification: 'DEPLOY' } }), SPEC);
    expect(fail.hardGateFailures).toEqual(['expected-classification']);
  });

  test('secret-free gate scans expected.notes too', () => {
    const leaky = scoreCase(evalFixture('c-leak', { expected: { notes: 'api_key: AKIAIOSFODNN7EXAMPLE' } }), SPEC);
    expect(leaky.hardGateFailures).toContain('secret-free');
  });

  test('unknown gates or metrics fail closed instead of silently passing', () => {
    expect(() => scoreCase(evalFixture('c'), { ...SPEC, hardGates: [...DETERMINISTIC_HARD_GATES, 'vibes'] })).toThrow(/SCORING_SPEC_UNEVALUABLE.*vibes/);
    expect(() => scoreCase(evalFixture('c'), { ...SPEC, softWeights: { astral: 1 } })).toThrow(/SCORING_SPEC_UNEVALUABLE.*astral/);
  });
});

describe('Trusted candidate evaluation path', () => {
  function setup(executor?: (request: { evalRunId: string; attemptId: string; evalCase: EvalCase }) => Promise<EvalCase>) {
    const dir = mkdtempSync(join('/tmp', 'eval-trusted-'));
    const drafts = join(dir, 'drafts');
    mkdirSync(drafts, { recursive: true, mode: 0o700 });
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const draft = { ...evalFixture(`case-${index}`), curated: true, harvestedAt: '2026-08-22T00:00:00.000Z' };
      writeFileSync(join(drafts, `case-${index}.json`), JSON.stringify(draft), { mode: 0o600 });
    }
    writeFileSync(join(dir, 'budget.json'), JSON.stringify(budget));
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(SPEC));
    const handler = createEvaluatorHandler({
      store: { listSessionIds: async () => [], load: async () => undefined },
      evaluatorDir: dir,
      featureSet: createStage7FeatureSet(true, true, false, true),
      baselineDigest: 'f'.repeat(64),
      ...(executor === undefined ? {} : { executeCandidateCase: executor }),
      now: () => new Date(Date.now() + Math.random()).toISOString(),
    });
    return { dir, handler };
  }

  function writeBundle(dir: string, candidateId: string): string {
    const bundleDir = join(dir, `bundle-${candidateId}`);
    writeCandidateBundle(bundleDir, { candidateId, baseVersion: 'stage9-sealed', baseDigest: 'f'.repeat(64), components: [{ component: 'routingTable', status: 'CHANGED' }], createdAt: '2026-08-22T00:00:00.000Z' }, { 'impl.js': `// candidate ${candidateId}` });
    return bundleDir;
  }

  /** Candidate "execution": richer observed evidence (deeper summaries) —
   * the executor is the trusted boundary; the scorer does the rest. */
  const richerExecutor = async ({ evalCase }: { evalRunId: string; attemptId: string; evalCase: EvalCase }): Promise<EvalCase> => ({
    ...evalCase,
    observed: { ...evalCase.observed, nodeSummaries: [1, 2, 3, 4].map((n) => ({ nodeId: `c${n}`, summary: `candidate step ${n}` })) },
  });

  test('1+2+7+8: real candidate execution → same scorer → bound candidate score', async () => {
    const { dir, handler } = setup(richerExecutor);
    expect((await handler('corpus', ['--id', 'trust-corpus', '--held-out', '3'])).ok).toBe(true);
    const bundleA = writeBundle(dir, 'cand-a');
    const evaluateOut = await handler('evaluate', ['--corpus', 'trust-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', bundleA]);
    expect(evaluateOut.ok).toBe(true);
    expect(evaluateOut.text).toContain('executed via trusted scorer');
    const runId = /evaluate (run-\d+):/.exec(evaluateOut.text)?.[1] ?? '';
    const baseline = JSON.parse(readFileSync(join(dir, 'runs', `${runId}-scores.json`), 'utf8')) as { kind: string; specHash: string; scorerVersion: string; scores: { caseId: string; partition: string; softScores: Record<string, number> }[] };
    const candidate = JSON.parse(readFileSync(join(dir, 'runs', `${runId}-candidate-scores.json`), 'utf8')) as { kind: string; candidateId: string; candidateDigest: string; attemptId: string; specHash: string; scorerVersion: string; corpusRevision?: number; scores: { caseId: string; partition: string; softScores: Record<string, number> }[] };
    expect(baseline.kind).toBe('BASELINE');
    expect(candidate.kind).toBe('CANDIDATE');
    // (7) same scoring specification on both sides.
    expect(candidate.specHash).toBe(baseline.specHash);
    expect(candidate.specHash).toBe(SPEC.specHash);
    expect(candidate.scorerVersion).toBe('deterministic-structural-v1');
    // (2) score binds the exact verified bundle digest.
    expect(candidate.candidateId).toBe('cand-a');
    expect(candidate.candidateDigest).toBe(candidateDigestFor(bundleA));
    // (8) runner MAY consume held-out: candidate envelope covers held-out cases…
    expect(candidate.scores.filter((entry) => entry.partition === 'HELD_OUT')).toHaveLength(3);
    // …and its soft evidence actually differs from baseline where execution differed.
    const heldBaseline = baseline.scores.find((entry) => entry.partition === 'HELD_OUT')!;
    const heldCandidate = candidate.scores.find((entry) => entry.partition === 'HELD_OUT')!;
    expect(heldCandidate.softScores.summaryDepth).toBeGreaterThan(heldBaseline.softScores.summaryDepth ?? 0);
    const compareOut = await handler('compare', [runId, '--spec', join(dir, 'spec.json'), '--candidate-bundle', bundleA]);
    expect(compareOut.ok).toBe(true);
    expect(compareOut.text).toContain('verdict=PROMOTE_RECOMMENDED');
    expect(compareOut.text).toContain('cand-a@');
    rmSync(dir, { recursive: true, force: true });
  });

  test('3: candidate-A score rejected when compared against candidate-B bundle', async () => {
    const { dir, handler } = setup(richerExecutor);
    await handler('corpus', ['--id', 'ab-corpus', '--held-out', '3']);
    const bundleA = writeBundle(dir, 'cand-a');
    const bundleB = writeBundle(dir, 'cand-b');
    const evaluateOut = await handler('evaluate', ['--corpus', 'ab-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', bundleA]);
    const runId = /evaluate (run-\d+):/.exec(evaluateOut.text)?.[1] ?? '';
    const compareOut = await handler('compare', [runId, '--spec', join(dir, 'spec.json'), '--candidate-bundle', bundleB]);
    expect(compareOut.ok).toBe(false);
    expect(compareOut.text).toContain('CANDIDATE_MISMATCH');
    rmSync(dir, { recursive: true, force: true });
  });

  test('4: caller-authored score files are rejected from every promotion-capable path', async () => {
    const { dir, handler } = setup(richerExecutor);
    await handler('corpus', ['--id', 'legacy-corpus', '--held-out', '3']);
    const evaluateOut = await handler('evaluate', ['--corpus', 'legacy-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json')]);
    const runId = /evaluate (run-\d+):/.exec(evaluateOut.text)?.[1] ?? '';
    const forged = join(dir, 'forged-candidate.json');
    writeFileSync(forged, JSON.stringify({ kind: 'CANDIDATE', evalRunId: runId, corpusRevision: 1, specHash: SPEC.specHash, scores: [{ caseId: 'case-0', partition: 'HELD_OUT', hardGateFailures: [], softScores: { summaryDepth: 1, gateCoverage: 1 } }] }));
    const legacy = await handler('compare', [runId, '--baseline-scores', join(dir, 'runs', `${runId}-scores.json`), '--candidate-scores', forged, '--spec', join(dir, 'spec.json')]);
    expect(legacy.ok).toBe(false);
    expect(legacy.errorCode).toBe('INVALID_COMMAND');
    expect(legacy.text).toContain('not accepted');
    // And without a candidate envelope at all, compare cannot fabricate a verdict either.
    const missing = await handler('compare', [runId, '--spec', join(dir, 'spec.json')]);
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain('TRUSTED_ENVELOPE_MISSING');
    rmSync(dir, { recursive: true, force: true });
  });

  test('5+6: tampered candidate scores and changed scoring policy are rejected', async () => {
    const { dir, handler } = setup(richerExecutor);
    await handler('corpus', ['--id', 'tamper2-corpus', '--held-out', '3']);
    const bundleA = writeBundle(dir, 'cand-a');
    const evaluateOut = await handler('evaluate', ['--corpus', 'tamper2-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', bundleA]);
    const runId = /evaluate (run-\d+):/.exec(evaluateOut.text)?.[1] ?? '';
    // (5) tamper: repoint one candidate score at a non-corpus case id.
    const candidatePath = join(dir, 'runs', `${runId}-candidate-scores.json`);
    const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as { scores: { caseId: string }[] };
    candidate.scores[0]!.caseId = 'ghost-case';
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const tampered = await handler('compare', [runId, '--spec', join(dir, 'spec.json'), '--candidate-bundle', bundleA]);
    expect(tampered.ok).toBe(false);
    expect(tampered.text).toContain('not a pinned corpus case');
    // (6) changed scoring policy invalidates the stale score: rebuild clean envelope, compare under a different spec.
    const fresh = { ...setup(richerExecutor) };
    await fresh.handler('corpus', ['--id', 'policy-corpus', '--held-out', '3']);
    const freshOut = await fresh.handler('evaluate', ['--corpus', 'policy-corpus', '--budget', join(fresh.dir, 'budget.json'), '--spec', join(fresh.dir, 'spec.json'), '--candidate', writeBundle(fresh.dir, 'cand-a')]);
    const freshRunId = /evaluate (run-\d+):/.exec(freshOut.text)?.[1] ?? '';
    const spec2 = { ...SPEC, specHash: sha256Of({ hardGates: SPEC.hardGates, softWeights: { gateCoverage: 2, summaryDepth: 0.5 }, tolerance: 0 }), softWeights: { gateCoverage: 2, summaryDepth: 0.5 } };
    writeFileSync(join(fresh.dir, 'spec2.json'), JSON.stringify(spec2));
    const stale = await fresh.handler('compare', [freshRunId, '--spec', join(fresh.dir, 'spec2.json'), '--candidate-bundle', join(fresh.dir, 'bundle-cand-a')]);
    expect(stale.ok).toBe(false);
    expect(stale.text).toMatch(/scoring policy drift|mismatch/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(fresh.dir, { recursive: true, force: true });
  });

  test('10: candidate execution consumes the shared EvalBudget accounting', async () => {
    const { dir, handler } = setup(richerExecutor);
    // Sub-cap budget: candidate executions share the SAME maxCases slice.
    const capped: EvalBudget = { ...budget, maxCases: 4 };
    writeFileSync(join(dir, 'budget.json'), JSON.stringify(capped));
    await handler('corpus', ['--id', 'budget-corpus', '--held-out', '3']);
    const bundleA = writeBundle(dir, 'cand-a');
    const out = await handler('evaluate', ['--corpus', 'budget-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', bundleA]);
    expect(out.ok).toBe(true);
    const runId = /evaluate (run-\d+):/.exec(out.text)?.[1] ?? '';
    const candidate = JSON.parse(readFileSync(join(dir, 'runs', `${runId}-candidate-scores.json`), 'utf8')) as { attemptId: string; budgetHash: string; scores: unknown[] };
    expect(candidate.scores).toHaveLength(4);
    expect(candidate.attemptId).toContain(runId);
    expect(typeof candidate.budgetHash).toBe('string');
    // The whole campaign (baseline + candidate sides) consumed ONE leakage-cap slot.
    const again = await handler('evaluate', ['--corpus', 'budget-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', bundleA]);
    expect(again.ok).toBe(true);
    const third = await handler('evaluate', ['--corpus', 'budget-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', bundleA]);
    expect(third.ok).toBe(true);
    const fourth = await handler('evaluate', ['--corpus', 'budget-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', bundleA]);
    expect(fourth.ok).toBe(false);
    expect(fourth.text).toContain('ADAPTIVE_LEAKAGE_CAP');
    rmSync(dir, { recursive: true, force: true });
  });

  test('11: hard-gate failure overrides numeric candidate improvement', async () => {
    const breakingExecutor = async ({ evalCase }: { evalRunId: string; attemptId: string; evalCase: EvalCase }): Promise<EvalCase> => ({
      ...evalCase,
      expected: { requestClassification: 'DEPLOY' },
      observed: { ...evalCase.observed, requestClassification: 'QA', nodeSummaries: [1, 2, 3, 4].map((n) => ({ nodeId: `c${n}`, summary: `candidate step ${n}` })) },
    });
    const { dir, handler } = setup(breakingExecutor);
    await handler('corpus', ['--id', 'gate-corpus', '--held-out', '3']);
    const bundleA = writeBundle(dir, 'cand-a');
    const evaluateOut = await handler('evaluate', ['--corpus', 'gate-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', bundleA]);
    const runId = /evaluate (run-\d+):/.exec(evaluateOut.text)?.[1] ?? '';
    const compareOut = await handler('compare', [runId, '--spec', join(dir, 'spec.json'), '--candidate-bundle', bundleA]);
    expect(compareOut.ok).toBe(true);
    expect(compareOut.text).toContain('verdict=REJECT');
    expect(compareOut.text).toMatch(/hardFailures=[1-9]/);
    rmSync(dir, { recursive: true, force: true });
  });

  test('improve candidate verify <dir> reaches the verifier through the real command string', async () => {
    const { dir, handler } = setup(undefined);
    const bundleA = writeBundle(dir, 'cand-verify');
    // Exact operator CLI shape: IMPROVE parse yields args=['verify', <dir>].
    const out = await handler('candidate', ['verify', bundleA]);
    expect(out.ok).toBe(true);
    expect(out.text).toContain('cand-verify verified');
    const missing = await handler('candidate', ['verify']);
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe('INVALID_COMMAND');
    rmSync(dir, { recursive: true, force: true });
  });

  test('evaluate without an injected executor refuses candidate scoring fail-closed', async () => {
    const { dir, handler } = setup(undefined);
    await handler('corpus', ['--id', 'noexec-corpus', '--held-out', '3']);
    const out = await handler('evaluate', ['--corpus', 'noexec-corpus', '--budget', join(dir, 'budget.json'), '--spec', join(dir, 'spec.json'), '--candidate', writeBundle(dir, 'cand-a')]);
    expect(out.ok).toBe(false);
    expect(out.text).toContain('injected trusted executor');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Live-replay seam boundaries', () => {
  const depsBase = {
    featureSetStage10Enabled: true,
    budget,
    providerAllowed: () => true,
    dispatch: async () => ({
      modelProvider: 'pinned-provider', modelId: 'm1', tier: 'LOW' as const,
      tokens: 10, costUsd: 0.01, durationMs: 5, status: 'SUCCEEDED' as const,
      rawSummary: 'ok\npassword: hunter2\nend',
    }),
    now: (() => {
      let tick = 0;
      return () => new Date(Date.parse('2026-08-21T00:00:00.000Z') + (tick += 1000)).toISOString();
    })(),
  };

  test('LOCAL_ONLY and REDACTED_INTERNAL cases never reach dispatch', async () => {
    let dispatched = 0;
    const deps = { ...depsBase, dispatch: async () => { dispatched += 1; return depsBase.dispatch(); } };
    // Deliberate forged-disclosure negatives: the seam must catch both at runtime.
    const local = await executeLiveReplay(deps, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: evalFixture('lc') as unknown as ExternalReplayApprovedCase, providerTier: 'LOW' });
    expect(local.kind).toBe('BOUNDED_BLOCKED');
    if (local.kind === 'BOUNDED_BLOCKED') expect(local.reasonCode).toBe('DISCLOSURE_NOT_APPROVED');
    const redacted = await executeLiveReplay(deps, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: { ...evalFixture('rc'), disclosure: 'REDACTED_INTERNAL' } as unknown as ExternalReplayApprovedCase, providerTier: 'LOW' });
    expect(redacted.kind).toBe('BOUNDED_BLOCKED');
    if (redacted.kind === 'BOUNDED_BLOCKED') expect(redacted.detail).toContain('REDACTED_INTERNAL');
    expect(dispatched).toBe(0);
  });

  test('dispatch-throwing providers surface scrubbed blocked details', async () => {
    const deps = { ...depsBase, dispatch: async () => { throw new Error('provider exploded\npassword: hunter2'); } };
    const outcome = await executeLiveReplay(deps, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: approvedFixture('xc'), providerTier: 'LOW' });
    expect(outcome.kind).toBe('BOUNDED_BLOCKED');
    if (outcome.kind === 'BOUNDED_BLOCKED') expect(outcome.detail).not.toContain('hunter2');
  });
  test('unauthorized provider is blocked before dispatch', async () => {
    let dispatched = 0;
    const deps = { ...depsBase, providerAllowed: () => false, dispatch: async () => { dispatched += 1; return depsBase.dispatch(); } };
    const outcome = await executeLiveReplay(deps, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: approvedFixture('ac'), providerTier: 'LOW' });
    expect(outcome.kind).toBe('BOUNDED_BLOCKED');
    if (outcome.kind === 'BOUNDED_BLOCKED') expect(outcome.reasonCode).toBe('PROVIDER_NOT_ALLOWED');
    expect(dispatched).toBe(0);
  });

  test('dispatch-time rescan quarantines secrets hidden in expected.notes', async () => {
    let dispatched = 0;
    const deps = { ...depsBase, dispatch: async () => { dispatched += 1; return depsBase.dispatch(); } };
    const inner = approvedFixture('sc');
    const leaky: ExternalReplayApprovedCase = { ...inner, expected: { notes: 'api_key: AKIAIOSFODNN7EXAMPLE' } };
    const outcome = await executeLiveReplay(deps, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: leaky, providerTier: 'LOW' });
    expect(outcome.kind).toBe('BOUNDED_BLOCKED');
    if (outcome.kind === 'BOUNDED_BLOCKED') expect(outcome.detail).toContain('quarantined');
    expect(dispatched).toBe(0);
  });

  test('duplicate replay ids are rejected', async () => {
    const replayId = replayIdFor('r1', 'dc', 'a'.repeat(64));
    const deps = { ...depsBase, seenReplayIds: new Set([replayId]) };
    const outcome = await executeLiveReplay(deps, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: approvedFixture('dc'), providerTier: 'LOW' });
    expect(outcome).toEqual({ kind: 'BOUNDED_BLOCKED', reasonCode: 'DUPLICATE_RESULT', detail: expect.anything() });
  });

  test('stale completions are rejected', async () => {
    let called = false;
    const deps = {
      ...depsBase,
      now: () => (called ? '2026-08-21T00:00:00.000Z' : '2026-08-21T00:00:05.000Z'),
      dispatch: async () => { called = true; return depsBase.dispatch(); },
    };
    const outcome = await executeLiveReplay(deps, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: approvedFixture('tc'), providerTier: 'LOW' });
    expect(outcome).toEqual({ kind: 'BOUNDED_BLOCKED', reasonCode: 'STALE_RESULT', detail: expect.anything() });
  });

  test('successful replay yields scrubbed bounded evidence', async () => {
    const outcome = await executeLiveReplay(depsBase, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: approvedFixture('ec'), providerTier: 'LOW' });
    if (outcome.kind !== 'EVIDENCE') throw new Error(`expected EVIDENCE, got ${JSON.stringify(outcome)}`);
    expect(outcome.evidence.replayId).toBe(replayIdFor('r1', 'ec', 'a'.repeat(64)));
    expect(outcome.evidence.summary).not.toContain('hunter2');
    expect(outcome.evidence.summary).toContain('[redacted credential-bearing line]');
  });

  test('over-budget results become BUDGET_TOTAL_COST blocks', async () => {
    const deps = { ...depsBase, dispatch: async () => ({ ...await depsBase.dispatch(), tokens: budget.maxTokensPerCase + 1 }) };
    const outcome = await executeLiveReplay(deps, { evalRunId: 'r1', candidateDigest: 'a'.repeat(64), case: approvedFixture('bc'), providerTier: 'LOW' });
    expect(outcome).toEqual({ kind: 'BOUNDED_BLOCKED', reasonCode: 'BUDGET_TOTAL_COST', detail: expect.anything() });
  });
});

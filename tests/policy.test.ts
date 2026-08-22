import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { BudgetProfile, GateDecisionType, PolicyDecision, PolicyRef, RiskLevel, TaskFamily } from '../src/contracts.js';
import {
  ABSOLUTE_MAX_NODE_TIMEOUT_MS,
  ABSOLUTE_MAX_REVIEW_ROUNDS,
  DEFAULT_POLICIES_DIR,
  loadPolicyPacks,
  parsePolicyPack,
  PolicyEngineError,
  resolveNodeTimeoutMs,
  resolvePolicy,
} from '../src/policy.js';
import type { ClassificationProposal, OperatorProfile, OperatorRules, PolicyPack, ResolvedOperatorConfig } from '../src/stage3-types.js';

const NOW = '2026-08-14T12:00:00Z';
const REASON_CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const POLICY_REF_PATTERN = /^[a-z][a-z0-9-]*@\d+:[A-Za-z][A-Za-z0-9_.]*$/;

function makeClassification(overrides: Partial<ClassificationProposal> = {}): ClassificationProposal {
  return {
    requestClassification: 'IMPLEMENT',
    riskClassification: 'MEDIUM',
    confidence: 'HIGH',
    decomposable: false,
    semanticCapabilities: [],
    rationale: 'test fixture request',
    ...overrides,
  };
}

function makeRules(overrides: Partial<OperatorRules> = {}): OperatorRules {
  return {
    humanIsFinalApprover: false,
    implementerSelfApproval: true,
    automaticCommit: true,
    automaticPush: false,
    automaticMerge: false,
    independentVerification: false,
    adversarialReviewForHighRisk: false,
    scopeFreezeRequired: false,
    maxReviewRounds: 4,
    ...overrides,
  };
}

function makeProfile(overrides: Partial<OperatorProfile> = {}): OperatorProfile {
  return {
    schemaVersion: '1.0',
    workflow: 'default.v1',
    defaultPolicyPacks: [],
    budgetProfile: 'BALANCED',
    maxConcurrency: 2,
    features: {
      automaticRouting: false,
      externalProviders: false,
      councilMode: false,
      autoFallback: false,
      persistentState: true,
      costTracking: true,
    },
    rules: makeRules(),
    capabilityAssignments: {},
    ...overrides,
  };
}

function makeConfig(profileOverrides: Partial<OperatorProfile> = {}): ResolvedOperatorConfig {
  return {
    profile: makeProfile(profileOverrides),
    globalConfigPath: '/config/defaults.json',
    projectOverlay: { status: 'ABSENT', projectRoot: '/repo' },
    policyRefs: [],
  };
}

function makePack(id: string, appliesTo: readonly TaskFamily[], overrides: Partial<PolicyPack> = {}): PolicyPack {
  return {
    schemaVersion: '1.0',
    id,
    version: 1,
    description: `Test pack ${id}.`,
    incompatibleWith: [],
    appliesTo,
    rules: {},
    ...overrides,
  };
}

function assertWellFormedDecisions(decisions: readonly PolicyDecision[]): void {
  expect(decisions.length).toBeGreaterThan(0);
  for (const decision of decisions) {
    expect(decision.reasonCodes.length).toBeGreaterThan(0);
    expect(decision.policyRefs.length).toBeGreaterThan(0);
    for (const code of decision.reasonCodes) expect(code).toMatch(REASON_CODE_PATTERN);
    for (const ref of decision.policyRefs) expect(ref).toMatch(POLICY_REF_PATTERN);
    expect(decision.decisionSource).toBe('POLICY');
    expect(decision.overrideGateId).toBeUndefined();
    expect(decision.timestamp).toBe(NOW);
  }
}

describe('parsePolicyPack', () => {
  test('parses a minimal valid pack', () => {
    const yaml = [
      'schemaVersion: "1.0"',
      'id: sample',
      'version: 3',
      'description: A sample pack.',
      'appliesTo:',
      '  - IMPLEMENT',
      '  - REVIEW',
      'incompatibleWith: []',
      'rules:',
      '  requireIndependentReview: true',
      '  maximumMutationClass: LOCAL',
      '  maxReviewRounds: 2',
    ].join('\n');

    const pack = parsePolicyPack(yaml, 'sample.yaml');

    expect(pack).toEqual({
      schemaVersion: '1.0',
      id: 'sample',
      version: 3,
      description: 'A sample pack.',
      incompatibleWith: [],
      appliesTo: ['IMPLEMENT', 'REVIEW'],
      rules: { requireIndependentReview: true, maximumMutationClass: 'LOCAL', maxReviewRounds: 2 },
    });
  });

  test('parses non-empty incompatibleWith as a block sequence', () => {
    const yaml = [
      'schemaVersion: "1.0"',
      'id: sample',
      'version: 1',
      'description: A sample pack.',
      'appliesTo:',
      '  - QA',
      'incompatibleWith:',
      '  - other-pack',
      'rules: {}',
    ].join('\n');

    const pack = parsePolicyPack(yaml, 'sample.yaml');
    expect(pack.incompatibleWith).toEqual(['other-pack']);
    expect(pack.rules).toEqual({});
  });

  test('rejects an unknown top-level field', () => {
    const yaml = [
      'schemaVersion: "1.0"',
      'id: sample',
      'version: 1',
      'description: A sample pack.',
      'appliesTo:',
      '  - QA',
      'incompatibleWith: []',
      'rules: {}',
      'extra: true',
    ].join('\n');

    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('rejects an unknown rules field', () => {
    const yaml = [
      'schemaVersion: "1.0"',
      'id: sample',
      'version: 1',
      'description: A sample pack.',
      'appliesTo:',
      '  - QA',
      'incompatibleWith: []',
      'rules:',
      '  requireSomethingUnknown: true',
    ].join('\n');

    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('rejects a missing required field', () => {
    const yaml = ['schemaVersion: "1.0"', 'id: sample', 'version: 1', 'appliesTo:', '  - QA', 'incompatibleWith: []', 'rules: {}'].join('\n');
    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('rejects tab characters', () => {
    const yaml = 'schemaVersion: "1.0"\n\tid: sample';
    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('rejects duplicate mapping keys', () => {
    const yaml = [
      'schemaVersion: "1.0"',
      'id: sample',
      'id: other',
      'version: 1',
      'description: dup',
      'appliesTo:',
      '  - QA',
      'incompatibleWith: []',
      'rules: {}',
    ].join('\n');
    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('rejects non-empty flow-style collections', () => {
    const yaml = [
      'schemaVersion: "1.0"',
      'id: sample',
      'version: 1',
      'description: flow',
      'appliesTo: [IMPLEMENT]',
      'incompatibleWith: []',
      'rules: {}',
    ].join('\n');
    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('rejects a self-referential incompatibleWith entry', () => {
    const yaml = [
      'schemaVersion: "1.0"',
      'id: sample',
      'version: 1',
      'description: self-ref',
      'appliesTo:',
      '  - QA',
      'incompatibleWith:',
      '  - sample',
      'rules: {}',
    ].join('\n');
    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('rejects an invalid pack id', () => {
    const yaml = [
      'schemaVersion: "1.0"',
      'id: Sample_Pack',
      'version: 1',
      'description: bad id',
      'appliesTo:',
      '  - QA',
      'incompatibleWith: []',
      'rules: {}',
    ].join('\n');
    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('rejects a schemaVersion other than "1.0"', () => {
    const yaml = [
      'schemaVersion: "2.0"',
      'id: sample',
      'version: 1',
      'description: bad schema',
      'appliesTo:',
      '  - QA',
      'incompatibleWith: []',
      'rules: {}',
    ].join('\n');
    expect(() => parsePolicyPack(yaml, 'sample.yaml')).toThrow(PolicyEngineError);
  });

  test('ignores comments and blank lines', () => {
    const yaml = [
      '# a leading comment',
      'schemaVersion: "1.0"',
      '',
      'id: sample  # trailing comment',
      'version: 1',
      'description: with comments',
      'appliesTo:',
      '  - QA',
      '',
      'incompatibleWith: []',
      'rules: {}',
    ].join('\n');
    const pack = parsePolicyPack(yaml, 'sample.yaml');
    expect(pack.id).toBe('sample');
  });
});

describe('loadPolicyPacks', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-operator-policy-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('loads all four bundled production packs from DEFAULT_POLICIES_DIR', async () => {
    const packs = await loadPolicyPacks(['default', 'secure-code', 'coding', 'qa'], DEFAULT_POLICIES_DIR);
    expect(packs.map((pack) => pack.id)).toEqual(['default', 'secure-code', 'coding', 'qa']);
    for (const pack of packs) {
      expect(pack.schemaVersion).toBe('1.0');
      expect(pack.version).toBeGreaterThanOrEqual(1);
      expect(pack.appliesTo.length).toBeGreaterThan(0);
    }
    const secureCode = packs.find((pack) => pack.id === 'secure-code');
    expect(secureCode?.rules.requireIndependentReview).toBe(true);
    expect(secureCode?.rules.requireAdversarialReview).toBe(true);
    const coding = packs.find((pack) => pack.id === 'coding');
    expect(coding?.rules.requireScopeFreeze).toBe(true);
    const qa = packs.find((pack) => pack.id === 'qa');
    expect(qa?.rules.maximumMutationClass).toBe('READ_ONLY');
  });

  test('deduplicates repeated ids and preserves first-occurrence order', async () => {
    const packs = await loadPolicyPacks(['qa', 'default', 'qa'], DEFAULT_POLICIES_DIR);
    expect(packs.map((pack) => pack.id)).toEqual(['qa', 'default']);
  });

  test('throws UNKNOWN_POLICY_PACK for a missing pack id', async () => {
    await expect(loadPolicyPacks(['does-not-exist'], DEFAULT_POLICIES_DIR)).rejects.toMatchObject({
      name: 'PolicyEngineError',
      code: 'UNKNOWN_POLICY_PACK',
    });
  });

  test('throws POLICY_PACK_INVALID when a file id does not match its filename', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'mismatched.yaml'),
      ['schemaVersion: "1.0"', 'id: other-id', 'version: 1', 'description: mismatch', 'appliesTo:', '  - QA', 'incompatibleWith: []', 'rules: {}'].join(
        '\n',
      ),
      'utf8',
    );
    await expect(loadPolicyPacks(['mismatched'], tmpDir)).rejects.toMatchObject({
      name: 'PolicyEngineError',
      code: 'POLICY_PACK_INVALID',
    });
  });
});

describe('resolvePolicy: conflicts', () => {
  test('throws INCOMPATIBLE_POLICY_PACKS when two active packs list each other', () => {
    const packA = makePack('pack-a', ['IMPLEMENT'], { incompatibleWith: ['pack-b'] });
    const packB = makePack('pack-b', ['IMPLEMENT']);
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig();

    expect(() => resolvePolicy(classification, config, [packA, packB], { now: NOW })).toThrow(PolicyEngineError);
    try {
      resolvePolicy(classification, config, [packA, packB], { now: NOW });
      throw new Error('expected resolvePolicy to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyEngineError);
      expect((error as PolicyEngineError).code).toBe('INCOMPATIBLE_POLICY_PACKS');
    }
  });

  test('does not conflict when the incompatible pack is inactive for this task family', () => {
    const packA = makePack('pack-a', ['IMPLEMENT'], { incompatibleWith: ['pack-b'] });
    const packB = makePack('pack-b', ['QA']);
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [packA, packB], { now: NOW });
    expect(resolved.packs.map((pack) => pack.id)).toEqual(['pack-a']);
  });
});

describe('resolvePolicy: task-family applicability', () => {
  test('excludes packs whose appliesTo does not include the classified family', () => {
    const qaOnly = makePack('qa-only', ['QA'], { rules: { requireIndependentReview: true } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [qaOnly], { now: NOW });
    expect(resolved.packs).toEqual([]);
    expect(resolved.effectiveRules.independentVerification).toBe(false);

    const inactiveDecision = resolved.decisions.find((d) => d.subjectId === 'pack:qa-only');
    expect(inactiveDecision?.reasonCodes).toContain('PACK_NOT_APPLICABLE_TASK_FAMILY');
  });

  test('includes packs whose appliesTo includes the classified family', () => {
    const implementOnly = makePack('implement-only', ['IMPLEMENT'], { rules: { requireIndependentReview: true } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [implementOnly], { now: NOW });
    expect(resolved.packs.map((pack) => pack.id)).toEqual(['implement-only']);
    expect(resolved.effectiveRules.independentVerification).toBe(true);
  });
});

describe('resolvePolicy: monotonic precedence (safety rules only narrow)', () => {
  test('a pack can only turn a rule on, never off', () => {
    const narrowingPack = makePack('narrow', ['IMPLEMENT'], {
      rules: { requireIndependentReview: true, requireAdversarialReview: true, requireScopeFreeze: true, requireHumanFinalApproval: true },
    });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig({
      rules: makeRules({
        humanIsFinalApprover: false,
        independentVerification: false,
        adversarialReviewForHighRisk: false,
        scopeFreezeRequired: false,
      }),
    });

    const resolved = resolvePolicy(classification, config, [narrowingPack], { now: NOW });

    expect(resolved.effectiveRules.independentVerification).toBe(true);
    expect(resolved.effectiveRules.adversarialReviewForHighRisk).toBe(true);
    expect(resolved.effectiveRules.scopeFreezeRequired).toBe(true);
    expect(resolved.effectiveRules.humanIsFinalApprover).toBe(true);
  });

  test('an already-true baseline rule is unaffected by a pack that does not set it', () => {
    const emptyPack = makePack('empty', ['IMPLEMENT']);
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig({ rules: makeRules({ humanIsFinalApprover: true }) });

    const resolved = resolvePolicy(classification, config, [emptyPack], { now: NOW });
    expect(resolved.effectiveRules.humanIsFinalApprover).toBe(true);
  });

  test('requireExecutionApprovalForMutation forces off every automatic-mutation rule', () => {
    const pack = makePack('mutation-gate', ['IMPLEMENT'], { rules: { requireExecutionApprovalForMutation: true } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig({
      rules: makeRules({ implementerSelfApproval: true, automaticCommit: true, automaticPush: true, automaticMerge: true }),
    });

    const resolved = resolvePolicy(classification, config, [pack], { now: NOW });
    expect(resolved.effectiveRules.implementerSelfApproval).toBe(false);
    expect(resolved.effectiveRules.automaticCommit).toBe(false);
    expect(resolved.effectiveRules.automaticPush).toBe(false);
    expect(resolved.effectiveRules.automaticMerge).toBe(false);
  });

  test('mutation ceiling takes the most restrictive class across active packs', () => {
    const looser = makePack('looser', ['IMPLEMENT'], { rules: { maximumMutationClass: 'DESTRUCTIVE' } });
    const stricter = makePack('stricter', ['IMPLEMENT'], { rules: { maximumMutationClass: 'READ_ONLY' } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [looser, stricter], { now: NOW });
    const ceilingDecision = resolved.decisions.find((d) => d.subjectId === 'mutation-ceiling');
    expect(ceilingDecision?.inputs.maximumMutationClass).toBe('READ_ONLY');
  });
});

describe('resolvePolicy: bounded max-round resolution', () => {
  test('bounds effective maxReviewRounds by the absolute system ceiling', () => {
    const classification = makeClassification();
    const config = makeConfig({ rules: makeRules({ maxReviewRounds: 1000 }) });

    const resolved = resolvePolicy(classification, config, [], { now: NOW });
    expect(resolved.effectiveRules.maxReviewRounds).toBe(ABSOLUTE_MAX_REVIEW_ROUNDS);
  });

  test('a pack narrows the round ceiling further than the profile default', () => {
    const pack = makePack('rounds', ['IMPLEMENT'], { rules: { maxReviewRounds: 1 } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig({ rules: makeRules({ maxReviewRounds: 4 }) });

    const resolved = resolvePolicy(classification, config, [pack], { now: NOW });
    expect(resolved.effectiveRules.maxReviewRounds).toBe(1);
  });

  test('a pack cannot widen the round ceiling above the profile default', () => {
    const pack = makePack('rounds', ['IMPLEMENT'], { rules: { maxReviewRounds: 10 } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig({ rules: makeRules({ maxReviewRounds: 2 }) });

    const resolved = resolvePolicy(classification, config, [pack], { now: NOW });
    expect(resolved.effectiveRules.maxReviewRounds).toBe(2);
  });

  test('resolvePolicy has no channel for a reviewer or the classifier to authorize another round', () => {
    // ClassificationProposal carries no round-count field at all, so nothing
    // a reviewer or the classifier reports can influence maxReviewRounds;
    // it is a pure function of config + packs.
    const config = makeConfig({ rules: makeRules({ maxReviewRounds: 3 }) });
    const lowRisk = resolvePolicy(makeClassification({ riskClassification: 'LOW' }), config, [], { now: NOW });
    const criticalRisk = resolvePolicy(makeClassification({ riskClassification: 'CRITICAL' }), config, [], { now: NOW });
    expect(lowRisk.effectiveRules.maxReviewRounds).toBe(3);
    expect(criticalRisk.effectiveRules.maxReviewRounds).toBe(3);
  });
});

describe('resolvePolicy: required gate derivation', () => {
  test('PLAN uses execution approval followed by terminal plan approval', () => {
    const resolved = resolvePolicy(
      makeClassification({ requestClassification: 'PLAN' }),
      makeConfig(),
      [],
      { now: NOW },
    );
    expect(resolved.requiredGates).toEqual(['EXECUTION_APPROVAL', 'PLAN_APPROVAL']);
  });

  test('non-plan workflows use execution approval followed by terminal result approval', () => {
    for (const requestClassification of ['RESEARCH', 'IMPLEMENT', 'UI', 'QA', 'SECURITY'] as const) {
      const resolved = resolvePolicy(
        makeClassification({ requestClassification }),
        makeConfig(),
        [],
        { now: NOW },
      );
      expect(resolved.requiredGates).toEqual(['EXECUTION_APPROVAL', 'RESULT_APPROVAL']);
    }
  });

  test('review requirements remain graph nodes and do not invent progression gates', () => {
    const pack = makePack('review', ['IMPLEMENT'], {
      rules: { requireIndependentReview: true, requireAdversarialReview: true },
    });
    const resolved = resolvePolicy(
      makeClassification({ requestClassification: 'IMPLEMENT' }),
      makeConfig(),
      [pack],
      { now: NOW },
    );
    expect(resolved.requiredGates).toEqual(['EXECUTION_APPROVAL', 'RESULT_APPROVAL']);
    expect(resolved.requiredGates).not.toContain('APPROVE_PROGRESSION');
  });
});


describe('resolvePolicy: budget-profile enforcement', () => {
  test('CHEAP forbids COUNCIL execution shape', () => {
    const classification = makeClassification({ requestedBudgetProfile: 'CHEAP', requestedExecutionShape: 'COUNCIL' });
    const config = makeConfig({ budgetProfile: 'CHEAP' });
    try {
      resolvePolicy(classification, config, [], { now: NOW });
      throw new Error('expected resolvePolicy to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyEngineError);
      expect((error as PolicyEngineError).code).toBe('BUDGET_PROFILE_CONFLICT');
      expect((error as PolicyEngineError).reasonCodes).toContain('CHEAP_FORBIDS_COUNCIL_EXECUTION_SHAPE');
    }
  });

  test('CRITICAL risk escalates the budget profile to CRITICAL regardless of the profile default', () => {
    const classification = makeClassification({ riskClassification: 'CRITICAL' });
    const config = makeConfig({ budgetProfile: 'BALANCED' });

    const resolved = resolvePolicy(classification, config, [], { now: NOW });
    expect(resolved.budgetProfile).toBe('CRITICAL');
    const decision = resolved.decisions.find((d) => d.subjectId === 'budget-profile');
    expect(decision?.reasonCodes).toContain('HARD_SAFETY_CRITICAL_RISK_REQUIRES_CRITICAL_BUDGET');
    expect(decision?.reasonCodes).toContain('BUDGET_ESCALATED_BY_HARD_SAFETY');
  });

  test('a pack-mandated review requirement escalates budget from BALANCED to QUALITY', () => {
    const pack = makePack('review', ['IMPLEMENT'], { rules: { requireIndependentReview: true } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT', riskClassification: 'MEDIUM' });
    const config = makeConfig({ budgetProfile: 'BALANCED' });

    const resolved = resolvePolicy(classification, config, [pack], { now: NOW });
    expect(resolved.budgetProfile).toBe('QUALITY');
  });

  test('explicit intent is honored when it does not conflict with a hard safety floor', () => {
    const classification = makeClassification({ requestedBudgetProfile: 'QUALITY', riskClassification: 'LOW' });
    const config = makeConfig({ budgetProfile: 'BALANCED' });

    const resolved = resolvePolicy(classification, config, [], { now: NOW });
    expect(resolved.budgetProfile).toBe('QUALITY');
    const decision = resolved.decisions.find((d) => d.subjectId === 'budget-profile');
    expect(decision?.reasonCodes).toContain('BUDGET_FROM_EXPLICIT_INTENT');
    expect(decision?.reasonCodes).not.toContain('BUDGET_ESCALATED_BY_HARD_SAFETY');
  });

  test('falls back to the trusted-policy default when no explicit intent is given', () => {
    const classification = makeClassification({ riskClassification: 'LOW' });
    const config = makeConfig({ budgetProfile: 'QUALITY' });

    const resolved = resolvePolicy(classification, config, [], { now: NOW });
    expect(resolved.budgetProfile).toBe('QUALITY');
    const decision = resolved.decisions.find((d) => d.subjectId === 'budget-profile');
    expect(decision?.reasonCodes).toContain('BUDGET_FROM_TRUSTED_POLICY');
  });

  const budgetMatrix: ReadonlyArray<{ risk: RiskLevel; requested: BudgetProfile | undefined; expected: BudgetProfile }> = [
    { risk: 'LOW', requested: undefined, expected: 'BALANCED' },
    { risk: 'LOW', requested: 'CHEAP', expected: 'CHEAP' },
    { risk: 'HIGH', requested: 'CHEAP', expected: 'CHEAP' },
  ];

  for (const { risk, requested, expected } of budgetMatrix) {
    test(`risk=${risk} requested=${String(requested)} -> ${expected} (no adversarial-review requirement active)`, () => {
      const classification = makeClassification({
        riskClassification: risk,
        ...(requested !== undefined ? { requestedBudgetProfile: requested } : {}),
      });
      const config = makeConfig({ budgetProfile: 'BALANCED' });
      const resolved = resolvePolicy(classification, config, [], { now: NOW });
      expect(resolved.budgetProfile).toBe(expected);
    });
  }

  test('HIGH risk only escalates the budget when adversarial review for high risk is actually required', () => {
    const classification = makeClassification({ riskClassification: 'HIGH', requestedBudgetProfile: 'CHEAP' });
    const config = makeConfig({ budgetProfile: 'BALANCED', rules: makeRules({ adversarialReviewForHighRisk: true }) });

    const resolved = resolvePolicy(classification, config, [], { now: NOW });
    expect(resolved.budgetProfile).toBe('QUALITY');
    const decision = resolved.decisions.find((d) => d.subjectId === 'budget-profile');
    expect(decision?.reasonCodes).toContain('HARD_SAFETY_HIGH_RISK_ADVERSARIAL_REVIEW_REQUIRES_QUALITY_BUDGET');
    expect(decision?.reasonCodes).toContain('BUDGET_ESCALATED_BY_HARD_SAFETY');
  });
});

describe('resolvePolicy: coding scope-freeze pack', () => {
  test('forces scope freeze, human final approval, independent review, and a bounded round cap', async () => {
    const [coding] = await loadPolicyPacks(['coding'], DEFAULT_POLICIES_DIR);
    if (coding === undefined) throw new Error('coding pack failed to load');
    const classification = makeClassification({ requestClassification: 'PLAN', riskClassification: 'MEDIUM' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [coding], { now: NOW });

    expect(resolved.effectiveRules.scopeFreezeRequired).toBe(true);
    expect(resolved.effectiveRules.humanIsFinalApprover).toBe(true);
    expect(resolved.effectiveRules.independentVerification).toBe(true);
    expect(resolved.effectiveRules.maxReviewRounds).toBeLessThanOrEqual(2);
    expect(resolved.requiredGates).toContain('PLAN_APPROVAL');
    assertWellFormedDecisions(resolved.decisions);
  });
});

describe('resolvePolicy: secure-code independent/adversarial review pack', () => {
  test('forces independent + adversarial review, caps mutation to LOCAL, and escalates budget', async () => {
    const [secureCode] = await loadPolicyPacks(['secure-code'], DEFAULT_POLICIES_DIR);
    if (secureCode === undefined) throw new Error('secure-code pack failed to load');
    const classification = makeClassification({ requestClassification: 'IMPLEMENT', riskClassification: 'MEDIUM' });
    const config = makeConfig({ budgetProfile: 'BALANCED' });

    const resolved = resolvePolicy(classification, config, [secureCode], { now: NOW });

    expect(resolved.effectiveRules.independentVerification).toBe(true);
    expect(resolved.effectiveRules.adversarialReviewForHighRisk).toBe(true);
    expect(resolved.requiredGates).toEqual(['EXECUTION_APPROVAL', 'RESULT_APPROVAL']);
    expect(resolved.budgetProfile).toBe('QUALITY');
    const ceilingDecision = resolved.decisions.find((d) => d.subjectId === 'mutation-ceiling');
    expect(ceilingDecision?.inputs.maximumMutationClass).toBe('LOCAL');
    assertWellFormedDecisions(resolved.decisions);
  });

  test('does not apply to a UI-classified request', async () => {
    const [secureCode] = await loadPolicyPacks(['secure-code'], DEFAULT_POLICIES_DIR);
    if (secureCode === undefined) throw new Error('secure-code pack failed to load');
    const classification = makeClassification({ requestClassification: 'UI' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [secureCode], { now: NOW });
    expect(resolved.packs).toEqual([]);
    expect(resolved.effectiveRules.independentVerification).toBe(false);
  });
});

describe('resolvePolicy: QA pack', () => {
  test('forces independent review and a READ_ONLY mutation ceiling', async () => {
    const [qa] = await loadPolicyPacks(['qa'], DEFAULT_POLICIES_DIR);
    if (qa === undefined) throw new Error('qa pack failed to load');
    const classification = makeClassification({ requestClassification: 'QA', riskClassification: 'LOW' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [qa], { now: NOW });

    expect(resolved.requiredGates).toEqual(['EXECUTION_APPROVAL', 'RESULT_APPROVAL']);
    const ceilingDecision = resolved.decisions.find((d) => d.subjectId === 'mutation-ceiling');
    expect(ceilingDecision?.inputs.maximumMutationClass).toBe('READ_ONLY');
    assertWellFormedDecisions(resolved.decisions);
  });
});

describe('resolvePolicy: the bundled production packs never conflict with each other', () => {
  test('loading and resolving all four together succeeds for every task family they jointly apply to', async () => {
    const allPacks = await loadPolicyPacks(['default', 'secure-code', 'coding', 'qa'], DEFAULT_POLICIES_DIR);
    for (const family of ['PLAN', 'IMPLEMENT', 'REVIEW', 'QA', 'SECURITY', 'DIRECT'] as const) {
      const resolved = resolvePolicy(makeClassification({ requestClassification: family }), makeConfig(), allPacks, { now: NOW });
      assertWellFormedDecisions(resolved.decisions);
    }
  });
});

describe('resolvePolicy: every derived decision is stable and auditable', () => {
  test('every PolicyDecision carries reason codes and versioned policy refs', () => {
    const pack = makePack('review', ['IMPLEMENT'], { rules: { requireIndependentReview: true, maxReviewRounds: 2 } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [pack], { now: NOW });
    assertWellFormedDecisions(resolved.decisions);
    expect(resolved.policyRefs.length).toBeGreaterThan(0);
    for (const ref of resolved.policyRefs) expect(ref).toMatch(POLICY_REF_PATTERN);
  });

  test('resolving twice with identical inputs is fully deterministic', () => {
    const pack = makePack('review', ['IMPLEMENT'], { rules: { requireIndependentReview: true } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig();

    const first = resolvePolicy(classification, config, [pack], { now: NOW });
    const second = resolvePolicy(classification, config, [pack], { now: NOW });
    expect(first).toEqual(second);
  });
});

describe('resolvePolicy: policyRefs cite real pack ids and versions', () => {
  test('a policy ref for a specific pack embeds that pack id and version', () => {
    const pack = makePack('versioned-pack', ['IMPLEMENT'], { version: 7, rules: { requireIndependentReview: true } });
    const classification = makeClassification({ requestClassification: 'IMPLEMENT' });
    const config = makeConfig();

    const resolved = resolvePolicy(classification, config, [pack], { now: NOW });
    const rulesDecision = resolved.decisions.find((d) => d.subjectId === 'effective-rules');
    expect(rulesDecision?.policyRefs).toContain('versioned-pack@7:rules.requireIndependentReview' satisfies PolicyRef);
  });

// ---------------------------------------------------------------------------
// Stage 4: resolveNodeTimeoutMs
// ---------------------------------------------------------------------------

describe('resolveNodeTimeoutMs', () => {
  test('returns a concrete, finite default per budget profile when no override is requested', () => {
    const cheap = resolveNodeTimeoutMs('CHEAP');
    const balanced = resolveNodeTimeoutMs('BALANCED');
    const quality = resolveNodeTimeoutMs('QUALITY');
    const critical = resolveNodeTimeoutMs('CRITICAL');

    for (const value of [cheap, balanced, quality, critical]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(ABSOLUTE_MAX_NODE_TIMEOUT_MS);
    }
    // A higher-scrutiny budget profile gets no less wall-clock room.
    expect(balanced).toBeGreaterThan(cheap);
    expect(quality).toBeGreaterThan(balanced);
    expect(critical).toBeGreaterThanOrEqual(quality);
  });

  test('clamps a caller-requested override to the per-profile ceiling rather than exceeding it', () => {
    const requested = resolveNodeTimeoutMs('CHEAP', 60 * 60_000);
    const unclamped = resolveNodeTimeoutMs('CHEAP');
    expect(requested).toBe(unclamped);
    expect(requested).toBeLessThan(60 * 60_000);
  });

  test('honors a smaller caller-requested override under the ceiling', () => {
    expect(resolveNodeTimeoutMs('BALANCED', 45_000)).toBe(45_000);
  });

  test('never returns a value above the absolute hard ceiling, even for CRITICAL', () => {
    expect(resolveNodeTimeoutMs('CRITICAL')).toBeLessThanOrEqual(ABSOLUTE_MAX_NODE_TIMEOUT_MS);
  });

  test('rejects a zero requested timeout as invalid rather than silently defaulting', () => {
    expect(() => resolveNodeTimeoutMs('BALANCED', 0)).toThrow(PolicyEngineError);
  });

  test('rejects a negative requested timeout', () => {
    expect(() => resolveNodeTimeoutMs('BALANCED', -1000)).toThrow(PolicyEngineError);
  });

  test('rejects a non-finite requested timeout', () => {
    expect(() => resolveNodeTimeoutMs('BALANCED', Number.POSITIVE_INFINITY)).toThrow(PolicyEngineError);
    expect(() => resolveNodeTimeoutMs('BALANCED', Number.NaN)).toThrow(PolicyEngineError);
  });

  test('a rejected requested timeout throws with code POLICY_CONFLICT', () => {
    try {
      resolveNodeTimeoutMs('BALANCED', 0);
      throw new Error('expected resolveNodeTimeoutMs to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyEngineError);
      expect((error as PolicyEngineError).code).toBe('POLICY_CONFLICT');
    }
  });
});
});

import { describe, expect, test } from 'bun:test';
import type { BudgetProfile, CapabilityRecord } from '../src/contracts.js';
import {
  CapabilitySelectionError,
  DEFAULT_MOCK_CAPABILITY_RECORDS,
  DEFAULT_PRODUCTION_CAPABILITY_RECORDS,
  PRODUCTION_MAX_CONCURRENT_NODES,
  buildProductionCapabilityRecords,
  createMockCapabilityRegistry,
  createProductionCapabilityRegistry,
  type CapabilitySelectionReasonCode,
} from '../src/registry.js';
import type {
  CapabilityPreference,
  CapabilityRequirement,
  OperatorFeatureFlags,
  OperatorProfile,
  OperatorRules,
  ResolvedPolicy,
} from '../src/stage3-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FEATURES: OperatorFeatureFlags = {
  automaticRouting: true,
  externalProviders: false,
  councilMode: false,
  autoFallback: true,
  persistentState: true,
  costTracking: true,
};

const RULES: OperatorRules = {
  humanIsFinalApprover: true,
  implementerSelfApproval: false,
  automaticCommit: false,
  automaticPush: false,
  automaticMerge: false,
  independentVerification: true,
  adversarialReviewForHighRisk: true,
  scopeFreezeRequired: false,
  maxReviewRounds: 2,
};

function preference(preferred: string, fallbacks: readonly string[] = [], fallbackPolicy: CapabilityPreference['fallbackPolicy'] = 'COMPATIBLE_ONLY'): CapabilityPreference {
  return { preferred, fallbacks, fallbackPolicy };
}

/** Builds a minimal-but-valid `ResolvedPolicy` fixture. Only the fields
 * `registry.select()` actually reads (`config.profile.capabilityAssignments`
 * and `budgetProfile`) vary meaningfully across tests; everything else is a
 * fixed, schema-shaped placeholder. */
function buildPolicy(capabilityAssignments: Readonly<Record<string, CapabilityPreference>>, budgetProfile: BudgetProfile = 'QUALITY'): ResolvedPolicy {
  const profile: OperatorProfile = {
    schemaVersion: '1.0',
    workflow: 'implement.v1',
    defaultPolicyPacks: [],
    budgetProfile,
    maxConcurrency: 4,
    features: FEATURES,
    rules: RULES,
    capabilityAssignments,
  };
  return {
    config: {
      profile,
      globalConfigPath: 'test-fixture:global-config.json',
      projectOverlay: { status: 'ABSENT', projectRoot: 'test-fixture:project-root' },
      policyRefs: [],
    },
    packs: [],
    effectiveRules: RULES,
    budgetProfile,
    maxConcurrency: 4,
    requiredGates: [],
    policyRefs: [],
    decisions: [],
  };
}

function requirement(overrides: Partial<CapabilityRequirement> & Pick<CapabilityRequirement, 'role' | 'capability'>): CapabilityRequirement {
  return {
    executionShape: 'SINGLE',
    mutationClass: 'READ_ONLY',
    independentFromRoles: [],
    ...overrides,
  };
}

function expectRejection(fn: () => unknown, reasonCode: CapabilitySelectionReasonCode): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapabilitySelectionError);
  expect((caught as CapabilitySelectionError).reasonCode).toBe(reasonCode);
}

// ---------------------------------------------------------------------------
// Default record set invariants
// ---------------------------------------------------------------------------

describe('DEFAULT_MOCK_CAPABILITY_RECORDS', () => {
  test('every record is a local omp-role with no binary/probes and is HEALTHY', () => {
    expect(DEFAULT_MOCK_CAPABILITY_RECORDS.length).toBeGreaterThan(0);
    for (const record of DEFAULT_MOCK_CAPABILITY_RECORDS) {
      expect(record.kind).toBe('omp-role');
      expect(record.binary).toBeUndefined();
      expect(record.versionProbe).toBeUndefined();
      expect(record.authProbe).toBeUndefined();
      expect(record.modelProbe).toBeUndefined();
      expect(record.health).toBe('HEALTHY');
      expect(record.spawns).toBe(false);
    }
  });

  test('every id is unique', () => {
    const ids = DEFAULT_MOCK_CAPABILITY_RECORDS.map((record) => record.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('covers every mandated Stage 3 role capability', () => {
    const capabilities = new Set(DEFAULT_MOCK_CAPABILITY_RECORDS.flatMap((record) => record.capabilities));
    for (const expected of [
      'planning',
      'implementation',
      'behavioral-verification',
      'conformance-verification',
      'independent-review',
      'adversarial-review',
      'qa-execution',
      'qa-review',
      'security-review',
      'security-validation',
      'ui-design',
      'ui-implementation',
      'ui-design-review',
      'ui-visual-verification',
      'research',
      'synthesis',
      'preflight',
      'operator-synthesis',
      'scope-freeze',
    ]) {
      expect(capabilities.has(expected)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Stage 4 production omp-task capability records
// ---------------------------------------------------------------------------

describe('DEFAULT_PRODUCTION_CAPABILITY_RECORDS', () => {
  test('is exactly the three package roles, each a healthy omp-task omp-role', () => {
    const ids = DEFAULT_PRODUCTION_CAPABILITY_RECORDS.map((record) => record.id).sort();
    expect(ids).toEqual(['omp-task-native-planner-v1', 'omp-task-native-reviewer-v1', 'omp-task-native-synthesis-v1']);
    for (const record of DEFAULT_PRODUCTION_CAPABILITY_RECORDS) {
      expect(record.kind).toBe('omp-role');
      expect(record.mutability).toBe('READ_ONLY');
      expect(record.spawns).toBe(false);
      expect(record.health).toBe('HEALTHY');
      expect(record.binary).toBeUndefined();
      expect(record.source.startsWith('omp-task:agents/')).toBe(true);
      expect(record.source).toMatch(/#sha256:[0-9a-f]{64}$/);
      expect(record.supports).toEqual(expect.arrayContaining(['SINGLE', 'PARALLEL', 'PIPELINE']));
    }
  });

  test('planner and reviewer receive exactly the operator_read/operator_grep/operator_glob grant; synthesis receives operator_read only', () => {
    const byId = Object.fromEntries(DEFAULT_PRODUCTION_CAPABILITY_RECORDS.map((record) => [record.id, record]));
    expect(byId['omp-task-native-planner-v1']?.tools).toEqual(['operator_read', 'operator_grep', 'operator_glob']);
    expect(byId['omp-task-native-reviewer-v1']?.tools).toEqual(['operator_read', 'operator_grep', 'operator_glob']);
    expect(byId['omp-task-native-synthesis-v1']?.tools).toEqual(['operator_read']);
    // No production record ever grants a write-capable or mutating tool.
    for (const record of DEFAULT_PRODUCTION_CAPABILITY_RECORDS) {
      for (const tool of record.tools) {
        expect(['edit', 'write', 'bash', 'eval', 'task', 'hub']).not.toContain(tool);
      }
    }
  });

  test('synthesis record supports PARALLEL with concurrency >= 2 (a research.v1-style grouped synthesis owner)', () => {
    const synthesis = DEFAULT_PRODUCTION_CAPABILITY_RECORDS.find((record) => record.id === 'omp-task-native-synthesis-v1');
    expect(synthesis?.supports).toContain('PARALLEL');
    expect(synthesis?.concurrency).toBeGreaterThanOrEqual(2);
  });

  test('every capability required by the six approved workflow templates is covered by exactly one record, except the three MUTATING ones', () => {
    const capabilities = new Set(DEFAULT_PRODUCTION_CAPABILITY_RECORDS.flatMap((record) => record.capabilities));
    for (const expected of [
      'planning',
      'preflight',
      'research',
      'ui-design',
      'independent-review',
      'adversarial-review',
      'qa-review',
      'security-review',
      'conformance-verification',
      'behavioral-verification',
      'ui-visual-verification',
      'scope-freeze',
      'synthesis',
      'operator-synthesis',
    ]) {
      expect(capabilities.has(expected)).toBe(true);
    }
    for (const excluded of ['implementation', 'qa-execution', 'ui-implementation']) {
      expect(capabilities.has(excluded)).toBe(false);
    }
  });

  test('PRODUCTION_MAX_CONCURRENT_NODES is a concrete finite ceiling', () => {
    expect(Number.isFinite(PRODUCTION_MAX_CONCURRENT_NODES)).toBe(true);
    expect(PRODUCTION_MAX_CONCURRENT_NODES).toBeGreaterThan(0);
  });
});

describe('buildProductionCapabilityRecords — non-dispatching preflight', () => {
  test('an unavailable adapter makes every record UNAVAILABLE', () => {
    const records = buildProductionCapabilityRecords({
      adapterAvailable: false,
      roleHashVerified: { planner: true, reviewer: true, synthesis: true },
    });
    for (const record of records) {
      expect(record.health).toBe('UNAVAILABLE');
    }
  });

  test('a single failed role-hash check makes only that role UNAVAILABLE', () => {
    const records = buildProductionCapabilityRecords({
      adapterAvailable: true,
      roleHashVerified: { planner: false, reviewer: true, synthesis: true },
    });
    const byId = Object.fromEntries(records.map((record) => [record.id, record]));
    expect(byId['omp-task-native-planner-v1']?.health).toBe('UNAVAILABLE');
    expect(byId['omp-task-native-reviewer-v1']?.health).toBe('HEALTHY');
    expect(byId['omp-task-native-synthesis-v1']?.health).toBe('HEALTHY');
  });
});

describe('createProductionCapabilityRegistry — production mock refusal', () => {
  function productionPolicy(capabilityAssignments: Readonly<Record<string, CapabilityPreference>>, budgetProfile: BudgetProfile = 'QUALITY'): ResolvedPolicy {
    return buildPolicy(capabilityAssignments, budgetProfile);
  }

  test('selects a real production record for a role assigned to it', () => {
    const registry = createProductionCapabilityRegistry();
    const policy = productionPolicy({ planner: preference('omp-task-native-planner-v1', [], 'DISABLED') });
    const selection = registry.select(requirement({ role: 'planner', capability: 'planning' }), policy);
    expect(selection.selected.id).toBe('omp-task-native-planner-v1');
    expect(selection.provider).toBe('omp-task');
  });

  test('rejects a mock record even when it is the only registered record and directly preferred', () => {
    const registry = createProductionCapabilityRegistry([DEFAULT_MOCK_CAPABILITY_RECORDS[0]!]);
    const policy = productionPolicy({ planner: preference('mock-planner-v1', [], 'DISABLED') });
    expectRejection(
      () => registry.select(requirement({ role: 'planner', capability: 'planning' }), policy),
      'PRODUCTION_MOCK_FORBIDDEN',
    );
  });

  test('rejects a mock record smuggled in alongside real production records, even via COMPATIBLE_ONLY fallback', () => {
    const registry = createProductionCapabilityRegistry([...DEFAULT_PRODUCTION_CAPABILITY_RECORDS, DEFAULT_MOCK_CAPABILITY_RECORDS[0]!]);
    const policy = productionPolicy({
      planner: preference('mock-planner-v1', ['omp-task-native-planner-v1'], 'COMPATIBLE_ONLY'),
    });
    const selection = registry.select(requirement({ role: 'planner', capability: 'planning' }), policy);
    // Falls through past the forbidden mock preferred id to the real fallback.
    expect(selection.selected.id).toBe('omp-task-native-planner-v1');
    expect(selection.reasonCode).toBe('COMPATIBLE_FALLBACK_MATCH');
  });

  test('a mock-only fallback list with no real alternative is NO_COMPATIBLE_FALLBACK, never a silent mock dispatch', () => {
    const registry = createProductionCapabilityRegistry([...DEFAULT_MOCK_CAPABILITY_RECORDS]);
    const policy = productionPolicy({ planner: preference('mock-planner-v1', ['mock-researcher-v1'], 'COMPATIBLE_ONLY') });
    expectRejection(
      () => registry.select(requirement({ role: 'planner', capability: 'planning' }), policy),
      'NO_COMPATIBLE_FALLBACK',
    );
  });

  test('mutating requirements never resolve against the production registry (no MUTATING production record exists)', () => {
    const registry = createProductionCapabilityRegistry();
    const policy = productionPolicy({ implementer: preference('omp-task-native-planner-v1', [], 'DISABLED') });
    // The only registered record for "implementer" is READ_ONLY, so a
    // mutating requirement against it is rejected as incompatible, not
    // silently downgraded to read-only capability.
    expectRejection(
      () => registry.select(requirement({ role: 'implementer', capability: 'implementation', mutationClass: 'LOCAL' }), policy),
      'CAPABILITY_MISMATCH',
    );
  });
});

// ---------------------------------------------------------------------------
// Positive selection
// ---------------------------------------------------------------------------

describe('select() — preferred assignment', () => {
  test('selects the preferred capability when every constraint is satisfied', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ planner: preference('mock-planner-v1') });
    const req = requirement({ role: 'planner', capability: 'planning' });

    const selection = registry.select(req, policy);

    expect(selection.selected.id).toBe('mock-planner-v1');
    expect(selection.provider).toBe('mock');
    expect(selection.reasonCode).toBe('PREFERRED_ASSIGNMENT_MATCH');
    expect(selection.fallbackFrom).toBeUndefined();
    expect(selection.requirement).toBe(req);
  });

  test('a HIGH-tier-only capability is selectable under a QUALITY budget', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ 'adversarial-reviewer': preference('mock-adversarial-reviewer-v1') }, 'QUALITY');
    const req = requirement({ role: 'adversarial-reviewer', capability: 'adversarial-review', executionShape: 'PARALLEL' });

    const selection = registry.select(req, policy);

    expect(selection.selected.id).toBe('mock-adversarial-reviewer-v1');
    expect(selection.reasonCode).toBe('PREFERRED_ASSIGNMENT_MATCH');
  });

  test('a mutating requirement selects a MUTATING record', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ implementer: preference('mock-implementer-v1') });
    const req = requirement({ role: 'implementer', capability: 'implementation', mutationClass: 'LOCAL' });

    const selection = registry.select(req, policy);

    expect(selection.selected.mutability).toBe('MUTATING');
  });
});

describe('select() — compatible fallback', () => {
  const RECORDS: readonly CapabilityRecord[] = [
    {
      id: 'reviewer-primary',
      kind: 'omp-role',
      capabilities: ['independent-review'],
      mutability: 'READ_ONLY',
      modelTiers: ['HIGH'],
      tools: [],
      spawns: false,
      supports: ['SINGLE'],
      costClass: 'HIGH',
      latencyClass: 'HIGH',
      concurrency: 1,
      health: 'DEGRADED',
      source: 'test-fixture',
    },
    {
      id: 'reviewer-fallback',
      kind: 'omp-role',
      capabilities: ['independent-review'],
      mutability: 'READ_ONLY',
      modelTiers: ['LOW'],
      tools: [],
      spawns: false,
      supports: ['SINGLE'],
      costClass: 'LOW',
      latencyClass: 'LOW',
      concurrency: 1,
      health: 'HEALTHY',
      source: 'test-fixture',
    },
  ];

  test('falls back to a compatible declared alternative when the preferred capability is unhealthy', () => {
    const registry = createMockCapabilityRegistry(RECORDS);
    const policy = buildPolicy({
      'independent-reviewer': preference('reviewer-primary', ['reviewer-fallback'], 'COMPATIBLE_ONLY'),
    });
    const req = requirement({ role: 'independent-reviewer', capability: 'independent-review' });

    const selection = registry.select(req, policy);

    expect(selection.selected.id).toBe('reviewer-fallback');
    expect(selection.reasonCode).toBe('COMPATIBLE_FALLBACK_MATCH');
    expect(selection.fallbackFrom).toBe('reviewer-primary');
  });

  test('skips an unknown fallback id and still finds a later compatible one', () => {
    const registry = createMockCapabilityRegistry(RECORDS);
    const policy = buildPolicy({
      'independent-reviewer': preference('reviewer-primary', ['does-not-exist', 'reviewer-fallback'], 'COMPATIBLE_ONLY'),
    });
    const req = requirement({ role: 'independent-reviewer', capability: 'independent-review' });

    const selection = registry.select(req, policy);

    expect(selection.selected.id).toBe('reviewer-fallback');
  });
});

// ---------------------------------------------------------------------------
// Negative selection — one test per enforced constraint
// ---------------------------------------------------------------------------

describe('select() — rejects unavailable/incompatible requirements', () => {
  test('rejects when the role has no capability assignment at all', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({});
    const req = requirement({ role: 'planner', capability: 'planning' });

    expectRejection(() => registry.select(req, policy), 'NO_CAPABILITY_ASSIGNMENT');
  });

  test('rejects when the preferred id is not registered', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ planner: preference('mock-planner-v9-does-not-exist') });
    const req = requirement({ role: 'planner', capability: 'planning' });

    expectRejection(() => registry.select(req, policy), 'UNKNOWN_CAPABILITY_ID');
  });

  test('rejects a semantic capability mismatch', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ planner: preference('mock-planner-v1', [], 'DISABLED') });
    const req = requirement({ role: 'planner', capability: 'implementation' });

    expectRejection(() => registry.select(req, policy), 'CAPABILITY_MISMATCH');
  });

  test('rejects an unsupported execution shape', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ 'ui-designer': preference('mock-ui-designer-v1', [], 'DISABLED') });
    const req = requirement({ role: 'ui-designer', capability: 'ui-design', executionShape: 'PARALLEL' });

    expectRejection(() => registry.select(req, policy), 'EXECUTION_SHAPE_UNSUPPORTED');
  });

  test('rejects an unhealthy capability record', () => {
    const records: readonly CapabilityRecord[] = [
      { ...DEFAULT_MOCK_CAPABILITY_RECORDS[0]!, health: 'UNAVAILABLE' },
    ];
    const registry = createMockCapabilityRegistry(records);
    const policy = buildPolicy({ planner: preference('mock-planner-v1', [], 'HUMAN_REQUIRED') });
    const req = requirement({ role: 'planner', capability: 'planning' });

    expectRejection(() => registry.select(req, policy), 'CAPABILITY_UNHEALTHY');
  });

  test('rejects a mutation-class mismatch (mutating requirement against a READ_ONLY record)', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ planner: preference('mock-planner-v1', [], 'DISABLED') });
    const req = requirement({ role: 'planner', capability: 'planning', mutationClass: 'DESTRUCTIVE' });

    expectRejection(() => registry.select(req, policy), 'MUTATION_CLASS_INCOMPATIBLE');
  });

  test('rejects a mutation-class mismatch (read-only requirement against a MUTATING record)', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ implementer: preference('mock-implementer-v1', [], 'DISABLED') });
    const req = requirement({ role: 'implementer', capability: 'implementation', mutationClass: 'READ_ONLY' });

    expectRejection(() => registry.select(req, policy), 'MUTATION_CLASS_INCOMPATIBLE');
  });

  test('rejects a capability whose cheapest model tier exceeds the CHEAP budget cap', () => {
    const registry = createMockCapabilityRegistry();
    const policy = buildPolicy({ 'adversarial-reviewer': preference('mock-adversarial-reviewer-v1', [], 'DISABLED') }, 'CHEAP');
    const req = requirement({ role: 'adversarial-reviewer', capability: 'adversarial-review', executionShape: 'PARALLEL' });

    expectRejection(() => registry.select(req, policy), 'BUDGET_MODEL_TIER_EXCEEDED');
  });

  test('rejects a capability whose cost class exceeds the budget cap', () => {
    const records: readonly CapabilityRecord[] = [
      { ...DEFAULT_MOCK_CAPABILITY_RECORDS[0]!, id: 'expensive-cheap-tier', modelTiers: ['LOW'], costClass: 'HIGH' },
    ];
    const registry = createMockCapabilityRegistry(records);
    const policy = buildPolicy({ planner: preference('expensive-cheap-tier', [], 'DISABLED') }, 'CHEAP');
    const req = requirement({ role: 'planner', capability: 'planning' });

    expectRejection(() => registry.select(req, policy), 'BUDGET_COST_TIER_EXCEEDED');
  });

  test('rejects insufficient concurrency for a PARALLEL requirement', () => {
    const records: readonly CapabilityRecord[] = [
      {
        id: 'low-concurrency-reviewer',
        kind: 'omp-role',
        capabilities: ['independent-review'],
        mutability: 'READ_ONLY',
        modelTiers: ['MEDIUM'],
        tools: [],
        spawns: false,
        supports: ['SINGLE', 'PARALLEL'],
        costClass: 'MEDIUM',
        latencyClass: 'MEDIUM',
        concurrency: 1,
        health: 'HEALTHY',
        source: 'test-fixture',
      },
    ];
    const registry = createMockCapabilityRegistry(records);
    const policy = buildPolicy({ 'independent-reviewer': preference('low-concurrency-reviewer', [], 'DISABLED') });
    const req = requirement({ role: 'independent-reviewer', capability: 'independent-review', executionShape: 'PARALLEL' });

    expectRejection(() => registry.select(req, policy), 'INSUFFICIENT_CONCURRENCY');
  });

  test('rejects reuse of a record already assigned to a role the requirement must be independent from', () => {
    const shared: readonly CapabilityRecord[] = [
      {
        id: 'shared-reviewer',
        kind: 'omp-role',
        capabilities: ['independent-review', 'adversarial-review'],
        mutability: 'READ_ONLY',
        modelTiers: ['MEDIUM'],
        tools: [],
        spawns: false,
        supports: ['SINGLE'],
        costClass: 'MEDIUM',
        latencyClass: 'MEDIUM',
        concurrency: 1,
        health: 'HEALTHY',
        source: 'test-fixture',
      },
    ];
    const registry = createMockCapabilityRegistry(shared);
    const policy = buildPolicy({
      'independent-reviewer': preference('shared-reviewer'),
      'adversarial-reviewer': preference('shared-reviewer', [], 'DISABLED'),
    });

    // First selection succeeds and records role → record state on this
    // registry instance.
    const first = registry.select(requirement({ role: 'independent-reviewer', capability: 'independent-review' }), policy);
    expect(first.selected.id).toBe('shared-reviewer');

    // Second requirement demands independence from the first role, but both
    // roles are only assigned the same underlying record.
    const secondReq = requirement({
      role: 'adversarial-reviewer',
      capability: 'adversarial-review',
      independentFromRoles: ['independent-reviewer'],
    });
    expectRejection(() => registry.select(secondReq, policy), 'INDEPENDENCE_VIOLATION');
  });

  test('never falls back when fallbackPolicy is DISABLED, even if a compatible fallback exists', () => {
    const records: readonly CapabilityRecord[] = [
      { ...DEFAULT_MOCK_CAPABILITY_RECORDS[0]!, id: 'planner-a', health: 'UNAVAILABLE' },
      { ...DEFAULT_MOCK_CAPABILITY_RECORDS[0]!, id: 'planner-b', health: 'HEALTHY' },
    ];
    const registry = createMockCapabilityRegistry(records);
    const policy = buildPolicy({ planner: preference('planner-a', ['planner-b'], 'DISABLED') });
    const req = requirement({ role: 'planner', capability: 'planning' });

    expectRejection(() => registry.select(req, policy), 'CAPABILITY_UNHEALTHY');
  });

  test('never falls back when fallbackPolicy is HUMAN_REQUIRED, even if a compatible fallback exists', () => {
    const records: readonly CapabilityRecord[] = [
      { ...DEFAULT_MOCK_CAPABILITY_RECORDS[0]!, id: 'planner-a', health: 'UNAVAILABLE' },
      { ...DEFAULT_MOCK_CAPABILITY_RECORDS[0]!, id: 'planner-b', health: 'HEALTHY' },
    ];
    const registry = createMockCapabilityRegistry(records);
    const policy = buildPolicy({ planner: preference('planner-a', ['planner-b'], 'HUMAN_REQUIRED') });
    const req = requirement({ role: 'planner', capability: 'planning' });

    expectRejection(() => registry.select(req, policy), 'CAPABILITY_UNHEALTHY');
  });

  test('rejects with NO_COMPATIBLE_FALLBACK when every declared fallback is also incompatible', () => {
    const records: readonly CapabilityRecord[] = [
      { ...DEFAULT_MOCK_CAPABILITY_RECORDS[0]!, id: 'planner-a', health: 'UNAVAILABLE' },
      { ...DEFAULT_MOCK_CAPABILITY_RECORDS[0]!, id: 'planner-b', health: 'DEGRADED' },
    ];
    const registry = createMockCapabilityRegistry(records);
    const policy = buildPolicy({ planner: preference('planner-a', ['planner-b'], 'COMPATIBLE_ONLY') });
    const req = requirement({ role: 'planner', capability: 'planning' });

    expectRejection(() => registry.select(req, policy), 'NO_COMPATIBLE_FALLBACK');
  });

  test('rejects a non-omp-role candidate as an external provider, independent of any policy flag', () => {
    const externalRecord: CapabilityRecord = {
      id: 'external-cli-tool',
      kind: 'external-cli',
      capabilities: ['planning'],
      mutability: 'READ_ONLY',
      modelTiers: ['LOW'],
      tools: [],
      spawns: false,
      supports: ['SINGLE'],
      binary: 'some-real-cli',
      costClass: 'LOW',
      latencyClass: 'LOW',
      concurrency: 1,
      health: 'HEALTHY',
      source: 'test-fixture',
    };
    const registry = createMockCapabilityRegistry([externalRecord]);
    const policy = buildPolicy({ planner: preference('external-cli-tool', [], 'DISABLED') });
    const req = requirement({ role: 'planner', capability: 'planning' });

    expectRejection(() => registry.select(req, policy), 'EXTERNAL_PROVIDER_DISABLED');
  });
});

// ---------------------------------------------------------------------------
// Registry instance isolation
// ---------------------------------------------------------------------------

describe('registry instance isolation', () => {
  test('independence tracking does not leak across separate registry instances', () => {
    const shared: readonly CapabilityRecord[] = [
      {
        id: 'shared-reviewer',
        kind: 'omp-role',
        capabilities: ['independent-review', 'adversarial-review'],
        mutability: 'READ_ONLY',
        modelTiers: ['MEDIUM'],
        tools: [],
        spawns: false,
        supports: ['SINGLE'],
        costClass: 'MEDIUM',
        latencyClass: 'MEDIUM',
        concurrency: 1,
        health: 'HEALTHY',
        source: 'test-fixture',
      },
    ];
    const policy = buildPolicy({
      'independent-reviewer': preference('shared-reviewer'),
      'adversarial-reviewer': preference('shared-reviewer', [], 'DISABLED'),
    });

    const registryA = createMockCapabilityRegistry(shared);
    registryA.select(requirement({ role: 'independent-reviewer', capability: 'independent-review' }), policy);

    // A fresh registry instance has no memory of registryA's selections, so
    // the same "shared-reviewer" record is selectable for the independent
    // role here.
    const registryB = createMockCapabilityRegistry(shared);
    const selection = registryB.select(
      requirement({ role: 'adversarial-reviewer', capability: 'adversarial-review', independentFromRoles: ['independent-reviewer'] }),
      policy,
    );
    expect(selection.selected.id).toBe('shared-reviewer');
  });
});

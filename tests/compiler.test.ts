/**
 * Agent Operator — Stage 3 workflow compiler golden tests.
 *
 * Every test injects its own `loadConfig`/`registryFactory` via
 * `Stage3WorkflowCompilerOptions` rather than touching the real
 * filesystem-backed configuration. `defaultPolicyPacks` is always `[]`, so
 * policy-pack I/O is covered separately by policy tests while compiler
 * orchestration stays deterministic.
 */

import { describe, expect, test } from 'bun:test';
import { createStage3WorkflowCompiler, type Stage3WorkflowCompilerOptions } from '../src/compiler.js';
import type { CapabilityRecord, PolicyRef } from '../src/contracts.js';
import type {
  CapabilityRegistry,
  OperatorFeatureFlags,
  OperatorProfile,
  OperatorRules,
  ProjectOverlayResolution,
  ResolvedOperatorConfig,
  WorkflowCompilerContext,
} from '../src/stage3-types.js';
import { createMockCapabilityRegistry, PRODUCTION_MAX_CONCURRENT_NODES } from '../src/registry.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

const FEATURES: OperatorFeatureFlags = {
  automaticRouting: false,
  externalProviders: false,
  councilMode: false,
  autoFallback: false,
  persistentState: false,
  costTracking: false,
};

const RULES: OperatorRules = {
  humanIsFinalApprover: true,
  implementerSelfApproval: false,
  automaticCommit: false,
  automaticPush: false,
  automaticMerge: false,
  independentVerification: true,
  adversarialReviewForHighRisk: false,
  scopeFreezeRequired: false,
  maxReviewRounds: 2,
};

/** One role -> one capability id, matching `workflow-templates.ts`'s exact
 * (role, requiredCapability) pairs for every node in every registered
 * template (relayed by OperatorWorkflowGraphs over hub during this build). */
const ROLE_CAPABILITY: Readonly<Record<string, string>> = {
  'context-preflight': 'preflight',
  planner: 'planning',
  'independent-reviewer': 'independent-review',
  'scope-freeze': 'scope-freeze',
  'adversarial-reviewer': 'adversarial-review',
  'operator-synthesis': 'operator-synthesis',
  'plan-context-loader': 'preflight',
  implementer: 'implementation',
  'behavioral-verifier': 'behavioral-verification',
  'conformance-verifier': 'conformance-verification',
  'qa-preflight': 'preflight',
  'qa-executor': 'qa-execution',
  'evidence-collector': 'qa-review',
  'security-reviewer': 'security-review',
  'ui-designer': 'ui-design',
  'ui-implementer': 'ui-implementation',
  'visual-verifier': 'ui-visual-verification',
  researcher: 'research',
  'research-synthesizer': 'synthesis',
};

function testCapabilityRecord(role: string): CapabilityRecord {
  return {
    id: `test-${role}`,
    kind: 'omp-role',
    capabilities: [ROLE_CAPABILITY[role] ?? role],
    mutability: role === 'implementer' || role === 'ui-implementer' || role === 'qa-executor' ? 'MUTATING' : 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM', 'HIGH'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL', 'PIPELINE'],
    costClass: 'LOW',
    latencyClass: 'LOW',
    concurrency: 5,
    health: 'HEALTHY',
    source: 'test-fixture',
  };
}

/** A registry pre-loaded with one working record per known role. */
function fullTestRegistry(): CapabilityRegistry {
  return createMockCapabilityRegistry(Object.keys(ROLE_CAPABILITY).map(testCapabilityRecord));
}

function fullCapabilityAssignments(): OperatorProfile['capabilityAssignments'] {
  const assignments: Record<string, OperatorProfile['capabilityAssignments'][string]> = {};
  for (const role of Object.keys(ROLE_CAPABILITY)) {
    assignments[role] = { preferred: `test-${role}`, fallbacks: [], fallbackPolicy: 'DISABLED' };
  }
  return assignments;
}

function baseProfile(overrides: Partial<OperatorProfile> = {}): OperatorProfile {
  return {
    schemaVersion: '1.0',
    workflow: 'default',
    defaultPolicyPacks: [],
    budgetProfile: 'CRITICAL',
    maxConcurrency: 4,
    features: FEATURES,
    rules: RULES,
    capabilityAssignments: fullCapabilityAssignments(),
    ...overrides,
  };
}

function overlayResolution(overrides: Partial<ProjectOverlayResolution> = {}): ProjectOverlayResolution {
  return { status: 'ABSENT', projectRoot: '/tmp/fixture-project', ...overrides };
}

function testConfig(overrides: { profile?: Partial<OperatorProfile>; projectOverlay?: Partial<ProjectOverlayResolution>; policyRefs?: readonly PolicyRef[] } = {}): ResolvedOperatorConfig {
  return {
    profile: baseProfile(overrides.profile),
    globalConfigPath: '/tmp/fixture-global.json',
    projectOverlay: overlayResolution(overrides.projectOverlay),
    policyRefs: overrides.policyRefs ?? ['agent-operator@1:config.defaults'],
  };
}

function compilerWith(
  configOverrides: Parameters<typeof testConfig>[0] = {},
  options: Partial<Stage3WorkflowCompilerOptions> = {},
) {
  return createStage3WorkflowCompiler({
    loadConfig: async () => testConfig(configOverrides),
    registryFactory: options.registryFactory ?? (() => fullTestRegistry()),
    ...options,
  });
}

function context(overrides: Partial<WorkflowCompilerContext> = {}): WorkflowCompilerContext {
  return {
    projectRoot: '/tmp/fixture-project',
    operatorSessionId: 'session-1',
    graphId: 'graph-1',
    gateId: 'gate-1',
    now: FIXED_NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Golden: global plan
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler global plan', () => {
  test('compiles a PLAN request against the global (non-project) config', async () => {
    const compiler = compilerWith({ projectOverlay: { status: 'ABSENT' } });
    const result = await compiler.compile('Please help me plan the rollout of the new billing module.', context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.classification.requestClassification).toBe('PLAN');
    expect(result.compiled.routeDecision.selectedWorkflow).toBe('plan.v1');
    expect(result.compiled.routeDecision.rejectedAlternatives).toEqual([]);
    expect(result.compiled.routeDecision.requiredGates[0]).toBe('EXECUTION_APPROVAL');
    expect(result.compiled.initialGate).not.toBeNull();
    const nodeIds = result.compiled.executionGraph.nodes.map((node) => node.nodeId);
    expect(nodeIds).not.toContain('scope-freeze');
    expect(nodeIds).not.toContain('adversarial-review');
    expect(result.compiled.executionGraph.nodes.find((node) => node.nodeId === 'operator-synthesis')?.dependsOn).toEqual([
      'independent-review',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Golden: trusted MASAR-like project overlay
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler trusted project overlay', () => {
  test('compiles a PLAN request when the project overlay is TRUSTED', async () => {
    const compiler = compilerWith(
      {
        projectOverlay: {
          status: 'TRUSTED',
          policyPath: '.omp/operator.json',
          trustRecordPath: '.git/agent-operator/trust.json',
        },
        policyRefs: ['agent-operator@1:config.defaults', 'agent-operator@1:config.project.trusted'],
      },
    );
    const result = await compiler.compile('Plan out the MASAR stage 4 rollout.', context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.routeDecision.rejectedAlternatives).toEqual([]);
    expect(result.compiled.routeDecision.policyRefs).toContain('agent-operator@1:config.project.trusted');
    expect(result.compiled.routeDecision.reasonCodes).toContain('PROJECT_OVERLAY_TRUSTED');
  });

  test('includes a trusted policy-required scope freeze and rewires synthesis to its output', async () => {
    const compiler = compilerWith({
      profile: { rules: { ...RULES, scopeFreezeRequired: true } },
      projectOverlay: {
        status: 'TRUSTED',
        policyPath: '.omp/operator.json',
        trustRecordPath: '.git/agent-operator/trust.json',
      },
    });
    const result = await compiler.compile('Plan out the MASAR stage 4 rollout.', context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const scopeFreeze = result.compiled.executionGraph.nodes.find((node) => node.nodeId === 'scope-freeze');
    const synthesis = result.compiled.executionGraph.nodes.find((node) => node.nodeId === 'operator-synthesis');
    expect(scopeFreeze?.dependsOn).toEqual(['independent-review']);
    expect(synthesis?.consumes).toEqual(['plan-review.v1', 'scope-freeze-record.v1']);
    expect(result.compiled.executionGraph.nodes.map((node) => node.nodeId)).not.toContain('adversarial-review');
  });
});
// ---------------------------------------------------------------------------
// Golden: untrusted overlay — ignored, surfaced, compile still succeeds
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler untrusted project overlay', () => {
  test('ignores an UNTRUSTED overlay, surfaces it as a rejected alternative, and still compiles', async () => {
    const compiler = compilerWith({
      projectOverlay: { status: 'UNTRUSTED', policyPath: '.omp/operator.json', reason: 'actualHash did not match the trust record expectedHash' },
    });
    const result = await compiler.compile('Plan the next iteration of the reporting pipeline.', context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.routeDecision.rejectedAlternatives).toHaveLength(1);
    expect(result.compiled.routeDecision.rejectedAlternatives[0]?.option).toBe('project-policy-overlay');
    expect(result.compiled.routeDecision.rejectedAlternatives[0]?.reasonCode).toBe('PROJECT_OVERLAY_UNTRUSTED');
    expect(result.compiled.routeDecision.reasonCodes).toContain('PROJECT_OVERLAY_UNTRUSTED');
  });

  test('a malformed or path-unsafe INVALID overlay fails compilation closed', async () => {
    const compiler = compilerWith({
      projectOverlay: { status: 'INVALID', reason: 'policyPath escaped the project root' },
    });
    const result = await compiler.compile('Plan a follow-up investigation.', context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CONFIG_INVALID');
    expect(result.message).toContain('escaped');
  });

});

// ---------------------------------------------------------------------------
// Golden: cheap-budget rejection
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler cheap-budget rejection', () => {
  test('rejects an explicit QUALITY budget request against a CHEAP-configured operator profile', async () => {
    const compiler = compilerWith(
      { profile: { budgetProfile: 'CHEAP' } },
      {
        classifier: {
          classify: () => ({
            requestClassification: 'IMPLEMENT',
            riskClassification: 'HIGH',
            confidence: 'HIGH',
            decomposable: true,
            semanticCapabilities: ['implementation'],
            requestedExecutionShape: 'PIPELINE',
            requestedBudgetProfile: 'QUALITY',
            rationale: 'Explicit test fixture budget request.',
          }),
        },
      },
    );
    const result = await compiler.compile('Please implement the new retry handler.', context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BUDGET_EXCEEDED');
    expect(result.message).toContain('QUALITY');
    expect(result.message).toContain('CHEAP');
  });
});

// ---------------------------------------------------------------------------
// Golden: provider/capability unavailable
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler capability unavailable', () => {
  test('rejects when the registry has no record for a required role', async () => {
    const compiler = compilerWith({}, { registryFactory: () => createMockCapabilityRegistry([]) });
    const result = await compiler.compile('Please implement the new retry handler.', context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Golden: ambiguous input
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler ambiguous classification', () => {
  test('refuses to compile a request the mock classifier abstains on', async () => {
    const compiler = compilerWith();
    const result = await compiler.compile('hello there', context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CLASSIFICATION_INVALID');
  });
});

// ---------------------------------------------------------------------------
// Golden: explicit direct intent
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler explicit direct intent', () => {
  test('refuses direct/automatic bypass requests with FEATURE_DISABLED', async () => {
    const compiler = compilerWith();
    const result = await compiler.compile('Just answer directly, skip the workflow entirely.', context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FEATURE_DISABLED');
  });
});

// ---------------------------------------------------------------------------
// Golden: graph/gate binding
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler graph/gate binding', () => {
  test('the compiled graph and initial gate are bound to the supplied ids and to each other', async () => {

    const compiler = compilerWith();
    const ctx = context({ graphId: 'graph-xyz', gateId: 'gate-xyz', operatorSessionId: 'session-xyz' });
    const result = await compiler.compile('Please implement the retry handler.', ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { executionGraph, initialGate } = result.compiled;
    expect(executionGraph.graphId).toBe('graph-xyz');
    expect(initialGate).not.toBeNull();
    expect(initialGate?.gateId).toBe('gate-xyz');
    expect(initialGate?.operatorSessionId).toBe('session-xyz');
    expect(initialGate?.graphRevision).toBe(executionGraph.graphRevision);
    expect(initialGate?.graphHash).toBe(executionGraph.graphHash);
    expect(executionGraph.nodes.some((n) => n.nodeId === initialGate?.resumeNode)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 4: production registry is the compiler's default
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler production registry default', () => {
  const PRODUCTION_ASSIGNMENTS: OperatorProfile['capabilityAssignments'] = {
    'context-preflight': { preferred: 'omp-task-native-planner-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    planner: { preferred: 'omp-task-native-planner-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    'independent-reviewer': { preferred: 'omp-task-native-reviewer-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    'scope-freeze': { preferred: 'omp-task-native-reviewer-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    'adversarial-reviewer': { preferred: 'omp-task-native-reviewer-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    'operator-synthesis': { preferred: 'omp-task-native-synthesis-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    'plan-context-loader': { preferred: 'omp-task-native-planner-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    implementer: { preferred: 'mock-implementer-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    'behavioral-verifier': { preferred: 'omp-task-native-reviewer-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
    'conformance-verifier': { preferred: 'omp-task-native-reviewer-v1', fallbacks: [], fallbackPolicy: 'DISABLED' },
  };

  function productionConfig(capabilityAssignments: OperatorProfile['capabilityAssignments'] = PRODUCTION_ASSIGNMENTS): ResolvedOperatorConfig {
    return testConfig({ profile: { capabilityAssignments } });
  }

  test('compiles a read-only PLAN workflow via the production omp-task registry with no registryFactory override', async () => {
    const compiler = createStage3WorkflowCompiler({ loadConfig: async () => productionConfig() });
    const result = await compiler.compile('Please help me plan the rollout of the new billing module.', context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.compiled.routeDecision.selectedRolesProviders.length).toBeGreaterThan(0);
    for (const assignment of result.compiled.routeDecision.selectedRolesProviders) {
      expect(assignment.provider).toBe('omp-task');
    }
  });

  test('the default production registry never selects a mock record, even when a role is misconfigured to prefer one', async () => {
    const compiler = createStage3WorkflowCompiler({
      loadConfig: async () => productionConfig({ ...PRODUCTION_ASSIGNMENTS, planner: { preferred: 'mock-planner-v1', fallbacks: [], fallbackPolicy: 'DISABLED' } }),
    });
    const result = await compiler.compile('Please help me plan the rollout of the new billing module.', context());

    // The default production registry is built from only the three
    // `omp-task-*` records (a whitelist, not a mock-record blocklist), so a
    // role misconfigured to prefer a mock id fails to resolve at all
    // (UNKNOWN_CAPABILITY_ID) — it is never silently dispatched.
    // `registry.test.ts` separately proves the defense-in-depth
    // `PRODUCTION_MOCK_FORBIDDEN` check for a mock record deliberately
    // present alongside real production records.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CAPABILITY_UNAVAILABLE');
    expect(result.message).toContain('UNKNOWN_CAPABILITY_ID');
  });

  test('a mutating IMPLEMENT workflow always blocks against the production registry (Stage 4 defines no MUTATING production capability)', async () => {
    const compiler = createStage3WorkflowCompiler({ loadConfig: async () => productionConfig() });
    const result = await compiler.compile('Please implement the retry handler.', context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CAPABILITY_UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
// Stage 4: adapter concurrency ceiling preflight
// ---------------------------------------------------------------------------

describe('Stage3WorkflowCompiler adapter concurrency ceiling', () => {
  test('rejects a resolved policy maxConcurrency above the omp-task adapter hard ceiling', async () => {
    const compiler = compilerWith({ profile: { maxConcurrency: PRODUCTION_MAX_CONCURRENT_NODES + 1 } });
    const result = await compiler.compile('Please help me plan the rollout of the new billing module.', context());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('BUDGET_EXCEEDED');
    expect(result.message).toContain('concurrency');
  });

  test('accepts a resolved policy maxConcurrency exactly at the ceiling', async () => {
    const compiler = compilerWith({ profile: { maxConcurrency: PRODUCTION_MAX_CONCURRENT_NODES } });
    const result = await compiler.compile('Please help me plan the rollout of the new billing module.', context());

    expect(result.ok).toBe(true);
  });
});

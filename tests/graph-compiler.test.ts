import { describe, expect, test } from 'bun:test';
import type {
  CapabilityRecord,
  ExecutionShape,
  GateDecisionType,
  Mutability,
  TaskFamily,
} from '../src/contracts.js';
import { compileExecutionGraph, type GraphCompilationErrorCode, type GraphCompilationInput } from '../src/graph.js';
import type {
  CapabilityRequirement,
  CapabilitySelection,
  OperatorFeatureFlags,
  OperatorProfile,
  OperatorRules,
  PolicyPack,
  ResolvedOperatorConfig,
  ResolvedPolicy,
  WorkflowNodeContract,
} from '../src/stage3-types.js';

import {
  getWorkflowTemplateById,
  listWorkflowTemplates,
  resolveTemplateNodes,
  selectWorkflowTemplateForFamily,
  WORKFLOW_TEMPLATES,
  type ResolvedTemplateNode,
} from '../src/workflow-templates.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_RULES: OperatorRules = {
  humanIsFinalApprover: true,
  implementerSelfApproval: false,
  automaticCommit: false,
  automaticPush: false,
  automaticMerge: false,
  independentVerification: true,
  adversarialReviewForHighRisk: false,
  scopeFreezeRequired: false,
  maxReviewRounds: 1,
};

const BASE_FEATURES: OperatorFeatureFlags = {
  automaticRouting: false,
  externalProviders: false,
  councilMode: false,
  autoFallback: false,
  persistentState: true,
  costTracking: false,
};

const BASE_PROFILE: OperatorProfile = {
  schemaVersion: '1.0',
  workflow: 'default',
  defaultPolicyPacks: [],
  budgetProfile: 'BALANCED',
  maxConcurrency: 4,
  features: BASE_FEATURES,
  rules: BASE_RULES,
  capabilityAssignments: {},
};

const BASE_CONFIG: ResolvedOperatorConfig = {
  profile: BASE_PROFILE,
  globalConfigPath: '/config/defaults.json',
  projectOverlay: { status: 'ABSENT', projectRoot: '/repo' },
  policyRefs: ['default@1:workflow'],
};

function buildPolicy(
  overrides: {
    rules?: Partial<OperatorRules>;
    maxConcurrency?: number;
    requiredGates?: readonly GateDecisionType[];
    packs?: readonly PolicyPack[];
  } = {},
): ResolvedPolicy {
  return {
    config: BASE_CONFIG,
    packs: overrides.packs ?? [],
    effectiveRules: { ...BASE_RULES, ...overrides.rules },
    budgetProfile: 'BALANCED',
    maxConcurrency: overrides.maxConcurrency ?? 4,
    requiredGates: overrides.requiredGates ?? [],
    policyRefs: ['default@1:workflow'],
    decisions: [],
  };
}

function makeCapability(id: string, capability: string, opts: { mutability?: Mutability; supports?: readonly ExecutionShape[] } = {}): CapabilityRecord {
  return {
    id,
    kind: 'omp-role',
    capabilities: [capability],
    mutability: opts.mutability ?? 'READ_ONLY',
    modelTiers: ['HIGH'],
    tools: ['read'],
    spawns: false,
    supports: opts.supports ?? ['SINGLE', 'PARALLEL', 'PIPELINE'],
    costClass: 'MEDIUM',
    latencyClass: 'MEDIUM',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'test-fixture',
  };
}

/** One distinct capability/provider per node — a clean default that never
 * self-collides, so adversarial tests only need to override the one node
 * under test. */
function autoSelect(nodes: readonly ResolvedTemplateNode[]): Record<string, CapabilitySelection> {
  const out: Record<string, CapabilitySelection> = {};
  for (const node of nodes) {
    const mutability: Mutability = node.requirement.mutationClass === 'READ_ONLY' ? 'READ_ONLY' : 'MUTATING';
    out[node.nodeId] = {
      requirement: node.requirement,
      selected: makeCapability(`cap-${node.nodeId}`, node.requirement.capability, { mutability }),
      provider: `provider-${node.nodeId}`,
      reasonCode: 'TEST_FIXTURE',
    };
  }
  return out;
}

function baseContract(overrides: Partial<WorkflowNodeContract> = {}): WorkflowNodeContract {
  return { contextPolicy: 'shared', consumes: [], produces: [], requiredCapability: 'generic', ...overrides };
}

function baseRequirement(overrides: Partial<CapabilityRequirement> = {}): CapabilityRequirement {
  return { role: 'generic-role', capability: 'generic', executionShape: 'SINGLE', mutationClass: 'READ_ONLY', independentFromRoles: [], ...overrides };
}

function makeNode(spec: {
  nodeId: string;
  role?: string;
  mandatory?: boolean;
  dependsOn?: readonly string[];
  groupId?: string;
  synthesisOwner?: boolean;
  contract?: WorkflowNodeContract;
  requirement?: CapabilityRequirement;
  mutation?: ResolvedTemplateNode['mutation'];
}): ResolvedTemplateNode {
  const role = spec.role ?? `${spec.nodeId}-role`;
  return {
    nodeId: spec.nodeId,
    role,
    mandatory: spec.mandatory ?? true,
    dependsOn: spec.dependsOn ?? [],
    synthesisOwner: spec.synthesisOwner ?? false,
    contract: spec.contract ?? baseContract(),
    requirement: spec.requirement ?? baseRequirement({ role }),
    ...(spec.groupId !== undefined ? { groupId: spec.groupId } : {}),
    ...(spec.mutation !== undefined ? { mutation: spec.mutation } : {}),
  };
}

const DEFAULT_POLICY = buildPolicy();

/** Minimal valid 3-node pipeline: preflight-ish `a` -> worker `b` -> terminal
 * mandatory operator-synthesis. Read-only, no groups. Every adversarial test
 * clones this and mutates exactly the one thing it targets. */
function miniNodes(): readonly ResolvedTemplateNode[] {
  return [
    makeNode({ nodeId: 'a', role: 'role-a', contract: baseContract({ produces: ['a-out.v1'] }), requirement: baseRequirement({ role: 'role-a' }) }),
    makeNode({
      nodeId: 'b',
      role: 'role-b',
      dependsOn: ['a'],
      contract: baseContract({ consumes: ['a-out.v1'], produces: ['b-out.v1'] }),
      requirement: baseRequirement({ role: 'role-b' }),
    }),
    makeNode({
      nodeId: 'synth',
      role: 'operator-synthesis',
      dependsOn: ['b'],
      synthesisOwner: true,
      contract: baseContract({ consumes: ['b-out.v1'], produces: ['synth-out.v1'] }),
      requirement: baseRequirement({ role: 'operator-synthesis' }),
    }),
  ];
}

function miniInput(overrides: Partial<GraphCompilationInput> = {}): GraphCompilationInput {
  const nodes = overrides.nodes ?? miniNodes();
  return {
    graphId: overrides.graphId ?? 'graph-1',
    graphRevision: overrides.graphRevision ?? 1,
    workflowTemplateId: overrides.workflowTemplateId ?? 'mini.v1',
    executionShape: overrides.executionShape ?? 'PIPELINE',
    requiredGateTypes: overrides.requiredGateTypes ?? ['RESULT_APPROVAL'],
    policy: overrides.policy ?? DEFAULT_POLICY,
    nodes,
    selections: overrides.selections ?? autoSelect(nodes),
  };
}

/** 3-node mutation fixture: implementer -> independent verifier -> terminal
 * synthesis. Used by mutation/verification-owner adversarial tests. */
function mutationNodes(): readonly ResolvedTemplateNode[] {
  return [
    makeNode({
      nodeId: 'impl',
      role: 'implementer-role',
      contract: baseContract({ produces: ['impl-out.v1'] }),
      requirement: baseRequirement({ role: 'implementer-role', mutationClass: 'LOCAL' }),
      mutation: { mutationClass: 'LOCAL', retryPolicy: 'RECONCILE_FIRST', verificationOwnerNodeId: 'verify' },
    }),
    makeNode({
      nodeId: 'verify',
      role: 'verifier-role',
      dependsOn: ['impl'],
      contract: baseContract({ consumes: ['impl-out.v1'], produces: ['verify-out.v1'] }),
      requirement: baseRequirement({ role: 'verifier-role', independentFromRoles: ['implementer-role'] }),
    }),
    makeNode({
      nodeId: 'synth',
      role: 'operator-synthesis',
      dependsOn: ['verify'],
      synthesisOwner: true,
      contract: baseContract({ consumes: ['verify-out.v1'], produces: ['synth-out.v1'] }),
      requirement: baseRequirement({ role: 'operator-synthesis' }),
    }),
  ];
}

function codesOf(errors: readonly { code: GraphCompilationErrorCode }[]): readonly GraphCompilationErrorCode[] {
  return errors.map((error) => error.code);
}

// ---------------------------------------------------------------------------
// Golden shapes: template selection
// ---------------------------------------------------------------------------

describe('selectWorkflowTemplateForFamily', () => {
  test('is deterministic and maps every V1 family to its one approved template', () => {
    const expected: Readonly<Record<TaskFamily, string | null>> = {
      PLAN: 'plan.v1',
      IMPLEMENT: 'implement.v1',
      QA: 'qa.v1',
      SECURITY: 'security.v1',
      UI: 'ui-change.v1',
      RESEARCH: 'research.v1',
      REVIEW: null,
      DIRECT: null,
      OPERATIONS: null,
    };
    for (const family of Object.keys(expected) as TaskFamily[]) {
      const templateId = expected[family];
      const first = selectWorkflowTemplateForFamily(family);
      const second = selectWorkflowTemplateForFamily(family);
      expect(first?.template.templateId ?? null).toBe(templateId);
      expect(second?.template.templateId ?? null).toBe(templateId);
    }
  });

  test('DIRECT never resolves to a template — callers must refuse, never fabricate a graph', () => {
    expect(selectWorkflowTemplateForFamily('DIRECT')).toBeNull();
  });

  test('registers exactly the six approved templates, each valid JSON-safe ids', () => {
    expect(listWorkflowTemplates()).toHaveLength(6);
    const ids = listWorkflowTemplates().map((registered) => registered.template.templateId);
    expect(new Set(ids).size).toBe(6);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*\.v[0-9]+$/);
      expect(getWorkflowTemplateById(id)?.template.templateId).toBe(id);
    }
  });
});

// ---------------------------------------------------------------------------
// Golden shapes: every registered template compiles cleanly end to end
// ---------------------------------------------------------------------------

describe('golden template compilation', () => {
  for (const registered of WORKFLOW_TEMPLATES) {
    test(`${registered.template.templateId} compiles with baseline policy and LOW risk`, () => {
      const resolvedNodes = resolveTemplateNodes(registered, DEFAULT_POLICY, 'LOW');
      const selections = autoSelect(resolvedNodes);
      const result = compileExecutionGraph({
        graphId: 'graph-golden',
        graphRevision: 1,
        workflowTemplateId: registered.template.templateId,
        executionShape: registered.template.executionShape,
        requiredGateTypes: registered.template.requiredGateTypes,
        policy: DEFAULT_POLICY,
        nodes: resolvedNodes,
        selections,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.graph.graphHash).toMatch(/^[0-9a-f]{64}$/);
        expect(result.graph.nodes).toHaveLength(resolvedNodes.length);
        expect(result.graph.workflowTemplateId).toBe(registered.template.templateId);
      }
    });
  }

  test('plan.v1: policy-controlled nodes are absent unless promoted to mandatory', () => {
    const registered = getWorkflowTemplateById('plan.v1');
    expect(registered).toBeDefined();
    if (registered === undefined) return;

    const baseline = resolveTemplateNodes(registered, DEFAULT_POLICY, 'HIGH');
    expect(baseline.map((node) => node.nodeId)).not.toContain('scope-freeze');
    expect(baseline.map((node) => node.nodeId)).not.toContain('adversarial-review');

    const strict = buildPolicy({ rules: { scopeFreezeRequired: true, adversarialReviewForHighRisk: true } });
    const promoted = resolveTemplateNodes(registered, strict, 'HIGH');
    expect(promoted.find((node) => node.nodeId === 'scope-freeze')?.mandatory).toBe(true);
    expect(promoted.find((node) => node.nodeId === 'adversarial-review')?.mandatory).toBe(true);

    // Adversarial review requires BOTH the policy flag and a HIGH/CRITICAL risk classification.
    const promotedButLowRisk = resolveTemplateNodes(registered, strict, 'LOW');
    expect(promotedButLowRisk.map((node) => node.nodeId)).not.toContain('adversarial-review');
    expect(promotedButLowRisk.find((node) => node.nodeId === 'scope-freeze')?.mandatory).toBe(true);
  });

  test('implement.v1: implementer mutation is verified by an independent node, never itself', () => {
    const registered = getWorkflowTemplateById('implement.v1');
    expect(registered).toBeDefined();
    if (registered === undefined) return;
    const nodes = resolveTemplateNodes(registered, DEFAULT_POLICY, 'LOW');
    const conformance = nodes.find((node) => node.nodeId === 'conformance-verification');
    expect(conformance?.contract.consumes).toContain('frozen-plan.v1');
    const implementer = nodes.find((node) => node.nodeId === 'implementer');
    expect(implementer?.mutation?.mutationClass).toBe('LOCAL');
    expect(implementer?.mutation?.verificationOwnerNodeId).not.toBe('implementer');
    const result = compileExecutionGraph({
      graphId: 'graph-implement',
      graphRevision: 1,
      workflowTemplateId: registered.template.templateId,
      executionShape: registered.template.executionShape,
      requiredGateTypes: registered.template.requiredGateTypes,
      policy: DEFAULT_POLICY,
      nodes,
      selections: autoSelect(nodes),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const implNode = result.graph.nodes.find((node) => node.nodeId === 'implementer');
      expect(implNode?.verificationOwnerNodeId).toBeDefined();
      expect(implNode?.verificationOwnerNodeId).not.toBe('implementer');
      expect(implNode?.mutation?.mutationId).toBe('graph-implement:implementer');
    }
  });
  test('research.v1: exactly one group synthesis owner, group size bounded by maxConcurrency', () => {
    const registered = getWorkflowTemplateById('research.v1');
    expect(registered).toBeDefined();
    if (registered === undefined) return;
    const nodes = resolveTemplateNodes(registered, DEFAULT_POLICY, 'LOW');
    const optionalResearcher = nodes.find((node) => node.nodeId === 'researcher-c');
    expect(optionalResearcher?.mandatory).toBe(false);
    const groupOwners = nodes.filter((node) => node.groupId === 'research-group' && node.synthesisOwner);
    expect(groupOwners).toHaveLength(1);

    const roomyPolicy = buildPolicy({ maxConcurrency: 3 });
    const roomy = compileExecutionGraph({
      graphId: 'graph-research-ok',
      graphRevision: 1,
      workflowTemplateId: registered.template.templateId,
      executionShape: registered.template.executionShape,
      requiredGateTypes: registered.template.requiredGateTypes,
      policy: roomyPolicy,
      nodes,
      selections: autoSelect(nodes),
    });
    expect(roomy.ok).toBe(true);

    const tightPolicy = buildPolicy({ maxConcurrency: 2 });
    const tight = compileExecutionGraph({
      graphId: 'graph-research-tight',
      graphRevision: 1,
      workflowTemplateId: registered.template.templateId,
      executionShape: registered.template.executionShape,
      requiredGateTypes: registered.template.requiredGateTypes,
      policy: tightPolicy,
      nodes,
      selections: autoSelect(nodes),
    });
    expect(tight.ok).toBe(false);
    if (!tight.ok) {
      expect(codesOf(tight.errors)).toContain('CONCURRENCY_CEILING_EXCEEDED');
    }
  });
});

// ---------------------------------------------------------------------------
// graphHash determinism
// ---------------------------------------------------------------------------

describe('graphHash', () => {
  test('is stable across repeated compiles of identical input', () => {
    const first = compileExecutionGraph(miniInput());
    const second = compileExecutionGraph(miniInput());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.graph.graphHash).toBe(second.graph.graphHash);
    }
  });

  test('changes when graphId changes', () => {
    const a = compileExecutionGraph(miniInput({ graphId: 'graph-a' }));
    const b = compileExecutionGraph(miniInput({ graphId: 'graph-b' }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.graph.graphHash).not.toBe(b.graph.graphHash);
    }
  });
});

// ---------------------------------------------------------------------------
// Adversarial: structural invariants
// ---------------------------------------------------------------------------

describe('structural invariants', () => {
  test('rejects a duplicate node id', () => {
    const nodes = miniNodes();
    const withDuplicate = [...nodes, nodes[0] as ResolvedTemplateNode];
    const result = compileExecutionGraph(miniInput({ nodes: withDuplicate, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('DUPLICATE_NODE_ID');
  });

  test('rejects a duplicate dependsOn entry on one node', () => {
    const nodes = miniNodes().map((node) => (node.nodeId === 'b' ? { ...node, dependsOn: ['a', 'a'] } : node));
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('DUPLICATE_DEPENDENCY');
  });

  test('rejects a dependency on an unknown node', () => {
    const nodes = miniNodes().map((node) => (node.nodeId === 'b' ? { ...node, dependsOn: ['ghost'] } : node));
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('UNKNOWN_DEPENDENCY');
  });

  test('rejects a dependency cycle', () => {
    const nodes = [
      makeNode({ nodeId: 'x', dependsOn: ['y'] }),
      makeNode({ nodeId: 'y', dependsOn: ['x'] }),
    ];
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('CYCLE_DETECTED');
  });

  test('rejects a mandatory node with no capability selection', () => {
    const nodes = miniNodes();
    const selections = autoSelect(nodes);
    delete selections['b'];
    const result = compileExecutionGraph(miniInput({ nodes, selections }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MISSING_SELECTION');
  });
});

// ---------------------------------------------------------------------------
// Adversarial: capability / role alignment
// ---------------------------------------------------------------------------

describe('capability and role alignment', () => {
  test('rejects a selection whose capabilities do not cover the required capability', () => {
    const nodes = miniNodes();
    const selections = autoSelect(nodes);
    const a = selections['a'] as CapabilitySelection;
    selections['a'] = { ...a, selected: { ...a.selected, capabilities: ['unrelated'] } };
    const result = compileExecutionGraph(miniInput({ nodes, selections }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('CAPABILITY_ROLE_MISMATCH');
  });

  test('rejects a selection whose supported shapes exclude the required shape', () => {
    const nodes = miniNodes();
    const selections = autoSelect(nodes);
    const a = selections['a'] as CapabilitySelection;
    selections['a'] = { ...a, selected: { ...a.selected, supports: ['COUNCIL'] } };
    const result = compileExecutionGraph(miniInput({ nodes, selections }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('CAPABILITY_SHAPE_UNSUPPORTED');
  });

  test('rejects granting a mutating capability to a read-only node (overreach)', () => {
    const nodes = miniNodes();
    const selections = autoSelect(nodes);
    const a = selections['a'] as CapabilitySelection;
    selections['a'] = { ...a, selected: { ...a.selected, mutability: 'MUTATING' } };
    const result = compileExecutionGraph(miniInput({ nodes, selections }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('CAPABILITY_OVERREACH');
  });

  test('rejects a read-only capability assigned to a node that must mutate (underpowered)', () => {
    const nodes = mutationNodes();
    const selections = autoSelect(nodes);
    const impl = selections['impl'] as CapabilitySelection;
    selections['impl'] = { ...impl, selected: { ...impl.selected, mutability: 'READ_ONLY' } };
    const result = compileExecutionGraph(miniInput({ nodes, selections, requiredGateTypes: ['RESULT_APPROVAL'] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('CAPABILITY_UNDERPOWERED');
  });
});

// ---------------------------------------------------------------------------
// Adversarial: mutation ceiling and verification independence
// ---------------------------------------------------------------------------

describe('mutation policy and verification independence', () => {
  test('baseline mutation fixture compiles cleanly', () => {
    const nodes = mutationNodes();
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(true);
  });

  test('rejects a mutation class above the resolved policy ceiling', () => {
    const nodes = mutationNodes();
    const restrictivePolicy = buildPolicy({ packs: [{ schemaVersion: '1.0', id: 'strict', version: 1, description: 'no local mutation', incompatibleWith: [], appliesTo: ['IMPLEMENT'], rules: { maximumMutationClass: 'READ_ONLY' } }] });
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes), policy: restrictivePolicy }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MUTATION_POLICY_VIOLATION');
  });

  test('rejects a mutation node whose verification owner resolved to the same capability id', () => {
    const nodes = mutationNodes();
    const selections = autoSelect(nodes);
    const impl = selections['impl'] as CapabilitySelection;
    const verify = selections['verify'] as CapabilitySelection;
    selections['verify'] = { ...verify, selected: { ...verify.selected, id: impl.selected.id } };
    const result = compileExecutionGraph(miniInput({ nodes, selections }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('SELF_VERIFICATION');
  });

  test('allows distinct verifier roles and capability identities on the same provider', () => {
    const nodes = mutationNodes();
    const selections = autoSelect(nodes);
    const impl = selections['impl'] as CapabilitySelection;
    const verify = selections['verify'] as CapabilitySelection;
    selections['verify'] = { ...verify, provider: impl.provider };
    const result = compileExecutionGraph(miniInput({ nodes, selections }));
    expect(result.ok).toBe(true);
  });

  test('rejects a mutation node whose verification owner does not exist', () => {
    const nodes = mutationNodes().map((node) =>
      node.nodeId === 'impl' ? { ...node, mutation: { ...(node.mutation as NonNullable<ResolvedTemplateNode['mutation']>), verificationOwnerNodeId: 'ghost' } } : node,
    );
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MISSING_VERIFICATION_OWNER');
  });

  test('rejects a mutation node declared as its own verification owner', () => {
    const nodes = mutationNodes().map((node) =>
      node.nodeId === 'impl' ? { ...node, mutation: { ...(node.mutation as NonNullable<ResolvedTemplateNode['mutation']>), verificationOwnerNodeId: 'impl' } } : node,
    );
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('SELF_VERIFICATION');
  });

  test("rejects a declared-independent reviewer that resolves to the implementer's own capability (non-mutation independence)", () => {
    const nodes = miniNodes().map((node) =>
      node.nodeId === 'b' ? { ...node, requirement: { ...node.requirement, independentFromRoles: ['role-a'] } } : node,
    );
    const selections = autoSelect(nodes);
    const a = selections['a'] as CapabilitySelection;
    const b = selections['b'] as CapabilitySelection;
    selections['b'] = { ...b, selected: { ...b.selected, id: a.selected.id } };
    const result = compileExecutionGraph(miniInput({ nodes, selections }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('SELF_VERIFICATION');
  });
});

// ---------------------------------------------------------------------------
// Adversarial: parallel/council synthesis and terminal operator synthesis
// ---------------------------------------------------------------------------

describe('parallel synthesis and terminal operator synthesis', () => {
  function groupedNodes(ownerCount: 0 | 1 | 2): readonly ResolvedTemplateNode[] {
    const g1 = makeNode({ nodeId: 'g1', groupId: 'grp', synthesisOwner: false, contract: baseContract({ produces: ['g1.v1'] }) });
    const g2 = makeNode({ nodeId: 'g2', groupId: 'grp', synthesisOwner: ownerCount >= 1, contract: baseContract({ produces: ['g2.v1'] }) });
    const g3 = makeNode({
      nodeId: 'g3',
      groupId: 'grp',
      synthesisOwner: ownerCount === 2,
      dependsOn: ['g1', 'g2'],
      contract: baseContract({ consumes: ['g1.v1', 'g2.v1'], produces: ['g3.v1'] }),
    });
    const synth = makeNode({
      nodeId: 'final',
      role: 'operator-synthesis',
      dependsOn: ['g3'],
      synthesisOwner: true,
      contract: baseContract({ consumes: ['g3.v1'], produces: ['final.v1'] }),
      requirement: baseRequirement({ role: 'operator-synthesis' }),
    });
    return [g1, g2, g3, synth];
  }

  test('rejects a parallel group with no synthesis owner', () => {
    const nodes = groupedNodes(0);
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('INVALID_PARALLEL_SYNTHESIS');
  });

  test('rejects a parallel group with two synthesis owners', () => {
    const nodes = groupedNodes(2);
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('INVALID_PARALLEL_SYNTHESIS');
  });

  test('accepts a parallel group with exactly one synthesis owner', () => {
    const nodes = groupedNodes(1);
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(true);
  });

  test('rejects PARALLEL/COUNCIL execution shape with fewer than two grouped nodes', () => {
    const nodes = groupedNodes(1);
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes), executionShape: 'PARALLEL' as ExecutionShape }));
    // groupedNodes has 3 grouped members, satisfying the >=2 rule — force the failure with a single grouped member instead.
    const singleGroupNodes = [
      makeNode({ nodeId: 'solo', groupId: 'grp', synthesisOwner: true, contract: baseContract({ produces: ['solo.v1'] }) }),
      makeNode({
        nodeId: 'final',
        role: 'operator-synthesis',
        dependsOn: ['solo'],
        synthesisOwner: true,
        contract: baseContract({ consumes: ['solo.v1'], produces: ['final.v1'] }),
        requirement: baseRequirement({ role: 'operator-synthesis' }),
      }),
    ];
    const singleResult = compileExecutionGraph(
      miniInput({ nodes: singleGroupNodes, selections: autoSelect(singleGroupNodes), executionShape: 'PARALLEL' as ExecutionShape }),
    );
    expect(result.ok).toBe(true);
    expect(singleResult.ok).toBe(false);
    if (!singleResult.ok) expect(codesOf(singleResult.errors)).toContain('INVALID_PARALLEL_SYNTHESIS');
  });

  test('rejects a graph with zero final operator-synthesis nodes', () => {
    const nodes = miniNodes().map((node) => (node.nodeId === 'synth' ? { ...node, synthesisOwner: false } : node));
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MISSING_SYNTHESIS_OWNER');
  });

  test('rejects a graph with two competing final operator-synthesis nodes', () => {
    const nodes = [...miniNodes(), makeNode({ nodeId: 'synth2', role: 'operator-synthesis', dependsOn: ['b'], synthesisOwner: true, contract: baseContract({ consumes: ['b-out.v1'] }) })];
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MISSING_SYNTHESIS_OWNER');
  });

  test('rejects a final synthesis node that is not mandatory', () => {
    const nodes = miniNodes().map((node) => (node.nodeId === 'synth' ? { ...node, mandatory: false } : node));
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MISSING_SYNTHESIS_OWNER');
  });

  test('rejects a final synthesis node that is not terminal (something depends on it)', () => {
    const nodes = [...miniNodes(), makeNode({ nodeId: 'after', dependsOn: ['synth'], contract: baseContract({ consumes: ['synth-out.v1'] }) })];
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MISSING_SYNTHESIS_OWNER');
  });

  test('rejects a final synthesis node that does not follow every other node (orphan branch)', () => {
    const nodes = [...miniNodes(), makeNode({ nodeId: 'orphan', contract: baseContract({ produces: ['orphan-out.v1'] }) })];
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MISSING_SYNTHESIS_OWNER');
  });
});

// ---------------------------------------------------------------------------
// Adversarial: gates, artifact contracts, concurrency
// ---------------------------------------------------------------------------

describe('gate, context/artifact contract, and concurrency invariants', () => {
  test('rejects a policy-required gate the template does not declare', () => {
    const result = compileExecutionGraph(miniInput({ requiredGateTypes: ['RESULT_APPROVAL'], policy: buildPolicy({ requiredGates: ['PLAN_APPROVAL'] }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('BYPASSED_MANDATORY_GATE');
  });

  test('accepts a policy-required gate the template does declare', () => {
    const result = compileExecutionGraph(miniInput({ requiredGateTypes: ['RESULT_APPROVAL'], policy: buildPolicy({ requiredGates: ['RESULT_APPROVAL'] }) }));
    expect(result.ok).toBe(true);
  });

  test('rejects a node that consumes an artifact type no ancestor produces', () => {
    const nodes = miniNodes().map((node) => (node.nodeId === 'b' ? { ...node, contract: baseContract({ consumes: ['ghost-artifact.v1'], produces: ['b-out.v1'] }) } : node));
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('MISSING_CONTEXT_CONTRACT');
  });

  test('rejects a parallel group whose concurrent membership exceeds policy maxConcurrency', () => {
    const g1 = makeNode({ nodeId: 'g1', groupId: 'grp', contract: baseContract({ produces: ['g1.v1'] }) });
    const g2 = makeNode({ nodeId: 'g2', groupId: 'grp', contract: baseContract({ produces: ['g2.v1'] }) });
    const g3 = makeNode({ nodeId: 'g3', groupId: 'grp', contract: baseContract({ produces: ['g3.v1'] }) });
    const owner = makeNode({
      nodeId: 'owner',
      groupId: 'grp',
      synthesisOwner: true,
      dependsOn: ['g1', 'g2', 'g3'],
      contract: baseContract({ consumes: ['g1.v1', 'g2.v1', 'g3.v1'], produces: ['owner.v1'] }),
    });
    const final = makeNode({
      nodeId: 'final',
      role: 'operator-synthesis',
      dependsOn: ['owner'],
      synthesisOwner: true,
      contract: baseContract({ consumes: ['owner.v1'] }),
      requirement: baseRequirement({ role: 'operator-synthesis' }),
    });
    const nodes = [g1, g2, g3, owner, final];
    const result = compileExecutionGraph(miniInput({ nodes, selections: autoSelect(nodes), policy: buildPolicy({ maxConcurrency: 2 }) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(codesOf(result.errors)).toContain('CONCURRENCY_CEILING_EXCEEDED');
  });
});

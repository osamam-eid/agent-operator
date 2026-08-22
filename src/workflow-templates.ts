/**
 * Agent Operator — Stage 3 approved workflow templates (plan §7).
 *
 * Declares the six V1-approved `WorkflowTemplate.v1` DAGs as capability
 * *role* names, never provider/model names. Concrete provider/model
 * assignment happens later, per session, in `graph.ts` + `registry.ts`.
 *
 * Two things live here that the fixed `WorkflowTemplate.v1` / stage3-types
 * shapes cannot express on their own:
 *
 * 1. Policy-controlled node activation. Scope-freeze and adversarial-review
 *    nodes are declared `mandatory: false` in the static template. Resolution
 *    removes them unless current policy requires them, then rewires downstream
 *    dependencies and consumed artifact types across the removed nodes.
 * 2. Which node independently verifies which other node's work (mutation
 *    verification ownership, reviewer independence). `WorkflowTemplateNode`
 *    has no field for this by design (it is compiler-owned knowledge, not
 *    portable template data), so it is tracked here as private per-template
 *    metadata and surfaced through `resolveTemplateNodes`.
 *
 * `resolveTemplateNodes` is a pure function: template + resolved policy +
 * risk classification in, a flat list of `ResolvedTemplateNode` out. It
 * does no I/O, no dispatch, no capability selection — `graph.ts` and
 * `registry.ts` do that from its output.
 */

import type {
  ExecutionShape,
  GateDecisionType,
  MutationClass,
  RetryPolicy,
  RiskLevel,
  TaskFamily,
  WorkflowTemplate,
  WorkflowTemplateNode,
} from './contracts.js';
import type { Stage7FeatureSet } from './stage7/types.js';

import type {
  CapabilityRequirement,
  RegisteredWorkflowTemplate,
  ResolvedPolicy,
  WorkflowNodeContract,
} from './stage3-types.js';

// ---------------------------------------------------------------------------
// Private template-authoring shapes (compiler-owned; not portable data)
// ---------------------------------------------------------------------------

interface TemplateNodeMutationSpec {
  readonly mutationClass: MutationClass;
  readonly retryPolicy: RetryPolicy;
  /** nodeId of this node's independent verification owner. */
  readonly verificationOwnerNodeId: string;
}

interface TemplateNodeSpec {
  readonly nodeId: string;
  readonly role: string;
  /** Declared mandatory flag before any policy-driven promotion. */
  readonly baseMandatory: boolean;
  readonly dependsOn: readonly string[];
  readonly groupId?: string;
  readonly synthesisOwner?: boolean;
  readonly contract: WorkflowNodeContract;
  readonly mutation?: TemplateNodeMutationSpec;
  /** nodeIds this node's assigned capability must differ from (reviewer/verifier independence). */
  readonly independentFromNodeIds?: readonly string[];
  /** Which boolean in `ResolvedPolicy.effectiveRules` promotes this node to mandatory. */
  readonly policyGate?: 'scopeFreeze' | 'adversarialReview';
}

interface TemplateDefinition {
  readonly templateId: string;
  readonly version: number;
  readonly taskFamilies: readonly TaskFamily[];
  readonly executionShape: ExecutionShape;
  readonly description: string;
  readonly requiredGateTypes: readonly GateDecisionType[];
  readonly nodes: readonly TemplateNodeSpec[];
}

// ---------------------------------------------------------------------------
// Template definitions (plan §7 "Approved templates")
// ---------------------------------------------------------------------------

const PLAN_V1: TemplateDefinition = {
  templateId: 'plan.v1',
  version: 1,
  taskFamilies: ['PLAN'],
  executionShape: 'PIPELINE',
  description: 'Preflight, plan, independently review, optionally freeze scope and adversarially review, then synthesize for a human plan decision. No mutation.',
  requiredGateTypes: ['PLAN_APPROVAL'],
  nodes: [
    {
      nodeId: 'preflight',
      role: 'context-preflight',
      baseMandatory: true,
      dependsOn: [],
      contract: { contextPolicy: 'shared', consumes: [], produces: ['request-context.v1'], requiredCapability: 'preflight' },
    },
    {
      nodeId: 'planner',
      role: 'planner',
      baseMandatory: true,
      dependsOn: ['preflight'],
      contract: { contextPolicy: 'isolated', consumes: ['request-context.v1'], produces: ['plan-draft.v1'], requiredCapability: 'planning' },
    },
    {
      nodeId: 'independent-review',
      role: 'independent-reviewer',
      baseMandatory: true,
      dependsOn: ['planner'],
      independentFromNodeIds: ['planner'],
      contract: { contextPolicy: 'evidence-only', consumes: ['plan-draft.v1'], produces: ['plan-review.v1'], requiredCapability: 'independent-review' },
    },
    {
      nodeId: 'scope-freeze',
      role: 'scope-freeze',
      baseMandatory: false,
      policyGate: 'scopeFreeze',
      dependsOn: ['independent-review'],
      contract: { contextPolicy: 'artifact-only', consumes: ['plan-review.v1'], produces: ['scope-freeze-record.v1'], requiredCapability: 'scope-freeze' },
    },
    {
      nodeId: 'adversarial-review',
      role: 'adversarial-reviewer',
      baseMandatory: false,
      policyGate: 'adversarialReview',
      dependsOn: ['scope-freeze'],
      independentFromNodeIds: ['planner', 'independent-review'],
      contract: { contextPolicy: 'evidence-only', consumes: ['scope-freeze-record.v1'], produces: ['adversarial-findings.v1'], requiredCapability: 'adversarial-review' },
    },
    {
      nodeId: 'operator-synthesis',
      role: 'operator-synthesis',
      baseMandatory: true,
      synthesisOwner: true,
      dependsOn: ['adversarial-review'],
      contract: {
        contextPolicy: 'summary-only',
        consumes: ['plan-review.v1', 'adversarial-findings.v1'],
        produces: ['operator-synthesis.v1'],
        requiredCapability: 'operator-synthesis',
      },
    },
  ],
};

const IMPLEMENT_V1: TemplateDefinition = {
  templateId: 'implement.v1',
  version: 1,
  taskFamilies: ['IMPLEMENT'],
  executionShape: 'PIPELINE',
  description: 'Implement against a frozen plan; behavioral and conformance verification are separate from the implementer; independent and risk-gated adversarial review precede synthesis.',
  requiredGateTypes: ['RESULT_APPROVAL'],
  nodes: [
    {
      nodeId: 'preflight',
      role: 'context-preflight',
      baseMandatory: true,
      dependsOn: [],
      contract: { contextPolicy: 'shared', consumes: [], produces: ['request-context.v1'], requiredCapability: 'preflight' },
    },
    {
      nodeId: 'approved-plan',
      role: 'plan-context-loader',
      baseMandatory: true,
      dependsOn: [],
      contract: { contextPolicy: 'artifact-only', consumes: [], produces: ['frozen-plan.v1'], requiredCapability: 'preflight' },
    },
    {
      nodeId: 'implementer',
      role: 'implementer',
      baseMandatory: true,
      dependsOn: ['preflight', 'approved-plan'],
      mutation: { mutationClass: 'LOCAL', retryPolicy: 'RECONCILE_FIRST', verificationOwnerNodeId: 'behavioral-verification' },
      contract: {
        contextPolicy: 'isolated',
        consumes: ['request-context.v1', 'frozen-plan.v1'],
        produces: ['implementation-diff.v1'],
        requiredCapability: 'implementation',
      },
    },
    {
      nodeId: 'behavioral-verification',
      role: 'behavioral-verifier',
      baseMandatory: true,
      dependsOn: ['implementer'],
      independentFromNodeIds: ['implementer'],
      contract: { contextPolicy: 'evidence-only', consumes: ['implementation-diff.v1'], produces: ['behavioral-verification.v1'], requiredCapability: 'behavioral-verification' },
    },
    {
      nodeId: 'conformance-verification',
      role: 'conformance-verifier',
      baseMandatory: true,
      dependsOn: ['implementer'],
      independentFromNodeIds: ['implementer'],
      contract: {
        contextPolicy: 'evidence-only',
        consumes: ['implementation-diff.v1', 'frozen-plan.v1'],
        produces: ['conformance-verification.v1'],
        requiredCapability: 'conformance-verification',
      },
    },
    {
      nodeId: 'independent-review',
      role: 'independent-reviewer',
      baseMandatory: true,
      dependsOn: ['behavioral-verification', 'conformance-verification'],
      independentFromNodeIds: ['implementer'],
      contract: {
        contextPolicy: 'evidence-only',
        consumes: ['behavioral-verification.v1', 'conformance-verification.v1'],
        produces: ['independent-review.v1'],
        requiredCapability: 'independent-review',
      },
    },
    {
      nodeId: 'adversarial-review',
      role: 'adversarial-reviewer',
      baseMandatory: false,
      policyGate: 'adversarialReview',
      dependsOn: ['independent-review'],
      independentFromNodeIds: ['implementer', 'independent-review'],
      contract: { contextPolicy: 'evidence-only', consumes: ['independent-review.v1'], produces: ['adversarial-findings.v1'], requiredCapability: 'adversarial-review' },
    },
    {
      nodeId: 'operator-synthesis',
      role: 'operator-synthesis',
      baseMandatory: true,
      synthesisOwner: true,
      dependsOn: ['adversarial-review'],
      contract: {
        contextPolicy: 'summary-only',
        consumes: ['independent-review.v1', 'adversarial-findings.v1'],
        produces: ['operator-synthesis.v1'],
        requiredCapability: 'operator-synthesis',
      },
    },
  ],
};

const QA_V1: TemplateDefinition = {
  templateId: 'qa.v1',
  version: 1,
  taskFamilies: ['QA'],
  executionShape: 'PIPELINE',
  description: 'Deployment/spec preflight, QA execution, evidence collection, independent QA review, report.',
  requiredGateTypes: ['RESULT_APPROVAL'],
  nodes: [
    {
      nodeId: 'preflight',
      role: 'qa-preflight',
      baseMandatory: true,
      dependsOn: [],
      contract: { contextPolicy: 'shared', consumes: [], produces: ['deployment-context.v1'], requiredCapability: 'preflight' },
    },
    {
      nodeId: 'qa-execution',
      role: 'qa-executor',
      baseMandatory: true,
      dependsOn: ['preflight'],
      contract: { contextPolicy: 'isolated', consumes: ['deployment-context.v1'], produces: ['qa-execution-log.v1'], requiredCapability: 'qa-execution' },
    },
    {
      nodeId: 'evidence-collection',
      role: 'evidence-collector',
      baseMandatory: true,
      dependsOn: ['qa-execution'],
      contract: { contextPolicy: 'artifact-only', consumes: ['qa-execution-log.v1'], produces: ['qa-evidence.v1'], requiredCapability: 'qa-review' },
    },
    {
      nodeId: 'qa-review',
      role: 'independent-reviewer',
      baseMandatory: true,
      dependsOn: ['evidence-collection'],
      independentFromNodeIds: ['qa-execution'],
      contract: { contextPolicy: 'evidence-only', consumes: ['qa-evidence.v1'], produces: ['qa-review.v1'], requiredCapability: 'independent-review' },
    },
    {
      nodeId: 'report',
      role: 'operator-synthesis',
      baseMandatory: true,
      synthesisOwner: true,
      dependsOn: ['qa-review'],
      contract: { contextPolicy: 'summary-only', consumes: ['qa-review.v1'], produces: ['qa-report.v1'], requiredCapability: 'operator-synthesis' },
    },
  ],
};

const SECURITY_V1: TemplateDefinition = {
  templateId: 'security.v1',
  version: 1,
  taskFamilies: ['SECURITY'],
  executionShape: 'PIPELINE',
  description: 'Security review, independent finding validation, operator synthesis, human decision.',
  requiredGateTypes: ['RESULT_APPROVAL'],
  nodes: [
    {
      nodeId: 'security-review',
      role: 'security-reviewer',
      baseMandatory: true,
      dependsOn: [],
      contract: { contextPolicy: 'isolated', consumes: [], produces: ['security-findings.v1'], requiredCapability: 'security-review' },
    },
    {
      nodeId: 'finding-validation',
      role: 'independent-reviewer',
      baseMandatory: true,
      dependsOn: ['security-review'],
      independentFromNodeIds: ['security-review'],
      contract: { contextPolicy: 'evidence-only', consumes: ['security-findings.v1'], produces: ['validated-findings.v1'], requiredCapability: 'independent-review' },
    },
    {
      nodeId: 'operator-synthesis',
      role: 'operator-synthesis',
      baseMandatory: true,
      synthesisOwner: true,
      dependsOn: ['finding-validation'],
      contract: { contextPolicy: 'summary-only', consumes: ['validated-findings.v1'], produces: ['operator-synthesis.v1'], requiredCapability: 'operator-synthesis' },
    },
  ],
};

const UI_CHANGE_V1: TemplateDefinition = {
  templateId: 'ui-change.v1',
  version: 1,
  taskFamilies: ['UI'],
  executionShape: 'PIPELINE',
  description: 'UI design, implementation, independent design review, visual verification, human approval.',
  requiredGateTypes: ['RESULT_APPROVAL'],
  nodes: [
    {
      nodeId: 'ui-design',
      role: 'ui-designer',
      baseMandatory: true,
      dependsOn: [],
      contract: { contextPolicy: 'isolated', consumes: [], produces: ['ui-design-spec.v1'], requiredCapability: 'ui-design' },
    },
    {
      nodeId: 'ui-implementation',
      role: 'ui-implementer',
      baseMandatory: true,
      dependsOn: ['ui-design'],
      mutation: { mutationClass: 'LOCAL', retryPolicy: 'RECONCILE_FIRST', verificationOwnerNodeId: 'design-review' },
      contract: { contextPolicy: 'isolated', consumes: ['ui-design-spec.v1'], produces: ['ui-implementation-diff.v1'], requiredCapability: 'ui-implementation' },
    },
    {
      nodeId: 'design-review',
      role: 'independent-reviewer',
      baseMandatory: true,
      dependsOn: ['ui-implementation'],
      independentFromNodeIds: ['ui-design', 'ui-implementation'],
      contract: { contextPolicy: 'evidence-only', consumes: ['ui-implementation-diff.v1'], produces: ['design-review.v1'], requiredCapability: 'independent-review' },
    },
    {
      nodeId: 'visual-verification',
      role: 'visual-verifier',
      baseMandatory: true,
      dependsOn: ['design-review'],
      contract: { contextPolicy: 'evidence-only', consumes: ['design-review.v1'], produces: ['visual-verification.v1'], requiredCapability: 'ui-visual-verification' },
    },
    {
      nodeId: 'operator-synthesis',
      role: 'operator-synthesis',
      baseMandatory: true,
      synthesisOwner: true,
      dependsOn: ['visual-verification'],
      contract: { contextPolicy: 'summary-only', consumes: ['visual-verification.v1'], produces: ['operator-synthesis.v1'], requiredCapability: 'operator-synthesis' },
    },
  ],
};

const RESEARCH_V1: TemplateDefinition = {
  templateId: 'research.v1',
  version: 1,
  taskFamilies: ['RESEARCH'],
  executionShape: 'PARALLEL',
  description: 'Independent parallel researchers, one group synthesis owner, risk-gated independent verification, operator synthesis.',
  requiredGateTypes: ['RESULT_APPROVAL'],
  nodes: [
    {
      nodeId: 'researcher-a',
      role: 'researcher',
      baseMandatory: true,
      dependsOn: [],
      groupId: 'research-group',
      contract: { contextPolicy: 'isolated', consumes: [], produces: ['research-finding-a.v1'], requiredCapability: 'research' },
    },
    {
      nodeId: 'researcher-b',
      role: 'researcher',
      baseMandatory: true,
      dependsOn: [],
      groupId: 'research-group',
      contract: { contextPolicy: 'isolated', consumes: [], produces: ['research-finding-b.v1'], requiredCapability: 'research' },
    },
    {
      nodeId: 'researcher-c',
      role: 'researcher',
      baseMandatory: false,
      dependsOn: [],
      groupId: 'research-group',
      contract: { contextPolicy: 'isolated', consumes: [], produces: ['research-finding-c.v1'], requiredCapability: 'research' },
    },
    {
      nodeId: 'research-synthesis',
      role: 'research-synthesizer',
      baseMandatory: true,
      synthesisOwner: true,
      groupId: 'research-group',
      dependsOn: ['researcher-a', 'researcher-b', 'researcher-c'],
      contract: {
        contextPolicy: 'summary-only',
        consumes: ['research-finding-a.v1', 'research-finding-b.v1', 'research-finding-c.v1'],
        produces: ['research-synthesis.v1'],
        requiredCapability: 'synthesis',

      },
    },
    {
      nodeId: 'verifier',
      role: 'independent-reviewer',
      baseMandatory: false,
      policyGate: 'adversarialReview',
      dependsOn: ['research-synthesis'],
      independentFromNodeIds: ['researcher-a', 'researcher-b', 'researcher-c'],
      contract: { contextPolicy: 'evidence-only', consumes: ['research-synthesis.v1'], produces: ['research-verification.v1'], requiredCapability: 'independent-review' },
    },
    {
      nodeId: 'operator-synthesis',
      role: 'operator-synthesis',
      baseMandatory: true,
      synthesisOwner: true,
      dependsOn: ['verifier'],
      contract: {
        contextPolicy: 'summary-only',
        consumes: ['research-synthesis.v1', 'research-verification.v1'],
        produces: ['operator-synthesis.v1'],
        requiredCapability: 'operator-synthesis',
      },
    },
  ],
};

const UI_CHANGE_V2: TemplateDefinition = {
  templateId: 'ui-change.v2',
  version: 2,
  taskFamilies: ['UI'],
  executionShape: 'PIPELINE',
  description: 'Stage-7 governed UI candidate lifecycle with Impeccable design, governed implementation, provider-neutral Sol assurance, contained visual verification, and synthesis.',
  requiredGateTypes: ['RESULT_APPROVAL'],
  nodes: [
    { nodeId: 'ui-v2-impeccable-design', role: 'ui-v2-impeccable-designer', baseMandatory: true, dependsOn: [], contract: { contextPolicy: 'isolated', consumes: [], produces: ['ui-design-spec.v1'], requiredCapability: 'ui-v2-design' } },
    { nodeId: 'ui-v2-governed-implementation', role: 'ui-v2-implementer', baseMandatory: true, dependsOn: ['ui-v2-impeccable-design'], mutation: { mutationClass: 'LOCAL', retryPolicy: 'RECONCILE_FIRST', verificationOwnerNodeId: 'ui-v2-sol-review' }, contract: { contextPolicy: 'isolated', consumes: ['ui-design-spec.v1'], produces: ['ui-implementation-diff.v1', 'ui-candidate-bundle.v1'], requiredCapability: 'ui-v2-implementation' } },
    { nodeId: 'ui-v2-sol-review', role: 'ui-v2-sol-reviewer', baseMandatory: true, dependsOn: ['ui-v2-governed-implementation'], independentFromNodeIds: ['ui-v2-impeccable-design', 'ui-v2-governed-implementation'], contract: { contextPolicy: 'evidence-only', consumes: ['ui-implementation-diff.v1', 'ui-candidate-bundle.v1'], produces: ['design-review.v1'], requiredCapability: 'ui-v2-sol-assurance' } },
    { nodeId: 'ui-v2-visual-verification', role: 'ui-v2-visual-verifier', baseMandatory: true, dependsOn: ['ui-v2-sol-review'], contract: { contextPolicy: 'evidence-only', consumes: ['design-review.v1', 'ui-candidate-bundle.v1'], produces: ['ui-visual-verification.v1'], requiredCapability: 'ui-v2-visual-verification' } },
    { nodeId: 'ui-v2-synthesis', role: 'ui-v2-synthesizer', baseMandatory: true, synthesisOwner: true, dependsOn: ['ui-v2-visual-verification'], contract: { contextPolicy: 'summary-only', consumes: ['ui-visual-verification.v1'], produces: ['operator-synthesis.v1'], requiredCapability: 'ui-v2-synthesis' } },
  ],
};

const QA_V2: TemplateDefinition = {
  templateId: 'qa.v2',
  version: 2,
  taskFamilies: ['QA'],
  executionShape: 'PIPELINE',
  description: 'Stage-7 governed QA with human-bound environment authority, evidence normalization, independent Terra assurance, and cleanup disposition.',
  requiredGateTypes: ['RESULT_APPROVAL'],
  nodes: [
    { nodeId: 'qa-v2-preflight', role: 'qa-v2-preflight', baseMandatory: true, dependsOn: [], contract: { contextPolicy: 'shared', consumes: [], produces: ['deployment-context.v1'], requiredCapability: 'qa-v2-preflight' } },
    { nodeId: 'qa-v2-execution', role: 'qa-v2-executor', baseMandatory: true, dependsOn: ['qa-v2-preflight'], contract: { contextPolicy: 'isolated', consumes: ['deployment-context.v1'], produces: ['qa-execution-log.v1'], requiredCapability: 'qa-v2-execution' } },
    { nodeId: 'qa-v2-evidence', role: 'qa-v2-evidence-collector', baseMandatory: true, dependsOn: ['qa-v2-execution'], contract: { contextPolicy: 'artifact-only', consumes: ['qa-execution-log.v1'], produces: ['qa-evidence.v1'], requiredCapability: 'qa-v2-evidence' } },
    { nodeId: 'qa-v2-terra-review', role: 'qa-v2-terra-reviewer', baseMandatory: true, dependsOn: ['qa-v2-evidence'], independentFromNodeIds: ['qa-v2-execution'], contract: { contextPolicy: 'evidence-only', consumes: ['qa-evidence.v1'], produces: ['qa-review.v1'], requiredCapability: 'qa-v2-independent-review' } },
    { nodeId: 'qa-v2-report', role: 'qa-v2-synthesizer', baseMandatory: true, synthesisOwner: true, dependsOn: ['qa-v2-terra-review'], contract: { contextPolicy: 'summary-only', consumes: ['qa-review.v1'], produces: ['qa-report.v1'], requiredCapability: 'qa-v2-synthesis' } },
  ],
};

const FLEET_V1: TemplateDefinition = {
  templateId: 'fleet.v1',
  version: 1,
  taskFamilies: ['OPERATIONS'],
  executionShape: 'SINGLE',
  description: 'Stage-9 fleet dispatch: one human-curated external-cli provider executes the request under compiled ceilings with bounded in-attempt fallback. Explicit invocation only.',
  requiredGateTypes: ['RESULT_APPROVAL'],
  nodes: [
    { nodeId: 'fleet-task', role: 'fleet-v1-executor', baseMandatory: true, dependsOn: [], contract: { contextPolicy: 'shared', consumes: [], produces: ['fleet-execution.v1'], requiredCapability: 'fleet-execution' } },
  ],
};

const V1_TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [PLAN_V1, IMPLEMENT_V1, QA_V1, SECURITY_V1, UI_CHANGE_V1, RESEARCH_V1];
const STAGE7_TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [QA_V2, UI_CHANGE_V2];
const STAGE9_TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [FLEET_V1];
const TEMPLATE_DEFINITIONS: readonly TemplateDefinition[] = [...V1_TEMPLATE_DEFINITIONS, ...STAGE7_TEMPLATE_DEFINITIONS, ...STAGE9_TEMPLATE_DEFINITIONS];

function buildRegisteredTemplate(def: TemplateDefinition): RegisteredWorkflowTemplate {
  const nodes: readonly WorkflowTemplateNode[] = def.nodes.map((spec) => ({
    nodeId: spec.nodeId,
    role: spec.role,
    mandatory: spec.baseMandatory,
    dependsOn: spec.dependsOn,
    ...(spec.groupId !== undefined ? { groupId: spec.groupId } : {}),
    ...(spec.synthesisOwner === true ? { synthesisOwner: true } : {}),
    ...(spec.mutation !== undefined ? { mutationClass: spec.mutation.mutationClass } : {}),
  }));
  const template: WorkflowTemplate = {
    templateId: def.templateId,
    version: def.version,
    taskFamilies: def.taskFamilies,
    executionShape: def.executionShape,
    description: def.description,
    nodes,
    requiredGateTypes: def.requiredGateTypes,
  };
  const nodeContracts: Record<string, WorkflowNodeContract> = {};
  for (const spec of def.nodes) {
    nodeContracts[spec.nodeId] = spec.contract;
  }
  return { template, nodeContracts };
}

/** Frozen Stage-1–6 templates remain the default public registry. */
export const WORKFLOW_TEMPLATES: readonly RegisteredWorkflowTemplate[] = V1_TEMPLATE_DEFINITIONS.map(buildRegisteredTemplate);
export const STAGE7_WORKFLOW_TEMPLATES: readonly RegisteredWorkflowTemplate[] = STAGE7_TEMPLATE_DEFINITIONS.map(buildRegisteredTemplate);
export const STAGE9_WORKFLOW_TEMPLATES: readonly RegisteredWorkflowTemplate[] = STAGE9_TEMPLATE_DEFINITIONS.map(buildRegisteredTemplate);

const TEMPLATE_DEFINITION_BY_ID: Readonly<Record<string, TemplateDefinition>> = Object.fromEntries(
  TEMPLATE_DEFINITIONS.map((def) => [def.templateId, def]),
);

const REGISTERED_TEMPLATE_BY_ID: Readonly<Record<string, RegisteredWorkflowTemplate>> = Object.fromEntries(
  [...WORKFLOW_TEMPLATES, ...STAGE7_WORKFLOW_TEMPLATES, ...STAGE9_WORKFLOW_TEMPLATES].map((registered) => [registered.template.templateId, registered]),
);

const TEMPLATE_BY_FAMILY: Readonly<Partial<Record<TaskFamily, RegisteredWorkflowTemplate>>> = Object.fromEntries(
  WORKFLOW_TEMPLATES.flatMap((registered) => registered.template.taskFamilies.map((family) => [family, registered] as const)),
);
const STAGE7_TEMPLATE_BY_FAMILY: Readonly<Partial<Record<TaskFamily, RegisteredWorkflowTemplate>>> = Object.fromEntries(
  STAGE7_WORKFLOW_TEMPLATES.flatMap((registered) => registered.template.taskFamilies.map((family) => [family, registered] as const)),
);

export function listWorkflowTemplates(featureSet?: Stage7FeatureSet): readonly RegisteredWorkflowTemplate[] {
  return featureSet?.stage7Enabled === true ? [...WORKFLOW_TEMPLATES, ...STAGE7_WORKFLOW_TEMPLATES] : WORKFLOW_TEMPLATES;
}

export function getWorkflowTemplateById(templateId: string, featureSet?: Stage7FeatureSet): RegisteredWorkflowTemplate | undefined {
  const template = REGISTERED_TEMPLATE_BY_ID[templateId];
  if ((templateId === 'qa.v2' || templateId === 'ui-change.v2') && featureSet?.stage7Enabled !== true) return undefined;
  if (templateId === 'fleet.v1' && featureSet?.stage9ExternalProvidersEnabled !== true) return undefined;
  return template;
}

export function selectWorkflowTemplateForFamily(taskFamily: TaskFamily, featureSet?: Stage7FeatureSet): RegisteredWorkflowTemplate | null {
  if (taskFamily === 'DIRECT') return null;
  if (featureSet?.stage7Enabled === true && (taskFamily === 'QA' || taskFamily === 'UI')) return STAGE7_TEMPLATE_BY_FAMILY[taskFamily] ?? null;
  return TEMPLATE_BY_FAMILY[taskFamily] ?? null;
}

// ---------------------------------------------------------------------------
// Policy-aware node resolution
// ---------------------------------------------------------------------------

export interface ResolvedTemplateNodeMutation {
  readonly mutationClass: MutationClass;
  readonly retryPolicy: RetryPolicy;
  readonly verificationOwnerNodeId: string;
}

export interface ResolvedTemplateNode {
  readonly nodeId: string;
  readonly role: string;
  /** False only for genuinely optional compiled nodes; policy-disabled conditional nodes are removed. */
  readonly mandatory: boolean;

  /** Base template value, promoted per policy for scope-freeze/adversarial-review nodes. */
  readonly dependsOn: readonly string[];
  readonly groupId?: string;
  readonly synthesisOwner: boolean;
  readonly mutation?: ResolvedTemplateNodeMutation;
  readonly contract: WorkflowNodeContract;
  readonly requirement: CapabilityRequirement;
}

function resolveMandatory(spec: TemplateNodeSpec, policy: ResolvedPolicy, risk: RiskLevel): boolean {
  if (spec.baseMandatory) {
    return true;
  }
  if (spec.policyGate === 'scopeFreeze') {
    return policy.effectiveRules.scopeFreezeRequired;
  }
  if (spec.policyGate === 'adversarialReview') {
    return policy.effectiveRules.adversarialReviewForHighRisk && (risk === 'HIGH' || risk === 'CRITICAL');
  }
  return false;
}

/**
 * Resolves a registered template's nodes against a resolved policy and risk
 * classification: promotes policy-controlled `mandatory` flags and derives
 * each node's `CapabilityRequirement` for `CapabilityRegistry.select`. Pure;
 * performs no capability selection, no I/O.
 *
 * Only works for templates returned by this module (`WORKFLOW_TEMPLATES`,
 * `getWorkflowTemplateById`, `selectWorkflowTemplateForFamily`) — verification
 * ownership and reviewer independence are compiler-owned knowledge that does
 * not belong in portable template data.
 */
export function resolveTemplateNodes(
  template: RegisteredWorkflowTemplate,
  policy: ResolvedPolicy,
  riskClassification: RiskLevel,
): readonly ResolvedTemplateNode[] {
  const def = TEMPLATE_DEFINITION_BY_ID[template.template.templateId];
  if (def === undefined) {
    throw new Error(`resolveTemplateNodes: "${template.template.templateId}" is not a registered Stage 3 template.`);
  }

  const specByNodeId: Readonly<Record<string, TemplateNodeSpec>> = Object.fromEntries(
    def.nodes.map((spec) => [spec.nodeId, spec]),
  );
  const activeSpecs = def.nodes.filter(
    (spec) => spec.policyGate === undefined || resolveMandatory(spec, policy, riskClassification),
  );
  const activeNodeIds = new Set(activeSpecs.map((spec) => spec.nodeId));
  const roleByNodeId: Readonly<Record<string, string>> = Object.fromEntries(
    activeSpecs.map((spec) => [spec.nodeId, spec.role]),
  );

  const activeDependencies = (nodeId: string, visiting: ReadonlySet<string> = new Set()): readonly string[] => {
    const spec = specByNodeId[nodeId];
    if (spec === undefined) {
      throw new Error(`Template "${def.templateId}" references unknown nodeId "${nodeId}".`);
    }
    if (visiting.has(nodeId)) {
      throw new Error(`Template "${def.templateId}" contains a dependency cycle at "${nodeId}".`);
    }
    const nextVisiting = new Set(visiting);
    nextVisiting.add(nodeId);
    const resolved: string[] = [];
    for (const dependencyId of spec.dependsOn) {
      if (activeNodeIds.has(dependencyId)) {
        resolved.push(dependencyId);
      } else {
        resolved.push(...activeDependencies(dependencyId, nextVisiting));
      }
    }
    return Array.from(new Set(resolved));
  };

  return activeSpecs.map((spec): ResolvedTemplateNode => {
    const dependsOn = activeDependencies(spec.nodeId);
    const inactiveDirectDependencies = spec.dependsOn.filter((dependencyId) => !activeNodeIds.has(dependencyId));
    const inactiveProducedArtifacts = new Set(
      inactiveDirectDependencies.flatMap((dependencyId) => specByNodeId[dependencyId]?.contract.produces ?? []),
    );
    const consumes =
      inactiveDirectDependencies.length === 0
        ? spec.contract.consumes
        : Array.from(
            new Set([
              ...spec.contract.consumes.filter((artifactType) => !inactiveProducedArtifacts.has(artifactType)),
              ...dependsOn.flatMap((dependencyId) => specByNodeId[dependencyId]?.contract.produces ?? []),
            ]),
          );
    const contract: WorkflowNodeContract = { ...spec.contract, consumes };
    const executionShape: CapabilityRequirement['executionShape'] = spec.groupId !== undefined ? 'PARALLEL' : 'SINGLE';
    const requirement: CapabilityRequirement = {
      role: spec.role,
      capability: contract.requiredCapability,
      executionShape,
      mutationClass: spec.mutation?.mutationClass ?? 'READ_ONLY',
      independentFromRoles: (spec.independentFromNodeIds ?? [])
        .filter((nodeId) => activeNodeIds.has(nodeId))
        .map((nodeId) => {
          const role = roleByNodeId[nodeId];
          if (role === undefined) {
            throw new Error(`Template "${def.templateId}" node "${spec.nodeId}" declares independence from unknown active nodeId "${nodeId}".`);
          }
          return role;
        }),
    };
    return {
      nodeId: spec.nodeId,
      role: spec.role,
      mandatory: resolveMandatory(spec, policy, riskClassification),
      dependsOn,
      synthesisOwner: spec.synthesisOwner === true,
      contract,
      requirement,
      ...(spec.groupId !== undefined ? { groupId: spec.groupId } : {}),
      ...(spec.mutation !== undefined
        ? {
            mutation: {
              mutationClass: spec.mutation.mutationClass,
              retryPolicy: spec.mutation.retryPolicy,
              verificationOwnerNodeId: spec.mutation.verificationOwnerNodeId,
            },
          }
        : {}),
    };
  });
}

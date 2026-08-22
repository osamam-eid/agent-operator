/**
 * Agent Operator — Stage 4 policy and workflow compiler.
 *
 * `createStage3WorkflowCompiler()` wires the classifier, config/trust layer,
 * policy engine, workflow-template registry, capability registry, and
 * graph compiler into a single `OperatorWorkflowCompiler.compile()` call:
 *
 *   request
 *     -> classify                         (classifier.ts)
 *     -> resolve config + project trust   (config.ts)
 *     -> load + resolve policy            (policy.ts)
 *     -> select a registered template     (workflow-templates.ts)
 *     -> resolve template nodes           (workflow-templates.ts)
 *     -> select capabilities per node     (registry.ts)
 *     -> compile + validate the graph     (graph.ts)
 *     -> build RouteDecision + initial HumanGate
 *
 * Every sibling module in this pipeline may throw a typed error (or, for
 * the graph compiler, return an `ok: false` result). None of that is ever
 * allowed to escape `compile()`: each stage is caught locally and converted
 * to a typed `CompilationResult` failure with the most specific applicable
 * `CompilationFailureCode`. `compile()` itself never throws.
 *
 * `compile()` still dispatches nothing by itself — it only ever selects a
 * `CapabilityRecord` and validates a graph. As of Stage 4 its default
 * `registryFactory` resolves against `registry.ts`'s production `omp-task`
 * records (`createProductionCapabilityRegistry`), not the Stage 1-3 mock
 * registry: a mock record can no longer be selected unless a caller
 * explicitly overrides `registryFactory` (as every test in this package
 * does). Whether anything is actually dispatched from a compiled graph is
 * entirely the caller's (controller/adapter) decision.
 */

import type {
  FallbackDecision,
  GateDecisionType,
  HumanGate,
  RejectedAlternative,
  RoleAssignment,
  RouteDecision,
} from './contracts.js';
import { validateRouteDecision } from './validation/core-contracts.js';
import { validateHumanGate } from './validation/session.js';
import { createMockOperatorClassifier } from './classifier.js';
import { loadResolvedOperatorConfig, OperatorConfigError, type LoadOperatorConfigOptions } from './config.js';
import { DEFAULT_POLICIES_DIR, loadPolicyPacks, PolicyEngineError, resolvePolicy } from './policy.js';
import { createProductionCapabilityRegistry, CapabilitySelectionError, PRODUCTION_MAX_CONCURRENT_NODES } from './registry.js';
import { getWorkflowTemplateById, resolveTemplateNodes, selectWorkflowTemplateForFamily } from './workflow-templates.js';
import { STAGE7_BINDINGS, selectStage7Capability } from './stage7/bindings.js';
import type { Stage7FeatureSet } from './stage7/types.js';
import { compileExecutionGraph } from './graph.js';
import type {
  CapabilityRegistry,
  CapabilitySelection,
  CapabilityRequirement,
  ClassificationProposal,
  CompilationFailureCode,
  CompilationResult,
  OperatorClassifier,
  OperatorWorkflowCompiler,
  ResolvedOperatorConfig,
  ResolvedPolicy,
  WorkflowCompilerContext,
} from './stage3-types.js';

// ---------------------------------------------------------------------------
// Options / construction
// ---------------------------------------------------------------------------

export interface Stage3WorkflowCompilerOptions {
  /** Deterministic mock classifier by default; injectable for tests. */
  readonly classifier?: OperatorClassifier;
  /** Forwarded to `config.ts#loadResolvedOperatorConfig`. */
  readonly cwd?: string;
  /** Forwarded to `config.ts#loadResolvedOperatorConfig`. */
  readonly globalConfigPath?: string;
  /** Forwarded to `policy.ts#loadPolicyPacks`; defaults to `DEFAULT_POLICIES_DIR`. */
  readonly policiesDir?: string;
  /** Override point for tests/DI: replaces the real `config.ts` file-system
   * load with a caller-supplied `ResolvedOperatorConfig`. Defaults to the
   * real `loadResolvedOperatorConfig` bound to `cwd`/`globalConfigPath`. */
  /** Override point for tests/DI: replaces the real config loader. */
  readonly loadConfig?: (input: { readonly projectRoot: string }) => Promise<ResolvedOperatorConfig>;
  /** Builds a fresh `CapabilityRegistry` for every `compile()` call (the
   * registry tracks per-instance independence state across sequential
   * `select()` calls, so instances must never be reused across requests).
   * Defaults to `() => createProductionCapabilityRegistry()` — the Stage 4
   * production `omp-task` registry, which structurally cannot select a mock
   * record. Pass `() => createMockCapabilityRegistry(...)` explicitly to
   * compile against mock/test fixtures instead. */
  readonly registryFactory?: () => CapabilityRegistry;
  /** Captured once at activation; never derived from the request or classifier. */
  readonly stage7FeatureSet?: Stage7FeatureSet;
  /** 7B/7C must explicitly provide concrete ports; 7A defaults closed. */
  readonly stage7ExecutorsAvailable?: boolean;
  /** Stage 9 only: resolves a fleet.v1 node requirement to a compiled
   * CapabilitySelection via the human-curated provider catalog. Absent keeps
   * fleet compilation failing closed. Never derived from request text. */
  readonly fleetCapabilitySelect?: (requirement: CapabilityRequirement) => CapabilitySelection;
}
/** Deterministic gate-priority order used to build `RouteDecision.requiredGates`.
 * `EXECUTION_APPROVAL` always sorts first (it gates the only work this Stage 3
 * mock ever performs); everything else is a *future* terminal gate the graph
 * still declares as required without being falsely marked approved here. */
const GATE_PRIORITY_ORDER: readonly GateDecisionType[] = [
  'EXECUTION_APPROVAL',
  'PLAN_APPROVAL',
  'RESULT_APPROVAL',
  'PUBLICATION_APPROVAL',
  'APPROVE_PROGRESSION',
  'CUSTOM_DECISION',
];

const BUDGET_RANK: Readonly<Record<ClassificationProposal['requestedBudgetProfile'] & string, number>> = {
  CHEAP: 0,
  BALANCED: 1,
  QUALITY: 2,
  CRITICAL: 3,
};

// ---------------------------------------------------------------------------
// Failure helper
// ---------------------------------------------------------------------------

function failure(code: CompilationFailureCode, message: string, policyRefs: readonly string[] = []): CompilationResult {
  return { ok: false, code, message, policyRefs };
}

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

class Stage3WorkflowCompiler implements OperatorWorkflowCompiler {
  private readonly classifier: OperatorClassifier;
  private readonly policiesDir: string;
  private readonly loadConfig: (input: { readonly projectRoot: string }) => Promise<ResolvedOperatorConfig>;
  private readonly registryFactory: () => CapabilityRegistry;
  private readonly stage7FeatureSet: Stage7FeatureSet | undefined;
  private readonly stage7ExecutorsAvailable: boolean;
  private readonly fleetCapabilitySelect: ((requirement: CapabilityRequirement) => CapabilitySelection) | undefined;

  constructor(options: Stage3WorkflowCompilerOptions) {
    this.classifier = options.classifier ?? createMockOperatorClassifier();
    this.policiesDir = options.policiesDir ?? DEFAULT_POLICIES_DIR;
    this.registryFactory = options.registryFactory ?? (() => createProductionCapabilityRegistry());
    this.stage7FeatureSet = options.stage7FeatureSet;
    this.stage7ExecutorsAvailable = options.stage7ExecutorsAvailable === true;
    this.fleetCapabilitySelect = options.fleetCapabilitySelect;
    const configOptions: LoadOperatorConfigOptions = {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.globalConfigPath !== undefined ? { globalConfigPath: options.globalConfigPath } : {}),
    };
    this.loadConfig = options.loadConfig ?? ((input) => loadResolvedOperatorConfig({ ...configOptions, projectRoot: input.projectRoot }));
  }

  async compile(request: string, context: WorkflowCompilerContext): Promise<CompilationResult> {
    try {
      return await this.compileInner(request, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure('CONFIG_INVALID', `Unexpected internal compiler error: ${message}`);
    }
  }

  private async compileInner(request: string, context: WorkflowCompilerContext): Promise<CompilationResult> {
    // -- 1. Classify -------------------------------------------------------
    let classification: ClassificationProposal;
    try {
      classification = await this.classifier.classify(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure('CLASSIFICATION_INVALID', `Classifier threw: ${message}`);
    }

    if (classification.requestClassification === 'DIRECT') {
      return failure(
        'FEATURE_DISABLED',
        'The request was classified as explicit direct/automatic intent. Automatic routing and direct bypass are outside the Stage 3 compiler; every request must go through an explicit human-approved workflow.',
      );
    }

    if (classification.confidence === 'LOW') {
      return failure(
        'CLASSIFICATION_INVALID',
        classification.abstentionReason ?? 'Classification abstained at LOW confidence with no reason recorded.',
      );
    }

    // -- 2. Resolve config + project trust ---------------------------------
    let config: ResolvedOperatorConfig;
    try {
      config = await this.loadConfig({ projectRoot: context.projectRoot });
    } catch (error) {
      if (error instanceof OperatorConfigError) {
        return failure('CONFIG_INVALID', `${error.code}: ${error.message}${error.details.length > 0 ? ` (${error.details.join('; ')})` : ''}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure('CONFIG_INVALID', `Config resolution failed: ${message}`);
    }
    if (config.projectOverlay.status === 'INVALID') {
      return failure(
        'CONFIG_INVALID',
        config.projectOverlay.reason ?? 'Project policy overlay failed trust/path/structure validation.',
        config.policyRefs,
      );
    }
    const rejectedAlternatives: RejectedAlternative[] = [];
    if (config.projectOverlay.status === 'UNTRUSTED') {
      rejectedAlternatives.push({
        option: 'project-policy-overlay',
        reasonCode: 'PROJECT_OVERLAY_UNTRUSTED',
        details:
          config.projectOverlay.reason ??
          `Project overlay at ${config.projectOverlay.policyPath ?? '(unresolved path)'} was ignored and never merged into the effective profile.`,
      });
    }


    // Compiler-owned budget-ceiling check. `resolvePolicy` ADOPTS
    // `classification.requestedBudgetProfile` as the resolved budget
    // (escalating it further for hard safety floors) rather than capping it
    // against `config.profile.budgetProfile` — so `resolvedPolicy.budgetProfile`
    // is never usable to detect "this request wants more than the operator
    // profile authorizes". That ceiling check is compiler-owned: compare the
    // classifier's raw ask against the *configured* ceiling before any
    // safety escalation is applied.
    if (classification.requestedBudgetProfile !== undefined) {
      const requestedRank = BUDGET_RANK[classification.requestedBudgetProfile];
      const ceilingRank = BUDGET_RANK[config.profile.budgetProfile];
      if (requestedRank > ceilingRank) {
        return failure(
          'BUDGET_EXCEEDED',
          `Classified budget requirement (${classification.requestedBudgetProfile}) exceeds the configured operator budget ceiling (${config.profile.budgetProfile}).`,
          config.policyRefs,
        );
      }
    }

    // -- 3. Load + resolve policy -------------------------------------------
    let resolvedPolicy: ResolvedPolicy;
    try {
      const packs = await loadPolicyPacks(config.profile.defaultPolicyPacks, this.policiesDir);
      resolvedPolicy = resolvePolicy(classification, config, packs, { now: context.now });
    } catch (error) {
      if (error instanceof PolicyEngineError) {
        const code: CompilationFailureCode = error.code === 'BUDGET_PROFILE_CONFLICT' ? 'BUDGET_EXCEEDED' : 'POLICY_CONFLICT';
        return failure(code, error.message, error.policyRefs);
      }
      const message = error instanceof Error ? error.message : String(error);
      return failure('POLICY_CONFLICT', `Unexpected policy resolution failure: ${message}`);
    }

    // -- 3b. Non-dispatching adapter-concurrency preflight -------------------
    // Independent of which registry backs this compile: no compiled
    // workflow may ever need more concurrently dispatched nodes than the
    // `omp-task` adapter's hard ceiling permits (plan §4.4, §6.1). This is
    // pure arithmetic over already-resolved policy — no provider work.
    if (resolvedPolicy.maxConcurrency > PRODUCTION_MAX_CONCURRENT_NODES) {
      return failure(
        'BUDGET_EXCEEDED',
        `Resolved policy maxConcurrency (${resolvedPolicy.maxConcurrency}) exceeds the omp-task adapter's hard concurrency ceiling (${PRODUCTION_MAX_CONCURRENT_NODES}).`,
        resolvedPolicy.policyRefs,
      );
    }

    // -- 4. Select a registered template -------------------------------------
    let template;
    if (context.fleetRoute === true) {
      if (this.stage7FeatureSet?.stage9ExternalProvidersEnabled !== true) {
        return failure('FEATURE_DISABLED', 'Fleet execution is disabled by immutable startup configuration.', resolvedPolicy.policyRefs);
      }
      const fleetTemplate = getWorkflowTemplateById('fleet.v1', this.stage7FeatureSet);
      if (fleetTemplate === undefined) {
        return failure('FEATURE_DISABLED', 'Fleet template is unavailable in this build.', resolvedPolicy.policyRefs);
      }
      template = fleetTemplate;
    } else {
      try {
        template = selectWorkflowTemplateForFamily(classification.requestClassification, this.stage7FeatureSet, classification.requestedExecutionShape);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure('GRAPH_INVALID', `Template selection threw: ${message}`, resolvedPolicy.policyRefs);
      }
      if (template === null) {
        return failure(
          'FEATURE_DISABLED',
          `No approved Stage 3 workflow template is registered yet for task family ${classification.requestClassification}.`,
          resolvedPolicy.policyRefs,
        );
      }
    }

    if ((template.template.templateId === 'qa.v2' || template.template.templateId === 'ui-change.v2') && !this.stage7ExecutorsAvailable) {
      return failure('CAPABILITY_UNAVAILABLE', `Stage-7 template "${template.template.templateId}" is registered but its concrete 7B/7C execution ports are unavailable in Work Package 7A.`, resolvedPolicy.policyRefs);
    }

    // -- 5. Resolve nodes + select capabilities ------------------------------
    let nodes;
    try {
      nodes = resolveTemplateNodes(template, resolvedPolicy, classification.riskClassification);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return failure('GRAPH_INVALID', `Template node resolution threw: ${message}`, resolvedPolicy.policyRefs);
    }
    const stage7Template = template.template.templateId === 'qa.v2' || template.template.templateId === 'ui-change.v2';

    const registry = this.registryFactory();
    const selections: Record<string, CapabilitySelection> = {};
    const fleetTemplate = template.template.templateId === 'fleet.v1';
    for (const node of nodes) {
      try {
        if (fleetTemplate) {
          if (this.fleetCapabilitySelect === undefined) {
            throw new CapabilitySelectionError('fleet provider selection is not wired into this process', node.requirement, 'NO_CAPABILITY_ASSIGNMENT');
          }
          selections[node.nodeId] = this.fleetCapabilitySelect(node.requirement);
        } else if (stage7Template) {
          const binding = STAGE7_BINDINGS.find((candidate) => candidate.tuple.workflowTemplateId === template.template.templateId && candidate.tuple.nodeId === node.nodeId && candidate.tuple.role === node.role && candidate.tuple.requiredCapability === node.requirement.capability && candidate.tuple.mutationClass === node.requirement.mutationClass);
          if (binding === undefined) throw new CapabilitySelectionError(`no exact Stage-7 binding exists for node "${node.nodeId}"`, node.requirement, 'NO_CAPABILITY_ASSIGNMENT');
          selections[node.nodeId] = selectStage7Capability(node.requirement, binding);
        } else {
          selections[node.nodeId] = registry.select(node.requirement, resolvedPolicy);
        }
      } catch (error) {
        if (error instanceof CapabilitySelectionError) {
          return failure(
            'CAPABILITY_UNAVAILABLE',
            `No capability satisfies role "${node.requirement.role}" (capability "${node.requirement.capability}"): ${error.reasonCode} — ${error.message}`,
            resolvedPolicy.policyRefs,
          );
        }
        const message = error instanceof Error ? error.message : String(error);
        return failure('CAPABILITY_UNAVAILABLE', `Capability selection for role "${node.requirement.role}" threw: ${message}`, resolvedPolicy.policyRefs);
      }
    }

    // -- 6. Compile + validate the graph -------------------------------------
    const graphResult = compileExecutionGraph({
      graphId: context.graphId,
      graphRevision: 1,
      workflowTemplateId: template.template.templateId,
      executionShape: template.template.executionShape,
      requiredGateTypes: template.template.requiredGateTypes,
      policy: resolvedPolicy,
      nodes,
      selections,
    });
    if (!graphResult.ok) {
      const joined = graphResult.errors.map((e) => (e.nodeId ? `[${e.nodeId}] ${e.code}: ${e.message}` : `${e.code}: ${e.message}`)).join('; ');
      return failure('GRAPH_INVALID', `Graph compilation failed: ${joined}`, resolvedPolicy.policyRefs);
    }
    const executionGraph = graphResult.graph;
    if (executionGraph.nodes.length === 0) {
      return failure('GRAPH_INVALID', 'Compiled graph has no nodes.', resolvedPolicy.policyRefs);
    }

    // -- 7. Build the RouteDecision (full WHY) -------------------------------
    const selectedRolesProviders: RoleAssignment[] = nodes.map((node) => {
      const selection = selections[node.nodeId]!;
      return { role: selection.requirement.role, capabilityId: selection.selected.id, provider: selection.provider };
    });

    const fallbackDecisions: FallbackDecision[] = nodes
      .map((node) => selections[node.nodeId]!)
      .filter((selection): selection is CapabilitySelection & { fallbackFrom: string } => selection.fallbackFrom !== undefined)
      .map((selection) => ({
        role: selection.requirement.role,
        from: selection.fallbackFrom,
        to: selection.selected.id,
        reasonCode: selection.reasonCode,
      }));

    const requiredGateValues: readonly GateDecisionType[] = [...resolvedPolicy.requiredGates, ...template.template.requiredGateTypes];
    const requiredGates = GATE_PRIORITY_ORDER.filter((gate) => requiredGateValues.includes(gate));

    const reasonCodes = Array.from(
      new Set<string>([
        `SELECTED_TEMPLATE_${template.template.templateId.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}`,
        `PROJECT_OVERLAY_${config.projectOverlay.status}`,
        ...resolvedPolicy.decisions.flatMap((decision) => decision.reasonCodes),
      ]),
    );

    const policyRefs = Array.from(new Set<string>([...config.policyRefs, ...resolvedPolicy.policyRefs]));

    const routeDecision: RouteDecision = {
      requestClassification: classification.requestClassification,
      riskClassification: classification.riskClassification,
      selectedWorkflow: template.template.templateId,
      selectedRolesProviders,
      rejectedAlternatives,
      requiredGates,
      budgetEffect: { profile: resolvedPolicy.budgetProfile },
      fallbackDecisions,
      reasonCodes,
      policyRefs,
      confidence: classification.confidence,
      abstention: { abstained: false },
    };

    const routeValidation = validateRouteDecision(routeDecision);
    if (!routeValidation.ok) {
      const joined = routeValidation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
      return failure('GRAPH_INVALID', `Compiled RouteDecision failed contract validation: ${joined}`, resolvedPolicy.policyRefs);
    }

    // -- 8. Build the initial, exact graph-bound HumanGate -------------------
    let initialGate: HumanGate | null = null;
    if (requiredGates.includes('EXECUTION_APPROVAL')) {
      const rootNode = executionGraph.nodes.find((n) => n.dependsOn.length === 0) ?? executionGraph.nodes[0]!;
      const gate: HumanGate = {
        gateId: context.gateId,
        operatorSessionId: context.operatorSessionId,
        reason: `The "${template.template.templateId}" workflow (task family ${classification.requestClassification}, risk ${classification.riskClassification}) requires explicit human approval before its first node executes.`,
        decisionType: 'EXECUTION_APPROVAL',
        requestedDecision: `Approve execution of the "${template.template.templateId}" workflow for this request?`,
        availableOptions: ['APPROVE', 'REJECT'],
        recommendedOption: 'APPROVE',
        evidenceRefs: [],
        consequences: {
          APPROVE: `The compiled graph's mandatory nodes execute in dependency order, starting at "${rootNode.nodeId}".`,
          REJECT: 'The session is declined; no node executes and no capability is dispatched.',
        },
        resumeNode: rootNode.nodeId,
        graphRevision: executionGraph.graphRevision,
        graphHash: executionGraph.graphHash,
        artifactRefs: [],
        artifactHashes: [],
        policyRefs,
        createdAt: context.now,
        status: 'OPEN',
      };
      const gateValidation = validateHumanGate(gate);
      if (!gateValidation.ok) {
        const joined = gateValidation.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
        return failure('GRAPH_INVALID', `Compiled initial HumanGate failed contract validation: ${joined}`, resolvedPolicy.policyRefs);
      }
      initialGate = gate;
    }

    return {
      ok: true,
      compiled: {
        classification,
        policy: resolvedPolicy,
        template: template.template,
        routeDecision,
        executionGraph,
        initialGate,
      },
    };
  }
}

export function createStage3WorkflowCompiler(options: Stage3WorkflowCompilerOptions = {}): OperatorWorkflowCompiler {
  return new Stage3WorkflowCompiler(options);
}

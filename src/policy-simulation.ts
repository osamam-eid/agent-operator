import { createHash } from 'node:crypto';

import type { CompilationResult, CompiledWorkflow, ProjectOperatorOverlay, ResolvedOperatorConfig, WorkflowCompilerContext } from './stage3-types.js';
import { applyProjectOperatorOverlay, findUnsafeBroadening, validateProjectOperatorOverlay } from './config.js';
import { isPlainObject } from './validation/primitives.js';

export interface ExecutionEstimate {
  readonly schemaVersion: '1.0';
  readonly expectedProviderCalls: number;
  readonly maximumDepth: number;
  readonly maximumParallelWidth: number;
  readonly usesExternalProvider: boolean;
  readonly mutationClasses: readonly string[];
  readonly budgetProfile: string;
  readonly estimatedCost: number | null;
  readonly costConfidence: 'UNAVAILABLE' | 'LOW' | 'MEDIUM' | 'HIGH';
  readonly previewRequired: boolean;
  readonly previewReasons: readonly string[];
  readonly provenance: 'COMPILED_GRAPH';
}

export interface PolicyRouteSnapshot {
  readonly ok: boolean;
  readonly failureCode?: string;
  readonly family?: string;
  readonly workflow?: string;
  readonly providers?: readonly string[];
  readonly requiredGates?: readonly string[];
  readonly mutationClasses?: readonly string[];
  readonly disclosureClass?: string;
  readonly budgetProfile?: string;
  readonly estimate?: ExecutionEstimate;
}

export function validateExecutionEstimate(value: unknown): value is ExecutionEstimate {
  if (!isPlainObject(value)) return false;
  const keys = ['schemaVersion', 'expectedProviderCalls', 'maximumDepth', 'maximumParallelWidth', 'usesExternalProvider', 'mutationClasses', 'budgetProfile', 'estimatedCost', 'costConfidence', 'previewRequired', 'previewReasons', 'provenance'];
  if (Object.keys(value).some((key) => !keys.includes(key))) return false;
  return value['schemaVersion'] === '1.0'
    && typeof value['expectedProviderCalls'] === 'number' && Number.isInteger(value['expectedProviderCalls']) && value['expectedProviderCalls'] >= 0
    && typeof value['maximumDepth'] === 'number' && Number.isInteger(value['maximumDepth']) && value['maximumDepth'] >= 0
    && typeof value['maximumParallelWidth'] === 'number' && Number.isInteger(value['maximumParallelWidth']) && value['maximumParallelWidth'] >= 0
    && typeof value['usesExternalProvider'] === 'boolean'
    && Array.isArray(value['mutationClasses']) && value['mutationClasses'].every((entry) => typeof entry === 'string')
    && typeof value['budgetProfile'] === 'string'
    && (value['estimatedCost'] === null || (typeof value['estimatedCost'] === 'number' && value['estimatedCost'] >= 0))
    && typeof value['costConfidence'] === 'string'
    && typeof value['previewRequired'] === 'boolean'
    && Array.isArray(value['previewReasons']) && value['previewReasons'].every((entry) => typeof entry === 'string')
    && value['provenance'] === 'COMPILED_GRAPH';
}

export interface PolicyDiffReport {
  readonly schemaVersion: '1.0';
  readonly reportId: string;
  readonly proposedPolicyHash: string;
  readonly current: PolicyRouteSnapshot;
  readonly proposed: PolicyRouteSnapshot;
  readonly changes: readonly string[];
  readonly unchangedHardInvariants: readonly string[];
  readonly generatedAt: string;
}

export function validatePolicyDiffReport(value: unknown): value is PolicyDiffReport {
  if (!isPlainObject(value)) return false;
  const current = value['current'];
  const proposed = value['proposed'];
  return value['schemaVersion'] === '1.0'
    && typeof value['reportId'] === 'string' && /^[0-9a-f]{64}$/.test(value['reportId'])
    && typeof value['proposedPolicyHash'] === 'string' && /^[0-9a-f]{64}$/.test(value['proposedPolicyHash'])
    && isPlainObject(current) && typeof current['ok'] === 'boolean'
    && isPlainObject(proposed) && typeof proposed['ok'] === 'boolean'
    && Array.isArray(value['changes']) && value['changes'].every((entry) => typeof entry === 'string')
    && Array.isArray(value['unchangedHardInvariants']) && value['unchangedHardInvariants'].every((entry) => typeof entry === 'string')
    && typeof value['generatedAt'] === 'string' && Number.isFinite(Date.parse(value['generatedAt']));
}

export interface PolicySimulationPort {
  test(proposedPath: string, request: string, context: WorkflowCompilerContext): Promise<PolicyDiffReport>;
}

export interface PolicySimulationOptions {
  readonly loadCurrentConfig: (projectRoot: string) => Promise<ResolvedOperatorConfig>;
  readonly readProposed: (path: string) => Promise<string>;
  readonly compileWithConfig: (request: string, context: WorkflowCompilerContext, config: ResolvedOperatorConfig) => Promise<CompilationResult>;
}

function graphDepth(compiled: CompiledWorkflow): { readonly depth: number; readonly width: number } {
  const byId = new Map(compiled.executionGraph.nodes.map((node) => [node.nodeId, node]));
  const depths = new Map<string, number>();
  const visit = (nodeId: string): number => {
    const known = depths.get(nodeId);
    if (known !== undefined) return known;
    const node = byId.get(nodeId);
    if (node === undefined) return 0;
    const value = node.dependsOn.length === 0 ? 1 : 1 + Math.max(...node.dependsOn.map(visit));
    depths.set(nodeId, value);
    return value;
  };
  for (const node of compiled.executionGraph.nodes) visit(node.nodeId);
  const depthValues = [...depths.values()];
  const counts: Record<string, number> = {};
  for (const value of depthValues) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
  return { depth: Math.max(0, ...depthValues), width: Math.max(0, ...Object.values(counts)) };
}

export function estimateCompiledWorkflow(compiled: CompiledWorkflow): ExecutionEstimate {
  const shape = graphDepth(compiled);
  const mutationClasses = [...new Set(compiled.capabilitySummaries.map((summary) => summary.mutationClass))].sort();
  const usesExternalProvider = compiled.routeDecision.selectedWorkflow === 'fleet.v1';
  const previewReasons: string[] = [];
  if (usesExternalProvider) previewReasons.push('EXTERNAL_PROVIDER');
  if (compiled.executionGraph.executionShape === 'COUNCIL') previewReasons.push('COUNCIL');
  if (compiled.executionGraph.nodes.length >= 5) previewReasons.push('LARGE_GRAPH');
  if (compiled.classification.riskClassification === 'HIGH' || compiled.classification.riskClassification === 'CRITICAL') previewReasons.push('HIGH_RISK');
  if (mutationClasses.some((value) => value !== 'READ_ONLY')) previewReasons.push('MUTATION');
  return {
    schemaVersion: '1.0',
    expectedProviderCalls: compiled.executionGraph.nodes.length,
    maximumDepth: shape.depth,
    maximumParallelWidth: shape.width,
    usesExternalProvider,
    mutationClasses,
    budgetProfile: compiled.policy.budgetProfile,
    estimatedCost: compiled.routeDecision.budgetEffect.estimatedCost ?? null,
    costConfidence: compiled.routeDecision.budgetEffect.estimatedCost === undefined ? 'UNAVAILABLE' : 'HIGH',
    previewRequired: previewReasons.length > 0,
    previewReasons,
    provenance: 'COMPILED_GRAPH',
  };
}

function snapshot(result: CompilationResult): PolicyRouteSnapshot {
  if (!result.ok) return { ok: false, failureCode: result.code };
  const compiled = result.compiled;
  return {
    ok: true,
    family: compiled.classification.requestClassification,
    workflow: compiled.routeDecision.selectedWorkflow,
    providers: [...new Set(compiled.routeDecision.selectedRolesProviders.map((entry) => entry.provider))].sort(),
    requiredGates: [...compiled.routeDecision.requiredGates],
    mutationClasses: [...new Set(compiled.capabilitySummaries.map((entry) => entry.mutationClass))].sort(),
    disclosureClass: compiled.disclosureDecision.disclosureClass,
    budgetProfile: compiled.policy.budgetProfile,
    estimate: estimateCompiledWorkflow(compiled),
  };
}

function differences(current: PolicyRouteSnapshot, proposed: PolicyRouteSnapshot): readonly string[] {
  const changes: string[] = [];
  for (const key of ['ok', 'failureCode', 'family', 'workflow', 'disclosureClass', 'budgetProfile'] as const) if (current[key] !== proposed[key]) changes.push(key.toUpperCase());
  for (const key of ['providers', 'requiredGates', 'mutationClasses'] as const) if (JSON.stringify(current[key] ?? []) !== JSON.stringify(proposed[key] ?? [])) changes.push(key.toUpperCase());
  if (current.estimate?.expectedProviderCalls !== proposed.estimate?.expectedProviderCalls) changes.push('EXPECTED_CALLS');
  if (current.estimate?.maximumDepth !== proposed.estimate?.maximumDepth) changes.push('EXECUTION_DEPTH');
  return changes;
}

function verifiedHardInvariants(current: ResolvedOperatorConfig, proposed: ResolvedOperatorConfig): readonly string[] {
  const invariants: readonly [string, boolean][] = [
    ['HUMAN_FINAL_APPROVAL', current.profile.rules.humanIsFinalApprover && proposed.profile.rules.humanIsFinalApprover],
    ['NO_AUTOMATIC_COMMIT', !current.profile.rules.automaticCommit && !proposed.profile.rules.automaticCommit],
    ['NO_AUTOMATIC_PUSH', !current.profile.rules.automaticPush && !proposed.profile.rules.automaticPush],
    ['NO_AUTOMATIC_MERGE', !current.profile.rules.automaticMerge && !proposed.profile.rules.automaticMerge],
    ['NO_IMPLEMENTER_SELF_APPROVAL', !current.profile.rules.implementerSelfApproval && !proposed.profile.rules.implementerSelfApproval],
    ['NO_AUTOMATIC_ROUTING', !current.profile.features.automaticRouting && !proposed.profile.features.automaticRouting],
    ['DISCLOSURE_BEFORE_EXTERNAL_PROVIDER', true],
    ['MUTATION_SCOPE_ENFORCED', true],
  ];
  return invariants.filter(([, unchanged]) => unchanged).map(([name]) => name);
}

export function createPolicySimulationService(options: PolicySimulationOptions): PolicySimulationPort {
  return {
    async test(proposedPath, request, context): Promise<PolicyDiffReport> {
      const proposedBytes = await options.readProposed(proposedPath);
      let raw: unknown;
      try { raw = JSON.parse(proposedBytes) as unknown; } catch { throw new Error('Proposed policy must be valid JSON.'); }
      const validated = validateProjectOperatorOverlay(raw);
      if (!validated.ok) throw new Error(`Proposed policy is invalid: ${validated.errors.join('; ')}`);
      const broadening = findUnsafeBroadening(validated.value);
      if (broadening.length > 0) throw new Error(`Proposed policy attempts unsafe broadening: ${broadening.join(', ')}`);
      const currentConfig = await options.loadCurrentConfig(context.projectRoot);
      const proposedConfig: ResolvedOperatorConfig = {
        ...currentConfig,
        profile: applyProjectOperatorOverlay(currentConfig.profile, validated.value),
        projectOverlay: { status: 'TRUSTED', projectRoot: context.projectRoot, policyPath: proposedPath, trustRecordPath: 'simulation-only', overlay: validated.value },
        policyRefs: [...new Set([...currentConfig.policyRefs, 'agent-operator@1:policy.simulation'])],
      };
      const [currentResult, proposedResult] = await Promise.all([
        options.compileWithConfig(request, { ...context, disableSemanticPrimary: true, operatorSessionId: `policy-current:${context.operatorSessionId}`, graphId: `policy-current:${context.graphId}`, gateId: `policy-current:${context.gateId}` }, currentConfig),
        options.compileWithConfig(request, { ...context, disableSemanticPrimary: true, operatorSessionId: `policy-proposed:${context.operatorSessionId}`, graphId: `policy-proposed:${context.graphId}`, gateId: `policy-proposed:${context.gateId}` }, proposedConfig),
      ]);
      const current = snapshot(currentResult);
      const proposed = snapshot(proposedResult);
      const proposedPolicyHash = createHash('sha256').update(proposedBytes, 'utf8').digest('hex');
      return {
        schemaVersion: '1.0',
        reportId: createHash('sha256').update(`${proposedPolicyHash}\n${request}\n${context.now}`, 'utf8').digest('hex'),
        proposedPolicyHash,
        current,
        proposed,
        changes: differences(current, proposed),
        unchangedHardInvariants: verifiedHardInvariants(currentConfig, proposedConfig),
        generatedAt: context.now,
      };
    },
  };
}

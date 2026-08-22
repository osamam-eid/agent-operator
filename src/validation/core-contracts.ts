/**
 * Agent Operator — Stage 1 deterministic contract validators: core routing
 * and graph contracts.
 *
 * Validates the capability registry entry, the router's route decision, the
 * static workflow template, and the per-session execution graph derived
 * from it (CapabilityRecord, RouteDecision, WorkflowTemplate,
 * ExecutionGraph — plan sections 1-4). These four contracts form one
 * cohesive domain: WorkflowTemplate and ExecutionGraph share the DAG
 * invariant checker (unique node ids, resolvable dependencies, no cycles,
 * one synthesis owner per group) defined once below and applied to both.
 * Self-contained: this module validates no other contract's embedded value
 * and depends only on src/validation/primitives.ts and enums.ts.
 */

import type {
  Abstention,
  BudgetEffect,
  CapabilityRecord,
  ExecutionGraph,
  ExecutionGraphNode,
  FallbackDecision,
  MutationClass,
  MutationMetadata,
  RejectedAlternative,
  RoleAssignment,
  RouteDecision,
  WorkflowTemplate,
  WorkflowTemplateNode,
} from '../contracts.js';

import {
  ARTIFACT_TYPE_PATTERN,
  MAX_ARRAY_ITEMS,
  MAX_MEDIUM_TEXT,
  MAX_SHORT_TEXT,
  REASON_CODE_PATTERN,
  ROLE_PATTERN,
  checkObjectShape,
  finalize,
  hasOwn,
  newCtx,
  pushErr,
  requireArray,
  requireBoolean,
  requireEnum,
  requireExactString,
  requireHash,
  requireHumanText,
  requireId,
  requireNumber,
  requirePolicyRefsArray,
  requireStringArray,
  type Ctx,
  type Path,
  type ValidationResult,
} from './primitives.js';

import {
  BUDGET_PROFILES,
  CAPABILITY_KINDS,
  CONFIDENCE_LEVELS,
  CONTEXT_POLICIES,
  COST_CLASSES,
  EXECUTION_SHAPES,
  GATE_DECISION_TYPES,
  HEALTH_STATUSES,
  LATENCY_CLASSES,
  MODEL_TIERS,
  MUTABILITY_VALUES,
  MUTATION_CLASSES,
  RETRY_POLICIES,
  RISK_LEVELS,
  TASK_FAMILIES,
} from './enums.js';

// ---------------------------------------------------------------------------
// 1. CapabilityRecord
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------

const CAPABILITY_RECORD_KEYS = [
  'id',
  'kind',
  'capabilities',
  'mutability',
  'modelTiers',
  'tools',
  'spawns',
  'supports',
  'binary',
  'sha256',
  'versionProbe',
  'authProbe',
  'modelProbe',
  'costClass',
  'latencyClass',
  'concurrency',
  'health',
  'source',
] as const;

export function validateCapabilityRecord(input: unknown): ValidationResult<CapabilityRecord> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, CAPABILITY_RECORD_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const id = requireId(ctx, ['id'], raw.id);
  const kind = requireEnum(ctx, ['kind'], raw.kind, CAPABILITY_KINDS);
  const capabilities = requireStringArray(ctx, ['capabilities'], raw.capabilities, { minItems: 1, maxItems: MAX_ARRAY_ITEMS, unique: true });
  const mutability = requireEnum(ctx, ['mutability'], raw.mutability, MUTABILITY_VALUES);
  const modelTiers = requireStringArray(ctx, ['modelTiers'], raw.modelTiers, {
    minItems: 1,
    unique: true,
    itemValidator: (c, p, v) => requireEnum(c, p, v, MODEL_TIERS),
  });
  const tools = requireStringArray(ctx, ['tools'], raw.tools, { unique: true });
  const spawns = requireBoolean(ctx, ['spawns'], raw.spawns);
  const supports = requireStringArray(ctx, ['supports'], raw.supports, {
    minItems: 1,
    unique: true,
    itemValidator: (c, p, v) => requireEnum(c, p, v, EXECUTION_SHAPES),
  });
  const costClass = requireEnum(ctx, ['costClass'], raw.costClass, COST_CLASSES);
  const latencyClass = requireEnum(ctx, ['latencyClass'], raw.latencyClass, LATENCY_CLASSES);
  const concurrency = requireNumber(ctx, ['concurrency'], raw.concurrency, { min: 1, integer: true });
  const health = requireEnum(ctx, ['health'], raw.health, HEALTH_STATUSES);
  const source = requireHumanText(ctx, ['source'], raw.source, { maxLen: MAX_SHORT_TEXT });

  let binary: string | undefined;
  if (hasOwn(raw, 'binary')) binary = requireExactString(ctx, ['binary'], raw.binary, { maxLen: MAX_SHORT_TEXT });
  let sha256: string | undefined;
  if (hasOwn(raw, 'sha256')) sha256 = requireHash(ctx, ['sha256'], raw.sha256);
  let versionProbe: string | undefined;
  if (hasOwn(raw, 'versionProbe')) versionProbe = requireExactString(ctx, ['versionProbe'], raw.versionProbe, { maxLen: MAX_SHORT_TEXT });
  let authProbe: string | undefined;
  if (hasOwn(raw, 'authProbe')) authProbe = requireExactString(ctx, ['authProbe'], raw.authProbe, { maxLen: MAX_SHORT_TEXT });
  let modelProbe: string | undefined;
  if (hasOwn(raw, 'modelProbe')) modelProbe = requireExactString(ctx, ['modelProbe'], raw.modelProbe, { maxLen: MAX_SHORT_TEXT });

  // Cross-field: external-cli capabilities must declare a binary.
  if (kind === 'external-cli' && !hasOwn(raw, 'binary')) {
    pushErr(ctx, ['binary'], 'is required when kind is "external-cli"');
  }
  if (kind === 'omp-role' && hasOwn(raw, 'binary')) {
    pushErr(ctx, ['binary'], 'must be absent when kind is "omp-role"');
  }
  // Cross-field: external-cli binaries are pinned and absolutely pathed (Stage 9).
  const ABSOLUTE_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\/)/;
  if (kind === 'external-cli') {
    if (!hasOwn(raw, 'sha256')) pushErr(ctx, ['sha256'], 'is required when kind is "external-cli"');
    if (binary !== undefined && !ABSOLUTE_PATH_PATTERN.test(binary)) pushErr(ctx, ['binary'], 'must be an absolute path when kind is "external-cli"');
  }
  if (kind === 'omp-role' && hasOwn(raw, 'sha256')) {
    pushErr(ctx, ['sha256'], 'must be absent when kind is "omp-role"');
  }

  if (
    id === undefined ||
    kind === undefined ||
    capabilities === undefined ||
    mutability === undefined ||
    modelTiers === undefined ||
    tools === undefined ||
    spawns === undefined ||
    supports === undefined ||
    costClass === undefined ||
    latencyClass === undefined ||
    concurrency === undefined ||
    health === undefined ||
    source === undefined
  ) {
    return finalize(ctx, out);
  }
  if (hasOwn(raw, 'binary') && binary === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'sha256') && sha256 === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'versionProbe') && versionProbe === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'authProbe') && authProbe === undefined) return finalize(ctx, out);
  if (hasOwn(raw, 'modelProbe') && modelProbe === undefined) return finalize(ctx, out);

  out.id = id;
  out.kind = kind;
  out.capabilities = capabilities;
  out.mutability = mutability;
  out.modelTiers = modelTiers;
  out.tools = tools;
  out.spawns = spawns;
  out.supports = supports;
  if (binary !== undefined) out.binary = binary;
  if (sha256 !== undefined) out.sha256 = sha256;
  if (versionProbe !== undefined) out.versionProbe = versionProbe;
  if (authProbe !== undefined) out.authProbe = authProbe;
  if (modelProbe !== undefined) out.modelProbe = modelProbe;
  out.costClass = costClass;
  out.latencyClass = latencyClass;
  out.concurrency = concurrency;
  out.health = health;
  out.source = source;

  return finalize<CapabilityRecord>(ctx, out);
}

// ---------------------------------------------------------------------------
// 2. RouteDecision
// ---------------------------------------------------------------------------

const ROLE_ASSIGNMENT_KEYS = ['role', 'capabilityId', 'provider'] as const;

function validateRoleAssignment(ctx: Ctx, path: Path, value: unknown): RoleAssignment | undefined {
  const raw = checkObjectShape(ctx, path, value, ROLE_ASSIGNMENT_KEYS);
  if (!raw) return undefined;
  const role = requireExactString(ctx, [...path, 'role'], raw.role, { maxLen: MAX_SHORT_TEXT, pattern: ROLE_PATTERN });
  const capabilityId = requireId(ctx, [...path, 'capabilityId'], raw.capabilityId);
  const provider = requireExactString(ctx, [...path, 'provider'], raw.provider, { maxLen: MAX_SHORT_TEXT });
  if (role === undefined || capabilityId === undefined || provider === undefined) return undefined;
  return { role, capabilityId, provider };
}

const REJECTED_ALTERNATIVE_KEYS = ['option', 'reasonCode', 'details'] as const;

function validateRejectedAlternative(ctx: Ctx, path: Path, value: unknown): RejectedAlternative | undefined {
  const raw = checkObjectShape(ctx, path, value, REJECTED_ALTERNATIVE_KEYS);
  if (!raw) return undefined;
  const option = requireExactString(ctx, [...path, 'option'], raw.option, { maxLen: MAX_SHORT_TEXT });
  const reasonCode = requireExactString(ctx, [...path, 'reasonCode'], raw.reasonCode, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN });
  let details: string | undefined;
  if (hasOwn(raw, 'details')) details = requireHumanText(ctx, [...path, 'details'], raw.details, { maxLen: MAX_MEDIUM_TEXT });
  if (option === undefined || reasonCode === undefined) return undefined;
  if (hasOwn(raw, 'details') && details === undefined) return undefined;
  return details !== undefined ? { option, reasonCode, details } : { option, reasonCode };
}

const BUDGET_EFFECT_KEYS = ['profile', 'estimatedTokens', 'estimatedCost', 'estimatedDurationMs'] as const;

function validateBudgetEffect(ctx: Ctx, path: Path, value: unknown): BudgetEffect | undefined {
  const raw = checkObjectShape(ctx, path, value, BUDGET_EFFECT_KEYS);
  if (!raw) return undefined;
  const profile = requireEnum(ctx, [...path, 'profile'], raw.profile, BUDGET_PROFILES);
  let estimatedTokens: number | undefined;
  if (hasOwn(raw, 'estimatedTokens')) estimatedTokens = requireNumber(ctx, [...path, 'estimatedTokens'], raw.estimatedTokens, { min: 0 });
  let estimatedCost: number | undefined;
  if (hasOwn(raw, 'estimatedCost')) estimatedCost = requireNumber(ctx, [...path, 'estimatedCost'], raw.estimatedCost, { min: 0 });
  let estimatedDurationMs: number | undefined;
  if (hasOwn(raw, 'estimatedDurationMs')) estimatedDurationMs = requireNumber(ctx, [...path, 'estimatedDurationMs'], raw.estimatedDurationMs, { min: 0 });
  if (profile === undefined) return undefined;
  if (hasOwn(raw, 'estimatedTokens') && estimatedTokens === undefined) return undefined;
  if (hasOwn(raw, 'estimatedCost') && estimatedCost === undefined) return undefined;
  if (hasOwn(raw, 'estimatedDurationMs') && estimatedDurationMs === undefined) return undefined;
  return {
    profile,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(estimatedCost !== undefined ? { estimatedCost } : {}),
    ...(estimatedDurationMs !== undefined ? { estimatedDurationMs } : {}),
  };
}

const FALLBACK_DECISION_KEYS = ['role', 'from', 'to', 'reasonCode'] as const;

function validateFallbackDecision(ctx: Ctx, path: Path, value: unknown): FallbackDecision | undefined {
  const raw = checkObjectShape(ctx, path, value, FALLBACK_DECISION_KEYS);
  if (!raw) return undefined;
  const role = requireExactString(ctx, [...path, 'role'], raw.role, { maxLen: MAX_SHORT_TEXT, pattern: ROLE_PATTERN });
  const from = requireExactString(ctx, [...path, 'from'], raw.from, { maxLen: MAX_SHORT_TEXT });
  const to = requireExactString(ctx, [...path, 'to'], raw.to, { maxLen: MAX_SHORT_TEXT });
  const reasonCode = requireExactString(ctx, [...path, 'reasonCode'], raw.reasonCode, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN });
  if (role === undefined || from === undefined || to === undefined || reasonCode === undefined) return undefined;
  return { role, from, to, reasonCode };
}

const ABSTENTION_KEYS = ['abstained', 'reason'] as const;

function validateAbstention(ctx: Ctx, path: Path, value: unknown): Abstention | undefined {
  const raw = checkObjectShape(ctx, path, value, ABSTENTION_KEYS);
  if (!raw) return undefined;
  const abstained = requireBoolean(ctx, [...path, 'abstained'], raw.abstained);
  let reason: string | undefined;
  if (hasOwn(raw, 'reason')) reason = requireHumanText(ctx, [...path, 'reason'], raw.reason, { maxLen: MAX_MEDIUM_TEXT });
  if (abstained === undefined) return undefined;
  if (abstained === true && reason === undefined) {
    pushErr(ctx, [...path, 'reason'], 'is required when abstained is true');
    return undefined;
  }
  if (abstained === false && hasOwn(raw, 'reason')) {
    pushErr(ctx, [...path, 'reason'], 'must be absent when abstained is false');
    return undefined;
  }
  return reason !== undefined ? { abstained, reason } : { abstained };
}

const ROUTE_DECISION_KEYS = [
  'requestClassification',
  'riskClassification',
  'selectedWorkflow',
  'selectedRolesProviders',
  'rejectedAlternatives',
  'requiredGates',
  'budgetEffect',
  'fallbackDecisions',
  'reasonCodes',
  'policyRefs',
  'confidence',
  'abstention',
] as const;

export function validateRouteDecision(input: unknown): ValidationResult<RouteDecision> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, ROUTE_DECISION_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const requestClassification = requireEnum(ctx, ['requestClassification'], raw.requestClassification, TASK_FAMILIES);
  const riskClassification = requireEnum(ctx, ['riskClassification'], raw.riskClassification, RISK_LEVELS);
  const selectedWorkflow = requireExactString(ctx, ['selectedWorkflow'], raw.selectedWorkflow, { maxLen: MAX_SHORT_TEXT, pattern: ARTIFACT_TYPE_PATTERN });

  let selectedRolesProviders: RoleAssignment[] | undefined;
  const rawSelected = requireArray(ctx, ['selectedRolesProviders'], raw.selectedRolesProviders, { minItems: 1 });
  if (rawSelected) {
    const items = rawSelected.map((v, i) => validateRoleAssignment(ctx, ['selectedRolesProviders', i], v));
    if (items.every((v): v is RoleAssignment => v !== undefined)) selectedRolesProviders = items;
  }

  let rejectedAlternatives: RejectedAlternative[] | undefined;
  const rawRejected = requireArray(ctx, ['rejectedAlternatives'], raw.rejectedAlternatives);
  if (rawRejected) {
    const items = rawRejected.map((v, i) => validateRejectedAlternative(ctx, ['rejectedAlternatives', i], v));
    if (items.every((v): v is RejectedAlternative => v !== undefined)) rejectedAlternatives = items;
  }

  const requiredGates = requireStringArray(ctx, ['requiredGates'], raw.requiredGates, {
    unique: true,
    itemValidator: (c, p, v) => requireEnum(c, p, v, GATE_DECISION_TYPES),
  });

  const budgetEffect = validateBudgetEffect(ctx, ['budgetEffect'], raw.budgetEffect);

  let fallbackDecisions: FallbackDecision[] | undefined;
  const rawFallback = requireArray(ctx, ['fallbackDecisions'], raw.fallbackDecisions);
  if (rawFallback) {
    const items = rawFallback.map((v, i) => validateFallbackDecision(ctx, ['fallbackDecisions', i], v));
    if (items.every((v): v is FallbackDecision => v !== undefined)) fallbackDecisions = items;
  }

  const reasonCodes = requireStringArray(ctx, ['reasonCodes'], raw.reasonCodes, {
    minItems: 1,
    itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }),
  });
  const policyRefs = requirePolicyRefsArray(ctx, ['policyRefs'], raw.policyRefs);
  const confidence = requireEnum(ctx, ['confidence'], raw.confidence, CONFIDENCE_LEVELS);
  const abstention = validateAbstention(ctx, ['abstention'], raw.abstention);

  if (
    requestClassification === undefined ||
    riskClassification === undefined ||
    selectedWorkflow === undefined ||
    selectedRolesProviders === undefined ||
    rejectedAlternatives === undefined ||
    requiredGates === undefined ||
    budgetEffect === undefined ||
    fallbackDecisions === undefined ||
    reasonCodes === undefined ||
    policyRefs === undefined ||
    confidence === undefined ||
    abstention === undefined
  ) {
    return finalize(ctx, out);
  }

  out.requestClassification = requestClassification;
  out.riskClassification = riskClassification;
  out.selectedWorkflow = selectedWorkflow;
  out.selectedRolesProviders = selectedRolesProviders;
  out.rejectedAlternatives = rejectedAlternatives;
  out.requiredGates = requiredGates;
  out.budgetEffect = budgetEffect;
  out.fallbackDecisions = fallbackDecisions;
  out.reasonCodes = reasonCodes;
  out.policyRefs = policyRefs;
  out.confidence = confidence;
  out.abstention = abstention;

  return finalize<RouteDecision>(ctx, out);
}

// ---------------------------------------------------------------------------
// 3. WorkflowTemplate
// ---------------------------------------------------------------------------

const WORKFLOW_TEMPLATE_NODE_KEYS = ['nodeId', 'role', 'mandatory', 'dependsOn', 'groupId', 'synthesisOwner', 'mutationClass'] as const;

function validateWorkflowTemplateNode(ctx: Ctx, path: Path, value: unknown): WorkflowTemplateNode | undefined {
  const raw = checkObjectShape(ctx, path, value, WORKFLOW_TEMPLATE_NODE_KEYS);
  if (!raw) return undefined;
  const nodeId = requireId(ctx, [...path, 'nodeId'], raw.nodeId);
  const role = requireExactString(ctx, [...path, 'role'], raw.role, { maxLen: MAX_SHORT_TEXT, pattern: ROLE_PATTERN });
  const mandatory = requireBoolean(ctx, [...path, 'mandatory'], raw.mandatory);
  const dependsOn = requireStringArray(ctx, [...path, 'dependsOn'], raw.dependsOn, { unique: true, itemValidator: requireId });
  let groupId: string | undefined;
  if (hasOwn(raw, 'groupId')) groupId = requireId(ctx, [...path, 'groupId'], raw.groupId);
  let synthesisOwner: boolean | undefined;
  if (hasOwn(raw, 'synthesisOwner')) synthesisOwner = requireBoolean(ctx, [...path, 'synthesisOwner'], raw.synthesisOwner);
  let mutationClass: MutationClass | undefined;
  if (hasOwn(raw, 'mutationClass')) mutationClass = requireEnum(ctx, [...path, 'mutationClass'], raw.mutationClass, MUTATION_CLASSES);

  if (nodeId === undefined || role === undefined || mandatory === undefined || dependsOn === undefined) return undefined;
  if (hasOwn(raw, 'groupId') && groupId === undefined) return undefined;
  if (hasOwn(raw, 'synthesisOwner') && synthesisOwner === undefined) return undefined;
  if (hasOwn(raw, 'mutationClass') && mutationClass === undefined) return undefined;

  return {
    nodeId,
    role,
    mandatory,
    dependsOn,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(synthesisOwner !== undefined ? { synthesisOwner } : {}),
    ...(mutationClass !== undefined ? { mutationClass } : {}),
  };
}

/** Validates DAG structure shared by WorkflowTemplate and ExecutionGraph:
 * unique node ids, dependency references resolve within the node set, no
 * self-dependency, no cycles, and exactly one synthesis owner per group. */
function validateDagInvariants(
  ctx: Ctx,
  path: Path,
  nodes: ReadonlyArray<{ nodeId: string; dependsOn: readonly string[]; groupId?: string; synthesisOwner?: boolean }>,
  opts: { requireMultiMemberGroup?: boolean } = {},
): void {
  const seen = new Set<string>();
  for (const [i, node] of nodes.entries()) {
    if (seen.has(node.nodeId)) {
      pushErr(ctx, [...path, i, 'nodeId'], `duplicate node id: ${node.nodeId}`);
    }
    seen.add(node.nodeId);
  }

  const ids = new Set(nodes.map((n) => n.nodeId));
  for (const [i, node] of nodes.entries()) {
    for (const dep of node.dependsOn) {
      if (dep === node.nodeId) {
        pushErr(ctx, [...path, i, 'dependsOn'], `node cannot depend on itself: ${dep}`);
      } else if (!ids.has(dep)) {
        pushErr(ctx, [...path, i, 'dependsOn'], `references unknown node id: ${dep}`);
      }
    }
  }

  // Cycle detection (recursive DFS over dependsOn edges).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const node of nodes) color.set(node.nodeId, WHITE);
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const indexById = new Map(nodes.map((node, index) => [node.nodeId, index]));
  let cycleFound = false;
  let cycleDependencyPath: Path | undefined;

  const visit = (id: string): void => {
    if (cycleFound) return;
    color.set(id, GRAY);
    const node = byId.get(id);
    if (node) {
      for (const dep of node.dependsOn) {
        if (!byId.has(dep)) continue; // already reported as unknown reference
        const depColor = color.get(dep);
        if (depColor === GRAY) {
          cycleFound = true;
          const nodeIndex = indexById.get(id);
          cycleDependencyPath = nodeIndex === undefined ? [...path, 'dependsOn'] : [...path, nodeIndex, 'dependsOn'];
          return;
        }
        if (depColor === WHITE) visit(dep);
        if (cycleFound) return;
      }
    }
    color.set(id, BLACK);
  };

  for (const node of nodes) {
    if (color.get(node.nodeId) === WHITE) visit(node.nodeId);
    if (cycleFound) break;
  }
  if (cycleFound) {
    pushErr(ctx, cycleDependencyPath ?? [...path, 'dependsOn'], 'dependency graph contains a cycle');
  }

  // Exactly one synthesis owner per parallel/council group.
  const groups = new Map<string, { count: number; owners: number }>();
  for (const node of nodes) {
    if (node.groupId === undefined) continue;
    const entry = groups.get(node.groupId) ?? { count: 0, owners: 0 };
    entry.count += 1;
    if (node.synthesisOwner === true) entry.owners += 1;
    groups.set(node.groupId, entry);
  }
  for (const [groupId, entry] of groups) {
    if (entry.owners !== 1) {
      const groupNodeIndex = nodes.findIndex((node) => node.groupId === groupId);
      const ownerPath = groupNodeIndex === -1 ? [...path, 'synthesisOwner'] : [...path, groupNodeIndex, 'synthesisOwner'];
      pushErr(ctx, ownerPath, `group "${groupId}" must have exactly one synthesis owner (found ${entry.owners})`);
    }
  }

  // PARALLEL/COUNCIL execution shapes only make sense with a genuine
  // multi-member group; a lone-member "group" is not a fan-out.
  if (opts.requireMultiMemberGroup) {
    const hasMultiMemberGroup = Array.from(groups.values()).some((entry) => entry.count >= 2);
    if (!hasMultiMemberGroup) {
      pushErr(ctx, path, 'a PARALLEL or COUNCIL executionShape requires at least one group with 2 or more members');
    }
  }
}

const WORKFLOW_TEMPLATE_KEYS = ['templateId', 'version', 'taskFamilies', 'executionShape', 'description', 'nodes', 'requiredGateTypes'] as const;

export function validateWorkflowTemplate(input: unknown): ValidationResult<WorkflowTemplate> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, WORKFLOW_TEMPLATE_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const templateId = requireExactString(ctx, ['templateId'], raw.templateId, { maxLen: MAX_SHORT_TEXT, pattern: ARTIFACT_TYPE_PATTERN });
  const version = requireNumber(ctx, ['version'], raw.version, { min: 1, integer: true });
  const taskFamilies = requireStringArray(ctx, ['taskFamilies'], raw.taskFamilies, {
    minItems: 1,
    unique: true,
    itemValidator: (c, p, v) => requireEnum(c, p, v, TASK_FAMILIES),
  });
  const executionShape = requireEnum(ctx, ['executionShape'], raw.executionShape, EXECUTION_SHAPES);
  const description = requireHumanText(ctx, ['description'], raw.description, { maxLen: MAX_MEDIUM_TEXT });

  let nodes: WorkflowTemplateNode[] | undefined;
  const rawNodes = requireArray(ctx, ['nodes'], raw.nodes, { minItems: 1 });
  if (rawNodes) {
    const items = rawNodes.map((v, i) => validateWorkflowTemplateNode(ctx, ['nodes', i], v));
    if (items.every((v): v is WorkflowTemplateNode => v !== undefined)) {
      nodes = items;
      validateDagInvariants(ctx, ['nodes'], nodes, {
        requireMultiMemberGroup: executionShape === 'PARALLEL' || executionShape === 'COUNCIL',
      });
    }
  }

  const requiredGateTypes = requireStringArray(ctx, ['requiredGateTypes'], raw.requiredGateTypes, {
    unique: true,
    itemValidator: (c, p, v) => requireEnum(c, p, v, GATE_DECISION_TYPES),
  });

  if (
    templateId === undefined ||
    version === undefined ||
    taskFamilies === undefined ||
    executionShape === undefined ||
    description === undefined ||
    nodes === undefined ||
    requiredGateTypes === undefined
  ) {
    return finalize(ctx, out);
  }

  out.templateId = templateId;
  out.version = version;
  out.taskFamilies = taskFamilies;
  out.executionShape = executionShape;
  out.description = description;
  out.nodes = nodes;
  out.requiredGateTypes = requiredGateTypes;

  return finalize<WorkflowTemplate>(ctx, out);
}


// ---------------------------------------------------------------------------
// 4. ExecutionGraph
// ---------------------------------------------------------------------------

const MUTATION_METADATA_KEYS = ['mutationId', 'mutationClass', 'retryPolicy'] as const;

function validateMutationMetadata(ctx: Ctx, path: Path, value: unknown): MutationMetadata | undefined {
  const raw = checkObjectShape(ctx, path, value, MUTATION_METADATA_KEYS);
  if (!raw) return undefined;
  const mutationId = requireId(ctx, [...path, 'mutationId'], raw.mutationId);
  const mutationClass = requireEnum(ctx, [...path, 'mutationClass'], raw.mutationClass, MUTATION_CLASSES);
  const retryPolicy = requireEnum(ctx, [...path, 'retryPolicy'], raw.retryPolicy, RETRY_POLICIES);
  if (mutationId === undefined || mutationClass === undefined || retryPolicy === undefined) return undefined;
  if (mutationClass === 'READ_ONLY') {
    pushErr(ctx, [...path, 'mutationClass'], 'mutation metadata requires a non-READ_ONLY mutationClass');
    return undefined;
  }
  return { mutationId, mutationClass, retryPolicy };
}

const EXECUTION_GRAPH_NODE_KEYS = [
  'nodeId',
  'capabilityId',
  'role',
  'mandatory',
  'requiredCapability',
  'dependsOn',
  'groupId',
  'synthesisOwner',
  'verificationOwnerNodeId',
  'mutation',
  'contextPolicy',
  'consumes',
  'produces',
] as const;

function validateExecutionGraphNode(ctx: Ctx, path: Path, value: unknown): ExecutionGraphNode | undefined {
  const raw = checkObjectShape(ctx, path, value, EXECUTION_GRAPH_NODE_KEYS);
  if (!raw) return undefined;

  const nodeId = requireId(ctx, [...path, 'nodeId'], raw.nodeId);
  const capabilityId = requireId(ctx, [...path, 'capabilityId'], raw.capabilityId);
  const role = requireExactString(ctx, [...path, 'role'], raw.role, { maxLen: MAX_SHORT_TEXT, pattern: ROLE_PATTERN });
  let requiredCapability: string | undefined;
  if (hasOwn(raw, 'requiredCapability')) requiredCapability = requireExactString(ctx, [...path, 'requiredCapability'], raw.requiredCapability, { maxLen: MAX_SHORT_TEXT, pattern: CAPABILITY_ID_PATTERN });
  const mandatory = requireBoolean(ctx, [...path, 'mandatory'], raw.mandatory);
  const dependsOn = requireStringArray(ctx, [...path, 'dependsOn'], raw.dependsOn, { unique: true, itemValidator: requireId });
  let groupId: string | undefined;
  if (hasOwn(raw, 'groupId')) groupId = requireId(ctx, [...path, 'groupId'], raw.groupId);
  let synthesisOwner: boolean | undefined;
  if (hasOwn(raw, 'synthesisOwner')) synthesisOwner = requireBoolean(ctx, [...path, 'synthesisOwner'], raw.synthesisOwner);
  let verificationOwnerNodeId: string | undefined;
  if (hasOwn(raw, 'verificationOwnerNodeId')) verificationOwnerNodeId = requireId(ctx, [...path, 'verificationOwnerNodeId'], raw.verificationOwnerNodeId);
  let mutation: MutationMetadata | undefined;
  if (hasOwn(raw, 'mutation')) mutation = validateMutationMetadata(ctx, [...path, 'mutation'], raw.mutation);
  const contextPolicy = requireEnum(ctx, [...path, 'contextPolicy'], raw.contextPolicy, CONTEXT_POLICIES);
  const consumes = requireStringArray(ctx, [...path, 'consumes'], raw.consumes, {
    itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: ARTIFACT_TYPE_PATTERN }),
  });
  const produces = requireStringArray(ctx, [...path, 'produces'], raw.produces, {
    itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: ARTIFACT_TYPE_PATTERN }),
  });

  if (
    nodeId === undefined ||
    capabilityId === undefined ||
    role === undefined ||
    mandatory === undefined ||
    dependsOn === undefined ||
    contextPolicy === undefined ||
    consumes === undefined ||
    produces === undefined
  ) {
    return undefined;
  }
  if (hasOwn(raw, 'groupId') && groupId === undefined) return undefined;
  if (hasOwn(raw, 'synthesisOwner') && synthesisOwner === undefined) return undefined;
  if (hasOwn(raw, 'verificationOwnerNodeId') && verificationOwnerNodeId === undefined) return undefined;
  if (hasOwn(raw, 'mutation') && mutation === undefined) return undefined;

  // Cross-field: mutation nodes require mutation metadata plus a distinct
  // verification owner; non-mutation nodes cannot declare one.
  if (mutation !== undefined) {
    if (verificationOwnerNodeId === undefined) {
      pushErr(ctx, [...path, 'verificationOwnerNodeId'], 'is required for a mutation node');
    } else if (verificationOwnerNodeId === nodeId) {
      pushErr(ctx, [...path, 'verificationOwnerNodeId'], 'must be a different node than the mutation node it verifies');
    }
  }
  return {
    nodeId,
    capabilityId,
    role,
    ...(requiredCapability !== undefined ? { requiredCapability } : {}),
    mandatory,
    dependsOn,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(synthesisOwner !== undefined ? { synthesisOwner } : {}),
    ...(verificationOwnerNodeId !== undefined ? { verificationOwnerNodeId } : {}),
    ...(mutation !== undefined ? { mutation } : {}),
    contextPolicy,
    consumes,
    produces,
  };
}

const EXECUTION_GRAPH_KEYS = ['graphId', 'graphRevision', 'workflowTemplateId', 'executionShape', 'nodes', 'graphHash'] as const;

export function validateExecutionGraph(input: unknown): ValidationResult<ExecutionGraph> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, EXECUTION_GRAPH_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  const graphId = requireId(ctx, ['graphId'], raw.graphId);
  const graphRevision = requireNumber(ctx, ['graphRevision'], raw.graphRevision, { min: 1, integer: true });
  const workflowTemplateId = requireExactString(ctx, ['workflowTemplateId'], raw.workflowTemplateId, { maxLen: MAX_SHORT_TEXT, pattern: ARTIFACT_TYPE_PATTERN });
  const executionShape = requireEnum(ctx, ['executionShape'], raw.executionShape, EXECUTION_SHAPES);

  let nodes: ExecutionGraphNode[] | undefined;
  const rawNodes = requireArray(ctx, ['nodes'], raw.nodes, { minItems: 1 });
  if (rawNodes) {
    const items = rawNodes.map((v, i) => validateExecutionGraphNode(ctx, ['nodes', i], v));
    if (items.every((v): v is ExecutionGraphNode => v !== undefined)) {
      nodes = items;
      validateDagInvariants(ctx, ['nodes'], nodes, {
        requireMultiMemberGroup: executionShape === 'PARALLEL' || executionShape === 'COUNCIL',
      });
      // The operator remains sole topology owner: no node may name a
      // verification owner that does not exist in this graph.
      const ids = new Set(nodes.map((n) => n.nodeId));
      nodes.forEach((n, i) => {
        if (n.verificationOwnerNodeId !== undefined && !ids.has(n.verificationOwnerNodeId)) {
          pushErr(ctx, ['nodes', i, 'verificationOwnerNodeId'], `references unknown node id: ${n.verificationOwnerNodeId}`);
        }
      });
    }
  }

  const graphHash = requireHash(ctx, ['graphHash'], raw.graphHash);

  if (
    graphId === undefined ||
    graphRevision === undefined ||
    workflowTemplateId === undefined ||
    executionShape === undefined ||
    nodes === undefined ||
    graphHash === undefined
  ) {
    return finalize(ctx, out);
  }

  out.graphId = graphId;
  out.graphRevision = graphRevision;
  out.workflowTemplateId = workflowTemplateId;
  out.executionShape = executionShape;
  out.nodes = nodes;
  out.graphHash = graphHash;

  return finalize<ExecutionGraph>(ctx, out);
}

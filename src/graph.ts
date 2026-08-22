/**
 * Agent Operator — Stage 3 graph compiler (plan §4, §7).
 *
 * Compiles a `RegisteredWorkflowTemplate`'s policy-resolved nodes
 * (`workflow-templates.resolveTemplateNodes`) plus per-node capability
 * selections into a validated `ExecutionGraph.v1` with a canonical stable
 * SHA-256 `graphHash`. Enforces every plan §7 graph invariant that is
 * representable at this boundary:
 *
 * - unique node ids, unique/valid `dependsOn` entries, acyclic graph
 *   (`DUPLICATE_NODE_ID`, `DUPLICATE_DEPENDENCY`, `UNKNOWN_DEPENDENCY`,
 *   `CYCLE_DETECTED`);
 * - no implicit recursive delegation — the graph is a fixed, finite node
 *   list supplied once per compile call; nothing here can introduce a node
 *   beyond `input.nodes`, and cycle detection covers direct/indirect
 *   self-reference;
 * - every mandatory node actually has an assigned capability
 *   (`MISSING_SELECTION`);
 * - capability/role alignment and no capability overreach
 *   (`CAPABILITY_ROLE_MISMATCH`, `CAPABILITY_SHAPE_UNSUPPORTED`,
 *   `CAPABILITY_OVERREACH`, `CAPABILITY_UNDERPOWERED`);
 * - a mutation node's mutation class never exceeds the resolved policy's
 *   effective ceiling (`MUTATION_POLICY_VIOLATION`);
 * - a mutation node can never be its own verification owner, and any node
 *   declared independent of another role can never share its selected
 *   capability (`SELF_VERIFICATION`, `MISSING_VERIFICATION_OWNER`);
 * - every parallel/council group has exactly one synthesis owner, with at
 *   least two grouped members whenever the graph's shape is `PARALLEL`/
 *   `COUNCIL` (`INVALID_PARALLEL_SYNTHESIS`);
 * - exactly one un-grouped, mandatory operator-synthesis node exists, and it
 *   is graph-terminal — every other node precedes it
 *   (`MISSING_SYNTHESIS_OWNER`);
 * - policy-required gate types are actually declared by the template
 *   (`BYPASSED_MANDATORY_GATE`);
 * - every consumed artifact/context contract is produced by some ancestor
 *   (`MISSING_CONTEXT_CONTRACT`);
 * - no parallel group exceeds the resolved policy's concurrency ceiling
 *   (`CONCURRENCY_CEILING_EXCEEDED`).
 */

import { createHash } from 'node:crypto';
import type { ExecutionGraph, ExecutionGraphNode, ExecutionShape, GateDecisionType, MutationClass } from './contracts.js';
import type { CapabilitySelection, ResolvedPolicy } from './stage3-types.js';
import type { ResolvedTemplateNode } from './workflow-templates.js';

const MUTATION_CLASS_ORDER: Readonly<Record<MutationClass, number>> = {
  READ_ONLY: 0,
  LOCAL: 1,
  EXTERNAL: 2,
  DESTRUCTIVE: 3,
};

export type GraphCompilationErrorCode =
  | 'DUPLICATE_NODE_ID'
  | 'DUPLICATE_DEPENDENCY'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLE_DETECTED'
  | 'MISSING_SELECTION'
  | 'CAPABILITY_ROLE_MISMATCH'
  | 'CAPABILITY_SHAPE_UNSUPPORTED'
  | 'CAPABILITY_OVERREACH'
  | 'CAPABILITY_UNDERPOWERED'
  | 'MUTATION_POLICY_VIOLATION'
  | 'SELF_VERIFICATION'
  | 'MISSING_VERIFICATION_OWNER'
  | 'INVALID_PARALLEL_SYNTHESIS'
  | 'MISSING_SYNTHESIS_OWNER'
  | 'BYPASSED_MANDATORY_GATE'
  | 'MISSING_CONTEXT_CONTRACT'
  | 'CONCURRENCY_CEILING_EXCEEDED';

export interface GraphCompilationError {
  readonly code: GraphCompilationErrorCode;
  readonly message: string;
  readonly nodeId?: string;
}

export interface GraphCompilationInput {
  readonly graphId: string;
  readonly graphRevision: number;
  readonly workflowTemplateId: string;
  readonly executionShape: ExecutionShape;
  readonly requiredGateTypes: readonly GateDecisionType[];
  readonly policy: ResolvedPolicy;
  readonly nodes: readonly ResolvedTemplateNode[];
  readonly selections: Readonly<Record<string, CapabilitySelection>>;
}

export type GraphCompilationResult =
  | { readonly ok: true; readonly graph: ExecutionGraph }
  | { readonly ok: false; readonly errors: readonly GraphCompilationError[] };

/** Deterministically stable stringify: object keys sorted, so equal graphs
 * always hash identically regardless of construction order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const entries = sortedKeys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Canonical `ExecutionGraph.graphHash`: sha256 of the stable-key-sorted JSON
 * of every other field. Two structurally identical graphs always hash equal. */
export function computeGraphHash(graph: Omit<ExecutionGraph, 'graphHash'>): string {
  return createHash('sha256').update(stableStringify(graph)).digest('hex');
}

function findCycle(nodeIds: readonly string[], dependsOnByNodeId: Readonly<Record<string, readonly string[]>>): string | null {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color: Record<string, number> = {};
  for (const nodeId of nodeIds) {
    color[nodeId] = WHITE;
  }
  let cycleNodeId: string | null = null;
  const visit = (nodeId: string): void => {
    if (cycleNodeId !== null || color[nodeId] === BLACK) {
      return;
    }
    if (color[nodeId] === GRAY) {
      cycleNodeId = nodeId;
      return;
    }
    color[nodeId] = GRAY;
    for (const dep of dependsOnByNodeId[nodeId] ?? []) {
      visit(dep);
      if (cycleNodeId !== null) {
        break;
      }
    }
    color[nodeId] = BLACK;
  };
  for (const nodeId of nodeIds) {
    visit(nodeId);
    if (cycleNodeId !== null) {
      break;
    }
  }
  return cycleNodeId;
}

/** Every nodeId transitively reachable via `dependsOn` from `nodeId` (its ancestors). */
function ancestorsOf(nodeId: string, dependsOnByNodeId: Readonly<Record<string, readonly string[]>>): ReadonlySet<string> {
  const seen = new Set<string>();
  const stack = [...(dependsOnByNodeId[nodeId] ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const dep of dependsOnByNodeId[current] ?? []) {
      stack.push(dep);
    }
  }
  return seen;
}

export function compileExecutionGraph(input: GraphCompilationInput): GraphCompilationResult {
  const errors: GraphCompilationError[] = [];
  const { nodes, selections, policy } = input;

  // --- unique node ids ------------------------------------------------
  const seenNodeIds = new Set<string>();
  for (const node of nodes) {
    if (seenNodeIds.has(node.nodeId)) {
      errors.push({ code: 'DUPLICATE_NODE_ID', message: `Node id "${node.nodeId}" is declared more than once.`, nodeId: node.nodeId });
    }
    seenNodeIds.add(node.nodeId);
  }
  const nodeById: Readonly<Record<string, ResolvedTemplateNode>> = Object.fromEntries(nodes.map((node) => [node.nodeId, node]));

  // --- dependsOn: duplicates within one node, and unknown targets -----
  for (const node of nodes) {
    const seenDeps = new Set<string>();
    for (const dep of node.dependsOn) {
      if (seenDeps.has(dep)) {
        errors.push({ code: 'DUPLICATE_DEPENDENCY', message: `Node "${node.nodeId}" lists dependency "${dep}" more than once.`, nodeId: node.nodeId });
      }
      seenDeps.add(dep);
      if (nodeById[dep] === undefined) {
        errors.push({ code: 'UNKNOWN_DEPENDENCY', message: `Node "${node.nodeId}" depends on unknown node "${dep}".`, nodeId: node.nodeId });
      }
    }
  }

  const dependsOnByNodeId: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
    nodes.map((node) => [node.nodeId, node.dependsOn.filter((dep) => nodeById[dep] !== undefined)]),
  );

  // --- acyclic ----------------------------------------------------------
  const cycleNodeId = findCycle(nodes.map((node) => node.nodeId), dependsOnByNodeId);
  if (cycleNodeId !== null) {
    errors.push({ code: 'CYCLE_DETECTED', message: `Dependency cycle detected reaching node "${cycleNodeId}".`, nodeId: cycleNodeId });
  }

  // --- every node has a selection; capability/role alignment -----------
  for (const node of nodes) {
    const selection = selections[node.nodeId];
    if (selection === undefined) {
      errors.push({
        code: 'MISSING_SELECTION',
        message: `Node "${node.nodeId}" (mandatory=${node.mandatory}) has no capability selection.`,
        nodeId: node.nodeId,
      });
      continue;
    }
    if (selection.requirement.role !== node.role || !selection.selected.capabilities.includes(node.requirement.capability)) {
      errors.push({
        code: 'CAPABILITY_ROLE_MISMATCH',
        message: `Node "${node.nodeId}" requires role "${node.role}"/capability "${node.requirement.capability}"; selection does not satisfy it.`,
        nodeId: node.nodeId,
      });
    }
    if (!selection.selected.supports.includes(node.requirement.executionShape)) {
      errors.push({
        code: 'CAPABILITY_SHAPE_UNSUPPORTED',
        message: `Node "${node.nodeId}" requires execution shape "${node.requirement.executionShape}"; selected capability "${selection.selected.id}" does not support it.`,
        nodeId: node.nodeId,
      });
    }
    if (node.requirement.mutationClass === 'READ_ONLY' && selection.selected.mutability === 'MUTATING') {
      errors.push({
        code: 'CAPABILITY_OVERREACH',
        message: `Node "${node.nodeId}" is read-only; selected capability "${selection.selected.id}" is granted mutation power it does not need.`,
        nodeId: node.nodeId,
      });
    }
    if (node.requirement.mutationClass !== 'READ_ONLY' && selection.selected.mutability === 'READ_ONLY') {
      errors.push({
        code: 'CAPABILITY_UNDERPOWERED',
        message: `Node "${node.nodeId}" requires mutation class "${node.requirement.mutationClass}"; selected capability "${selection.selected.id}" is read-only.`,
        nodeId: node.nodeId,
      });
    }
  }

  // --- mutation ceiling ---------------------------------------------------
  const declaredCeilings = policy.packs
    .map((pack) => pack.rules.maximumMutationClass)
    .filter((value): value is MutationClass => value !== undefined);
  const ceilingOrder = declaredCeilings.length > 0 ? Math.min(...declaredCeilings.map((value) => MUTATION_CLASS_ORDER[value])) : MUTATION_CLASS_ORDER.DESTRUCTIVE;
  for (const node of nodes) {
    if (node.mutation !== undefined && MUTATION_CLASS_ORDER[node.mutation.mutationClass] > ceilingOrder) {
      errors.push({
        code: 'MUTATION_POLICY_VIOLATION',
        message: `Node "${node.nodeId}" mutation class "${node.mutation.mutationClass}" exceeds the resolved policy's mutation ceiling.`,
        nodeId: node.nodeId,
      });
    }
  }

  // --- self-verification: mutation owners, and declared role independence
  for (const node of nodes) {
    const selection = selections[node.nodeId];
    if (node.mutation === undefined || selection === undefined) {
      continue;
    }
    const ownerId = node.mutation.verificationOwnerNodeId;
    if (ownerId === node.nodeId) {
      errors.push({ code: 'SELF_VERIFICATION', message: `Node "${node.nodeId}" cannot be its own verification owner.`, nodeId: node.nodeId });
      continue;
    }
    const ownerNode = nodeById[ownerId];
    const ownerSelection = selections[ownerId];
    if (ownerNode === undefined || ownerSelection === undefined) {
      errors.push({
        code: 'MISSING_VERIFICATION_OWNER',
        message: `Node "${node.nodeId}" declares verification owner "${ownerId}", which is not a resolved node with a selection.`,
        nodeId: node.nodeId,
      });
      continue;
    }
    if (ownerSelection.selected.id === selection.selected.id || ownerNode.role === node.role) {
      errors.push({
        code: 'SELF_VERIFICATION',
        message: `Node "${node.nodeId}" and its verification owner "${ownerId}" must use distinct capability identities and roles.`,
        nodeId: node.nodeId,
      });
    }
  }
  for (const node of nodes) {
    const selection = selections[node.nodeId];
    if (selection === undefined || node.requirement.independentFromRoles.length === 0) {
      continue;
    }
    for (const other of nodes) {
      if (other.nodeId === node.nodeId || !node.requirement.independentFromRoles.includes(other.role)) {
        continue;
      }
      const otherSelection = selections[other.nodeId];
      if (otherSelection !== undefined && otherSelection.selected.id === selection.selected.id) {
        errors.push({
          code: 'SELF_VERIFICATION',
          message: `Node "${node.nodeId}" must be independent of role "${other.role}" (node "${other.nodeId}") but resolved to the same capability.`,
          nodeId: node.nodeId,
        });
      }
    }
  }

  // --- parallel/council group synthesis ----------------------------------
  const groupIds = new Set(nodes.map((node) => node.groupId).filter((groupId): groupId is string => groupId !== undefined));
  for (const groupId of groupIds) {
    const members = nodes.filter((node) => node.groupId === groupId);
    const owners = members.filter((node) => node.synthesisOwner);
    if (owners.length !== 1) {
      errors.push({
        code: 'INVALID_PARALLEL_SYNTHESIS',
        message: `Group "${groupId}" must have exactly one synthesis-owner node; found ${owners.length}.`,
      });
    }
  }
  if ((input.executionShape === 'PARALLEL' || input.executionShape === 'COUNCIL') && nodes.filter((node) => node.groupId !== undefined).length < 2) {
    errors.push({
      code: 'INVALID_PARALLEL_SYNTHESIS',
      message: `Execution shape "${input.executionShape}" requires at least two grouped nodes.`,
    });
  }

  // --- concurrency ceiling: siblings actually dispatched together --------
  for (const groupId of groupIds) {
    const concurrentMembers = nodes.filter((node) => node.groupId === groupId && !node.synthesisOwner);
    if (concurrentMembers.length > policy.maxConcurrency) {
      errors.push({
        code: 'CONCURRENCY_CEILING_EXCEEDED',
        message: `Group "${groupId}" would dispatch ${concurrentMembers.length} nodes concurrently, exceeding policy maxConcurrency ${policy.maxConcurrency}.`,
      });
    }
  }

  // --- exactly one terminal, mandatory, un-grouped operator-synthesis node
  const finalCandidates = nodes.filter((node) => node.synthesisOwner && node.groupId === undefined);
  if (finalCandidates.length !== 1) {
    errors.push({
      code: 'MISSING_SYNTHESIS_OWNER',
      message: `Workflow must have exactly one un-grouped operator-synthesis node; found ${finalCandidates.length}.`,
    });
  } else {
    const final = finalCandidates[0] as ResolvedTemplateNode;
    if (!final.mandatory) {
      errors.push({ code: 'MISSING_SYNTHESIS_OWNER', message: `Operator-synthesis node "${final.nodeId}" must be mandatory.`, nodeId: final.nodeId });
    }
    const dependents = nodes.filter((node) => node.dependsOn.includes(final.nodeId));
    if (dependents.length > 0) {
      errors.push({
        code: 'MISSING_SYNTHESIS_OWNER',
        message: `Operator-synthesis node "${final.nodeId}" must be terminal; ${dependents.map((node) => node.nodeId).join(', ')} depend(s) on it.`,
        nodeId: final.nodeId,
      });
    }
    const ancestors = ancestorsOf(final.nodeId, dependsOnByNodeId);
    const missingAncestors = nodes.filter((node) => node.nodeId !== final.nodeId && !ancestors.has(node.nodeId));
    if (missingAncestors.length > 0) {
      errors.push({
        code: 'MISSING_SYNTHESIS_OWNER',
        message: `Operator-synthesis node "${final.nodeId}" must follow every other node; missing a path from ${missingAncestors.map((node) => node.nodeId).join(', ')}.`,
        nodeId: final.nodeId,
      });
    }
  }

  // --- policy-required gates must be declared by the template -----------
  // EXECUTION_APPROVAL is the always-present, session-level initial gate
  // (built separately by the compiler from WorkflowCompilerContext.gateId,
  // per stage3-types.CompiledWorkflow.initialGate) — it is never a
  // template-declared terminal gate, so it is intentionally excluded here.
  for (const gateType of policy.requiredGates) {
    if (gateType !== 'EXECUTION_APPROVAL' && !input.requiredGateTypes.includes(gateType)) {
      errors.push({
        code: 'BYPASSED_MANDATORY_GATE',
        message: `Resolved policy requires gate "${gateType}", but template "${input.workflowTemplateId}" does not declare it.`,
      });
    }
  }

  // --- context/artifact contracts: every consumed type is produced upstream
  for (const node of nodes) {
    const ancestors = ancestorsOf(node.nodeId, dependsOnByNodeId);
    for (const consumed of node.contract.consumes) {
      const isProducedUpstream = [...ancestors].some((ancestorId) => nodeById[ancestorId]?.contract.produces.includes(consumed) === true);
      if (!isProducedUpstream) {
        errors.push({
          code: 'MISSING_CONTEXT_CONTRACT',
          message: `Node "${node.nodeId}" consumes "${consumed}", which no ancestor node produces.`,
          nodeId: node.nodeId,
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const executionNodes: ExecutionGraphNode[] = nodes.map((node) => {
    const selection = selections[node.nodeId] as CapabilitySelection;
    const executionNode: ExecutionGraphNode = {
      nodeId: node.nodeId,
      capabilityId: selection.selected.id,
      role: node.role,
      ...(input.workflowTemplateId === 'qa.v2' || input.workflowTemplateId === 'ui-change.v2' || input.workflowTemplateId === 'fleet.v1' ? { requiredCapability: node.requirement.capability } : {}),
      mandatory: node.mandatory,
      dependsOn: node.dependsOn,
      contextPolicy: node.contract.contextPolicy,
      consumes: node.contract.consumes,
      produces: node.contract.produces,
      ...(node.groupId !== undefined ? { groupId: node.groupId } : {}),
      ...(node.synthesisOwner ? { synthesisOwner: true } : {}),
      ...(node.mutation !== undefined
        ? {
            verificationOwnerNodeId: node.mutation.verificationOwnerNodeId,
            mutation: {
              mutationId: `${input.graphId}:${node.nodeId}`,
              mutationClass: node.mutation.mutationClass,
              retryPolicy: node.mutation.retryPolicy,
            },
          }
        : {}),
    };
    return executionNode;
  });

  const graphWithoutHash: Omit<ExecutionGraph, 'graphHash'> = {
    graphId: input.graphId,
    graphRevision: input.graphRevision,
    workflowTemplateId: input.workflowTemplateId,
    executionShape: input.executionShape,
    nodes: executionNodes,
  };
  return { ok: true, graph: { ...graphWithoutHash, graphHash: computeGraphHash(graphWithoutHash) } };
}

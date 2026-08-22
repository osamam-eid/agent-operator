/**
 * Agent Operator — node-graph promotion and ready-batch selection (plan
 * §4.4).
 *
 * `promoteReadyNodes` marks every `PENDING` node whose dependencies have
 * completed `READY`; `selectReadyBatch` then picks the exact node(s)
 * `beginExecutionBatch` may dispatch next from among the currently `READY`
 * nodes. Neither ever consults the store, the clock, or any runtime-owned
 * identity ledger.
 */

import type { ExecutionGraph, ExecutionGraphNode, NodeState } from '../contracts.js';
import type { StoredOperatorSession } from '../runtime-types.js';
import { isDegradedOptionalState } from './verification.js';

/** Marks every `PENDING` node whose dependencies have completed. Mandatory
 * dependencies must succeed; a failed/blocked/cancelled/skipped optional
 * dependency is a satisfied edge carrying an explicit degraded outcome. A
 * `PARALLEL` synthesis owner's own `dependsOn` already lists every required
 * group member, so it is never promoted until they are all terminal. */
export function promoteReadyNodes(graph: ExecutionGraph, nodeStates: Readonly<Record<string, NodeState>>): Record<string, NodeState> {
  const next: Record<string, NodeState> = { ...nodeStates };
  const nodeById = Object.fromEntries(graph.nodes.map((node) => [node.nodeId, node]));
  for (const node of graph.nodes) {
    const dependenciesCompleted = node.dependsOn.every((dependencyId) => {
      const dependencyState = next[dependencyId];
      const dependency = nodeById[dependencyId];
      return dependencyState === 'SUCCEEDED' || (dependency?.mandatory === false && isDegradedOptionalState(dependencyState));
    });
    if (next[node.nodeId] === 'PENDING' && dependenciesCompleted) {
      next[node.nodeId] = 'READY';
    }
  }
  return next;
}

export interface BatchSelectionPolicy {
  /** Effective concurrency ceiling for a `PARALLEL` group: the minimum of
   * the session's resolved policy `maxConcurrency` and any narrower
   * per-capability/adapter ceiling the controller already intersected in
   * before calling this function. Ignored for `SINGLE`/`PIPELINE`, which
   * always select at most one node. */
  readonly maxConcurrency: number;
}

/** Selects the exact node(s) `beginExecutionBatch` may dispatch next.
 * `SINGLE`/`PIPELINE`: at most one `READY` node, in declared graph order
 * (deterministic). `PARALLEL`: every currently `READY` node in one
 * validated group, capped by `policy.maxConcurrency` (also in declared
 * graph order, so a bounded batch is deterministic run to run). Returns an
 * empty array when the session is not `READY`, has no execution graph, or
 * no node is currently `READY` (nothing to select is not an error — the
 * caller decides what that means for the command in progress). */
export function selectReadyBatch(record: StoredOperatorSession, policy: BatchSelectionPolicy): readonly ExecutionGraphNode[] {
  const graph = record.session.executionGraph;
  if (record.session.currentState !== 'READY' || graph === null) {
    return [];
  }
  const readyNodes = graph.nodes.filter((node) => record.session.nodeStates[node.nodeId] === 'READY');
  if (readyNodes.length === 0) {
    return [];
  }
  if (graph.executionShape !== 'PARALLEL') {
    const first = readyNodes[0];
    return first === undefined ? [] : [first];
  }
  const cap = Math.max(1, Math.min(policy.maxConcurrency, readyNodes.length));
  return readyNodes.slice(0, cap);
}

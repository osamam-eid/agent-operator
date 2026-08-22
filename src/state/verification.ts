/**
 * Agent Operator — verification-state and optional-node-degradation
 * derivation.
 *
 * Pure helpers that derive two related truths purely from the compiled
 * execution graph and the current `nodeStates` map: which optional nodes
 * are degraded (a non-mandatory node in a terminal-but-not-SUCCEEDED
 * state), and the session's overall `VerificationState` (one entry per
 * reviewer/verifier role). Neither ever consults the store, the clock, or
 * any runtime-owned identity ledger — both are recomputed fresh from graph
 * + node states every time the reducer needs them.
 */

import type { ExecutionGraph, NodeState, VerificationState } from '../contracts.js';

export function isDegradedOptionalState(state: NodeState | undefined): boolean {
  return state === 'FAILED' || state === 'BLOCKED' || state === 'CANCELLED' || state === 'SKIPPED';
}

export function degradedOptionalNodeIds(
  graph: ExecutionGraph,
  nodeStates: Readonly<Record<string, NodeState>>,
): readonly string[] {
  return graph.nodes
    .filter((node) => !node.mandatory && isDegradedOptionalState(nodeStates[node.nodeId]))
    .map((node) => node.nodeId);
}

type VerificationStateKey = keyof VerificationState;

function verificationKeyForRole(role: string): VerificationStateKey | undefined {
  switch (role) {
    case 'behavioral-verifier':
      return 'behavioralVerification';
    case 'conformance-verifier':
      return 'conformanceVerification';
    case 'independent-reviewer':
      return 'independentReview';
    case 'adversarial-reviewer':
      return 'adversarialReview';
    default:
      return undefined;
  }
}

/** Derives verification truth from the compiled graph and current node
 * states. A successful reviewer/verifier node is a passed verification;
 * an applicable but unstarted node is never reported as N/A. */
export function deriveVerificationState(
  graph: ExecutionGraph,
  nodeStates: Readonly<Record<string, NodeState>>,
): VerificationState {
  const derive = (key: VerificationStateKey): VerificationState[VerificationStateKey] => {
    const nodes = graph.nodes.filter((node) => verificationKeyForRole(node.role) === key);
    if (nodes.length === 0) return 'NOT_APPLICABLE';
    const states = nodes.map((node) => nodeStates[node.nodeId]);
    if (states.some((state) => state === 'RUNNING')) return 'IN_PROGRESS';
    if (states.some((state) => state === 'FAILED' || state === 'BLOCKED' || state === 'CANCELLED' || state === 'UNKNOWN' || state === 'SKIPPED')) {
      return 'FAILED';
    }
    if (states.every((state) => state === 'SUCCEEDED')) return 'PASSED';
    return 'NOT_STARTED';
  };
  return {
    behavioralVerification: derive('behavioralVerification'),
    conformanceVerification: derive('conformanceVerification'),
    independentReview: derive('independentReview'),
    adversarialReview: derive('adversarialReview'),
  };
}

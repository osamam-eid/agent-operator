/**
 * Agent Operator — node-execution outcome mapping and identity binding.
 *
 * Translates a provider-returned `AgentResult`/`AgentResultStatus` into the
 * reducer's own vocabulary (`NodeState`, `NodeResultRefs`, journal event
 * names), and verifies that an incoming `NodeExecutionOutcome` is exactly
 * the attempt this session is currently running for that node — the only
 * identity check `completeExecutionBatch`/`reconcileExecutionBatch` may
 * trust, since only the reducer holds `activeAttempts`.
 */

import type { AgentResult, AgentResultStatus, NodeState } from '../contracts.js';
import type { NodeExecutionOutcome, NodeResultRefs, StoredOperatorSession } from '../runtime-types.js';
import type { FailureFingerprint, ProviderFallbackJournal } from '../execution-safety.js';

export function mapAgentResultStatusToNodeState(status: AgentResultStatus): NodeState {
  switch (status) {
    case 'SUCCEEDED':
      return 'SUCCEEDED';
    case 'FAILED':
      return 'FAILED';
    case 'BLOCKED':
      return 'BLOCKED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'UNKNOWN':
      return 'UNKNOWN';
  }
}

export function toNodeResultRefs(
  result: AgentResult,
  attempt: NodeExecutionOutcome['attempt'],
  completedAt: string,
  usage: NodeExecutionOutcome['usage'] = undefined,
  failureFingerprint?: FailureFingerprint,
  fallbackJournal?: ProviderFallbackJournal,
): NodeResultRefs {
  return {
    status: result.status,
    summary: result.summary,
    producedArtifactRefs: result.producedArtifactRefs,
    consumedArtifactRefs: result.consumedArtifactRefs,
    evidenceIds: result.evidenceIds,
    findingIds: result.findingIds,
    policyRefs: result.policyRefs,
    ...(result.recommendedDisposition !== undefined ? { recommendedDisposition: result.recommendedDisposition } : {}),
    providerSessionId: attempt.providerSessionId,
    modelProvider: attempt.modelProvider,
    modelId: attempt.modelId,
    startedAt: attempt.startedAt,
    completedAt,
    ...(failureFingerprint === undefined ? {} : { failureFingerprint }),
    ...(fallbackJournal === undefined ? {} : { fallbackJournal }),
    ...(usage !== undefined ? { usage } : {}),
  };
}

export function journalEventForStatus(status: AgentResultStatus): string {
  switch (status) {
    case 'SUCCEEDED':
      return 'EXECUTION_SUCCEEDED';
    case 'FAILED':
      return 'EXECUTION_FAILED';
    case 'BLOCKED':
      return 'EXECUTION_BLOCKED';
    case 'CANCELLED':
      return 'EXECUTION_CANCELLED';
    case 'UNKNOWN':
      return 'EXECUTION_UNKNOWN';
  }
}

/** Whether `outcome.attempt` is exactly the attempt this session is
 * currently RUNNING for `outcome.attempt.nodeId`, and `outcome.result`'s
 * own identity fields agree. A caller-side (controller) shape validation
 * of `outcome.result` against `AgentResult.v1` is assumed to have already
 * happened; this only checks identity binding, which only this reducer can
 * do (it alone holds `activeAttempts`). */
export function outcomeMatchesActiveAttempt(record: StoredOperatorSession, outcome: NodeExecutionOutcome): boolean {
  const expected = record.activeAttempts[outcome.attempt.nodeId];
  if (expected === undefined) return false;
  const a = outcome.attempt;
  return (
    expected.attemptId === a.attemptId &&
    expected.batchId === a.batchId &&
    expected.operatorSessionId === a.operatorSessionId &&
    expected.graphRevision === a.graphRevision &&
    expected.nodeId === a.nodeId &&
    expected.capabilityId === a.capabilityId &&
    expected.adapterId === a.adapterId &&
    expected.providerSessionId === a.providerSessionId &&
    outcome.result.operatorSessionId === record.session.operatorSessionId &&
    outcome.result.nodeId === a.nodeId &&
    outcome.result.capabilityId === a.capabilityId
  );
}

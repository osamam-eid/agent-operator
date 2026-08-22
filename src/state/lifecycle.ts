/**
 * Agent Operator — session lifecycle termination: CANCEL/TIMEOUT and
 * RESUME reconciliation.
 *
 * `cancelExecutionBatch` and `reconcileExecutionBatch` are the two
 * reducers that end (or reconcile) a session from outside the normal
 * CONTINUE fold: an explicit user/shutdown cancel, a per-batch timeout, or
 * a controller resume discovering nodes that were left `RUNNING` when the
 * process last stopped. `reconcileExecutionBatch` folds any provable
 * outcomes through `completeExecutionBatch` before blocking on whatever
 * remains unproven, so the two lifecycles share this module.
 */

import type { ExecutionStatus, NodeState, OperatorSession, StopDetail } from '../contracts.js';
import type { NodeExecutionAttemptAllocation, NodeExecutionOutcome, OperatorIdFactory, StoredOperatorSession } from '../runtime-types.js';
import { completeExecutionBatch } from '../state.js';
import { appendJournal } from '../store.js';
import { transitionError, type OperatorTransitionError } from './errors.js';
import { buildFinalResult } from './final-result.js';
import { outcomeMatchesActiveAttempt } from './outcomes.js';
import { deriveVerificationState } from './verification.js';

/** Cancels every attempt named by `attemptIds` (the controller passes every
 * currently active attempt — Stage 4's `ActiveExecutionBatch.cancel`
 * operates on the whole batch, never a single node within it). `USER`/
 * `SHUTDOWN` end the session in the terminal `CANCELLED` state, matching
 * every prior Stage 1-3 CANCEL behavior. `TIMEOUT` instead moves the
 * session to the non-terminal `BLOCKED` state (a human can cancel it, or a
 * later explicitly planned recovery command may resume it) — this runtime
 * never retries automatically either way. */
export function cancelExecutionBatch(
  record: StoredOperatorSession,
  attemptIds: readonly string[],
  reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN',
  now: string,
): StoredOperatorSession | OperatorTransitionError {
  const { currentState } = record.session;
  if (currentState === 'COMPLETED' || currentState === 'FAILED' || currentState === 'CANCELLED') {
    return transitionError('INVALID_TRANSITION', `Cannot cancel a session already in terminal state ${currentState}.`);
  }

  const cancelledNodeIds = Object.values(record.activeAttempts)
    .filter((attempt) => attemptIds.includes(attempt.attemptId))
    .map((attempt) => attempt.nodeId);
  const nextNodeStates: Record<string, NodeState> = { ...record.session.nodeStates };
  const nextActiveAttempts: Record<string, NodeExecutionAttemptAllocation> = { ...record.activeAttempts };
  for (const nodeId of cancelledNodeIds) {
    nextNodeStates[nodeId] = 'CANCELLED';
    delete nextActiveAttempts[nodeId];
  }
  const verificationState =
    record.session.executionGraph === null
      ? record.session.verificationState
      : deriveVerificationState(record.session.executionGraph, nextNodeStates);

  const templateId = record.session.workflowTemplateId ?? 'workflow';
  const openGateId = record.session.openGateId;
  const updatedGates =
    currentState === 'AWAITING_HUMAN' && openGateId !== undefined
      ? record.gates.map((candidate) => (candidate.gateId === openGateId ? { ...candidate, status: 'SUPERSEDED' as const } : candidate))
      : record.gates;
  const { openGateId: _openGateId, stopDetail: _stopDetail, ...sessionSansTransient } = record.session;

  if (reason === 'TIMEOUT') {
    const stopDetail: StopDetail = {
      reason: 'BLOCKED_PROVIDER_UNAVAILABLE',
      affectedNodeId: cancelledNodeIds[0] ?? templateId,
      evidenceRefs: [],
      retryEligible: false,
      requiredDecisionOrPrerequisite: `Node(s) [${cancelledNodeIds.join(', ')}] exceeded their timeout and were cancelled; this runtime never retries automatically. Cancel this session or plan an explicit recovery.`,
      nextAllowedActions: ['CANCEL'],
    };
    const blocked: OperatorSession = {
      ...sessionSansTransient,
      nodeStates: nextNodeStates,
      verificationState,
      currentState: 'BLOCKED',
      currentPhase: 'Blocked after node timeout',
      stopDetail,
    };
    const journaled = appendJournal(blocked, {
      timestamp: now,
      eventType: 'EXECUTION_TIMED_OUT',
      operatorSessionId: blocked.operatorSessionId,
      message: `Node(s) [${cancelledNodeIds.join(', ')}] timed out and were cancelled; session blocked pending human decision.`,
    });
    return { ...record, session: journaled, gates: updatedGates, activeAttempts: nextActiveAttempts };
  }

  const nodeHasStarted = Object.values(record.session.nodeStates).some((state) => state !== 'PENDING');
  const executionStatus: ExecutionStatus = nodeHasStarted ? 'CANCELLED' : 'NOT_STARTED';
  const terminalSession: OperatorSession = {
    ...sessionSansTransient,
    nodeStates: nextNodeStates,
    verificationState,
    currentState: 'CANCELLED',
    currentPhase: 'Cancelled',
    terminalResult: null,
  };
  const terminal = buildFinalResult({
    session: terminalSession,
    workflowStatus: 'CANCELLED',
    executionStatus,
    recommendation: 'STOP',
    recommendationRationale: reason === 'SHUTDOWN' ? 'The session was cancelled because the runtime shut down.' : 'The session was cancelled by explicit user command.',
    workPerformed: [],
    changesMade: [],
    actionsNotPerformed: [`Execution of the "${templateId}" workflow (session cancelled).`],
    nodeResultRefs: record.nodeResultRefs,
  });
  const cancelled: OperatorSession = {
    ...terminalSession,
    terminalResult: terminal,
  };
  const journaled = appendJournal(cancelled, {
    timestamp: now,
    eventType: 'SESSION_CANCELLED',
    operatorSessionId: cancelled.operatorSessionId,
    message: reason === 'SHUTDOWN' ? 'Session cancelled by runtime shutdown.' : 'Session cancelled by user command.',
  });
  return { ...record, session: journaled, gates: updatedGates, activeAttempts: nextActiveAttempts };
}

/** No-op when nothing was left RUNNING. Otherwise, for every RUNNING node:
 * ingests `providerEvidence`'s outcome for it once, if present and its
 * attempt still matches `activeAttempts` exactly (same identity binding as
 * `completeExecutionBatch`, folded the same way, including preserving a
 * terminal result if a proven outcome ends the session). Any RUNNING node
 * left unproven becomes `UNKNOWN`, and the non-terminal session moves to
 * `BLOCKED` with a `StopDetail` naming it — never retried automatically. */
export function reconcileExecutionBatch(
  record: StoredOperatorSession,
  providerEvidence: readonly NodeExecutionOutcome[],
  ids: OperatorIdFactory,
  now: string,
): StoredOperatorSession {
  const runningNodeIds = Object.entries(record.session.nodeStates)
    .filter(([, state]) => state === 'RUNNING')
    .map(([nodeId]) => nodeId);
  if (runningNodeIds.length === 0) {
    return record;
  }

  const proven = providerEvidence.filter((outcome) => outcomeMatchesActiveAttempt(record, outcome) && runningNodeIds.includes(outcome.attempt.nodeId));
  const provenNodeIds = new Set(proven.map((outcome) => outcome.attempt.nodeId));
  const unprovenNodeIds = runningNodeIds.filter((nodeId) => !provenNodeIds.has(nodeId));

  const afterProven = proven.length > 0 ? completeExecutionBatch(record, proven, ids, now) : record;
  if (unprovenNodeIds.length === 0) {
    return afterProven;
  }

  // A proven terminal outcome wins over the unresolved peers. Preserve the
  // terminal result produced by completeExecutionBatch rather than replacing
  // it with BLOCKED, which would violate the terminalResult/session-state
  // invariant. The remaining active attempts stay recorded as RUNNING
  // evidence; the terminal state prevents any automatic redispatch.
  if (afterProven.session.currentState === 'COMPLETED' || afterProven.session.currentState === 'FAILED' || afterProven.session.currentState === 'CANCELLED') {
    return afterProven;
  }

  const nextNodeStates: Record<string, NodeState> = { ...afterProven.session.nodeStates };
  const nextActiveAttempts: Record<string, NodeExecutionAttemptAllocation> = { ...afterProven.activeAttempts };
  for (const nodeId of unprovenNodeIds) {
    nextNodeStates[nodeId] = 'UNKNOWN';
    delete nextActiveAttempts[nodeId];
  }

  const stopDetail: StopDetail = {
    reason: 'BLOCKED_PROVIDER_UNAVAILABLE',
    affectedNodeId: unprovenNodeIds[0] ?? 'unknown',
    evidenceRefs: [],
    retryEligible: false,
    requiredDecisionOrPrerequisite: `Node(s) [${unprovenNodeIds.join(', ')}] were RUNNING when this session was interrupted; their outcome is unknown and this runtime never retries automatically. Cancel this session or start a new one.`,
    nextAllowedActions: ['CANCEL'],
  };

  const { openGateId: _openGateId, ...sessionSansGate } = afterProven.session;
  const blocked: OperatorSession = {
    ...sessionSansGate,
    nodeStates: nextNodeStates,
    verificationState:
      afterProven.session.executionGraph === null
        ? afterProven.session.verificationState
        : deriveVerificationState(afterProven.session.executionGraph, nextNodeStates),
    currentState: 'BLOCKED',
    currentPhase: 'Blocked pending reconciliation after resume',
    stopDetail,
  };
  const journaled = appendJournal(blocked, {
    timestamp: now,
    eventType: 'RESUME_RECONCILED',
    operatorSessionId: blocked.operatorSessionId,
    ...(unprovenNodeIds[0] !== undefined ? { nodeId: unprovenNodeIds[0] } : {}),
    evidenceRefs: [],
    message: `Resume found node(s) [${unprovenNodeIds.join(', ')}] still RUNNING with no provable terminal outcome; reconciled to UNKNOWN and blocked (no automatic retry).`,
  });
  return { ...afterProven, session: journaled, activeAttempts: nextActiveAttempts };
}

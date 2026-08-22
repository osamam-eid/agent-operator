import type { AgentResult, AgentResultStatus } from '../../contracts.js';
import type { ActiveExecutionBatch, ExecutionBatchRequest, NodeExecutionAttempt, NodeExecutionOutcome, NodeExecutionRequest } from '../../runtime-types.js';
import type { UiAdapterId } from './contracts.js';

export function adapterFailure(request: NodeExecutionRequest, adapterId: UiAdapterId, status: AgentResultStatus, summary: string): NodeExecutionOutcome {
  const attempt: NodeExecutionAttempt = { ...request.allocation, modelProvider: adapterId === 'stage7-sol-assurance' ? 'kiro' : 'stage7-fixed', modelId: adapterId === 'stage7-sol-assurance' ? 'gpt-5.6-sol' : adapterId };
  const result: AgentResult = {
    resultId: attempt.attemptId,
    operatorSessionId: attempt.operatorSessionId,
    nodeId: attempt.nodeId,
    capabilityId: attempt.capabilityId,
    status,
    summary,
    producedArtifactRefs: [],
    consumedArtifactRefs: [],
    findingIds: [],
    evidenceIds: [],
    startedAt: attempt.startedAt,
    completedAt: new Date().toISOString(),
    policyRefs: [],
  };
  return { attempt, result };
}

export function uiBatch(
  request: ExecutionBatchRequest,
  adapterId: UiAdapterId,
  run: (node: NodeExecutionRequest, signal: AbortSignal) => Promise<NodeExecutionOutcome>,
): ActiveExecutionBatch {
  const controller = new AbortController();
  const completion = Promise.allSettled(request.nodes.map((node) => run(node, controller.signal))).then((settled) => settled.map((entry, index) => {
    const node = request.nodes[index];
    if (node === undefined) throw new Error('UI batch lost node ordering.');
    if (entry.status === 'fulfilled') return entry.value;
    return adapterFailure(node, adapterId, controller.signal.aborted ? 'UNKNOWN' : 'BLOCKED', entry.reason instanceof Error ? entry.reason.message : String(entry.reason));
  }));
  return {
    batchId: request.batchId,
    attempts: request.nodes.map((node) => ({ ...node.allocation, modelProvider: adapterId === 'stage7-sol-assurance' ? 'kiro' : 'stage7-fixed', modelId: adapterId === 'stage7-sol-assurance' ? 'gpt-5.6-sol' : adapterId })),
    completion,
    async cancel(reason): Promise<void> {
      controller.abort(reason);
      await completion;
    },
  };
}

export function requireNode(request: NodeExecutionRequest, expectedNodeId: string, expectedCapability: string): void {
  if (request.node.nodeId !== expectedNodeId || request.node.requiredCapability !== expectedCapability || request.mutationClass !== (expectedNodeId === 'ui-v2-governed-implementation' ? 'LOCAL' : 'READ_ONLY')) {
    throw new Error(`UI route mismatch: expected ${expectedNodeId}/${expectedCapability}.`);
  }
}

export function requireSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('UI execution was cancelled before dispatch.');
}

export function abortReason(signal: AbortSignal): 'USER' | 'TIMEOUT' | 'SHUTDOWN' {
  return signal.reason === 'TIMEOUT' ? 'TIMEOUT' : signal.reason === 'SHUTDOWN' ? 'SHUTDOWN' : 'USER';
}

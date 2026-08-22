import type { AgentResult } from '../../contracts.js';
import type { ActiveExecutionBatch, ExecutionBatchRequest, NodeExecutionAttempt, NodeExecutionOutcome, NodeExecutionRequest } from '../../runtime-types.js';
import { NativeQaSessionRunner } from './native-session.js';
import type { QaNativeBinding, QaSessionRunInput, QaSessionRunResult } from './types.js';

export function safeQaFailure(attempt: NodeExecutionAttempt, status: AgentResult['status'], code: string): AgentResult {
  return {
    resultId: attempt.attemptId,
    operatorSessionId: attempt.operatorSessionId,
    nodeId: attempt.nodeId,
    capabilityId: attempt.capabilityId,
    status,
    summary: `[${code}] QA adapter blocked or failed before an authoritative terminal result.`,
    producedArtifactRefs: [],
    consumedArtifactRefs: [],
    findingIds: [],
    evidenceIds: [],
    providerSessionId: attempt.providerSessionId,
    startedAt: attempt.startedAt,
    completedAt: new Date().toISOString(),
    policyRefs: [],
  };
}

export function assertQaRequest(request: NodeExecutionRequest, binding: QaNativeBinding): void {
  if (request.mutationClass !== 'READ_ONLY') throw new Error('QA execution requires READ_ONLY repository mutation.');
  if (request.allocation.adapterId !== binding.adapterId || request.node.nodeId !== binding.nodeId || request.node.role !== binding.role || request.node.capabilityId !== binding.capabilityId || request.node.requiredCapability !== binding.requiredCapability) throw new Error('QA request does not match the exact fixed tuple.');
  if (request.outputSchemaId !== binding.outputSchemaId) throw new Error('QA request output schema does not match the fixed binding.');
  if (request.toolGrant.some((tool) => !binding.allowedDispatchTools.includes(tool))) throw new Error('QA request contains a tool outside the fixed dispatch ceiling.');
  if (request.toolGrant.includes('write')) throw new Error('QA source/configuration write access is denied.');
}

function untrusted(label: string, text: string): string { return `<UNTRUSTED-DATA label=${JSON.stringify(label)}>\n${text}\n</UNTRUSTED-DATA>`; }

export function executionPrompt(request: NodeExecutionRequest, authority: string, approvalId: string): string {
  return [
    '# QA execution identity',
    `nodeId: ${request.node.nodeId}`,
    `operatorSessionId: ${request.allocation.operatorSessionId}`,
    `qaEnvironmentApprovalId: ${approvalId}`,
    'repositoryMutationClass=READ_ONLY',
    `applicationDataAuthority=${authority}`,
    '# Request',
    untrusted('request', request.requestOrSummary),
    '# Acceptance criteria',
    request.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${untrusted(`criterion-${index + 1}`, criterion)}`).join('\n'),
    '# Dispatch restrictions',
    'Application-data writes must use the exact pre-dispatch/per-operation QA authorization seam and must be ledgered. No source, configuration, infrastructure, CI, or harness mutation is permitted.',
  ].join('\n\n');
}

export function reviewPrompt(request: NodeExecutionRequest, lunaProviderSessionId: string, authority: string): string {
  const artifacts = request.consumedArtifacts.map((artifact) => `${artifact.artifactId} (${artifact.artifactType}) at ${artifact.location}`).join('\n');
  return [
    '# Terra independent review identity',
    `nodeId: ${request.node.nodeId}`,
    `operatorSessionId: ${request.allocation.operatorSessionId}`,
    `lunaProviderSessionId: ${lunaProviderSessionId}`,
    'reviewProvider: kiro/gpt-5.6-terra',
    'repositoryMutationClass=READ_ONLY',
    `applicationDataAuthority=${authority}`,
    '# Read-only inputs',
    untrusted('artifact-references', artifacts),
    'Review only the supplied files and immutable artifact references. Do not use browser, API, database, debug, test rerun, or report-editing tools. Emit REVIEW_COMPLETE_HUMAN_PENDING when the independent review is complete.',
  ].join('\n\n');
}

export function inputForRunner(request: NodeExecutionRequest, binding: QaNativeBinding, systemPrompt: string, outputSchema: Readonly<Record<string, unknown>>, prompt: string, signal: AbortSignal): QaSessionRunInput {
  return { request, binding, systemPrompt, outputSchema, toolNames: [...request.toolGrant], prompt, signal };
}

export function normalizeAdapterResult(run: QaSessionRunResult, pendingReview: boolean): QaSessionRunResult {
  if (!pendingReview || run.result.status !== 'SUCCEEDED') return run;
  const summary = run.result.summary.includes('REVIEW_COMPLETE_HUMAN_PENDING') ? run.result.summary : `REVIEW_COMPLETE_HUMAN_PENDING: ${run.result.summary}`;
  return { ...run, result: { ...run.result, summary } };
}

export class QaAdapterBatch implements ActiveExecutionBatch {
  readonly attempts: readonly NodeExecutionAttempt[];
  #cancelled = false;
  constructor(readonly batchId: string, attempts: readonly NodeExecutionAttempt[], readonly completion: Promise<readonly NodeExecutionOutcome[]>, private readonly controller: AbortController) { this.attempts = attempts; }
  async cancel(reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN'): Promise<void> {
    if (!this.#cancelled) { this.#cancelled = true; this.controller.abort(reason); }
    await this.completion.catch(() => undefined);
  }
}

export function createQaBatch(request: ExecutionBatchRequest, binding: QaNativeBinding, run: (node: NodeExecutionRequest, signal: AbortSignal) => Promise<NodeExecutionOutcome>): QaAdapterBatch {
  const controller = new AbortController();
  const attempts = request.nodes.map((node) => ({ ...node.allocation, modelProvider: binding.provider, modelId: binding.modelId }));
  const completion = Promise.allSettled(request.nodes.map((node) => run(node, controller.signal))).then((settled) => settled.map((entry, index) => {
    const attempt = attempts[index];
    if (attempt === undefined) throw new Error('QA batch attempt allocation is unavailable.');
    return entry.status === 'fulfilled' ? entry.value : { attempt, result: safeQaFailure(attempt, 'BLOCKED', 'QA_ADAPTER_FAILURE') };
  }));
  return new QaAdapterBatch(request.batchId, attempts, completion, controller);
}

export function createRunner(sessionFactory: import('../../adapters/omp-task.js').OmpSessionFactory, roleRoot: string): NativeQaSessionRunner { return new NativeQaSessionRunner({ sessionFactory, roleRoot }); }

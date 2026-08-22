import type { AgentResult } from '../../contracts.js';
import type { ExecutionBatchRequest, NodeExecutionAdapter, NodeExecutionRequest } from '../../runtime-types.js';
import type { Stage7ArtifactEnvelope } from '../types.js';
import { assertDesignReviewPayload, createUiArtifact, verifySameCandidateHash } from './artifacts.js';
import { SOL_NODE, SOL_ASSURANCE_ROLE, SOL_RUNTIME_IMPLEMENTATION, type DesignReviewPayload, type SolProcessSupervisor, type SolReviewInput, type UiSolAssurancePort } from './contracts.js';
import { adapterFailure, abortReason, requireNode, requireSignal, uiBatch } from './runtime.js';

export class KiroSolAssurancePort implements UiSolAssurancePort {
  readonly assuranceRole = SOL_ASSURANCE_ROLE;
  readonly runtimeImplementation = SOL_RUNTIME_IMPLEMENTATION;
  constructor(private readonly supervisor: SolProcessSupervisor) {
    if (supervisor.runtimeImplementation !== SOL_RUNTIME_IMPLEMENTATION) throw new Error('Sol supervisor runtime is not the fixed Kiro implementation.');
  }
  available(): boolean { return this.supervisor.runtimeImplementation === SOL_RUNTIME_IMPLEMENTATION && this.supervisor.available(); }
  async review(input: SolReviewInput): Promise<DesignReviewPayload> {
    if (!this.available()) throw new Error('Kiro Sol assurance is unavailable.');
    verifySameCandidateHash(input.candidateBundle, input.candidateBundleHash);
    const onAbort = (): void => { void this.supervisor.terminate(abortReason(input.signal)).catch(() => undefined); };
    input.signal.addEventListener('abort', onAbort, { once: true });
    let review: DesignReviewPayload;
    try {
      review = await this.supervisor.reviewReadOnly(input, input.signal);
    } finally {
      input.signal.removeEventListener('abort', onAbort);
    }
    assertDesignReviewPayload(review, input.candidateBundleHash);
    return review;
  }
}

export interface UiSolAssuranceAdapterOptions {
  readonly port: UiSolAssurancePort;
  readonly resolveInput: (request: NodeExecutionRequest, signal: AbortSignal) => SolReviewInput;
  readonly clock?: () => string;
}

export class UiSolAssuranceAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'stage7-sol-assurance' as const;
  private readonly clock: () => string;
  constructor(private readonly options: UiSolAssuranceAdapterOptions) { this.clock = options.clock ?? (() => new Date().toISOString()); }
  launchBatch(request: ExecutionBatchRequest) {
    return uiBatch(request, this.adapterId, async (node, signal) => {
      try {
        const review = await this.assure(node, signal);
        const status = review.result.status === 'BLOCKED' ? 'BLOCKED' : 'SUCCEEDED';
        return { attempt: { ...node.allocation, modelProvider: 'kiro', modelId: 'gpt-5.6-sol' }, result: { ...review.result, status } };
      } catch (error) {
        return adapterFailure(node, this.adapterId, signal.aborted ? 'UNKNOWN' : 'BLOCKED', error instanceof Error ? error.message : String(error));
      }
    });
  }
  async assure(request: NodeExecutionRequest, signal: AbortSignal): Promise<{ readonly review: Stage7ArtifactEnvelope; readonly result: AgentResult }> {
    requireSignal(signal);
    requireNode(request, SOL_NODE, 'ui-v2-sol-assurance');
    if (request.node.role !== 'ui-v2-sol-reviewer' || request.node.capabilityId !== 'stage7-sol-assurance' || request.node.requiredCapability !== 'ui-v2-sol-assurance') throw new Error('Sol assurance tuple is not exact.');
    if (this.options.port.assuranceRole !== SOL_ASSURANCE_ROLE || this.options.port.runtimeImplementation !== SOL_RUNTIME_IMPLEMENTATION || !this.options.port.available()) throw new Error('Fixed Kiro Sol assurance is unavailable.');
    const input = this.options.resolveInput(request, signal);
    verifySameCandidateHash(input.candidateBundle, input.candidateBundleHash);
    const payload = await this.options.port.review(input);
    const createdAt = this.clock();
    const artifactPayload: Readonly<Record<string, unknown>> = {
      assuranceRole: payload.assuranceRole,
      candidateBundleHash: payload.candidateBundleHash,
      outcome: payload.outcome,
      findings: payload.findings,
    };
    const review = createUiArtifact('design-review.v1', artifactPayload, { artifactId: `review-${request.allocation.attemptId}`, nodeId: request.node.nodeId, sessionId: request.allocation.operatorSessionId, producer: this.adapterId, location: `/artifacts/review-${request.allocation.attemptId}`, createdAt });
    const blocked = payload.outcome === 'BLOCK';
    return { review, result: { resultId: request.allocation.attemptId, operatorSessionId: request.allocation.operatorSessionId, nodeId: request.node.nodeId, capabilityId: request.node.capabilityId, status: blocked ? 'BLOCKED' : 'SUCCEEDED', summary: blocked ? 'Kiro Sol blocked the candidate; visual verification is not permitted.' : 'Kiro Sol approved the exact candidate hash for visual verification.', producedArtifactRefs: [review.artifactId], consumedArtifactRefs: [input.designSpec.artifactId, input.implementationDiff.artifactId, input.candidateBundle.artifactId], findingIds: [], evidenceIds: [], startedAt: request.allocation.startedAt, completedAt: createdAt, policyRefs: [] } };
  }
}

import * as path from 'node:path';
import type { NodeExecutionAdapter, NodeExecutionRequest } from '../../runtime-types.js';
import type { Stage7ArtifactEnvelope } from '../types.js';
import { assertDesignReviewPayload, assertRenderEvidence, createUiArtifact, renderPayload, verifySameCandidateHash } from './artifacts.js';
import { VISUAL_NODE, FROZEN_RENDER_RECIPE_ID, type RenderEvidence, type RenderPolicy, type RenderSandbox, type RenderSandboxPort, type VisualVerificationInput } from './contracts.js';
import { adapterFailure, requireNode, requireSignal, uiBatch } from './runtime.js';

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function validatePolicy(policy: RenderPolicy): void {
  if (policy.recipeId !== FROZEN_RENDER_RECIPE_ID || policy.network !== 'DENY' || policy.inheritedCredentials !== 'NONE' || policy.hostWrites !== 'DENY' || policy.scripts !== 'DISABLED' || policy.dependencyInputsPinned !== true) throw new Error('Render policy is not the frozen contained policy.');
  if (policy.recipeId.length === 0 || policy.cpuTimeMs <= 0 || policy.memoryBytes <= 0 || policy.processLimit <= 0) throw new Error('Render policy must pin a recipe and positive resource limits.');
}

export interface UiVisualVerificationAdapterOptions {
  readonly sandbox: RenderSandboxPort;
  readonly resolveInput: (request: NodeExecutionRequest, signal: AbortSignal) => VisualVerificationInput;
  readonly clock?: () => string;
}

export class UiVisualVerificationAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'stage7-visual' as const;
  private readonly clock: () => string;
  constructor(private readonly options: UiVisualVerificationAdapterOptions) { this.clock = options.clock ?? (() => new Date().toISOString()); }
  launchBatch(request: Parameters<NodeExecutionAdapter['launchBatch']>[0]) {
    return uiBatch(request, this.adapterId, async (node, signal) => {
      try {
        const verification = await this.verify(node, signal);
        return { attempt: { ...node.allocation, modelProvider: 'stage7-fixed', modelId: this.adapterId }, result: verification.result };
      } catch (error) {
        return adapterFailure(node, this.adapterId, signal.aborted ? 'UNKNOWN' : 'BLOCKED', error instanceof Error ? error.message : String(error));
      }
    });
  }
  async verify(request: NodeExecutionRequest, signal: AbortSignal): Promise<{ readonly visual: Stage7ArtifactEnvelope; readonly result: import('../../contracts.js').AgentResult }> {
    requireSignal(signal);
    requireNode(request, VISUAL_NODE, 'ui-v2-visual-verification');
    if (request.node.role !== 'ui-v2-visual-verifier' || request.node.capabilityId !== 'stage7-visual') throw new Error('Visual verification tuple is not exact.');
    const input = this.options.resolveInput(request, signal);
    validatePolicy(input.policy);
    verifySameCandidateHash(input.candidateBundle, input.candidateBundle.hash);
    if (input.designReview.artifactType !== 'design-review.v1' || typeof input.designReview.payload.candidateBundleHash !== 'string') throw new Error('Visual verification requires a strict Sol design review.');
    const reviewPayload = input.designReview.payload;
    assertDesignReviewPayload(reviewPayload, input.candidateBundle.hash);
    if (reviewPayload.outcome !== 'APPROVE') throw new Error('Sol BLOCK stops visual verification.');
    const parent = await this.options.sandbox.canonicalize(input.policy.approvedParent);
    let sandbox: RenderSandbox | undefined;
    try {
      sandbox = await this.options.sandbox.create(input.policy, signal);
      const canonicalSandbox = await this.options.sandbox.canonicalize(sandbox.realpath);
      if (!contained(parent, canonicalSandbox)) throw new Error('Render sandbox escaped the approved parent.');
      await this.options.sandbox.materialize(sandbox, input.candidateBundle, input.policy, signal);
      const evidence: RenderEvidence = await this.options.sandbox.render(sandbox, input.policy.recipeId, input.policy, signal);
      assertRenderEvidence(evidence, input.candidateBundle.hash);
      const createdAt = this.clock();
      const visual = createUiArtifact('ui-visual-verification.v1', renderPayload(evidence, input.candidateBundle.hash), { artifactId: `visual-${request.allocation.attemptId}`, nodeId: request.node.nodeId, sessionId: request.allocation.operatorSessionId, producer: this.adapterId, location: `/artifacts/visual-${request.allocation.attemptId}`, createdAt });
      return { visual, result: { resultId: request.allocation.attemptId, operatorSessionId: request.allocation.operatorSessionId, nodeId: request.node.nodeId, capabilityId: request.node.capabilityId, status: 'SUCCEEDED', summary: 'Contained visual verification captured screenshot evidence for the Sol-reviewed candidate.', producedArtifactRefs: [visual.artifactId], consumedArtifactRefs: [input.candidateBundle.artifactId, input.designReview.artifactId], findingIds: [], evidenceIds: [], startedAt: request.allocation.startedAt, completedAt: createdAt, policyRefs: [] } };
    } finally {
      if (sandbox !== undefined) await sandbox.cleanup();
    }
  }
}

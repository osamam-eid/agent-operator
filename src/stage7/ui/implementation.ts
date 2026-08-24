import type { NodeExecutionAdapter, NodeExecutionRequest } from '../../runtime-types.js';
import type { MutationGate, VerificationPorts, WorktreePort, GovernedMutationRequest } from '../../mutation/worktree.js';
import type { MutationClock } from '../../mutation/governed.js';
import { GovernedMutationExecutor } from '../../mutation/governed.js';
import { CapturingWorktreePort, GovernedUiImplementationAdapter as FrozenGovernedUiImplementationAdapter } from '../ui-capture.js';
import type { GovernedUiImplementationPort, ProvisionalCandidateStore, Stage7ArtifactEnvelope, UiExecutionGrant } from '../types.js';
import { validateUiExecutionGrant } from '../grants.js';
import { assertCandidateArtifact, createUiArtifact } from './artifacts.js';
import { IMPLEMENTATION_NODE, type UiImplementationDependencies, type UiImplementationRequest, type UiImplementationResult } from './contracts.js';
import { adapterFailure, requireNode, requireSignal, uiBatch } from './runtime.js';

export interface GovernedUiImplementationAdapterOptions {
  readonly port: GovernedUiImplementationPort;
  readonly registry: { register: (artifact: Stage7ArtifactEnvelope) => void };
  readonly provisional: ProvisionalCandidateStore;
  readonly resolveGrant: (request: NodeExecutionRequest) => UiExecutionGrant;
  readonly resolveGate: (request: NodeExecutionRequest) => MutationGate;
  readonly clock?: () => string;
}

export function createGovernedUiImplementationPort(dependencies: UiImplementationDependencies): GovernedUiImplementationPort {
  const capturingWorktrees = new CapturingWorktreePort(dependencies.worktrees, dependencies.capture, dependencies.provisional, dependencies.captureContext);
  const executor = new GovernedMutationExecutor(
    capturingWorktrees,
    dependencies.verification,
    dependencies.clock,
    dependencies.recovery,
  );
  const bufferedPromotions = new Map<string, Stage7ArtifactEnvelope>();
  return new FrozenGovernedUiImplementationAdapter(executor, dependencies.provisional, () => capturingWorktrees.lastCandidateId, { register: (artifact) => { assertCandidateArtifact(artifact); bufferedPromotions.set(artifact.artifactId, structuredClone(artifact)); } });
}

export class GovernedUiImplementationAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'stage7-ui-implementation' as const;
  private readonly clock: () => string;
  constructor(private readonly options: GovernedUiImplementationAdapterOptions) { this.clock = options.clock ?? (() => new Date().toISOString()); }
  launchBatch(request: Parameters<NodeExecutionAdapter['launchBatch']>[0]) {
    return uiBatch(request, this.adapterId, async (node, signal) => {
      try {
        const outcome = await this.implement({ request: node, grant: this.options.resolveGrant(node), operation: node.requestOrSummary, signal });
        return { attempt: { ...node.allocation, modelProvider: 'stage7-fixed', modelId: this.adapterId }, result: outcome.mutation.worktreeRemoved ? {
          resultId: node.allocation.attemptId, operatorSessionId: node.allocation.operatorSessionId, nodeId: node.node.nodeId, capabilityId: node.node.capabilityId, status: 'SUCCEEDED', summary: 'Governed UI mutation passed frozen verification and promoted a candidate.', producedArtifactRefs: [outcome.candidate.artifactId, outcome.diff.artifactId], consumedArtifactRefs: node.consumedArtifacts.map((artifact) => artifact.artifactId), findingIds: [], evidenceIds: [], startedAt: node.allocation.startedAt, completedAt: outcome.mutation.completedAt, policyRefs: [],
        } : { resultId: node.allocation.attemptId, operatorSessionId: node.allocation.operatorSessionId, nodeId: node.node.nodeId, capabilityId: node.node.capabilityId, status: 'UNKNOWN', summary: 'Governed UI mutation did not prove cleanup.', producedArtifactRefs: [], consumedArtifactRefs: [], findingIds: [], evidenceIds: [], startedAt: node.allocation.startedAt, completedAt: this.clock(), policyRefs: [] } };
      } catch (error) {
        return adapterFailure(node, this.adapterId, signal.aborted ? 'UNKNOWN' : 'BLOCKED', error instanceof Error ? error.message : String(error));
      }
    });
  }
  async implement(input: UiImplementationRequest): Promise<UiImplementationResult> {
    requireSignal(input.signal);
    const request = input.request;
    requireNode(request, IMPLEMENTATION_NODE, 'ui-v2-implementation');
    if (request.node.role !== 'ui-v2-implementer' || request.node.capabilityId !== 'stage7-ui-implementation' || !request.consumedArtifacts.some((artifact) => artifact.artifactType === 'ui-design-spec.v1')) throw new Error('Governed UI mutation requires the exact Impeccable design artifact.');
    const grantValidation = validateUiExecutionGrant(input.grant);
    if (!grantValidation.ok) throw new Error(`Invalid UiExecutionGrant: ${grantValidation.errors.map((entry) => `${entry.path}: ${entry.message}`).join('; ')}`);
    const grant = grantValidation.value;
    const mutation: GovernedMutationRequest & { readonly grant: UiExecutionGrant } = {
      projectRoot: grant.projectRoot,
      approvedWorktreeParent: grant.approvedWorktreeParent,
      worktreeId: grant.worktreeId,
      scope: { scopeHash: grant.scopeHash, contractHash: grant.contractHash, allowedPaths: grant.allowedPaths, baselineIdentity: grant.baselineIdentity, mutationClass: grant.mutationClass },
      gate: this.options.resolveGate(request),
      operation: input.operation,
      grant,
    };
    const mutationResult = await this.options.port.execute(mutation);
    if (input.signal.aborted) {
      this.options.provisional.invalidate(mutationResult.candidate.artifactId, 'UI mutation cancellation after frozen execution; candidate remains non-durable.');
      throw new Error('Governed UI mutation became UNKNOWN after cancellation; no candidate was published.');
    }
    if (!mutationResult.worktreeRemoved) throw new Error('Governed UI mutation did not prove worktree removal.');
    const candidate = mutationResult.candidate;
    assertCandidateArtifact(candidate);
    if (candidate.payload.baselineIdentity !== mutationResult.baseline.identity || JSON.stringify(candidate.payload.changedPaths) !== JSON.stringify(mutationResult.changedPaths)) throw new Error('Candidate evidence does not match frozen mutation evidence.');
    const createdAt = this.clock();
    const diff = createUiArtifact('ui-implementation-diff.v1', { baselineIdentity: mutationResult.baseline.identity, changedPaths: [...mutationResult.changedPaths], verificationEvidenceRefs: [...mutationResult.behavioral.evidence, ...mutationResult.conformance.evidence], candidateBundleId: candidate.artifactId }, { artifactId: `diff-${request.allocation.attemptId}`, nodeId: request.node.nodeId, sessionId: request.allocation.operatorSessionId, producer: this.adapterId, location: `/artifacts/diff-${request.allocation.attemptId}`, createdAt });
    this.options.registry.register(candidate);
    this.options.registry.register(diff);
    return { mutation: mutationResult, candidate, diff };
  }
}

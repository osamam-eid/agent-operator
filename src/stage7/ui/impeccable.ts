import type { NodeExecutionAdapter, NodeExecutionRequest } from '../../runtime-types.js';
import type { Stage7ArtifactEnvelope } from '../types.js';
import { assertDesignSpecPayload, createUiArtifact } from './artifacts.js';
import { IMPECCABLE_NODE, IMPECCABLE_SKILL_URI, type DesignSpecPayload, type ImpeccableDesignPort } from './contracts.js';
import { adapterFailure, abortReason, requireNode, requireSignal, uiBatch } from './runtime.js';
import type { AgentResult } from '../../contracts.js';

export interface ImpeccableDesignAdapterOptions {
  readonly port: ImpeccableDesignPort;
  readonly mode: 'Persuade' | 'Operate' | 'Read' | 'Experience';
  readonly surface: string;
  readonly projectRoot: string;
  readonly allowedPaths: readonly string[];
  readonly incumbentTruth: string;
  readonly clock?: () => string;
}

export interface ImpeccableDesignResult {
  readonly spec: Stage7ArtifactEnvelope;
  readonly result: AgentResult;
}

export class ImpeccableDesignAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'stage7-impeccable' as const;
  private readonly clock: () => string;
  constructor(private readonly options: ImpeccableDesignAdapterOptions) { this.clock = options.clock ?? (() => new Date().toISOString()); }
  launchBatch(request: Parameters<NodeExecutionAdapter['launchBatch']>[0]) {
    return uiBatch(request, this.adapterId, async (node, signal) => {
      try {
        const outcome = await this.design(node, signal);
        return { attempt: { ...node.allocation, modelProvider: 'stage7-fixed', modelId: this.adapterId }, result: outcome.result };
      } catch (error) {
        return adapterFailure(node, this.adapterId, signal.aborted ? 'UNKNOWN' : 'BLOCKED', error instanceof Error ? error.message : String(error));
      }
    });
  }
  async design(request: NodeExecutionRequest, signal: AbortSignal): Promise<ImpeccableDesignResult> {
    requireSignal(signal);
    requireNode(request, IMPECCABLE_NODE, 'ui-v2-design');
    if (request.node.role !== 'ui-v2-impeccable-designer' || request.node.capabilityId !== 'stage7-impeccable') throw new Error('UI design tuple is not exact.');
    if (this.options.port.skillUri !== IMPECCABLE_SKILL_URI || !this.options.port.available()) throw new Error('Canonical Impeccable skill is unavailable.');
    const onAbort = (): void => { void this.options.port.terminate(abortReason(signal)).catch(() => undefined); };
    signal.addEventListener('abort', onAbort, { once: true });
    let payload: DesignSpecPayload;
    try {
      payload = await this.options.port.execute({ skillUri: IMPECCABLE_SKILL_URI, mode: this.options.mode, target: this.options.surface, projectRoot: this.options.projectRoot, allowedPaths: [...this.options.allowedPaths], incumbentTruth: this.options.incumbentTruth, craftFloorLoaded: true, signal });
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    assertDesignSpecPayload(payload);
    const createdAt = this.clock();
    const artifactPayload: Readonly<Record<string, unknown>> = {
      surface: payload.surface,
      incumbentTruth: payload.incumbentTruth,
      layout: payload.layout,
      typography: payload.typography,
      color: payload.color,
      spacing: payload.spacing,
      responsiveStates: payload.responsiveStates,
      accessibility: payload.accessibility,
      nonGoals: payload.nonGoals,
    };
    const spec = createUiArtifact('ui-design-spec.v1', artifactPayload, { artifactId: `design-${request.allocation.attemptId}`, nodeId: request.node.nodeId, sessionId: request.allocation.operatorSessionId, producer: this.adapterId, location: `/artifacts/design-${request.allocation.attemptId}`, createdAt });
    return { spec, result: { resultId: request.allocation.attemptId, operatorSessionId: request.allocation.operatorSessionId, nodeId: request.node.nodeId, capabilityId: request.node.capabilityId, status: 'SUCCEEDED', summary: 'Canonical Impeccable produced a craft-floor UI design specification.', producedArtifactRefs: [spec.artifactId], consumedArtifactRefs: [], findingIds: [], evidenceIds: [], startedAt: request.allocation.startedAt, completedAt: createdAt, policyRefs: [] } };
  }
}

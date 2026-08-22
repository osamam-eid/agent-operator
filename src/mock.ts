/**
 * Agent Operator — deterministic mock node-execution adapter (tests only).
 *
 * `DeterministicMockAdapter` is the only shipped `NodeExecutionAdapter` with
 * `adapterId: 'mock'`. No network, no credentials, no real provider or
 * child session: every `AgentResult` is derived purely from the
 * `NodeExecutionRequest`s passed to `launchBatch`, plus the injected
 * clock/id factory, so repeated runs against the same inputs and the same
 * clock/ids produce byte-identical results. Production wiring must never
 * select this adapter (`registry.ts` is responsible for that refusal); this
 * module exists solely so `controller.ts`/`state.ts` can be exercised
 * end-to-end without any OMP SDK dependency.
 *
 * `completion` resolution is caller-driven per attempt via `resolveNode`/
 * `rejectNode`, so a test can exercise immediate completion (resolve before
 * ever awaiting `completion`), deferred completion (resolve later, after
 * the test has already observed the `RUNNING`/`EXECUTING` state), and
 * cancellation (`cancel()` settles every still-unresolved attempt with a
 * `CANCELLED` `AgentResult` and never lets the batch hang).
 */

import type { AgentResult, AgentResultStatus } from './contracts.js';
import type {
  ActiveExecutionBatch,
  ExecutionBatchRequest,
  NodeContextProjection,
  NodeContextProjector,
  NodeExecutionAdapter,
  NodeExecutionAttempt,
  NodeExecutionOutcome,
  NodeExecutionRequest,
  OperatorClock,
  OperatorIdFactory,
} from './runtime-types.js';

function deterministicSummary(node: NodeExecutionRequest['node'], status: AgentResultStatus): string {
  return `Deterministic mock execution of node "${node.nodeId}" (role "${node.role}") returned ${status}.`;
}

class MockActiveExecutionBatch implements ActiveExecutionBatch {
  readonly batchId: string;
  readonly attempts: readonly NodeExecutionAttempt[];
  readonly completion: Promise<readonly NodeExecutionOutcome[]>;
  readonly #pending = new Map<string, { readonly attempt: NodeExecutionAttempt; readonly node: NodeExecutionRequest['node']; resolve: (result: AgentResult) => void }>();
  readonly #settled = new Map<string, NodeExecutionOutcome>();
  #cancelled = false;
  readonly #ids: OperatorIdFactory;
  readonly #clock: OperatorClock;
  #settleAll: (() => void) | undefined;

  constructor(request: ExecutionBatchRequest, attempts: readonly NodeExecutionAttempt[], ids: OperatorIdFactory, clock: OperatorClock) {
    this.batchId = request.batchId;
    this.attempts = attempts;
    this.#ids = ids;
    this.#clock = clock;

    const nodeByAttemptId = new Map(request.nodes.map((n) => [n.allocation.attemptId, n.node] as const));
    const { promise: completion, resolve: resolveCompletion } = Promise.withResolvers<readonly NodeExecutionOutcome[]>();
    this.completion = completion;

    const total = attempts.length;
    const checkDone = (): void => {
      if (this.#settled.size < total) return;
      resolveCompletion(attempts.map((attempt) => this.#settled.get(attempt.attemptId) as NodeExecutionOutcome));
    };
    this.#settleAll = checkDone;

    for (const attempt of attempts) {
      const node = nodeByAttemptId.get(attempt.attemptId);
      if (node === undefined) continue;
      this.#pending.set(attempt.attemptId, {
        attempt,
        node,
        resolve: (result) => {
          if (this.#settled.has(attempt.attemptId)) return;
          this.#settled.set(attempt.attemptId, { attempt, result });
          this.#pending.delete(attempt.attemptId);
          checkDone();
        },
      });
    }
    if (total === 0) resolveCompletion([]);
  }

  /** Test hook: settle one pending attempt with `status` (default
   * `SUCCEEDED`), or leave `status` unset for the default success path. */
  resolveNode(nodeId: string, overrides: Partial<Pick<AgentResult, 'status' | 'summary' | 'findingIds' | 'recommendedDisposition'>> = {}): void {
    const entry = Array.from(this.#pending.values()).find((p) => p.attempt.nodeId === nodeId);
    if (entry === undefined) return;
    const status = overrides.status ?? 'SUCCEEDED';
    const at = this.#clock.now();
    entry.resolve({
      resultId: this.#ids.next('result'),
      operatorSessionId: entry.attempt.operatorSessionId,
      nodeId: entry.attempt.nodeId,
      capabilityId: entry.attempt.capabilityId,
      status,
      summary: overrides.summary ?? deterministicSummary(entry.node, status),
      producedArtifactRefs: [],
      consumedArtifactRefs: [],
      findingIds: overrides.findingIds ?? [],
      evidenceIds: [],
      ...(overrides.recommendedDisposition !== undefined ? { recommendedDisposition: overrides.recommendedDisposition } : {}),
      providerSessionId: entry.attempt.providerSessionId,
      startedAt: at,
      completedAt: at,
      policyRefs: ['mock@1:node.deterministic'],
    });
  }

  async cancel(reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN'): Promise<void> {
    this.#cancelled = true;
    for (const entry of Array.from(this.#pending.values())) {
      const at = this.#clock.now();
      entry.resolve({
        resultId: this.#ids.next('result'),
        operatorSessionId: entry.attempt.operatorSessionId,
        nodeId: entry.attempt.nodeId,
        capabilityId: entry.attempt.capabilityId,
        status: 'CANCELLED',
        summary: `Mock node "${entry.attempt.nodeId}" cancelled (${reason}).`,
        producedArtifactRefs: [],
        consumedArtifactRefs: [],
        findingIds: [],
        evidenceIds: [],
        providerSessionId: entry.attempt.providerSessionId,
        startedAt: at,
        completedAt: at,
        policyRefs: ['mock@1:node.cancelled'],
      });
    }
    this.#settleAll?.();
  }

  get isCancelled(): boolean {
    return this.#cancelled;
  }
}

export class DeterministicMockAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'mock' as const;
  readonly #clock: OperatorClock;
  readonly #ids: OperatorIdFactory;
  readonly #autoResolve: boolean;
  readonly #batches = new Map<string, MockActiveExecutionBatch>();

  /** `autoResolve` (default `true`) settles every attempt with `SUCCEEDED`
   * synchronously inside `launchBatch`, matching Stage 1-3's observable
   * "one continue, one immediate result" behavior for simple tests. Pass
   * `false` to drive completion manually via `resolveBatch`/`getBatch` for
   * deferred-completion, cancellation, and race tests. */
  constructor(clock: OperatorClock, ids: OperatorIdFactory, options: { readonly autoResolve?: boolean } = {}) {
    this.#clock = clock;
    this.#ids = ids;
    this.#autoResolve = options.autoResolve ?? true;
  }

  launchBatch(request: ExecutionBatchRequest): ActiveExecutionBatch {
    const attempts: NodeExecutionAttempt[] = request.nodes.map((node) => ({
      ...node.allocation,
      modelProvider: 'mock',
      modelId: 'mock-v1',
    }));
    const batch = new MockActiveExecutionBatch(request, attempts, this.#ids, this.#clock);
    this.#batches.set(request.batchId, batch);
    if (this.#autoResolve) {
      for (const node of request.nodes) batch.resolveNode(node.node.nodeId);
    }
    return batch;
  }

  /** Test hook: resolve one specific node in an already-launched batch. */
  resolveNode(batchId: string, nodeId: string, overrides: Partial<Pick<AgentResult, 'status' | 'summary' | 'findingIds' | 'recommendedDisposition'>> = {}): void {
    this.#batches.get(batchId)?.resolveNode(nodeId, overrides);
  }

  getBatch(batchId: string): MockActiveExecutionBatch | undefined {
    return this.#batches.get(batchId);
  }
}

/** Trivial deterministic `NodeContextProjector` for tests: never touches
 * the filesystem, never depends on `context-projection.ts`. Real
 * production wiring (`extension/index.ts`) injects a projector backed by
 * `context-projection.ts`'s `materializeProjection` instead. */
export function createDeterministicContextProjector(): NodeContextProjector {
  return {
    project(params) {
      const projection: NodeContextProjection = {
        projectionRoot: `mock-projection://${params.allocation.attemptId}`,
        allowedPaths: [`mock-projection://${params.allocation.attemptId}`],
        manifestHash: '0'.repeat(64),
        sourceLabels: [],
      };
      const request: NodeExecutionRequest = {
        allocation: params.allocation,
        node: params.node,
        requestOrSummary: params.record.session.originalRequest,
        consumedArtifacts: [],
        consumedEvidence: [],
        dependencyResultSummaries: params.node.dependsOn.map((nodeId) => {
          const result = params.record.nodeResultRefs[nodeId];
          return result === undefined
            ? { nodeId, status: 'UNKNOWN' as AgentResultStatus, summary: `No terminal result is stored for dependency "${nodeId}".` }
            : { nodeId, status: result.status, summary: result.summary };
        }),

        projection,
        policyRefs: [],
        instructions: `Mock instructions for node "${params.node.nodeId}" (role "${params.node.role}").`,
        acceptanceCriteria: [],
        toolGrant: ['operator_read', 'operator_grep', 'operator_glob'],
        mutationClass: 'READ_ONLY',
        outputSchemaId: 'agent-result.v1',
      };
      return request;
    },
  };
}

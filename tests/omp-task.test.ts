import { describe, expect, test } from 'bun:test';
import type { ExecutionGraphNode } from '../src/contracts.js';
import type { ExecutionBatchRequest, NodeExecutionRequest } from '../src/runtime-types.js';
import { resolvePackageRoleName } from '../src/adapters/roles.js';
import {
  createOmpTaskAdapter,
  type OmpChildSession,
  type OmpChildSessionHandle,
  type OmpCreateChildSessionOptions,
  type OmpCustomToolDefinition,
  type OmpSessionFactory,
  type OmpTaskAdapterDeps,
  type OmpToolFactories,
} from '../src/adapters/omp-task.js';

const STARTED_AT = '2026-08-14T00:00:00.000Z';
const TIMEOUT_AT = '2026-08-14T00:10:00.000Z';
const MODEL = { provider: 'anthropic', id: 'claude-sonnet-5' };

function makeNode(overrides: Partial<ExecutionGraphNode> = {}): ExecutionGraphNode {
  return {
    nodeId: 'planner', capabilityId: 'cap-planner-1', role: 'planner', mandatory: true,
    dependsOn: [], contextPolicy: 'isolated', consumes: [], produces: ['plan-draft.v1'], ...overrides,
  };
}

function makeRequest(overrides: Partial<NodeExecutionRequest> = {}, nodeOverrides: Partial<ExecutionGraphNode> = {}): NodeExecutionRequest {
  const node = makeNode(nodeOverrides);
  return {
    allocation: { attemptId: 'attempt-1', batchId: 'batch-1', operatorSessionId: 'session-1', graphRevision: 1, nodeId: node.nodeId, capabilityId: node.capabilityId, adapterId: 'omp-task', providerSessionId: 'provider-session-1', startedAt: STARTED_AT, timeoutAt: TIMEOUT_AT },
    node, requestOrSummary: 'Plan a small read-only change.', consumedArtifacts: [], consumedEvidence: [], dependencyResultSummaries: [],
    projection: { projectionRoot: '/tmp/fake-projection-root', allowedPaths: ['src/foo.ts'], manifestHash: 'a'.repeat(64), sourceLabels: ['project-root'] },
    policyRefs: [], instructions: 'Draft a plan.', acceptanceCriteria: ['Plan covers the request.'], toolGrant: ['operator_read', 'operator_grep', 'operator_glob'], mutationClass: 'READ_ONLY', outputSchemaId: 'agent-result.v1', ...overrides,
  };
}

function makeBatch(nodes: readonly NodeExecutionRequest[]): ExecutionBatchRequest {
  return { batchId: 'batch-1', operatorSessionId: 'session-1', graphRevision: 1, executionShape: nodes.length > 1 ? 'PARALLEL' : 'SINGLE', nodes };
}

function resultJson(request: NodeExecutionRequest, identity: Partial<Record<'operatorSessionId' | 'nodeId' | 'capabilityId', string>> = {}): string {
  return JSON.stringify({ resultId: request.allocation.attemptId, operatorSessionId: identity.operatorSessionId ?? request.allocation.operatorSessionId, nodeId: identity.nodeId ?? request.allocation.nodeId, capabilityId: identity.capabilityId ?? request.allocation.capabilityId, status: 'SUCCEEDED', summary: 'Drafted a plan.', producedArtifactRefs: [], consumedArtifactRefs: [], findingIds: [], evidenceIds: [], startedAt: request.allocation.startedAt, completedAt: '2026-08-14T00:00:05.000Z', policyRefs: [] });
}

interface FakeCall { readonly options: OmpCreateChildSessionOptions; disposed: boolean; mcpClosed: boolean; aborted: boolean; promptCalled: boolean; }
interface FakeOptions { readonly text?: string; readonly fallback?: string; readonly failure?: { readonly stopReason: string; readonly errorMessage: string }; readonly defer?: boolean; readonly yieldPayload?: boolean; }

function fakeFactory(requests: readonly NodeExecutionRequest[], options: FakeOptions = {}): { readonly factory: OmpSessionFactory; readonly calls: FakeCall[]; readonly release: () => void; readonly waitForCreated: () => Promise<void> } {
  const calls: FakeCall[] = [];
  let releasePrompt: (() => void) | undefined;
  let resolveCreated: (() => void) | undefined;
  const allCreated = new Promise<void>((resolve) => {
    resolveCreated = resolve;
    if (requests.length === 0) resolve();
  });
  const promptReleased = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const factory: OmpSessionFactory = {
    async createSession(sessionOptions): Promise<OmpChildSessionHandle> {
      const request = requests.find((item) => item.projection.projectionRoot === sessionOptions.cwd) ?? requests[0];
      if (request === undefined) throw new Error('missing fake request');
      const call: FakeCall = { options: sessionOptions, disposed: false, mcpClosed: false, aborted: false, promptCalled: false };
      calls.push(call);
      if (calls.length >= requests.length) resolveCreated?.();
      let listener: ((event: { readonly type: string; readonly toolName?: string; readonly args?: unknown }) => void) | undefined;
      const session: OmpChildSession = {
        async prompt(): Promise<void> {
          call.promptCalled = true;
          if (options.defer) await promptReleased;
          if (options.yieldPayload && listener !== undefined) listener({ type: 'tool_execution_start', toolName: 'yield', args: { result: { data: JSON.parse(resultJson(request)) } } });
        },
        getLastAssistantText: () => options.text ?? resultJson(request),
        getLastAssistantMessage: () => options.failure,
        subscribe(next) { listener = next; return () => { if (listener === next) listener = undefined; }; },
        async abort() { call.aborted = true; if (releasePrompt !== undefined) releasePrompt(); },
        beginDispose() { call.disposed = true; },
        async dispose() { call.disposed = true; },
      };
      // Keep the listener observable to make the fake conform to the native seam.
      void listener;
      return { session, mcpManager: { async disconnectAll() { call.mcpClosed = true; } }, ...(options.fallback !== undefined ? { modelFallbackMessage: options.fallback } : {}) };
    },
  };
  return { factory, calls, release: () => { if (releasePrompt !== undefined) releasePrompt(); }, waitForCreated: () => allCreated };
}

const tools: OmpToolFactories = {
  createReadToolDefinition: () => ({ name: 'operator_read' }),
  createGrepToolDefinition: () => ({ name: 'operator_grep' }),
  createFindToolDefinition: () => ({ name: 'operator_glob' }),
  defineTool: (definition: Record<string, unknown>): OmpCustomToolDefinition => ({ name: typeof definition['name'] === 'string' ? definition['name'] : 'unknown' }),
};

function deps(factory: OmpSessionFactory, overrides: Partial<OmpTaskAdapterDeps> = {}): OmpTaskAdapterDeps {
  return { sessionFactory: factory, resolveModel: () => MODEL, toolFactories: tools, createSafeTools: () => [{ name: 'operator_read' }, { name: 'operator_grep' }, { name: 'operator_glob' }], safeToolNames: ['operator_read', 'operator_grep', 'operator_glob'], ...overrides };
}

describe('resolvePackageRoleName', () => {
  test('maps supported native roles and rejects mutating roles', () => {
    expect(resolvePackageRoleName('planner')).toBe('agent-operator-native-planner');
    expect(resolvePackageRoleName('independent-reviewer')).toBe('agent-operator-native-reviewer');
    expect(resolvePackageRoleName('operator-synthesis')).toBe('agent-operator-native-synthesis');
    expect(resolvePackageRoleName('implementer')).toBeUndefined();
  });
});

describe('OmpTaskAdapter native boundary', () => {
  test('binds attempt identity and disposes child resources', async () => {
    const request = makeRequest();
    const fake = fakeFactory([request]);
    const outcome = await createOmpTaskAdapter(deps(fake.factory)).launchBatch(makeBatch([request])).completion;
    expect(outcome[0]?.result.status).toBe('SUCCEEDED');
    expect(outcome[0]?.attempt.attemptId).toBe('attempt-1');
    expect(fake.calls[0]?.options.cwd).toBe(request.projection.projectionRoot);
    expect(fake.calls[0]?.options.toolNames.slice().sort()).toEqual(['operator_glob', 'operator_grep', 'operator_read']);
    expect(fake.calls[0]?.disposed).toBe(true);
    expect(fake.calls[0]?.mcpClosed).toBe(true);
  });

  test('blocks a reported model fallback before prompting', async () => {
    const request = makeRequest();
    const fake = fakeFactory([request], { fallback: 'fell back to another model' });
    const outcome = await createOmpTaskAdapter(deps(fake.factory)).launchBatch(makeBatch([request])).completion;
    expect(outcome[0]?.result.status).toBe('BLOCKED');
    expect(fake.calls[0]?.promptCalled).toBe(false);
    expect(fake.calls[0]?.disposed).toBe(true);
  });

  test('rejects prose and identity mismatches', async () => {
    const request = makeRequest();
    const prose = fakeFactory([request], { text: 'Here is a plan in prose.' });
    const proseOutcome = await createOmpTaskAdapter(deps(prose.factory)).launchBatch(makeBatch([request])).completion;
    expect(proseOutcome[0]?.result.status).toBe('FAILED');
    const wrong = fakeFactory([request], { text: resultJson(request, { operatorSessionId: 'other-session' }) });
    const wrongOutcome = await createOmpTaskAdapter(deps(wrong.factory)).launchBatch(makeBatch([request])).completion;
    expect(wrongOutcome[0]?.result.status).toBe('FAILED');
  });

  test('accepts an exact structured yield payload when assistant text is prose', async () => {
    const request = makeRequest();
    const fake = fakeFactory([request], { text: 'Assistant prose is not the structured result.', yieldPayload: true });
    const outcome = await createOmpTaskAdapter(deps(fake.factory)).launchBatch(makeBatch([request])).completion;
    expect(outcome[0]?.result.status).toBe('SUCCEEDED');
    expect(outcome[0]?.result.resultId).toBe('attempt-1');
  });

  test('maps provider terminal errors to blocked without exposing provider detail', async () => {
    const request = makeRequest();
    const fake = fakeFactory([request], { failure: { stopReason: 'error', errorMessage: 'usage limit reached' }, text: '' });
    const outcome = await createOmpTaskAdapter(deps(fake.factory)).launchBatch(makeBatch([request])).completion;
    expect(outcome[0]?.result.status).toBe('BLOCKED');
    expect(outcome[0]?.result.summary).toContain('BLOCKED_PROVIDER_UNAVAILABLE');
    expect(outcome[0]?.result.summary).not.toContain('usage limit reached');
  });

  test('blocks unsupported roles and mutation classes without creating sessions', async () => {
    const unsupported = makeRequest({}, { role: 'implementer', nodeId: 'implementer' });
    const fake = fakeFactory([unsupported]);
    const result = await createOmpTaskAdapter(deps(fake.factory)).launchBatch(makeBatch([unsupported])).completion;
    expect(result[0]?.result.status).toBe('BLOCKED');
    expect(fake.calls).toHaveLength(0);
    const mutating = makeRequest({ mutationClass: 'LOCAL' });
    const mutationFake = fakeFactory([mutating]);
    const mutationResult = await createOmpTaskAdapter(deps(mutationFake.factory)).launchBatch(makeBatch([mutating])).completion;
    expect(mutationResult[0]?.result.status).toBe('BLOCKED');
    expect(mutationFake.calls).toHaveLength(0);
  });

  test('runs independent nodes in one parallel batch and supports cancellation', async () => {
    const a = makeRequest({ projection: { projectionRoot: '/tmp/a', allowedPaths: [], manifestHash: 'a'.repeat(64), sourceLabels: [] }, allocation: { ...makeRequest().allocation, attemptId: 'a', nodeId: 'a', capabilityId: 'a' } }, { nodeId: 'a', capabilityId: 'a' });
    const b = makeRequest({ projection: { projectionRoot: '/tmp/b', allowedPaths: [], manifestHash: 'b'.repeat(64), sourceLabels: [] }, allocation: { ...makeRequest().allocation, attemptId: 'b', nodeId: 'b', capabilityId: 'b' } }, { nodeId: 'b', capabilityId: 'b' });
    const fake = fakeFactory([a, b], { defer: true });
    const batch = createOmpTaskAdapter(deps(fake.factory)).launchBatch(makeBatch([a, b]));
    await fake.waitForCreated();
    expect(fake.calls).toHaveLength(2);
    fake.release();
    const results = await batch.completion;
    expect(results).toHaveLength(2);
    const cancelFake = fakeFactory([a], { defer: true });
    const cancelled = createOmpTaskAdapter(deps(cancelFake.factory)).launchBatch(makeBatch([a]));
    await cancelled.cancel('USER');
    const cancelledResults = await cancelled.completion;
    expect(cancelledResults[0]?.result.status).toBe('CANCELLED');
  });
});

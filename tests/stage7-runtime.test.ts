import { describe, expect, test } from 'bun:test';

import { createOperatorRuntime } from '../src/controller.js';
import { createDeterministicContextProjector, DeterministicMockAdapter } from '../src/mock.js';
import { MemoryOperatorSessionStore } from '../src/store.js';
import type { AgentResult } from '../src/contracts.js';
import type { CompilationResult, OperatorWorkflowCompiler } from '../src/stage3-types.js';
import { createFrozenNodeExecutionAdapterResolver, createStage7FeatureSet, serializeNodeExecutionTuple, Stage7RouteResolutionError } from '../src/stage7/index.js';
import type { NodeExecutionAdapterResolver, NodeExecutionTuple, Stage7AdapterId, Stage7FeatureSet } from '../src/stage7/types.js';
import type { ActiveExecutionBatch, ExecutionBatchRequest, NodeExecutionAdapter, NodeExecutionAttempt, NodeExecutionOutcome, OperatorSessionStore } from '../src/runtime-types.js';
import { FakeCompiler, FixedClock, makeCompiledWorkflow, SequentialIds } from './helpers/runtime-fixtures.js';

class Stage7ParallelCompiler implements OperatorWorkflowCompiler {
  async compile(_request: string, context: Parameters<OperatorWorkflowCompiler['compile']>[1]): Promise<CompilationResult> {
    return {
      ok: true,
      compiled: makeCompiledWorkflow(context, {
        templateId: 'qa.v2',
        nodes: [
          { nodeId: 'qa-a', role: 'mock-reader', mandatory: true, dependsOn: [], groupId: 'qa-parallel', synthesisOwner: true },
          { nodeId: 'qa-b', role: 'mock-reader', mandatory: true, dependsOn: [], groupId: 'qa-parallel' },
        ],
        requiredGates: ['EXECUTION_APPROVAL'],
        executionShape: 'PARALLEL',
        maxConcurrency: 2,
      }),
    };
  }
}

class FakeStage7Adapter implements NodeExecutionAdapter {
  readonly launches: ExecutionBatchRequest[] = [];
  constructor(readonly adapterId: Stage7AdapterId) {}

  launchBatch(request: ExecutionBatchRequest): ActiveExecutionBatch {
    this.launches.push(request);
    const attempts: readonly NodeExecutionAttempt[] = request.nodes.map((node) => ({ ...node.allocation, modelProvider: 'fake-stage7', modelId: this.adapterId }));
    return { batchId: request.batchId, attempts, completion: Promise.resolve([]), cancel: async () => {} };
  }
}

class ExactTupleResolver implements NodeExecutionAdapterResolver {
  constructor(private readonly routes: ReadonlyMap<string, NodeExecutionAdapter>) {}

  resolve(tuple: NodeExecutionTuple): NodeExecutionAdapter {
    const adapter = this.routes.get(serializeNodeExecutionTuple(tuple));
    if (adapter === undefined) throw new Stage7RouteResolutionError('STAGE7_ROUTE_MISMATCH', tuple, `No test route for ${tuple.nodeId}.`);
    return adapter;
  }
}

function stage7Runtime(store: OperatorSessionStore, featureSet: Stage7FeatureSet, resolver: NodeExecutionAdapterResolver, compiler: OperatorWorkflowCompiler = new Stage7ParallelCompiler()) {
  return createOperatorRuntime({
    store,
    clock: new FixedClock(),
    ids: new SequentialIds(),
    nodeExecutionAdapterResolver: resolver,
    stage7FeatureSet: featureSet,
    contextProjector: createDeterministicContextProjector(),
    nodeTimeoutMs: () => 60_000,
    compiler,
    projectRoot: '/dev/null',
  });
}

function success(attempt: NodeExecutionAttempt): NodeExecutionOutcome {
  const result: AgentResult = {
    resultId: `result-${attempt.nodeId}`,
    operatorSessionId: attempt.operatorSessionId,
    nodeId: attempt.nodeId,
    capabilityId: attempt.capabilityId,
    status: 'SUCCEEDED',
    summary: `Fake Stage-7 adapter completed ${attempt.nodeId}.`,
    producedArtifactRefs: [],
    consumedArtifactRefs: [],
    findingIds: [],
    evidenceIds: [],
    startedAt: attempt.startedAt,
    completedAt: attempt.startedAt,
    policyRefs: [],
  };
  return { attempt, result };
}

function stage7Routes(first: FakeStage7Adapter, second: FakeStage7Adapter): ExactTupleResolver {
  const base = {
    workflowTemplateId: 'qa.v2',
    role: 'mock-reader',
    capabilityId: 'mock-read-capability',
    requiredCapability: 'mock-read-capability',
    mutationClass: 'READ_ONLY' as const,
  };
  const firstTuple: NodeExecutionTuple = { ...base, nodeId: 'qa-a' };
  const secondTuple: NodeExecutionTuple = { ...base, nodeId: 'qa-b' };
  return new ExactTupleResolver(new Map([
    [serializeNodeExecutionTuple(firstTuple), first],
    [serializeNodeExecutionTuple(secondTuple), second],
  ]));
}

describe('Stage-7 runtime partitioning', () => {
  test('CONTINUE launches one homogeneous adapter partition and defers the other ready node', async () => {
    const store = new MemoryOperatorSessionStore();
    const firstAdapter = new FakeStage7Adapter('stage7-qa-preflight');
    const secondAdapter = new FakeStage7Adapter('stage7-qa-execution');
    const runtime = stage7Runtime(store, createStage7FeatureSet(true, true), stage7Routes(firstAdapter, secondAdapter));
    const started = await runtime.handle('run heterogeneous Stage-7 checks');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected Stage-7 gate and session');
    expect((await runtime.handle(`approve ${gateId}`)).ok).toBe(true);

    const continued = await runtime.handle('continue');
    expect(continued.ok).toBe(true);
    const persisted = await store.load(sessionId);
    if (persisted === undefined) throw new Error('expected persisted Stage-7 session');
    const attempts = Object.values(persisted.activeAttempts);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.adapterId).toBe('stage7-qa-preflight');
    expect(attempts[0]?.nodeId).toBe('qa-a');
    expect(persisted.session.nodeStates['qa-b']).toBe('READY');
    expect(firstAdapter.launches).toHaveLength(1);
    expect(secondAdapter.launches).toHaveLength(0);
    expect(continued.errorCode).not.toBe('STAGE7_ROUTE_UNAVAILABLE');

    const active = runtime.getActiveBatch(sessionId);
    if (active === undefined) throw new Error('expected first active Stage-7 partition');
    await runtime.completeBatch(sessionId, active.batchId, active.attempts.map(success));
    const secondContinue = await runtime.handle('continue');
    expect(secondContinue.ok).toBe(true);
    expect(secondAdapter.launches).toHaveLength(1);
    const secondPersisted = await store.load(sessionId);
    if (secondPersisted === undefined) throw new Error('expected second persisted Stage-7 batch');
    const secondAttempts = Object.values(secondPersisted.activeAttempts);
    expect(secondAttempts).toHaveLength(1);
    expect(secondAttempts[0]?.adapterId).toBe('stage7-qa-execution');
    expect(secondAttempts.every((attempt) => attempt.adapterId === 'stage7-qa-execution')).toBe(true);
  });

  test('an unresolved ready tuple prevents every launch and attempt persistence', async () => {
    const store = new MemoryOperatorSessionStore();
    const firstAdapter = new FakeStage7Adapter('stage7-qa-preflight');
    const runtime = stage7Runtime(
      store,
      createStage7FeatureSet(true, true),
      stage7Routes(firstAdapter, new FakeStage7Adapter('stage7-qa-execution')),
    );
    const started = await runtime.handle('run unresolved Stage-7 checks');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected Stage-7 gate and session');
    await runtime.handle(`approve ${gateId}`);
    const before = await store.load(sessionId);
    const routes = new ExactTupleResolver(new Map([[serializeNodeExecutionTuple({ workflowTemplateId: 'qa.v2', nodeId: 'qa-a', role: 'mock-reader', capabilityId: 'mock-read-capability', requiredCapability: 'mock-read-capability', mutationClass: 'READ_ONLY' }), firstAdapter]]));
    const unresolvedRuntime = stage7Runtime(store, createStage7FeatureSet(true, true), routes);
    const resumed = await unresolvedRuntime.handle(`resume ${sessionId}`);
    expect(resumed.ok).toBe(true);
    const result = await unresolvedRuntime.handle('continue');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('STAGE7_ROUTE_UNAVAILABLE');
    expect(firstAdapter.launches).toHaveLength(0);
    const after = await store.load(sessionId);
    expect(after).toEqual(before);
    expect(after?.activeAttempts).toEqual({});
    expect(after?.session.nodeStates['qa-a']).toBe('READY');
    expect(after?.session.nodeStates['qa-b']).toBe('READY');
  });
});

describe('Stage-7 startup feature-hash resume', () => {
  test('mismatched enabled hash refuses resume without mutating state or dispatching', async () => {
    const store = new MemoryOperatorSessionStore();
    const enabled = createStage7FeatureSet(true, true);
    const firstAdapter = new FakeStage7Adapter('stage7-qa-preflight');
    const secondAdapter = new FakeStage7Adapter('stage7-qa-execution');
    const creator = stage7Runtime(store, enabled, stage7Routes(firstAdapter, secondAdapter));
    const started = await creator.handle('persist an enabled Stage-7 session');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected Stage-7 gate and session');
    await creator.handle(`approve ${gateId}`);
    await creator.handle('continue');
    const before = await store.load(sessionId);
    expect(before?.startupFeatureSetHash).toBe(enabled.hash);

    const mismatched = { ...enabled, hash: 'c'.repeat(64) };
    const resumeAdapter = new FakeStage7Adapter('stage7-qa-preflight');
    const resumed = await stage7Runtime(store, mismatched, stage7Routes(resumeAdapter, new FakeStage7Adapter('stage7-qa-execution'))).handle(`resume ${sessionId}`);
    expect(resumed.ok).toBe(false);
    expect(resumed.errorCode).toBe('FEATURE_SET_MISMATCH');
    expect(resumeAdapter.launches).toHaveLength(0);
    expect(await store.load(sessionId)).toEqual(before);
  });

  test('disabled-session absent hash refuses resume in an enabled process', async () => {
    const store = new MemoryOperatorSessionStore();
    const disabled = createStage7FeatureSet(false, true);
    const disabledRuntime = stage7Runtime(store, disabled, createFrozenNodeExecutionAdapterResolver(new DeterministicMockAdapter(new FixedClock(), new SequentialIds()), true), new FakeCompiler());
    const started = await disabledRuntime.handle('persist a disabled session');
    const sessionId = started.operatorSessionId;
    if (sessionId === undefined) throw new Error('expected session');
    const before = await store.load(sessionId);
    expect(before?.startupFeatureSetHash).toBeUndefined();

    const enabled = createStage7FeatureSet(true, true);
    const resumed = await stage7Runtime(store, enabled, createFrozenNodeExecutionAdapterResolver(new DeterministicMockAdapter(new FixedClock(), new SequentialIds()), true), new FakeCompiler()).handle(`resume ${sessionId}`);
    expect(resumed.ok).toBe(false);
    expect(resumed.errorCode).toBe('FEATURE_SET_MISMATCH');
    expect(await store.load(sessionId)).toEqual(before);
  });

  test('matching enabled startup hash resumes through the command path', async () => {
    const store = new MemoryOperatorSessionStore();
    const enabled = createStage7FeatureSet(true, true);
    const first = stage7Runtime(store, enabled, stage7Routes(new FakeStage7Adapter('stage7-qa-preflight'), new FakeStage7Adapter('stage7-qa-execution')));
    const started = await first.handle('persist a matching Stage-7 session');
    const sessionId = started.operatorSessionId;
    if (sessionId === undefined) throw new Error('expected session');
    const before = await store.load(sessionId);
    const resumed = await stage7Runtime(store, enabled, stage7Routes(new FakeStage7Adapter('stage7-qa-preflight'), new FakeStage7Adapter('stage7-qa-execution'))).handle(`resume ${sessionId}`);
    expect(resumed.ok).toBe(true);
    expect(resumed.session?.currentState).toBe('AWAITING_HUMAN');
    expect(await store.load(sessionId)).toEqual(before);
  });
});

import { describe, expect, test } from 'bun:test';
import type { FindingEffectiveDisposition } from '../src/contracts.js';
import { createOperatorRuntime } from '../src/controller.js';
import { DeterministicMockAdapter, createDeterministicContextProjector } from '../src/mock.js';
import { validateStoredOperatorSession } from '../src/runtime-validators.js';
import { assessFindingDispositions } from '../src/state/final-result.js';
import { MemoryOperatorSessionStore } from '../src/store.js';
import type { NodeExecutionOutcome, NodeResultRefs } from '../src/runtime-types.js';
import { createFrozenNodeExecutionAdapterResolver } from '../src/stage7/adapter-resolver.js';
import { FakeCompiler, FixedClock, SequentialIds } from './helpers/runtime-fixtures.js';

const TIMESTAMP = '2026-01-01T00:00:00.000Z';

function makeNodeResultRefs(findingId: string, recommendedDisposition?: FindingEffectiveDisposition): NodeResultRefs {
  const refs: NodeResultRefs = {
    status: 'SUCCEEDED',
    summary: 'finding report',
    producedArtifactRefs: [],
    consumedArtifactRefs: [],
    evidenceIds: [],
    findingIds: [findingId],
    policyRefs: [],
    providerSessionId: 'provider-session-1',
    modelProvider: 'mock',
    modelId: 'mock-v1',
    startedAt: TIMESTAMP,
    completedAt: TIMESTAMP,
  };
  return recommendedDisposition === undefined ? refs : { ...refs, recommendedDisposition };
}

describe('finding disposition aggregation', () => {
  test('undefined followed by BLOCK remains blocking', () => {
    const assessment = assessFindingDispositions({
      observation: makeNodeResultRefs('finding-1'),
      blocker: makeNodeResultRefs('finding-1', 'BLOCK'),
    });

    expect(assessment.fundamentalBlockers).toEqual(['finding-1']);
    expect(assessment.workflowStatus).toBe('BLOCKED');
  });

  test('BLOCK followed by undefined remains blocking', () => {
    const assessment = assessFindingDispositions({
      blocker: makeNodeResultRefs('finding-1', 'BLOCK'),
      observation: makeNodeResultRefs('finding-1'),
    });

    expect(assessment.fundamentalBlockers).toEqual(['finding-1']);
    expect(assessment.workflowStatus).toBe('BLOCKED');
  });

  test('undefined followed by HUMAN_DECISION remains human-gated', () => {
    const assessment = assessFindingDispositions({
      observation: makeNodeResultRefs('finding-1'),
      decision: makeNodeResultRefs('finding-1', 'HUMAN_DECISION'),
    });

    expect(assessment.blockingFindings).toEqual(['finding-1']);
    expect(assessment.humanDecisionRequired).toBe(true);
    expect(assessment.workflowStatus).toBe('HUMAN_DECISION_REQUIRED');
  });

  test('CONTINUE followed by BLOCK chooses the more restrictive disposition', () => {
    const assessment = assessFindingDispositions({
      permissive: makeNodeResultRefs('finding-1', 'CONTINUE'),
      blocker: makeNodeResultRefs('finding-1', 'BLOCK'),
    });

    expect(assessment.fundamentalBlockers).toEqual(['finding-1']);
    expect(assessment.nonBlockingFindings).toEqual([]);
  });

  test('BLOCK followed by CONTINUE cannot erase the blocker', () => {
    const assessment = assessFindingDispositions({
      blocker: makeNodeResultRefs('finding-1', 'BLOCK'),
      permissive: makeNodeResultRefs('finding-1', 'CONTINUE'),
    });

    expect(assessment.fundamentalBlockers).toEqual(['finding-1']);
    expect(assessment.nonBlockingFindings).toEqual([]);
  });
});

describe('parallel resume reconciliation', () => {
  test('partial evidence preserves a terminal failure, validates, and never retries the unproven peer', async () => {
    const store = new MemoryOperatorSessionStore();
    const clock = new FixedClock();
    const ids = new SequentialIds();
    const adapter = new DeterministicMockAdapter(clock, ids, { autoResolve: false });
    let provenOutcome: NodeExecutionOutcome | undefined;
    const runtime = createOperatorRuntime({
      store,
      clock,
      ids,
      nodeExecutionAdapterResolver: createFrozenNodeExecutionAdapterResolver(adapter, true),
      contextProjector: createDeterministicContextProjector(),
      nodeTimeoutMs: () => 60_000,
      compiler: new FakeCompiler('parallel'),
      projectRoot: '/dev/null',
      resumeEvidence: async () => (provenOutcome === undefined ? [] : [provenOutcome]),
    });

    const started = await runtime.handle('run parallel checks');
    const gateId = started.gate?.gateId;
    if (gateId === undefined) throw new Error('expected execution approval gate');
    const approved = await runtime.handle(`approve ${gateId}`);
    const operatorSessionId = approved.operatorSessionId;
    if (operatorSessionId === undefined) throw new Error('expected operator session id');
    const continued = await runtime.handle('continue');
    expect(continued.ok).toBe(true);

    const active = runtime.getActiveBatch(operatorSessionId);
    if (active === undefined) throw new Error('expected active parallel batch');
    const provenAttempt = active.attempts[0];
    const unprovenAttempt = active.attempts[1];
    if (provenAttempt === undefined || unprovenAttempt === undefined) throw new Error('expected two parallel attempts');

    provenOutcome = {
      attempt: provenAttempt,
      result: {
        resultId: 'result-resume-failure',
        operatorSessionId: provenAttempt.operatorSessionId,
        nodeId: provenAttempt.nodeId,
        capabilityId: provenAttempt.capabilityId,
        status: 'FAILED',
        summary: 'proven terminal failure',
        producedArtifactRefs: [],
        consumedArtifactRefs: [],
        findingIds: [],
        evidenceIds: [],
        startedAt: provenAttempt.startedAt,
        completedAt: provenAttempt.timeoutAt,
        policyRefs: [],
      },
    };

    const resumed = await runtime.handle(`resume ${operatorSessionId}`);
    expect(resumed.ok).toBe(true);
    expect(resumed.session?.currentState).toBe('FAILED');
    expect(resumed.session?.terminalResult).not.toBeNull();
    expect(resumed.session?.stopDetail).toBeUndefined();
    expect(resumed.session?.nodeStates[provenAttempt.nodeId]).toBe('FAILED');
    expect(resumed.session?.nodeStates[unprovenAttempt.nodeId]).toBe('RUNNING');

    const persisted = await store.load(operatorSessionId);
    if (persisted === undefined) throw new Error('expected reconciled record');
    expect(validateStoredOperatorSession(persisted).ok).toBe(true);
    expect(persisted.activeAttempts[provenAttempt.nodeId]).toBeUndefined();
    expect(persisted.activeAttempts[unprovenAttempt.nodeId]?.attemptId).toBe(unprovenAttempt.attemptId);

    const continuedAfterTerminal = await runtime.handle('continue');
    expect(continuedAfterTerminal.ok).toBe(false);
    expect(runtime.getActiveBatch(operatorSessionId)?.batchId).toBe(active.batchId);
  });
});

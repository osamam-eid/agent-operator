import { describe, expect, test } from 'bun:test';
import { createOperatorRuntime } from '../src/controller.js';
import { parseOperatorCommand } from '../src/commands.js';
import { DeterministicMockAdapter, createDeterministicContextProjector } from '../src/mock.js';
import { MemoryOperatorSessionStore } from '../src/store.js';
import { createFrozenNodeExecutionAdapterResolver } from '../src/stage7/adapter-resolver.js';
import type { NodeExecutionOutcome, StoredOperatorSession } from '../src/runtime-types.js';
import {
  dispatchOneBatch,
  expectValidSession,
  FakeCompiler,
  FIXED_NOW,
  FixedClock,
  makeRuntime,
  RacingSaveStore,
  SequentialIds,
} from './helpers/runtime-fixtures.js';

// ---------------------------------------------------------------------------
// Happy path: start -> approve -> continue -> completeBatch -> COMPLETED
// ---------------------------------------------------------------------------

describe('OperatorRuntime happy path', () => {
  test('start, approve, continue, completeBatch completes with a valid contract-conformant session', async () => {
    const { runtime, store, adapter } = makeRuntime();

    const started = await runtime.handle('build the login page');
    expect(started.ok).toBe(true);
    expect(started.session?.currentState).toBe('AWAITING_HUMAN');
    expect(started.session?.openGateId).toBeDefined();
    expect(started.gate?.status).toBe('OPEN');
    expect(started.gate?.decisionType).toBe('EXECUTION_APPROVAL');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');

    const approved = await runtime.handle(`approve ${gateId}`);
    expect(approved.ok).toBe(true);
    expect(approved.session?.currentState).toBe('READY');
    expect(approved.session?.openGateId).toBeUndefined();
    expect(approved.session?.humanDecisions).toHaveLength(1);
    expect(approved.session?.humanDecisions[0]?.outcome).toBe('APPROVED');

    const { outcome: completed } = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(completed.ok).toBe(true);
    expect(completed.session?.currentState).toBe('COMPLETED');
    const stored = await store.load(sessionId);
    expect(stored?.nodeResultRefs['mock-read-node']).toMatchObject({
      status: 'SUCCEEDED',
      summary: 'Deterministic mock execution of node "mock-read-node" (role "mock-reader") returned SUCCEEDED.',
      providerSessionId: 'providerSession-1',
      modelProvider: 'mock',
      modelId: 'mock-v1',
      startedAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(completed.session?.nodeStates['mock-read-node']).toBe('SUCCEEDED');

    const terminal = completed.session?.terminalResult;
    expect(terminal).not.toBeNull();
    expect(terminal?.status.workflowStatus).toBe('COMPLETED');
    expect(terminal?.usage).toEqual({ providers: ['mock'], models: ['mock-v1'], tokens: null, cost: null, duration: 0 });
    expect(terminal?.status.executionStatus).toBe('SUCCEEDED');
    expect(terminal?.execution.actionsNotPerformed.length).toBeGreaterThan(0);
    expect(terminal?.decision.recommendation).toBe('GO');

    if (completed.session === undefined) throw new Error('expected session');
    expectValidSession(completed.session);

    const eventTypes = completed.session.journal.map((entry) => entry.eventType);
    expect(eventTypes).toEqual(['SESSION_STARTED', 'GATE_OPENED', 'GATE_APPROVED', 'EXECUTION_STARTED', 'EXECUTION_SUCCEEDED', 'SESSION_COMPLETED']);
  });

  test('a SUCCEEDED reviewer result with BLOCK disposition is not PASSED and cannot produce GO', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter, new FakeCompiler('reviewer'));
    const started = await runtime.handle('review this plan for blocking findings');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const { outcome: completed } = await dispatchOneBatch(runtime, sessionId, adapter, {
      'independent-review': { findingIds: ['finding-critical'], recommendedDisposition: 'BLOCK' },
    });

    expect(completed.ok).toBe(false);
    expect(completed.session?.currentState).toBe('FAILED');
    expect(completed.session?.verificationState.independentReview).toBe('FAILED');
    expect(completed.session?.terminalResult?.status.workflowStatus).toBe('BLOCKED');
    expect(completed.session?.terminalResult?.decision.recommendation).toBe('STOP');
    expect(completed.session?.terminalResult?.findings.fundamentalBlockers).toEqual(['finding-critical']);
    expect(completed.session?.terminalResult?.findings.observations).not.toContain('finding-critical');
    if (completed.session === undefined) throw new Error('expected session');
    expectValidSession(completed.session);
  });

  test('a SUCCEEDED verifier result with HUMAN_DECISION disposition is held fail-closed', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter, new FakeCompiler('reviewer'));
    const started = await runtime.handle('review this plan for a decision-required finding');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const { outcome: completed } = await dispatchOneBatch(runtime, sessionId, adapter, {
      'independent-review': { findingIds: ['finding-needs-human'], recommendedDisposition: 'HUMAN_DECISION' },
    });

    expect(completed.ok).toBe(false);
    expect(completed.session?.currentState).toBe('FAILED');
    expect(completed.session?.verificationState.independentReview).toBe('FAILED');
    expect(completed.session?.terminalResult?.status.workflowStatus).toBe('HUMAN_DECISION_REQUIRED');
    expect(completed.session?.terminalResult?.decision.recommendation).toBe('HOLD');
    expect(completed.session?.terminalResult?.findings.blockingFindings).toEqual(['finding-needs-human']);
    expect(completed.session?.terminalResult?.humanDecision.required).toBe(true);
    if (completed.session === undefined) throw new Error('expected session');
    expectValidSession(completed.session);
  });
  test('derives independent review state from the reviewer node lifecycle', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter, new FakeCompiler('reviewer'));
    const started = await runtime.handle('review this plan');
    expect(started.session?.verificationState.independentReview).toBe('NOT_STARTED');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);
    const { outcome: completed } = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(completed.session?.verificationState.independentReview).toBe('PASSED');
    expect(completed.session?.terminalResult?.verification.independentReview).toBe('PASSED');
  });

  test('why renders the actual compiled route, not fixed Stage 2 wording', async () => {
    const { runtime } = makeRuntime();
    await runtime.handle('--explain explain this route');
    const why = await runtime.handle('why');

    expect(why.ok).toBe(true);
    expect(why.text).not.toContain('fixed mock capability fit');
    expect(why.text).not.toContain('local mock provider available');
    for (const label of [
      'Classification:',
      'Risk:',
      'Workflow:',
      'graph revision',
      'Roles/providers and capability fit:',
      'Rejected alternatives:',
      'Required gates:',
      'Budget effect:',
      'Provider health/fallback decisions:',
      'Policy refs:',
      'Confidence:',
      'abstained:',
    ]) {
      expect(why.text).toContain(label);
    }
  });

  test('reject declines the session without ever dispatching', async () => {
    const { runtime } = makeRuntime();
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    if (gateId === undefined) throw new Error('expected gate id');

    const rejected = await runtime.handle(`reject ${gateId}`);
    expect(rejected.ok).toBe(true);
    expect(rejected.session?.currentState).toBe('CANCELLED');
    expect(rejected.session?.terminalResult?.status.workflowStatus).toBe('DECLINED');
    expect(rejected.session?.terminalResult?.status.executionStatus).toBe('NOT_STARTED');
    expect(rejected.session?.nodeStates['mock-read-node']).toBe('PENDING');
    if (rejected.session === undefined) throw new Error('expected session');
    expectValidSession(rejected.session);
  });

  test('cancel while AWAITING_HUMAN supersedes the open gate', async () => {
    const { runtime } = makeRuntime();
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;

    const cancelled = await runtime.handle('cancel');
    expect(cancelled.ok).toBe(true);
    expect(cancelled.session?.currentState).toBe('CANCELLED');
    expect(cancelled.session?.terminalResult?.status.workflowStatus).toBe('CANCELLED');
    if (cancelled.session === undefined) throw new Error('expected session');
    expectValidSession(cancelled.session);

    // The superseded gate cannot be decided afterward.
    if (gateId === undefined) throw new Error('expected gate id');
    const lateApprove = await runtime.handle(`approve ${gateId}`);
    expect(lateApprove.ok).toBe(false);
    expect(lateApprove.errorCode).toBe('GATE_NOT_OPEN');
  });
});

// ---------------------------------------------------------------------------
// Compiler failure: never reaches state.ts or the store
// ---------------------------------------------------------------------------

describe('OperatorRuntime compiler failure', () => {
  test('a failed compilation maps to COMPILATION_FAILED and creates no session', async () => {
    const { runtime, store } = makeRuntime();
    const result = await runtime.handle('please FAIL_COMPILE this request');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('COMPILATION_FAILED');
    expect(result.operatorSessionId).toBeUndefined();
    expect(result.session).toBeUndefined();

    // No active session was ever established: the very next start succeeds.
    const started = await runtime.handle('a normal request');
    expect(started.ok).toBe(true);
    expect(await store.load('session-1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pipeline readiness: one continue never dispatches more than one node
// ---------------------------------------------------------------------------

describe('OperatorRuntime pipeline sequencing (two-node)', () => {
  test('continue dispatches exactly one node at a time, in dependency order, before completing', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter, new FakeCompiler('two-node'));
    const started = await runtime.handle('build a two-step feature');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    const approved = await runtime.handle(`approve ${gateId}`);
    expect(approved.session?.nodeStates['mock-node-a']).toBe('READY');
    expect(approved.session?.nodeStates['mock-node-b']).toBe('PENDING');

    const first = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(first.outcome.ok).toBe(true);
    expect(first.outcomes).toHaveLength(1);
    expect(first.outcomes[0]?.attempt.nodeId).toBe('mock-node-a');
    expect(first.outcome.session?.currentState).toBe('READY');
    expect(first.outcome.session?.nodeStates['mock-node-a']).toBe('SUCCEEDED');
    expect(first.outcome.session?.nodeStates['mock-node-b']).toBe('READY');

    const second = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(second.outcome.ok).toBe(true);
    expect(second.outcomes).toHaveLength(1);
    expect(second.outcomes[0]?.attempt.nodeId).toBe('mock-node-b');
    expect(second.outcome.session?.currentState).toBe('COMPLETED');
    expect(second.outcome.session?.nodeStates['mock-node-a']).toBe('SUCCEEDED');
    expect(second.outcome.session?.nodeStates['mock-node-b']).toBe('SUCCEEDED');
    if (second.outcome.session === undefined) throw new Error('expected session');
    expectValidSession(second.outcome.session);
  });
});

// ---------------------------------------------------------------------------
// Parallel readiness: selectReadyBatch caps a PARALLEL batch at maxConcurrency
// ---------------------------------------------------------------------------

describe('OperatorRuntime parallel readiness', () => {
  test('a PARALLEL execution shape dispatches at most maxConcurrency ready nodes per batch, continuing across multiple continues', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter, new FakeCompiler('parallel'));
    const started = await runtime.handle('run three independent checks in parallel');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    const approved = await runtime.handle(`approve ${gateId}`);
    expect(approved.session?.nodeStates['p-a']).toBe('READY');
    expect(approved.session?.nodeStates['p-b']).toBe('READY');
    expect(approved.session?.nodeStates['p-c']).toBe('READY');

    // maxConcurrency=2 (fixture): the first batch dispatches exactly two of
    // the three currently-READY nodes, in declared graph order.
    const first = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(first.outcome.ok).toBe(true);
    expect(first.outcomes).toHaveLength(2);
    const dispatchedFirst = first.outcomes.map((o) => o.attempt.nodeId);
    expect(new Set(dispatchedFirst).size).toBe(2);
    expect(dispatchedFirst).toEqual(['p-a', 'p-b']);
    for (const nodeId of dispatchedFirst) expect(first.outcome.session?.nodeStates[nodeId]).toBe('SUCCEEDED');
    // The third node was never touched by this batch; the session returns
    // to READY (not EXECUTING) for the next continue to pick it up.
    expect(first.outcome.session?.currentState).toBe('READY');
    expect(first.outcome.session?.nodeStates['p-c']).toBe('READY');

    const second = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(second.outcome.ok).toBe(true);
    expect(second.outcomes).toHaveLength(1);
    expect(second.outcomes[0]?.attempt.nodeId).toBe('p-c');
    expect(second.outcome.session?.currentState).toBe('COMPLETED');
    for (const nodeId of ['p-a', 'p-b', 'p-c']) expect(second.outcome.session?.nodeStates[nodeId]).toBe('SUCCEEDED');
  });
});

// ---------------------------------------------------------------------------
// Optional-node degradation
// ---------------------------------------------------------------------------

describe('OperatorRuntime optional-node degradation', () => {
  test('an optional-node failure permits downstream synthesis and completes as explicit partial/deferred work', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter, new FakeCompiler('optional-node'));
    const started = await runtime.handle('run a workflow with optional evidence');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const mandatoryStart = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(mandatoryStart.outcome.session?.nodeStates['optional-node']).toBe('READY');

    const degraded = await dispatchOneBatch(runtime, sessionId, adapter, {
      'optional-node': { status: 'FAILED', summary: 'Deliberate optional-node failure.' },
    });
    expect(degraded.outcome.ok).toBe(true);
    expect(degraded.outcome.session?.currentState).toBe('READY');
    expect(degraded.outcome.session?.nodeStates['optional-node']).toBe('FAILED');
    expect(degraded.outcome.session?.nodeStates['mandatory-synthesis']).toBe('READY');
    expect(degraded.outcome.session?.journal.at(-1)?.eventType).toBe('EXECUTION_FAILED');

    const completed = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(completed.outcome.ok).toBe(true);
    expect(completed.outcome.session?.currentState).toBe('COMPLETED');
    expect(completed.outcome.session?.terminalResult?.status.executionStatus).toBe('PARTIAL');
    expect(completed.outcome.session?.terminalResult?.status.workflowStatus).toBe('COMPLETED_WITH_DEFERRED_ITEMS');
    expect(completed.outcome.session?.terminalResult?.decision.recommendation).toBe('GO_WITH_DEFERRED_ITEMS');
    expect(completed.outcome.session?.terminalResult?.scope.deviations[0]?.description).toContain('optional-node');
    expect(completed.outcome.session?.terminalResult?.risk.remainingRisks[0]).toContain('optional-node');
    if (completed.outcome.session === undefined) throw new Error('expected session');
    expectValidSession(completed.outcome.session);
  });
});

// ---------------------------------------------------------------------------
// Multi-gate chaining: required gates beyond the initial one
// ---------------------------------------------------------------------------

describe('OperatorRuntime multi-gate chaining', () => {
  test('a second required gate opens after the mandatory node succeeds; approving it completes the session', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter, new FakeCompiler('multi-gate'));
    const started = await runtime.handle('do something requiring double approval');
    const firstGateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (firstGateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${firstGateId}`);

    const afterContinue = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(afterContinue.outcome.ok).toBe(true);
    expect(afterContinue.outcome.session?.currentState).toBe('AWAITING_HUMAN');
    const secondGateId = afterContinue.outcome.session?.openGateId;
    if (secondGateId === undefined) throw new Error('expected second gate id');
    expect(secondGateId).not.toBe(firstGateId);

    const status = await runtime.handle('status');
    expect(status.gate?.gateId).toBe(secondGateId);
    expect(status.gate?.decisionType).toBe('RESULT_APPROVAL');

    const finalApproval = await runtime.handle(`approve ${secondGateId}`);
    expect(finalApproval.ok).toBe(true);
    expect(finalApproval.session?.currentState).toBe('COMPLETED');
    expect(finalApproval.session?.humanDecisions).toHaveLength(2);
    expect(finalApproval.session?.humanDecisions.map((d) => d.decisionType)).toEqual(['EXECUTION_APPROVAL', 'RESULT_APPROVAL']);
    if (finalApproval.session === undefined) throw new Error('expected session');
    expectValidSession(finalApproval.session);
  });

  test('rejecting the second required gate declines the session with a SUCCEEDED execution status', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter, new FakeCompiler('multi-gate'));
    const started = await runtime.handle('do something requiring double approval');
    const firstGateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (firstGateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${firstGateId}`);
    const afterContinue = await dispatchOneBatch(runtime, sessionId, adapter);
    const secondGateId = afterContinue.outcome.session?.openGateId;
    if (secondGateId === undefined) throw new Error('expected second gate id');

    const rejected = await runtime.handle(`reject ${secondGateId}`);
    expect(rejected.ok).toBe(true);
    expect(rejected.session?.currentState).toBe('CANCELLED');
    expect(rejected.session?.terminalResult?.status.workflowStatus).toBe('DECLINED');
    expect(rejected.session?.terminalResult?.status.executionStatus).toBe('SUCCEEDED');
    if (rejected.session === undefined) throw new Error('expected session');
    expectValidSession(rejected.session);
  });
});

// ---------------------------------------------------------------------------
// Explain mode: never dispatches
// ---------------------------------------------------------------------------

describe('OperatorRuntime explain mode', () => {
  test('--explain builds a plan but never opens a gate and never dispatches', async () => {
    const { runtime } = makeRuntime();
    const started = await runtime.handle('--explain build the login page');
    expect(started.ok).toBe(true);
    expect(started.session?.currentState).toBe('PLANNING');
    expect(started.session?.openGateId).toBeUndefined();
    expect(started.session?.executionGraph).not.toBeNull();
    expect(started.gate).toBeUndefined();

    const continueAttempt = await runtime.handle('continue');
    expect(continueAttempt.ok).toBe(false);
    expect(continueAttempt.errorCode).toBe('CONTRACT_INVALID');

    const cancelled = await runtime.handle('cancel');
    expect(cancelled.ok).toBe(true);
    expect(cancelled.session?.currentState).toBe('CANCELLED');
    if (cancelled.session === undefined) throw new Error('expected session');
    expectValidSession(cancelled.session);
  });

  test('bare explain describes the active session without a new one', async () => {
    const { runtime } = makeRuntime();
    await runtime.handle('investigate the bug');
    const explained = await runtime.handle('explain');
    expect(explained.ok).toBe(true);
    expect(explained.text).toContain('investigate the bug');
    expect(explained.session?.currentState).toBe('AWAITING_HUMAN');
  });
});

// ---------------------------------------------------------------------------
// Invalid transitions and gate errors
// ---------------------------------------------------------------------------

describe('OperatorRuntime invalid transitions and gate resolution', () => {
  test('continue before approval finds no READY node and is rejected', async () => {
    const { runtime } = makeRuntime();
    await runtime.handle('do something');
    const result = await runtime.handle('continue');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('CONTRACT_INVALID');
  });

  test('approving an unknown gate id returns GATE_NOT_FOUND', async () => {
    const { runtime } = makeRuntime();
    await runtime.handle('do something');
    const result = await runtime.handle('approve gate-does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('GATE_NOT_FOUND');
  });

  test('approving the same gate twice returns GATE_NOT_OPEN the second time', async () => {
    const { runtime } = makeRuntime();
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    if (gateId === undefined) throw new Error('expected gate id');

    const first = await runtime.handle(`approve ${gateId}`);
    expect(first.ok).toBe(true);
    const second = await runtime.handle(`approve ${gateId}`);
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('GATE_NOT_OPEN');
  });

  test('rejects a gate whose graph binding is stale', async () => {
    const { runtime, store } = makeRuntime();
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    const record = await store.load(sessionId);
    if (record === undefined || record.session.executionGraph === null) throw new Error('expected stored graph');
    await store.save({
      ...record,
      session: {
        ...record.session,
        executionGraph: { ...record.session.executionGraph, graphHash: 'f'.repeat(64) },
      },
    });

    const result = await runtime.handle(`approve ${gateId}`);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('GATE_MISMATCH');
  });

  test('starting a session while one is already active is rejected', async () => {
    const { runtime } = makeRuntime();
    await runtime.handle('first request');
    const second = await runtime.handle('second request');
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('SESSION_ALREADY_ACTIVE');
  });

  test('starting a new session after the active one completed is allowed', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('first request');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);
    await dispatchOneBatch(runtime, sessionId, adapter);

    const second = await runtime.handle('second request');
    expect(second.ok).toBe(true);
    expect(second.session?.operatorSessionId).not.toBe(started.session?.operatorSessionId);
  });

  test('status/graph/why/cancel with no active session return NO_ACTIVE_SESSION', async () => {
    const { runtime } = makeRuntime();
    for (const cmd of ['status', 'graph', 'why', 'cancel', 'approve gate-1', 'continue']) {
      const result = await runtime.handle(cmd);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('NO_ACTIVE_SESSION');
    }
  });
});

// ---------------------------------------------------------------------------
// Node execution failure paths
// ---------------------------------------------------------------------------

describe('OperatorRuntime node execution failure paths', () => {
  test('a node returning FAILED produces NODE_EXECUTION_FAILED and ends the session FAILED', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something risky');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const { outcome } = await dispatchOneBatch(runtime, sessionId, adapter, {
      'mock-read-node': { status: 'FAILED', summary: 'Deliberate deterministic test failure.' },
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('NODE_EXECUTION_FAILED');
    expect(outcome.session?.currentState).toBe('FAILED');
    expect(outcome.session?.terminalResult?.status.workflowStatus).toBe('FAILED');
    expect(outcome.session?.nodeStates['mock-read-node']).toBe('FAILED');
    if (outcome.session === undefined) throw new Error('expected session');
    expectValidSession(outcome.session);
  });

  test('completeBatch rejects a structurally valid AgentResult bound to another session, synthesizing a FAILED result instead', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something risky');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const continued = await runtime.handle('continue');
    expect(continued.ok).toBe(true);
    const batch = runtime.getActiveBatch(sessionId);
    if (batch === undefined) throw new Error('expected an active batch');
    const attempt = batch.attempts[0];
    if (attempt === undefined) throw new Error('expected an attempt');

    const wrongIdentityOutcome: NodeExecutionOutcome = {
      attempt,
      result: {
        resultId: 'result-wrong-identity',
        operatorSessionId: 'a-different-session',
        nodeId: attempt.nodeId,
        capabilityId: attempt.capabilityId,
        status: 'SUCCEEDED',
        summary: `Incorrectly claimed success for ${sessionId}.`,
        producedArtifactRefs: [],
        consumedArtifactRefs: [],
        findingIds: [],
        evidenceIds: [],
        startedAt: FIXED_NOW,
        completedAt: FIXED_NOW,
        policyRefs: ['mock@1:node.deterministic'],
      },
    };

    const result = await runtime.completeBatch(sessionId, batch.batchId, [wrongIdentityOutcome]);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NODE_EXECUTION_FAILED');
    expect(result.session?.currentState).toBe('FAILED');
    expect(result.session?.terminalResult?.decision.recommendationRationale).toContain('identity did not match its attempt');
  });
});

// ---------------------------------------------------------------------------
// Batch completion timing: immediate (autoResolve) vs deferred completion
// ---------------------------------------------------------------------------

describe('OperatorRuntime batch completion timing', () => {
  test('an autoResolve adapter settles every attempt inside launchBatch itself (immediate completion)', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds());
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const continued = await runtime.handle('continue');
    expect(continued.ok).toBe(true);
    const batch = runtime.getActiveBatch(sessionId);
    if (batch === undefined) throw new Error('expected an active batch');

    // Already resolved synchronously inside launchBatch: awaiting it never
    // needs an external resolveNode call for the default autoResolve adapter.
    const outcomes = await batch.completion;
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.result.status).toBe('SUCCEEDED');

    const completed = await runtime.completeBatch(sessionId, batch.batchId, outcomes);
    expect(completed.ok).toBe(true);
    expect(completed.session?.currentState).toBe('COMPLETED');
  });

  test('a deferred (autoResolve:false) adapter leaves the node RUNNING until it is explicitly resolved and the batch explicitly completed', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const continued = await runtime.handle('continue');
    expect(continued.ok).toBe(true);
    expect(continued.session?.currentState).toBe('EXECUTING');
    expect(continued.session?.nodeStates['mock-read-node']).toBe('RUNNING');
    const batch = runtime.getActiveBatch(sessionId);
    if (batch === undefined) throw new Error('expected an active batch');

    let settled = false;
    void batch.completion.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    adapter.resolveNode(batch.batchId, 'mock-read-node');
    const outcomes = await batch.completion;
    expect(settled).toBe(true);

    const completed = await runtime.completeBatch(sessionId, batch.batchId, outcomes);
    expect(completed.ok).toBe(true);
    expect(completed.session?.currentState).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------
// Cancellation and timeout
// ---------------------------------------------------------------------------

describe('OperatorRuntime cancellation and timeout', () => {
  test('cancel mid-flight cancels the active batch and ends the session CANCELLED without ever redispatching', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);
    const continued = await runtime.handle('continue');
    expect(continued.session?.nodeStates['mock-read-node']).toBe('RUNNING');
    const batch = runtime.getActiveBatch(sessionId);
    if (batch === undefined) throw new Error('expected an active batch');

    const cancelled = await runtime.handle('cancel');
    expect(cancelled.ok).toBe(true);
    expect(cancelled.session?.currentState).toBe('CANCELLED');
    expect(cancelled.session?.nodeStates['mock-read-node']).toBe('CANCELLED');
    expect(adapter.getBatch(batch.batchId)?.isCancelled).toBe(true);
    expect(runtime.getActiveBatch(sessionId)).toBeUndefined();

    // Terminal CANCELLED never accepts another continue: no redispatch.
    const continueAfterCancel = await runtime.handle('continue');
    expect(continueAfterCancel.ok).toBe(false);
    expect(continueAfterCancel.errorCode).toBe('CONTRACT_INVALID');
  });

  test('runtime.timeoutBatch cancels the batch and blocks the session, and a repeated/stale timeout is a harmless no-op', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);
    await runtime.handle('continue');
    const batch = runtime.getActiveBatch(sessionId);
    if (batch === undefined) throw new Error('expected an active batch');

    const timedOut = await runtime.timeoutBatch(sessionId, batch.batchId);
    expect(timedOut.ok).toBe(true);
    expect(timedOut.session?.currentState).toBe('BLOCKED');
    expect(timedOut.session?.stopDetail?.retryEligible).toBe(false);
    expect(adapter.getBatch(batch.batchId)?.isCancelled).toBe(true);
    expect(runtime.getActiveBatch(sessionId)).toBeUndefined();

    // BLOCKED never auto-retries: continue is still illegal.
    const continueAfterTimeout = await runtime.handle('continue');
    expect(continueAfterTimeout.ok).toBe(false);
    expect(continueAfterTimeout.errorCode).toBe('CONTRACT_INVALID');

    // A stale/repeated timeout for a batch that is no longer active never
    // overwrites the already-reconciled BLOCKED state.
    const staleTimeout = await runtime.timeoutBatch(sessionId, batch.batchId);
    expect(staleTimeout.ok).toBe(true);
    expect(staleTimeout.text).toContain('no longer the active batch');
  });
});

// ---------------------------------------------------------------------------
// Stale / wrong-attempt outcome rejection
// ---------------------------------------------------------------------------

describe('OperatorRuntime stale and wrong-attempt outcome rejection', () => {
  test('a duplicate completeBatch call for an already-resolved batch id is ignored, never reprocessed', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const { outcome, batchId, outcomes } = await dispatchOneBatch(runtime, sessionId, adapter);
    expect(outcome.ok).toBe(true);
    expect(outcome.session?.currentState).toBe('COMPLETED');

    const replay = await runtime.completeBatch(sessionId, batchId, outcomes);
    expect(replay.ok).toBe(false);
    expect(replay.errorCode).toBe('CONTRACT_INVALID');
    expect(replay.text).toContain('no longer active');
    expect(replay.session?.currentState).toBe('COMPLETED');
  });

  test('an outcome bound to an attempt id that no longer matches activeAttempts is silently dropped, leaving the node RUNNING for a legitimate later completion', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);
    await runtime.handle('continue');
    const batch = runtime.getActiveBatch(sessionId);
    if (batch === undefined) throw new Error('expected an active batch');
    const realAttempt = batch.attempts[0];
    if (realAttempt === undefined) throw new Error('expected an attempt');

    const forgedOutcome: NodeExecutionOutcome = {
      attempt: { ...realAttempt, attemptId: 'forged-stale-attempt-id' },
      result: {
        resultId: 'result-forged',
        operatorSessionId: realAttempt.operatorSessionId,
        nodeId: realAttempt.nodeId,
        capabilityId: realAttempt.capabilityId,
        status: 'SUCCEEDED',
        summary: 'Forged outcome bound to a stale/replayed attempt id.',
        producedArtifactRefs: [],
        consumedArtifactRefs: [],
        findingIds: [],
        evidenceIds: [],
        startedAt: FIXED_NOW,
        completedAt: FIXED_NOW,
        policyRefs: ['mock@1:node.deterministic'],
      },
    };

    const dropped = await runtime.completeBatch(sessionId, batch.batchId, [forgedOutcome]);
    expect(dropped.ok).toBe(true);
    expect(dropped.session?.currentState).toBe('EXECUTING');
    expect(dropped.session?.nodeStates['mock-read-node']).toBe('RUNNING');

    adapter.resolveNode(batch.batchId, 'mock-read-node');
    const outcomes = await batch.completion;
    const completed = await runtime.completeBatch(sessionId, batch.batchId, outcomes);
    expect(completed.ok).toBe(true);
    expect(completed.session?.currentState).toBe('COMPLETED');
  });
});

// ---------------------------------------------------------------------------
// No-redispatch guarantees
// ---------------------------------------------------------------------------

describe('OperatorRuntime no-redispatch guarantees', () => {
  test('continue while a batch is already active in this runtime is rejected, never dispatching a second attempt for the same node', async () => {
    const adapter = new DeterministicMockAdapter(new FixedClock(), new SequentialIds(), { autoResolve: false });
    const { runtime } = makeRuntime(adapter);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    const sessionId = started.operatorSessionId;
    if (gateId === undefined || sessionId === undefined) throw new Error('expected gate and session ids');
    await runtime.handle(`approve ${gateId}`);

    const first = await runtime.handle('continue');
    expect(first.ok).toBe(true);
    const second = await runtime.handle('continue');
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('EXECUTION_ACTIVE');

    const batch = runtime.getActiveBatch(sessionId);
    expect(batch?.attempts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Bounded compare-and-swap retry (plan §6.2)
// ---------------------------------------------------------------------------

describe('OperatorRuntime bounded compare-and-swap retry', () => {
  test('a transient store conflict is retried internally and the command still applies', async () => {
    const store = new RacingSaveStore();
    const { runtime } = makeRuntime(undefined, undefined, store);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    if (gateId === undefined) throw new Error('expected gate id');

    store.armRaces(1);
    const approved = await runtime.handle(`approve ${gateId}`);
    expect(approved.ok).toBe(true);
    expect(approved.session?.currentState).toBe('READY');
  });

  test('exhausting the bounded CAS retry budget surfaces STORE_CONFLICT instead of retrying forever', async () => {
    const store = new RacingSaveStore();
    const { runtime } = makeRuntime(undefined, undefined, store);
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    if (gateId === undefined) throw new Error('expected gate id');

    store.armRaces(1000); // far exceeds the runtime's bounded retry budget
    const approved = await runtime.handle(`approve ${gateId}`);
    expect(approved.ok).toBe(false);
    expect(approved.errorCode).toBe('STORE_CONFLICT');
  });
});

// ---------------------------------------------------------------------------
// Strict updatedAt behavior
// ---------------------------------------------------------------------------

describe('OperatorRuntime strict updatedAt behavior', () => {
  test('every state-mutating command strictly advances session.updatedAt; read-only commands never do', async () => {
    const { runtime } = makeRuntime();
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    if (gateId === undefined || started.session === undefined) throw new Error('expected gate id and session');

    const approved = await runtime.handle(`approve ${gateId}`);
    if (approved.session === undefined) throw new Error('expected session');
    expect(Date.parse(approved.session.updatedAt)).toBeGreaterThan(Date.parse(started.session.updatedAt));

    const status = await runtime.handle('status');
    expect(status.session?.updatedAt).toBe(approved.session.updatedAt);

    const cancelled = await runtime.handle('cancel');
    if (cancelled.session === undefined) throw new Error('expected session');
    expect(Date.parse(cancelled.session.updatedAt)).toBeGreaterThan(Date.parse(approved.session.updatedAt));
  });
});

// ---------------------------------------------------------------------------
// Resume reconciliation
// ---------------------------------------------------------------------------

describe('OperatorRuntime resume', () => {
  test('resuming a session with a RUNNING node blocks it and never retries automatically', async () => {
    const store = new MemoryOperatorSessionStore();
    const runtime = createOperatorRuntime({
      store,
      clock: new FixedClock(),
      ids: new SequentialIds(),
      nodeExecutionAdapterResolver: createFrozenNodeExecutionAdapterResolver(new DeterministicMockAdapter(new FixedClock(), new SequentialIds()), true),
      contextProjector: createDeterministicContextProjector(),
      nodeTimeoutMs: () => 60_000,
      compiler: new FakeCompiler(),
      projectRoot: '/dev/null',
    });

    // Start and approve normally, then hand-craft the "crashed mid-dispatch"
    // state a real process interruption between beginExecutionBatch's
    // persist and the adapter's launchBatch call would leave behind, and
    // save it directly.
    const started = await runtime.handle('do something');
    const gateId = started.gate?.gateId;
    if (gateId === undefined) throw new Error('expected gate id');
    const approved = await runtime.handle(`approve ${gateId}`);
    const operatorSessionId = approved.operatorSessionId;
    if (operatorSessionId === undefined) throw new Error('expected operator session id');

    const record = await store.load(operatorSessionId);
    if (record === undefined) throw new Error('expected stored record');
    const interrupted: StoredOperatorSession = {
      ...record,
      session: {
        ...record.session,
        currentState: 'EXECUTING',
        currentPhase: 'Executing mock node',
        nodeStates: { 'mock-read-node': 'RUNNING' },
      },
    };
    await store.save(interrupted, record.session.updatedAt);

    const resumed = await runtime.handle(`resume ${operatorSessionId}`);
    expect(resumed.ok).toBe(true);
    expect(resumed.session?.currentState).toBe('BLOCKED');
    expect(resumed.session?.nodeStates['mock-read-node']).toBe('UNKNOWN');
    expect(resumed.session?.stopDetail?.retryEligible).toBe(false);
    expect(resumed.session?.journal.at(-1)?.eventType).toBe('RESUME_RECONCILED');
    if (resumed.session === undefined) throw new Error('expected session');
    expectValidSession(resumed.session);

    // BLOCKED never auto-retries: continue is still illegal.
    const continueAttempt = await runtime.handle('continue');
    expect(continueAttempt.ok).toBe(false);
    expect(continueAttempt.errorCode).toBe('CONTRACT_INVALID');

    // Cancel remains legal from BLOCKED.
    const cancelled = await runtime.handle('cancel');
    expect(cancelled.ok).toBe(true);
    expect(cancelled.session?.currentState).toBe('CANCELLED');
    expect(cancelled.session?.stopDetail).toBeUndefined();
  });

  test('resuming a session with nothing RUNNING is a no-op reattachment', async () => {
    const { runtime } = makeRuntime();
    const started = await runtime.handle('do something');
    const operatorSessionId = started.operatorSessionId;
    if (operatorSessionId === undefined) throw new Error('expected operator session id');

    const resumed = await runtime.handle(`resume ${operatorSessionId}`);
    expect(resumed.ok).toBe(true);
    expect(resumed.session?.currentState).toBe('AWAITING_HUMAN');
    expect(resumed.session?.journal).toEqual(started.session?.journal);
  });

  test('resuming an unknown session id returns SESSION_NOT_FOUND', async () => {
    const { runtime } = makeRuntime();
    const result = await runtime.handle('resume session-does-not-exist');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SESSION_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

describe('parseOperatorCommand', () => {
  test('parses a plain request as START/EXECUTE', () => {
    const result = parseOperatorCommand('fix the bug in the parser');
    expect(result).toEqual({ kind: 'START', request: 'fix the bug in the parser', mode: 'EXECUTE' });
  });

  test('parses --explain <request> as START/EXPLAIN', () => {
    const result = parseOperatorCommand('--explain fix the bug');
    expect(result).toEqual({ kind: 'START', request: 'fix the bug', mode: 'EXPLAIN' });
  });

  test('rejects --explain with no request', () => {
    const result = parseOperatorCommand('--explain');
    expect(result.kind).toBe('PARSE_ERROR');
  });

  test('rejects bare commands with extra arguments', () => {
    const result = parseOperatorCommand('status extra-token');
    expect(result.kind).toBe('PARSE_ERROR');
  });

  test('rejects approve with a missing gate id', () => {
    const result = parseOperatorCommand('approve');
    expect(result.kind).toBe('PARSE_ERROR');
  });

  test('rejects approve with more than one argument', () => {
    const result = parseOperatorCommand('approve gate-1 gate-2');
    expect(result.kind).toBe('PARSE_ERROR');
  });

  test('rejects empty input', () => {
    const result = parseOperatorCommand('   ');
    expect(result.kind).toBe('PARSE_ERROR');
  });

  test('parses approve/reject/continue/cancel/resume', () => {
    expect(parseOperatorCommand('approve gate-9')).toEqual({ kind: 'APPROVE', gateId: 'gate-9' });
    expect(parseOperatorCommand('reject gate-9')).toEqual({ kind: 'REJECT', gateId: 'gate-9' });
    expect(parseOperatorCommand('continue')).toEqual({ kind: 'CONTINUE' });
    expect(parseOperatorCommand('cancel')).toEqual({ kind: 'CANCEL' });
    expect(parseOperatorCommand('resume session-9')).toEqual({ kind: 'RESUME', operatorSessionId: 'session-9' });
    expect(parseOperatorCommand('why')).toEqual({ kind: 'WHY' });
    expect(parseOperatorCommand('graph')).toEqual({ kind: 'GRAPH' });
    expect(parseOperatorCommand('explain')).toEqual({ kind: 'EXPLAIN' });
  });
});

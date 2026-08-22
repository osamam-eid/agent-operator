import { describe, expect, test } from 'bun:test';
import type { AgentResult } from '../src/contracts.js';
import {
  adaptHostTimerScheduler,
  assertProductionAdapter,
  DuplicateBatchRegistrationError,
  ExecutionCoordinator,
  ExtensionTaskSupervisor,
  NodeTimerScheduler,
  ProductionMockAdapterRefusedError,
  type ExecutionCoordinatorRuntime,
  type SupervisedFailure,
  type TimerScheduler,
} from '../src/execution-coordinator.js';
import type {
  ActiveExecutionBatch,
  NodeExecutionAttempt,
  NodeExecutionOutcome,
  OperatorCommandOutcome,
} from '../src/runtime-types.js';

// ---------------------------------------------------------------------------
// Deterministic test fixtures
// ---------------------------------------------------------------------------

/** Drains the microtask queue (no real wall-clock wait) so every
 * `registerActiveBatch`/`shutdown` continuation (await batch.completion ->
 * await runtime.completeBatch/timeoutBatch -> cleanup -> Map delete) runs
 * to completion before the test asserts on coordinator/runtime state. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}

function makeAttempt(overrides: Partial<NodeExecutionAttempt> = {}): NodeExecutionAttempt {
  return {
    attemptId: 'attempt-1',
    batchId: 'batch-1',
    operatorSessionId: 'session-1',
    graphRevision: 1,
    nodeId: 'node-1',
    capabilityId: 'capability-1',
    adapterId: 'omp-task',
    providerSessionId: 'provider-session-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    timeoutAt: '2026-01-01T00:05:00.000Z',
    modelProvider: 'anthropic',
    modelId: 'claude-sonnet-5',
    ...overrides,
  };
}

function makeOutcome(overrides: Partial<NodeExecutionOutcome> = {}): NodeExecutionOutcome {
  const attempt = overrides.attempt ?? makeAttempt();
  const result: AgentResult = {
    resultId: 'result-1',
    operatorSessionId: attempt.operatorSessionId,
    nodeId: attempt.nodeId,
    capabilityId: attempt.capabilityId,
    status: 'SUCCEEDED',
    summary: 'ok',
    producedArtifactRefs: [],
    consumedArtifactRefs: [],
    findingIds: [],
    evidenceIds: [],
    startedAt: attempt.startedAt,
    completedAt: attempt.timeoutAt,
    policyRefs: [],
    ...overrides.result,
  };
  return { attempt, result };
}

/** A batch whose `completion` is a caller-controlled deferred, so tests can
 * decide exactly when the supervised continuation observes it settling. */
function makeControllableBatch(
  overrides: { batchId?: string; cancel?: ActiveExecutionBatch['cancel'] } = {},
): ActiveExecutionBatch & { resolveCompletion: (outcomes: readonly NodeExecutionOutcome[]) => void; rejectCompletion: (error: unknown) => void } {
  const { promise, resolve, reject } = deferred<readonly NodeExecutionOutcome[]>();
  return {
    batchId: overrides.batchId ?? 'batch-1',
    attempts: [makeAttempt()],
    completion: promise,
    cancel: overrides.cancel ?? (async () => {}),
    resolveCompletion: resolve,
    rejectCompletion: reject,
  };
}

class FakeRuntime implements ExecutionCoordinatorRuntime {
  readonly completeBatchCalls: Array<{ operatorSessionId: string; batchId: string; outcomes: readonly NodeExecutionOutcome[] }> = [];
  readonly timeoutBatchCalls: Array<{ operatorSessionId: string; batchId: string }> = [];
  shutdownActiveCalls = 0;
  completeBatchImpl: (operatorSessionId: string, batchId: string, outcomes: readonly NodeExecutionOutcome[]) => Promise<OperatorCommandOutcome> =
    async () => ({ ok: true, text: 'completed' });
  timeoutBatchImpl: (operatorSessionId: string, batchId: string) => Promise<OperatorCommandOutcome> = async () => ({ ok: true, text: 'timed out' });
  shutdownActiveImpl: () => Promise<void> = async () => {};

  getActiveBatch(): ActiveExecutionBatch | undefined {
    return undefined;
  }

  async completeBatch(operatorSessionId: string, batchId: string, outcomes: readonly NodeExecutionOutcome[]): Promise<OperatorCommandOutcome> {
    this.completeBatchCalls.push({ operatorSessionId, batchId, outcomes });
    return this.completeBatchImpl(operatorSessionId, batchId, outcomes);
  }

  async timeoutBatch(operatorSessionId: string, batchId: string): Promise<OperatorCommandOutcome> {
    this.timeoutBatchCalls.push({ operatorSessionId, batchId });
    return this.timeoutBatchImpl(operatorSessionId, batchId);
  }

  async shutdownActive(): Promise<void> {
    this.shutdownActiveCalls += 1;
    return this.shutdownActiveImpl();
  }
}

/** A `TimerScheduler` with manually-fired timers: never a real clock, so
 * timeout tests are deterministic and instant. */
class ManualScheduler implements TimerScheduler {
  readonly #pending = new Map<number, () => void>();
  #nextId = 0;

  setTimeout(callback: () => void, _delayMs: number): unknown {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#pending.set(id, callback);
    return id;
  }

  clearTimer(handle: unknown): void {
    this.#pending.delete(handle as number);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  fireAll(): void {
    const callbacks = [...this.#pending.values()];
    this.#pending.clear();
    for (const callback of callbacks) callback();
  }
}

function collectFailures(): { failures: SupervisedFailure[]; onUnhandledFailure: (failure: SupervisedFailure) => void } {
  const failures: SupervisedFailure[] = [];
  return { failures, onUnhandledFailure: (failure) => failures.push(failure) };
}

// ---------------------------------------------------------------------------
// ExtensionTaskSupervisor
// ---------------------------------------------------------------------------

describe('ExtensionTaskSupervisor.run', () => {
  test('resolves with the job value on success and never calls the failure reporter', async () => {
    const { failures, onUnhandledFailure } = collectFailures();
    const supervisor = new ExtensionTaskSupervisor({ onUnhandledFailure });

    const result = await supervisor.run('job', async () => 42);

    expect(result).toEqual({ ok: true, value: 42 });
    expect(failures).toHaveLength(0);
  });

  test('a throwing job is reported and swallowed, never rejecting the returned promise', async () => {
    const { failures, onUnhandledFailure } = collectFailures();
    const supervisor = new ExtensionTaskSupervisor({ onUnhandledFailure });
    const jobError = new Error('validation failed');

    const result = await supervisor.run('validate-result', async () => {
      throw jobError;
    });

    expect(result).toEqual({ ok: false });
    expect(failures).toEqual([{ stage: 'validate-result', error: jobError }]);
  });

  test('cleanup always runs after a failing job, and a throwing cleanup is reported separately', async () => {
    const { failures, onUnhandledFailure } = collectFailures();
    const supervisor = new ExtensionTaskSupervisor({ onUnhandledFailure });
    const jobError = new Error('store write failed');
    const cleanupError = new Error('disposal failed');
    let cleanupRan = false;

    const result = await supervisor.run(
      'persist',
      async () => {
        throw jobError;
      },
      async () => {
        cleanupRan = true;
        throw cleanupError;
      },
    );

    expect(result).toEqual({ ok: false });
    expect(cleanupRan).toBe(true);
    expect(failures).toEqual([
      { stage: 'persist', error: jobError },
      { stage: 'persist:cleanup', error: cleanupError },
    ]);
  });

  test('a throwing onUnhandledFailure reporter itself never escapes run()', async () => {
    const supervisor = new ExtensionTaskSupervisor({
      onUnhandledFailure: () => {
        throw new Error('reporter is broken');
      },
    });

    const result = await supervisor.run('job', async () => {
      throw new Error('original failure');
    });

    expect(result).toEqual({ ok: false });
  });
});

describe('ExtensionTaskSupervisor.scheduleTimeout', () => {
  test('fires the callback through the given scheduler and reports a throwing callback instead of rejecting', async () => {
    const { failures, onUnhandledFailure } = collectFailures();
    const supervisor = new ExtensionTaskSupervisor({ onUnhandledFailure });
    const scheduler = new ManualScheduler();
    const timeoutError = new Error('timeout handler failed');

    supervisor.scheduleTimeout('node-timeout', scheduler, 1000, () => {
      throw timeoutError;
    });
    scheduler.fireAll();
    await flush();

    expect(failures).toEqual([{ stage: 'node-timeout', error: timeoutError }]);
  });

  test('cancel() before firing prevents the callback from ever running', async () => {
    const supervisor = new ExtensionTaskSupervisor();
    const scheduler = new ManualScheduler();
    let called = false;

    const handle = supervisor.scheduleTimeout('node-timeout', scheduler, 1000, () => {
      called = true;
    });
    handle.cancel();
    scheduler.fireAll();
    await flush();

    expect(called).toBe(false);
    expect(scheduler.pendingCount).toBe(0);
  });

  test('cancel() is idempotent and a no-op once the timer has already fired', async () => {
    const supervisor = new ExtensionTaskSupervisor();
    const scheduler = new ManualScheduler();
    let calls = 0;

    const handle = supervisor.scheduleTimeout('node-timeout', scheduler, 1000, () => {
      calls += 1;
    });
    scheduler.fireAll();
    await flush();
    handle.cancel();
    handle.cancel();

    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// assertProductionAdapter
// ---------------------------------------------------------------------------

describe('assertProductionAdapter', () => {
  test('refuses a mock adapter by default', () => {
    expect(() => assertProductionAdapter({ adapterId: 'mock' })).toThrow(ProductionMockAdapterRefusedError);
  });

  test('allows a mock adapter only when explicitly permitted', () => {
    expect(() => assertProductionAdapter({ adapterId: 'mock' }, true)).not.toThrow();
  });

  test('never refuses the real omp-task adapter', () => {
    expect(() => assertProductionAdapter({ adapterId: 'omp-task' })).not.toThrow();
    expect(() => assertProductionAdapter({ adapterId: 'omp-task' }, false)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// ExecutionCoordinator.registerActiveBatch
// ---------------------------------------------------------------------------

describe('ExecutionCoordinator.registerActiveBatch', () => {
  test('completion applies through runtime.completeBatch and removes the handle only afterward', async () => {
    const runtime = new FakeRuntime();
    const { failures, onUnhandledFailure } = collectFailures();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler: new ManualScheduler(), onUnhandledFailure });
    const batch = makeControllableBatch();
    const outcomes = [makeOutcome()];

    coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' });
    expect(coordinator.isPending('session-1', 'batch-1')).toBe(true);

    batch.resolveCompletion(outcomes);
    await flush();

    expect(runtime.completeBatchCalls).toEqual([{ operatorSessionId: 'session-1', batchId: 'batch-1', outcomes }]);
    expect(coordinator.isPending('session-1', 'batch-1')).toBe(false);
    expect(coordinator.pendingCount).toBe(0);
    expect(failures).toHaveLength(0);
  });

  test('a completion validation/store failure (runtime.completeBatch rejects) is reported, never thrown, and the handle is still removed', async () => {
    const runtime = new FakeRuntime();
    const storeError = new Error('CAS conflict: session updated concurrently');
    runtime.completeBatchImpl = async () => {
      throw storeError;
    };
    const { failures, onUnhandledFailure } = collectFailures();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler: new ManualScheduler(), onUnhandledFailure });
    const batch = makeControllableBatch();

    expect(() =>
      coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' }),
    ).not.toThrow();
    batch.resolveCompletion([makeOutcome()]);
    await flush();

    expect(coordinator.isPending('session-1', 'batch-1')).toBe(false);
    expect(failures.map((f) => f.error)).toContain(storeError);
  });

  test('the adapter batch itself rejecting (a crashed child) is reported and still cleans up', async () => {
    const runtime = new FakeRuntime();
    const { failures, onUnhandledFailure } = collectFailures();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler: new ManualScheduler(), onUnhandledFailure });
    const batch = makeControllableBatch();
    const crash = new Error('adapter internal crash');

    coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' });
    batch.rejectCompletion(crash);
    await flush();

    expect(runtime.completeBatchCalls).toHaveLength(0);
    expect(coordinator.isPending('session-1', 'batch-1')).toBe(false);
    expect(failures.map((f) => f.error)).toContain(crash);
  });

  test('a scheduled timeout calls runtime.timeoutBatch through the injected scheduler and never redispatches', async () => {
    const runtime = new FakeRuntime();
    const scheduler = new ManualScheduler();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler });
    const batch = makeControllableBatch();

    coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2026-01-01T00:05:00.000Z' });
    scheduler.fireAll();
    await flush();

    expect(runtime.timeoutBatchCalls).toEqual([{ operatorSessionId: 'session-1', batchId: 'batch-1' }]);
    // Completion still pending: a timeout dispatch never redispatches or
    // fabricates a batch outcome by itself.
    expect(coordinator.isPending('session-1', 'batch-1')).toBe(true);
  });

  test('completion cancels the still-pending timeout so it never fires afterward', async () => {
    const runtime = new FakeRuntime();
    const scheduler = new ManualScheduler();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler });
    const batch = makeControllableBatch();

    coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' });
    batch.resolveCompletion([makeOutcome()]);
    await flush();

    expect(scheduler.pendingCount).toBe(0);
    expect(runtime.timeoutBatchCalls).toHaveLength(0);
  });

  test('a disposal failure while cancelling the timeout (scheduler.clearTimer throws) is reported and the handle is still removed', async () => {
    const throwingScheduler: TimerScheduler = {
      // Never actually schedules a real timer: this test only exercises
      // `clearTimer` throwing during the completion cleanup step.
      setTimeout: () => 'fake-handle',
      clearTimer: () => {
        throw new Error('host timer registry unavailable');
      },
    };
    const runtime = new FakeRuntime();
    const { failures, onUnhandledFailure } = collectFailures();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler: throwingScheduler, onUnhandledFailure });
    const batch = makeControllableBatch();

    coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' });
    batch.resolveCompletion([makeOutcome()]);
    await flush();

    expect(coordinator.isPending('session-1', 'batch-1')).toBe(false);
    expect(failures.some((f) => f.stage.endsWith(':timeout:clear'))).toBe(true);
  });

  test('a duplicate (operatorSessionId, batchId) registration is reported, never throws, and the original registration keeps being supervised', async () => {
    const runtime = new FakeRuntime();
    const { failures, onUnhandledFailure } = collectFailures();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler: new ManualScheduler(), onUnhandledFailure });
    const batch = makeControllableBatch();

    coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' });
    expect(() =>
      coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' }),
    ).not.toThrow();
    await flush();

    expect(coordinator.pendingCount).toBe(1);
    expect(failures.some((f) => f.error instanceof DuplicateBatchRegistrationError)).toBe(true);

    batch.resolveCompletion([makeOutcome()]);
    await flush();
    expect(runtime.completeBatchCalls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ExecutionCoordinator.shutdown
// ---------------------------------------------------------------------------

describe('ExecutionCoordinator.shutdown', () => {
  test('aborts through runtime.shutdownActive() then awaits every still-pending supervised completion', async () => {
    const runtime = new FakeRuntime();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler: new ManualScheduler() });
    const batch = makeControllableBatch();
    coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' });

    const shutdownPromise = coordinator.shutdown();
    // shutdown() must not resolve while a registered batch's completion is
    // still outstanding: prove it is genuinely awaiting, not racing ahead.
    let shutdownSettled = false;
    void shutdownPromise.then(() => {
      shutdownSettled = true;
    });
    await flush();
    expect(shutdownSettled).toBe(false);
    expect(runtime.shutdownActiveCalls).toBe(1);

    batch.resolveCompletion([makeOutcome()]);
    await shutdownPromise;

    expect(shutdownSettled).toBe(true);
    expect(coordinator.pendingCount).toBe(0);
  });

  test('a cancellation failure (runtime.shutdownActive rejects) is reported, never thrown, and pending batches are still awaited', async () => {
    const runtime = new FakeRuntime();
    runtime.shutdownActiveImpl = async () => {
      throw new Error('abort signal delivery failed');
    };
    const { failures, onUnhandledFailure } = collectFailures();
    const coordinator = new ExecutionCoordinator({ runtime, scheduler: new ManualScheduler(), onUnhandledFailure });
    const batch = makeControllableBatch();
    coordinator.registerActiveBatch({ operatorSessionId: 'session-1', batch, earliestTimeoutAt: '2099-01-01T00:00:00.000Z' });
    batch.resolveCompletion([makeOutcome()]);

    await expect(coordinator.shutdown()).resolves.toBeUndefined();

    expect(runtime.shutdownActiveCalls).toBe(1);
    expect(failures.some((f) => f.stage === 'execution-coordinator:shutdown:abort-active')).toBe(true);
    expect(coordinator.pendingCount).toBe(0);
  });

  test('shutdown with no active batches resolves immediately after the abort call', async () => {
    const runtime = new FakeRuntime();
    const coordinator = new ExecutionCoordinator({ runtime });

    await coordinator.shutdown();

    expect(runtime.shutdownActiveCalls).toBe(1);
    expect(coordinator.pendingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Timer scheduler adaptation
// ---------------------------------------------------------------------------

describe('adaptHostTimerScheduler', () => {
  test('adapts a host object exposing setTimeout/clearTimer instead of falling back to Node timers', () => {
    const calls: Array<{ delayMs: number }> = [];
    const host = {
      setTimeout: (callback: () => void, delayMs: number) => {
        calls.push({ delayMs });
        callback();
        return 'host-handle';
      },
      clearTimer: (_handle: unknown) => {},
    };

    const scheduler = adaptHostTimerScheduler(host);
    let ran = false;
    scheduler.setTimeout(() => {
      ran = true;
    }, 500);

    expect(ran).toBe(true);
    expect(calls).toEqual([{ delayMs: 500 }]);
  });

  test('falls back to NodeTimerScheduler when the host does not expose both methods', async () => {
    const scheduler = adaptHostTimerScheduler({ setTimeout: () => {} });
    expect(scheduler).toBeInstanceOf(NodeTimerScheduler);
  });
});

/**
 * Agent Operator — Stage 4 execution coordinator.
 *
 * Stage 3's `MockNodeExecutor` seam was synchronous and single-node:
 * `#handleContinue` awaited `execute()` directly inside the command
 * handler. Stage 4 generalizes execution to the async `NodeExecutionAdapter`
 * contract (`launchBatch()` starts work and returns immediately — see
 * `./runtime-types.ts`), so `OperatorRuntime` (`controller.ts`) now launches
 * a batch, persists `RUNNING` state, and returns to the user immediately.
 * Nobody is left blocking on the batch's `completion` promise inside a
 * command handler; something else has to observe it out-of-band, apply its
 * result through the runtime's own CAS-guarded reducer path, and guarantee
 * that observation can never crash the host process.
 *
 * This module is that "something else." It owns exactly two concerns, and
 * nothing about graph/state/store/adapter internals:
 *
 *  1. `ExtensionTaskSupervisor` — a small, host-independent utility that
 *     runs an async job to completion (with an optional cleanup step) and
 *     *guarantees* the returned promise never rejects. Every failure,
 *     whether from the job itself, the cleanup step, or a scheduled timer
 *     callback, is caught and funneled through a single bounded
 *     `onUnhandledFailure(stage, error)` callback that itself can never
 *     throw back into the supervisor.
 *
 *  2. `ExecutionCoordinator` — the Stage 4 extension-owned in-memory
 *     registry of active batches. `OperatorRuntime` calls
 *     `registerActiveBatch(...)` (`OperatorRuntimeDependencies.registerActiveBatch`,
 *     an `ActiveBatchRegistrar`) synchronously, once, right after
 *     `adapter.launchBatch()` succeeds and `RUNNING` state is persisted.
 *     The coordinator never persists anything itself and never
 *     redispatches a node: it attaches a supervised continuation to
 *     `batch.completion` that calls back into the runtime's own
 *     `completeBatch(...)`, schedules a single finite timeout that calls
 *     back into `timeoutBatch(...)`, and removes its bookkeeping entry
 *     only once that continuation (including its cleanup step) has fully
 *     settled. `shutdown()` aborts every active batch through the
 *     runtime's `shutdownActive()` and then awaits every outstanding
 *     supervised continuation via `Promise.allSettled` before returning —
 *     no batch, and no raw detached promise, is ever left running past
 *     extension teardown.
 *
 * Nothing in this file imports an OMP SDK type. `extension/index.ts` is the
 * only place that adapts a real host object (`ExtensionAPI`/`ExtensionCommandContext`)
 * into the structural `TimerScheduler` this module depends on, and the only
 * place that constructs the production `omp-task` adapter Stage 4 dispatches
 * against — this module only ever sees `NodeExecutionAdapter`'s public
 * `adapterId` tag, never a concrete adapter implementation.
 */

import type { ActiveBatchRegistration, ActiveExecutionBatch, NodeExecutionAdapter, NodeExecutionOutcome, OperatorCommandOutcome } from './runtime-types.js';
import { STAGE7_BINDINGS } from './stage7/bindings.js';

// ---------------------------------------------------------------------------
// Timer scheduling seam
// ---------------------------------------------------------------------------

/**
 * Structural subset of a "finite timeout" primitive. Deliberately narrower
 * than `globalThis.setTimeout`/`clearTimeout` (no `unref`, no interval) so a
 * real host `ExtensionContext`'s managed `ctx.setTimeout`/`ctx.clearTimer`
 * helpers (added in OMP so a throwing scheduled callback is reported through
 * the extension error channel instead of crashing the process) can satisfy
 * this interface without adaptation, while a plain Node fallback and a
 * deterministic test fake can too.
 */
export interface TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

/** Default scheduler: real, unmanaged `setTimeout`/`clearTimeout`. Safe to
 * use as-is because every callback that ever reaches it is already wrapped
 * by `ExtensionTaskSupervisor` before being handed to `setTimeout`. */
export class NodeTimerScheduler implements TimerScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown {
    return globalThis.setTimeout(callback, Math.max(0, delayMs));
  }

  clearTimer(handle: unknown): void {
    globalThis.clearTimeout(handle as NodeJS.Timeout);
  }
}

/**
 * Feature-detects a host-provided timer pair (e.g. a real OMP
 * `ExtensionContext`'s `ctx.setTimeout`/`ctx.clearTimer`) on an arbitrary
 * object and adapts it to `TimerScheduler`. Falls back to
 * `NodeTimerScheduler` when the host does not expose both methods, so
 * callers never need to branch on host shape themselves.
 */
export function adaptHostTimerScheduler(host: unknown): TimerScheduler {
  const candidate = host as { setTimeout?: unknown; clearTimer?: unknown } | null | undefined;
  if (candidate && typeof candidate.setTimeout === 'function' && typeof candidate.clearTimer === 'function') {
    const setTimeoutFn = candidate.setTimeout as (callback: () => void, delayMs: number) => unknown;
    const clearTimerFn = candidate.clearTimer as (handle: unknown) => void;
    return {
      setTimeout: (callback, delayMs) => setTimeoutFn.call(candidate, callback, delayMs),
      clearTimer: (handle) => clearTimerFn.call(candidate, handle),
    };
  }
  return new NodeTimerScheduler();
}

// ---------------------------------------------------------------------------
// ExtensionTaskSupervisor
// ---------------------------------------------------------------------------

/** A single unhandled failure surfaced by the supervisor. `stage` is an
 * opaque, human-readable label identifying which supervised job or timer
 * produced it — never a reasoning trace or raw agent output. */
export interface SupervisedFailure {
  readonly stage: string;
  readonly error: unknown;
}

export interface ExtensionTaskSupervisorDeps {
  /** Bounded, user-facing/diagnostic error reporting. MUST NOT throw; if it
   * does, the supervisor swallows that too rather than let it escape. */
  readonly onUnhandledFailure?: (failure: SupervisedFailure) => void;
}

export interface SupervisedRunResult<T> {
  readonly ok: boolean;
  readonly value?: T;
}

/** A live, cancellable scheduled timeout. `cancel()` is idempotent and a
 * no-op once the timer has already fired. */
export interface ScheduledTimeout {
  cancel(): void;
}

/**
 * Runs async work with the guarantee that the returned promise never
 * rejects and no scheduled timer callback can escape as an unhandled
 * rejection or a process-fatal throw. This is the mechanism, not the
 * policy: it has no knowledge of batches, sessions, or the store.
 */
export class ExtensionTaskSupervisor {
  readonly #onUnhandledFailure: (failure: SupervisedFailure) => void;

  constructor(deps: ExtensionTaskSupervisorDeps = {}) {
    this.#onUnhandledFailure = deps.onUnhandledFailure ?? (() => {});
  }

  /**
   * Runs `job()` to completion. If `job` throws/rejects, the error is
   * reported (never re-thrown) and the returned result is `{ ok: false }`.
   * `cleanup`, when given, always runs afterward (a `finally`) regardless
   * of `job`'s outcome; a throwing `cleanup` is reported the same way and
   * never prevents the returned promise from resolving.
   */
  async run<T>(stage: string, job: () => Promise<T>, cleanup?: () => Promise<void>): Promise<SupervisedRunResult<T>> {
    let outcome: SupervisedRunResult<T>;
    try {
      const value = await job();
      outcome = { ok: true, value };
    } catch (error) {
      this.#reportFailure(stage, error);
      outcome = { ok: false };
    }
    if (cleanup) {
      try {
        await cleanup();
      } catch (error) {
        this.#reportFailure(`${stage}:cleanup`, error);
      }
    }
    return outcome;
  }

  /**
   * Node's maximum signed 32-bit `setTimeout` delay (~24.8 days). Any
   * `TimerScheduler` — including a real `NodeTimerScheduler` — is only ever
   * asked to honor a delay within this bound: `scheduleTimeout` clamps
   * before calling `scheduler.setTimeout`, so no scheduler implementation
   * has to defend against a `TimeoutOverflowWarning`-class value itself.
   */
  static readonly MAX_TIMER_DELAY_MS = 2_147_483_647;

  /**
   * Schedules `callback` at most once, `delayMs` from now, through
   * `scheduler`. The callback is wrapped exactly like `run()`'s `job`: a
   * throw/rejection is reported, never escapes as an unhandled rejection.
   * Returns a handle whose idempotent `cancel()` clears the timer if it has
   * not fired yet; calling `cancel()` after firing (or twice) is a no-op.
   *
   * `delayMs` is bounded before ever reaching `scheduler`: a non-finite
   * value (an unparseable deadline) or a negative one (an already-past
   * deadline) is treated as `0` — dispatched immediately, but still through
   * this same supervised, scheduler-mediated path, never synchronously
   * inline — and a finite value longer than `MAX_TIMER_DELAY_MS` is clamped
   * to it.
   */
  scheduleTimeout(stage: string, scheduler: TimerScheduler, delayMs: number, callback: () => void | Promise<void>): ScheduledTimeout {
    let fired = false;
    let cancelled = false;
    const boundedDelayMs = Number.isFinite(delayMs) ? Math.min(Math.max(delayMs, 0), ExtensionTaskSupervisor.MAX_TIMER_DELAY_MS) : 0;
    const handle = scheduler.setTimeout(() => {
      if (cancelled) return;
      fired = true;
      Promise.resolve()
        .then(() => callback())
        .catch((error: unknown) => this.#reportFailure(stage, error));
    }, boundedDelayMs);
    return {
      cancel: () => {
        if (fired || cancelled) return;
        cancelled = true;
        try {
          scheduler.clearTimer(handle);
        } catch (error) {
          this.#reportFailure(`${stage}:clear`, error);
        }
      },
    };
  }

  #reportFailure(stage: string, error: unknown): void {
    try {
      this.#onUnhandledFailure({ stage, error });
    } catch {
      // Terminal: a failure reporter that itself throws must never escape.
    }
  }
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/** Thrown synchronously by `assertProductionAdapter` when a wiring path
 * that must never use the deterministic mock adapter receives one anyway.
 * Never thrown by `ExecutionCoordinator` itself (registration failures are
 * reported, not thrown — see `registerActiveBatch`). */
export class ProductionMockAdapterRefusedError extends Error {
  constructor() {
    super(
      'Refusing to wire the deterministic mock NodeExecutionAdapter into production execution. ' +
        'The mock adapter is a test-only fixture; production wiring must construct the omp-task adapter.',
    );
    this.name = 'ProductionMockAdapterRefusedError';
  }
}

/** Reported (never thrown) by `ExecutionCoordinator.registerActiveBatch`
 * when the same `(operatorSessionId, batchId)` pair is registered twice.
 * `OperatorRuntime` is the real guard against concurrent dispatch for a
 * session (it refuses to launch a second batch while one is active); this
 * is a defense-in-depth invariant so a violation upstream is surfaced
 * through `onUnhandledFailure` instead of silently losing supervision of
 * one of the two batches. */
export class DuplicateBatchRegistrationError extends Error {
  constructor(
    readonly operatorSessionId: string,
    readonly batchId: string,
  ) {
    super(`Batch "${batchId}" for operator session "${operatorSessionId}" is already registered with the execution coordinator.`);
    this.name = 'DuplicateBatchRegistrationError';
  }
}

/**
 * Rejects any `NodeExecutionAdapter` whose `adapterId` is `'mock'` unless
 * `allowMockAdapter` is explicitly `true` (set only by test wiring — see
 * `tests/execution-coordinator.test.ts`). Call this once, synchronously, at
 * the point production dependencies are assembled (`extension/index.ts`),
 * before the adapter is ever passed to `createOperatorRuntime`.
 */
export class UnsupportedProductionAdapterIdError extends Error {
  constructor(adapterId: string) {
    super(`Adapter id "${adapterId}" is not an approved production fixed-purpose identity.`);
    this.name = 'UnsupportedProductionAdapterIdError';
  }
}

const APPROVED_PRODUCTION_ADAPTER_IDS = new Set<string>(['omp-task', 'external-cli', ...STAGE7_BINDINGS.map((binding) => binding.adapterId)]);

export function assertProductionAdapter(adapter: { readonly adapterId: string }, allowMockAdapter = false): void {
  if (adapter.adapterId === 'mock' && !allowMockAdapter) throw new ProductionMockAdapterRefusedError();
  if (adapter.adapterId === 'mock') return;
  if (!APPROVED_PRODUCTION_ADAPTER_IDS.has(adapter.adapterId)) throw new UnsupportedProductionAdapterIdError(adapter.adapterId);
}

// ---------------------------------------------------------------------------
// ExecutionCoordinator
// ---------------------------------------------------------------------------

/** The narrow structural subset of `OperatorRuntime` the coordinator calls
 * back into. Defined locally (rather than imported) so this module never
 * depends on `controller.ts`; any object with these four methods —
 * including a real `OperatorRuntime` instance — satisfies it structurally. */
export interface ExecutionCoordinatorRuntime {
  getActiveBatch(operatorSessionId: string): ActiveExecutionBatch | undefined;
  completeBatch(operatorSessionId: string, batchId: string, outcomes: readonly NodeExecutionOutcome[]): Promise<OperatorCommandOutcome>;
  timeoutBatch(operatorSessionId: string, batchId: string): Promise<OperatorCommandOutcome>;
  shutdownActive(): Promise<void>;
}

export interface ExecutionCoordinatorDeps {
  readonly runtime: ExecutionCoordinatorRuntime;
  /** Defaults to `NodeTimerScheduler`. `extension/index.ts` calls
   * `setScheduler` with a host-adapted scheduler before each command
   * invocation that might register a batch, so a real per-invocation host
   * timer is used when available without this module ever importing an
   * OMP SDK type. */
  readonly scheduler?: TimerScheduler;
  /** Bounded, user-facing/diagnostic error reporting for every failure this
   * coordinator's supervised work can produce (batch completion, its
   * cleanup step, timeout dispatch, or a duplicate registration). MUST NOT
   * throw. */
  readonly onUnhandledFailure?: (failure: SupervisedFailure) => void;
}

/**
 * Extension-owned, in-memory registry of active execution batches. See the
 * module docstring for the full lifecycle. Holds no reference to the
 * store, clock, or id factory: every persisted state transition happens
 * inside `runtime.completeBatch`/`runtime.timeoutBatch`/`runtime.shutdownActive`,
 * which own the bounded reload/recheck/reducer/CAS helper Stage 4 requires
 * for every mutating path.
 */
export class ExecutionCoordinator {
  readonly #runtime: ExecutionCoordinatorRuntime;
  readonly #supervisor: ExtensionTaskSupervisor;
  #scheduler: TimerScheduler;
  readonly #pending = new Map<string, Promise<SupervisedRunResult<void>>>();

  constructor(deps: ExecutionCoordinatorDeps) {
    this.#runtime = deps.runtime;
    this.#scheduler = deps.scheduler ?? new NodeTimerScheduler();
    this.#supervisor = new ExtensionTaskSupervisor(
      deps.onUnhandledFailure !== undefined ? { onUnhandledFailure: deps.onUnhandledFailure } : {},
    );
  }

  /** Swaps the scheduler used by every timeout registered *after* this
   * call. Already-scheduled timers keep using whatever scheduler was
   * active when they were created. Safe to call before every command
   * invocation with a freshly host-adapted scheduler (see
   * `adaptHostTimerScheduler`); falls back to whatever was passed in
   * construction (or `NodeTimerScheduler`) if never called. */
  setScheduler(scheduler: TimerScheduler): void {
    this.#scheduler = scheduler;
  }

  /** `true` while a batch for `(operatorSessionId, batchId)` is still being
   * supervised (its completion has not yet fully settled, including
   * cleanup). Read-only; never mutates coordinator state. */
  isPending(operatorSessionId: string, batchId: string): boolean {
    return this.#pending.has(`${operatorSessionId}:${batchId}`);
  }

  /** How many batches this coordinator is currently supervising. Read-only. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Registers a just-launched batch for supervision (`ActiveBatchRegistrar`).
   * Called synchronously by `OperatorRuntime` right after
   * `adapter.launchBatch()` succeeds and `RUNNING` state has already been
   * persisted — never called by this coordinator itself, and never
   * triggers a redispatch. Never throws: a duplicate
   * `(operatorSessionId, batchId)` registration is reported through
   * `onUnhandledFailure` and otherwise ignored (the original
   * registration's supervision continues untouched).
   */
  registerActiveBatch(registration: ActiveBatchRegistration): void {
    const { operatorSessionId, batch, earliestTimeoutAt } = registration;
    const key = `${operatorSessionId}:${batch.batchId}`;

    if (this.#pending.has(key)) {
      void this.#supervisor.run(`execution-coordinator:${key}:duplicate-registration`, async () => {
        throw new DuplicateBatchRegistrationError(operatorSessionId, batch.batchId);
      });
      return;
    }

    const stage = `execution-coordinator:${key}`;
    let timeoutHandle: ScheduledTimeout | undefined;

    const completion = this.#supervisor.run(
      stage,
      async () => {
        const outcomes = await batch.completion;
        await this.#runtime.completeBatch(operatorSessionId, batch.batchId, outcomes);
      },
      async () => {
        timeoutHandle?.cancel();
        this.#pending.delete(key);
      },
    );
    this.#pending.set(key, completion);

    const delayMs = Date.parse(earliestTimeoutAt) - Date.now();
    timeoutHandle = this.#supervisor.scheduleTimeout(`${stage}:timeout`, this.#scheduler, delayMs, async () => {
      await this.#runtime.timeoutBatch(operatorSessionId, batch.batchId);
    });
  }

  /**
   * Extension shutdown (`session_shutdown`). Aborts every active batch
   * through `runtime.shutdownActive()` first, then awaits every
   * outstanding supervised completion (including its cleanup step) via
   * `Promise.allSettled` before returning — never leaves a batch, a child
   * session, or a raw detached promise running past this call.
   */
  async shutdown(): Promise<void> {
    await this.#supervisor.run('execution-coordinator:shutdown:abort-active', async () => {
      await this.#runtime.shutdownActive();
    });
    await Promise.allSettled([...this.#pending.values()]);
  }
}

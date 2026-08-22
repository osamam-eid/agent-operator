/**
 * Agent Operator — session journal.
 *
 * A single pure function for appending a compact journal event to an
 * `OperatorSession`. No I/O, no validation, no store dependency: `store.ts`
 * re-exports it alongside the session stores.
 *
 * Stage 4: real asynchronous completion makes two persisted transitions
 * landing at the same millisecond unsafe (the store's compare-and-swap
 * token is `session.updatedAt`; equal tokens across two writes would let a
 * later write silently believe it was racing an earlier one it never saw).
 * `appendJournal` is the single choke point every transition in `state.ts`
 * goes through, so it is also the single place that enforces
 * `session.updatedAt` strictly advances on every append:
 *
 *   nextUpdatedAt = max(entry.timestamp, previousUpdatedAt + 1ms)
 *
 * `entry.timestamp` (the caller-supplied "when this happened", normally
 * `clock.now()`) is preserved on the journal entry exactly as given — only
 * `session.updatedAt`, the CAS token, is advanced. Two appends in the same
 * reducer call that pass the same `now` therefore still produce two
 * strictly increasing `updatedAt` values.
 */

import type { FallbackDecision, JournalEntry, OperatorSession } from './contracts.js';

const ONE_MILLISECOND = 1;

/** `max(candidate, previous + 1ms)`, expressed as ISO-8601 strings. Falls
 * back to `candidate` if either timestamp fails to parse (defensive; every
 * caller in this package only ever passes validator-checked timestamps). */
function advanceTimestamp(previousUpdatedAt: string, candidate: string): string {
  const previousMs = Date.parse(previousUpdatedAt);
  const candidateMs = Date.parse(candidate);
  if (Number.isNaN(previousMs) || Number.isNaN(candidateMs)) {
    return candidate;
  }
  const nextMs = Math.max(candidateMs, previousMs + ONE_MILLISECOND);
  return new Date(nextMs).toISOString();
}

/**
 * Immutably appends `entry` to `session.journal` and advances
 * `session.updatedAt` to `max(entry.timestamp, session.updatedAt + 1ms)`.
 * Never mutates `session` or its prior `journal` array; always returns a
 * new `OperatorSession`.
 */
export function appendJournal(session: OperatorSession, entry: JournalEntry): OperatorSession {
  return {
    ...session,
    journal: [...session.journal, entry],
    updatedAt: advanceTimestamp(session.updatedAt, entry.timestamp),
  };
}

/** Record a provider fallback at dispatch time, after the selected provider is known. */
export function appendFallbackDecision(session: OperatorSession, decision: FallbackDecision, timestamp: string): OperatorSession {
  return appendJournal(session, {
    timestamp,
    eventType: 'PROVIDER_FALLBACK_SELECTED',
    operatorSessionId: session.operatorSessionId,
    reasonCode: decision.reasonCode,
    message: `${decision.role}: dispatched from ${decision.from} to ${decision.to}.`,
  });
}

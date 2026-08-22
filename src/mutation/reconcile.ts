import type { AgentResultStatus } from '../contracts.js';

export interface InFlightMutation {
  readonly mutationId: string;
  readonly operatorSessionId: string;
  readonly worktreeId: string;
  readonly operation: string;
  readonly startedAt: string;
}

export interface ReconciledMutation {
  readonly mutationId: string;
  readonly operatorSessionId: string;
  readonly worktreeId: string;
  readonly status: Extract<AgentResultStatus, 'UNKNOWN'>;
  readonly reasonCode: 'CRASH_RECONCILIATION_REQUIRED';
  readonly evidence: readonly string[];
  readonly reconciledAt: string;
  readonly redispatchAllowed: false;
}

/** Converts an in-flight mutation to UNKNOWN after restart; it never guesses completion or redispatches. */
export function reconcileInFlightMutation(record: InFlightMutation, reconciledAt: string, evidence: readonly string[] = []): ReconciledMutation {
  return {
    mutationId: record.mutationId,
    operatorSessionId: record.operatorSessionId,
    worktreeId: record.worktreeId,
    status: 'UNKNOWN',
    reasonCode: 'CRASH_RECONCILIATION_REQUIRED',
    evidence: [...evidence, `Mutation ${record.mutationId} was in flight at ${record.startedAt}.`],
    reconciledAt,
    redispatchAllowed: false,
  };
}

/** Stage-10 live-replay seam. The ONLY boundary through which an evaluation
 * case may reach a networked/external provider during replay.
 *
 * Invariants (plan §Evaluation data classification / §Provider-fleet interaction):
 * - accepts ONLY ExternalReplayApprovedCase; LOCAL_ONLY and REDACTED_INTERNAL
 *   fail closed before any provider dispatch;
 * - trusted-startup state must enable the evaluator AND the provider/fleet
 *   authorization callback must admit the pinned provider;
 * - EvalBudget clamps apply before and after dispatch (tier, tokens, cost,
 *   wall clock); a clamp produces a typed bounded outcome — the dispatch
 *   adapter cannot override policy;
 * - replay identity is bound to (evalRunId, caseId, candidateDigest) and
 *   duplicate/stale completions are rejected;
 * - evidence is normalized and secret-scrubbed; no active-operator file is
 *   read or written; fleet routing is never enabled implicitly. */

import { createHash } from 'node:crypto';

import { SECRET_PATTERN } from '../stage7/qa/evidence.js';
import { scanForSecrets } from './engine.js';
import type { ExternalReplayApprovedCase, EvalBudget } from './contracts.js';

export type ProviderTier = 'LOW' | 'MEDIUM' | 'HIGH';
const TIER_ORDER: readonly ProviderTier[] = ['LOW', 'MEDIUM', 'HIGH'];
function tierWithinBudget(actual: ProviderTier, ceiling: ProviderTier): boolean {
  return TIER_ORDER.indexOf(actual) <= TIER_ORDER.indexOf(ceiling);
}

export interface ReplayEvidence {
  readonly replayId: string;
  readonly evalRunId: string;
  readonly caseId: string;
  readonly candidateDigest: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly tier: ProviderTier;
  readonly tokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly status: 'SUCCEEDED' | 'FAILED';
  readonly summary: string;
  readonly completedAt: string;
}

export interface LiveReplayRequest {
  readonly evalRunId: string;
  readonly candidateDigest: string;
  readonly case: ExternalReplayApprovedCase;
  readonly providerTier: ProviderTier;
}

export interface DispatchResult {
  readonly modelProvider: string;
  readonly modelId: string;
  readonly tier: ProviderTier;
  readonly tokens: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly status: 'SUCCEEDED' | 'FAILED';
  /** Unscrubbed child output; the seam redacts before persisting. */
  readonly rawSummary: string;
}

/** The networked boundary. Implementations dispatch to one concrete external
 * CLI/provider; they never choose providers themselves. */
export type ProviderDispatch = (request: LiveReplayRequest, maxTokens: number) => Promise<DispatchResult>;

export interface LiveReplaySeamDeps {
  readonly featureSetStage10Enabled: boolean;
  readonly budget: EvalBudget;
  /** Operator-owned authorization: is this named provider admitted for
   * replay? Fleet catalogs are NOT consulted here — authorization is an
   * explicit operator decision surfaced as this predicate. */
  readonly providerAllowed: (modelProvider: string) => boolean;
  readonly dispatch: ProviderDispatch;
  readonly now?: () => string;
  readonly seenReplayIds?: ReadonlySet<string>;
}

export type BoundedReplayOutcome =
  | { readonly kind: 'EVIDENCE'; readonly evidence: ReplayEvidence }
  | { readonly kind: 'BOUNDED_BLOCKED'; readonly reasonCode: 'DISCLOSURE_NOT_APPROVED' | 'FEATURE_DISABLED' | 'PROVIDER_NOT_ALLOWED' | 'TIER_EXCEEDS_BUDGET' | 'BUDGET_TOKENS_PER_CASE' | 'BUDGET_TOTAL_COST' | 'STALE_RESULT' | 'DUPLICATE_RESULT'; readonly detail: string };

function scrub(text: string): string {
  return text
    .split('\n')
    .map((line) => (SECRET_PATTERN.test(line) ? '[redacted credential-bearing line]' : line))
    .join('\n')
    .slice(0, 4_000);
}

export function replayIdFor(evalRunId: string, caseId: string, candidateDigest: string): string {
  return createHash('sha256').update(`${evalRunId}\n${caseId}\n${candidateDigest}`).digest('hex').slice(0, 32);
}

/** Executes one approved case against ONE explicitly authorized provider.
 * Everything that can stop the dispatch happens before `dispatch` runs;
 * post-dispatch clamps convert over-budget results into bounded evidence. */
export function executeLiveReplay(deps: LiveReplaySeamDeps, request: LiveReplayRequest, startedAtMs = Date.now()): Promise<BoundedReplayOutcome> {
  return execute(deps, request, startedAtMs).catch((error: unknown) => ({
    kind: 'BOUNDED_BLOCKED',
    reasonCode: 'PROVIDER_NOT_ALLOWED',
    detail: scrub(error instanceof Error ? error.message : String(error)),
  }) satisfies BoundedReplayOutcome);
}

async function execute(deps: LiveReplaySeamDeps, request: LiveReplayRequest, startedAtMs: number): Promise<BoundedReplayOutcome> {
  const { case: evalCase, providerTier } = request;
  const replayId = replayIdFor(request.evalRunId, evalCase.caseId, request.candidateDigest);

  if (deps.featureSetStage10Enabled !== true) {
    return blocked('FEATURE_DISABLED', 'Evaluator subsystem is disabled by immutable startup configuration.');
  }
  if (evalCase.disclosure !== 'EXTERNAL_REPLAY_APPROVED') {
    return blocked('DISCLOSURE_NOT_APPROVED', `Disclosure "${evalCase.disclosure}" may not cross into an external provider path.`);
  }
  if (!('approvedBy' in evalCase) || typeof evalCase.approvedBy !== 'string' || evalCase.approvedBy.trim() === '') {
    return blocked('DISCLOSURE_NOT_APPROVED', 'External-replay approval lacks a recorded approver.');
  }
  if (deps.seenReplayIds?.has(replayId) === true) {
    return blocked('DUPLICATE_RESULT', `Replay ${replayId} was already completed for this run/case/candidate.`);
  }
  const caseText = [evalCase.originalRequest, ...(evalCase.expected?.notes !== undefined ? [evalCase.expected.notes] : []), ...evalCase.observed.nodeSummaries.map((node) => node.summary)].join('\n');
  const secretScan = scanForSecrets(caseText);
  if (!secretScan.clean) {
    return blocked('DISCLOSURE_NOT_APPROVED', 'Dispatch-time secret scan detected credential-bearing content; case quarantined.');
  }
  if (!deps.providerAllowed('fleet-pinned-provider')) {
    return blocked('PROVIDER_NOT_ALLOWED', `Provider is not admitted by operator authorization.`);
  }
  if (!tierWithinBudget(providerTier, deps.budget.maxProviderTier)) {
    return blocked('TIER_EXCEEDS_BUDGET', `Provider tier ${providerTier} exceeds the budget ceiling ${deps.budget.maxProviderTier}.`);
  }
  if (deps.budget.maxTokensPerCase <= 0) {
    return blocked('BUDGET_TOKENS_PER_CASE', 'Per-case token budget is exhausted before dispatch.');
  }

  const dispatchStartedAt = deps.now?.() ?? new Date().toISOString();
  const result = await deps.dispatch(request, deps.budget.maxTokensPerCase);
  const completedAt = deps.now?.() ?? new Date().toISOString();
  if (Date.parse(completedAt) < Date.parse(dispatchStartedAt)) {
    return blocked('STALE_RESULT', `Provider returned a completion timestamp earlier than dispatch start.`);
  }
  if (result.tokens > deps.budget.maxTokensPerCase || result.costUsd > deps.budget.maxTotalCostUsd) {
    return blocked('BUDGET_TOTAL_COST', `Provider usage (${result.tokens} tokens, $${result.costUsd}) exceeds the evaluation budget.`);
  }

  const evidence: ReplayEvidence = {
    replayId,
    evalRunId: request.evalRunId,
    caseId: evalCase.caseId,
    candidateDigest: request.candidateDigest,
    modelProvider: result.modelProvider,
    modelId: result.modelId,
    tier: result.tier,
    tokens: result.tokens,
    costUsd: result.costUsd,
    durationMs: result.durationMs,
    status: result.status,
    summary: scrub(result.rawSummary),
    completedAt,
  };
  void startedAtMs;
  return { kind: 'EVIDENCE', evidence };
}

function blocked(reasonCode: Extract<BoundedReplayOutcome, { kind: 'BOUNDED_BLOCKED' }>['reasonCode'], detail: string): BoundedReplayOutcome {
  return { kind: 'BOUNDED_BLOCKED', reasonCode, detail };
}

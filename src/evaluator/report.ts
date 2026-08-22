/** Stage-10 evidence-package builder. Deterministic: identical inputs always
 * produce a byte-identical report (sorted keys/arrays, fixed section order)
 * with a SHA-256 package hash. It never invents missing evidence — absent
 * optional sections are recorded as `"absent"` — and it never converts an
 * UNKNOWN outcome into a PASS. Promotion remains a recommendation only:
 * `promotedBySystem` is always false. */

import { createHash } from 'node:crypto';

import type {
  EvalBudget, MutationAllowlist, OperatorCandidateManifest, OperatorComparison,
  OperatorEvalCorpus, OperatorEvalRun, OperatorPromotionDecision, ScoringSpec,
} from './contracts.js';
import type { ReplayEvidence } from './live-replay.js';

export interface Stage10ReportInput {
  readonly baselineDigest: string;
  readonly featureSetHash: string;
  readonly corpus?: OperatorEvalCorpus;
  readonly candidate?: OperatorCandidateManifest;
  readonly candidateBundleDigest?: string;
  readonly allowlist?: MutationAllowlist;
  readonly scoringSpec?: ScoringSpec;
  readonly hardGateSpec?: { readonly specHash: string; readonly gates: readonly string[] };
  readonly budget?: EvalBudget;
  readonly usage?: { readonly tokens: number; readonly costUsd: number; readonly durationMs: number; readonly externalReplays: number };
  readonly runs?: readonly OperatorEvalRun[];
  readonly replayEvidence?: readonly ReplayEvidence[];
  readonly comparison?: OperatorComparison;
  readonly promotionDecision?: OperatorPromotionDecision;
  readonly unresolvedFindings?: readonly string[];
  readonly actionsNotPerformed?: readonly string[];
}

export interface Stage10Report {
  readonly reportVersion: 'stage10-evidence-package.v1';
  readonly generatedAt: string;
  readonly baselineDigest: string;
  readonly featureSetHash: string;
  readonly sections: {
    readonly corpus: Record<string, unknown> | 'absent';
    readonly candidate: Record<string, unknown> | 'absent';
    readonly allowlist: Record<string, unknown> | 'absent';
    readonly scoringSpec: Record<string, unknown> | 'absent';
    readonly hardGateSpec: Record<string, unknown> | 'absent';
    readonly budgetAndUsage: Record<string, unknown> | 'absent';
    readonly runs: readonly unknown[] | 'absent';
    readonly replayEvidence: readonly ReplayEvidence[] | 'absent';
    readonly comparison: Record<string, unknown> | 'absent';
    readonly disclosureDecisions: readonly string[];
    readonly providerModelUsage: readonly string[];
    readonly totals: { readonly tokens: number; readonly costUsd: number; readonly durationMs: number } | 'absent';
    readonly promotionRecommendation: Record<string, unknown> | 'absent';
    readonly unresolvedFindings: readonly string[];
    readonly actionsNotPerformed: readonly string[];
  };
  readonly verdictConsistency: {
    readonly comparisonVerdict: string | 'absent';
    readonly recommendationMatchesComparison: boolean | 'absent';
    readonly hardFailureHiddenBehindScore: boolean;
    readonly selfPromotionPossible: boolean;
  };
  readonly packageSha256: string;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortDeep(entry)]));
  }
  return value;
}

/** Builds the deterministic evidence package. Absent optional inputs are
 * recorded verbatim as "absent" — never synthesized. */
export function buildStage10Report(input: Stage10ReportInput, generatedAt: string): Stage10Report {
  const sections: Stage10Report['sections'] = {
    corpus: input.corpus === undefined ? 'absent' : JSON.parse(canonical(input.corpus)) as Record<string, unknown>,
    candidate: input.candidate === undefined || input.candidateBundleDigest === undefined ? 'absent' : { ...JSON.parse(canonical(input.candidate)) as Record<string, unknown>, bundleDigest: input.candidateBundleDigest },
    allowlist: input.allowlist === undefined ? 'absent' : JSON.parse(canonical(input.allowlist)) as Record<string, unknown>,
    scoringSpec: input.scoringSpec === undefined ? 'absent' : { ...JSON.parse(canonical(input.scoringSpec)) as Record<string, unknown>, specHash: input.scoringSpec.specHash },
    hardGateSpec: input.hardGateSpec === undefined ? 'absent' : JSON.parse(canonical(input.hardGateSpec)) as Record<string, unknown>,
    budgetAndUsage: input.budget === undefined || input.usage === undefined
      ? 'absent'
      : { budget: JSON.parse(canonical(input.budget)) as Record<string, unknown>, usage: JSON.parse(canonical(input.usage)) as Record<string, unknown> },
    runs: input.runs === undefined ? 'absent' : [...input.runs].map((run) => JSON.parse(canonical(run))),
    replayEvidence: input.replayEvidence === undefined ? 'absent' : [...input.replayEvidence].map((evidence) => JSON.parse(canonical(evidence))),
    comparison: input.comparison === undefined ? 'absent' : JSON.parse(canonical(input.comparison)) as Record<string, unknown>,
    disclosureDecisions: input.replayEvidence === undefined
      ? []
      : input.replayEvidence.map((evidence) => `${evidence.caseId}: EXTERNAL_REPLAY_APPROVED dispatched to ${evidence.modelProvider}/${evidence.modelId}`).sort(),
    providerModelUsage: input.replayEvidence === undefined
      ? []
      : [...new Set(input.replayEvidence.map((evidence) => `${evidence.modelProvider}/${evidence.modelId}`))].sort(),
    totals: input.usage === undefined ? 'absent' : { tokens: input.usage.tokens, costUsd: input.usage.costUsd, durationMs: input.usage.durationMs },
    promotionRecommendation: input.promotionDecision === undefined ? 'absent' : JSON.parse(canonical(input.promotionDecision)) as Record<string, unknown>,
    unresolvedFindings: [...(input.unresolvedFindings ?? [])].sort(),
    actionsNotPerformed: [...(input.actionsNotPerformed ?? ['installation', 'commit', 'push', 'merge', 'publication', 'deployment', 'active-Operator promotion', 'Stage-11 implementation'])].sort(),
  };

  const comparisonVerdict = input.comparison?.verdict ?? 'absent';
  const hardFailuresVisible = input.comparison !== undefined && Array.isArray(input.comparison.hardFailures) ? input.comparison.hardFailures.length > 0 : false;
  const verdictIsReject = input.comparison?.verdict === 'REJECT';

  const report: Omit<Stage10Report, 'packageSha256'> = {
    reportVersion: 'stage10-evidence-package.v1' as const,
    generatedAt,
    baselineDigest: input.baselineDigest,
    featureSetHash: input.featureSetHash,
    sections,
    verdictConsistency: {
      comparisonVerdict,
      recommendationMatchesComparison: input.promotionDecision === undefined || input.comparison === undefined
        ? 'absent'
        : input.promotionDecision.recommendation === input.comparison.verdict,
      hardFailureHiddenBehindScore: hardFailuresVisible && !verdictIsReject,
      selfPromotionPossible: false,
    },
  };

  const packageSha256 = createHash('sha256').update(canonical(report), 'utf8').digest('hex');
  return { ...report, packageSha256 };
}

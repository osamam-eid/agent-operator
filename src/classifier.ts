/**
 * Agent Operator — Stage 3 deterministic mock classifier.
 *
 * `createMockOperatorClassifier()` implements `OperatorClassifier` against a
 * fixed set of keyword fixtures only. There is no model or provider call:
 * every request is scored against literal, word-boundary phrase lists for
 * each of the nine V1 task families (plan section 6), and the classifier
 * abstains at `LOW` confidence whenever the signal is not unambiguous. This
 * is deliberately conservative — a real router may guess; this mock never
 * silently guesses on the caller's behalf. `compiler.ts` is responsible for
 * refusing to compile a workflow from an abstained classification.
 *
 * Explicit "just do this directly, skip the workflow" intent is detected
 * separately and takes priority over every other family: a user who names
 * bypass explicitly should never be routed into REVIEW because their
 * request also happened to mention the word "review".
 */

import type { RiskLevel, TaskFamily } from './contracts.js';
import type { ClassificationProposal, OperatorClassifier } from './stage3-types.js';

// ---------------------------------------------------------------------------
// Keyword fixtures
// ---------------------------------------------------------------------------

/** Non-DIRECT task families this classifier can resolve to. `DIRECT` is
 * handled by its own explicit-intent phrase list, never by scoring. */
type ScoredFamily = Exclude<TaskFamily, 'DIRECT'>;

const DIRECT_PHRASES: readonly string[] = [
  'skip the workflow',
  'skip workflow',
  'bypass the workflow',
  'bypass workflow',
  'no gate',
  'no approval needed',
  'direct mode',
  'just answer directly',
  'answer directly',
  'skip review',
  'skip planning',
  'override the workflow',
  'no workflow needed',
  'just do it',
  'do this directly',
];

const FAMILY_PHRASES: Readonly<Record<ScoredFamily, readonly string[]>> = {
  RESEARCH: ['research', 'investigate', 'look into', 'find out', 'survey the', 'explore options', 'compare options', 'what is the difference'],
  PLAN: ['plan', 'roadmap', 'break down the work', 'scope out', 'proposal for', 'planning session', 'sequence the work'],
  IMPLEMENT: ['implement', 'build the', 'write code', 'fix the bug', 'refactor', 'develop the', 'add a feature', 'code up'],
  REVIEW: ['review', 'code review', 'critique', 'audit the code', 'check my pr', 'evaluate the diff', 'pull request review'],
  UI: ['ui', 'user interface', 'frontend', 'front-end', 'design the interface', 'button layout', 'css', 'screen layout', 'component styling'],
  QA: ['qa', 'quality assurance', 'test this', 'verify the feature', 'acceptance criteria', 'run the tests', 'regression test'],
  SECURITY: ['security', 'vulnerability', 'pentest', 'exploit', 'cve', 'security review', 'audit for vulnerabilities', 'threat model'],
  OPERATIONS: ['deploy', 'deployment', 'operations', 'infra', 'provision', 'incident', 'rollback', 'on-call', 'runbook'],
};

/** Canonical, deterministic iteration order for tie-break and the
 * ambiguous-input fallback guess. Mirrors the `TaskFamily` declaration
 * order in contracts.ts, minus `DIRECT`. */
const FAMILY_ORDER: readonly ScoredFamily[] = ['RESEARCH', 'PLAN', 'IMPLEMENT', 'REVIEW', 'UI', 'QA', 'SECURITY', 'OPERATIONS'];

// ---------------------------------------------------------------------------
// Per-family conservative defaults
// ---------------------------------------------------------------------------

const RISK_BY_FAMILY: Readonly<Record<ScoredFamily, RiskLevel>> = {
  RESEARCH: 'LOW',
  PLAN: 'LOW',
  REVIEW: 'LOW',
  QA: 'MEDIUM',
  UI: 'MEDIUM',
  IMPLEMENT: 'HIGH',
  SECURITY: 'HIGH',
  OPERATIONS: 'CRITICAL',
};

const CAPABILITIES_BY_FAMILY: Readonly<Record<ScoredFamily, readonly string[]>> = {
  RESEARCH: ['research'],
  PLAN: ['planning'],
  IMPLEMENT: ['implementation'],
  REVIEW: ['code-review'],
  UI: ['ui-design', 'implementation'],
  QA: ['qa-verification'],
  SECURITY: ['security-review'],
  OPERATIONS: ['operations'],
};

type RequestedShape = NonNullable<ClassificationProposal['requestedExecutionShape']>;

const SHAPE_BY_FAMILY: Readonly<Record<ScoredFamily, RequestedShape>> = {
  RESEARCH: 'SINGLE',
  PLAN: 'SINGLE',
  IMPLEMENT: 'PIPELINE',
  REVIEW: 'PARALLEL',
  UI: 'PIPELINE',
  QA: 'SINGLE',
  SECURITY: 'SINGLE',
  OPERATIONS: 'PIPELINE',
};


/** Ambiguous-input fallback family: never used to drive a compile (the
 * `LOW` confidence + `abstentionReason` always stop the compiler first),
 * only kept so `requestClassification` is never left semantically empty. */
const AMBIGUOUS_FALLBACK_FAMILY: ScoredFamily = 'RESEARCH';

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function escapeRegExp(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Word-boundary containment so e.g. "plan" does not match inside "planet",
 * while still matching multi-word phrases verbatim. */
function phraseMatches(request: string, phrase: string): boolean {
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(phrase)}(?![a-z0-9])`, 'i');
  return pattern.test(request);
}

interface FamilyScore {
  readonly family: ScoredFamily;
  readonly matched: readonly string[];
}

// `scoreFamilies`/`matchedDirectPhrases` were inlined into `classify()` below:
// each had exactly one call site and a body that was a single filter/map
// expression, so a separate name added a jump with no durable contract.

// ---------------------------------------------------------------------------
// Public classifier
// ---------------------------------------------------------------------------

export function createMockOperatorClassifier(): OperatorClassifier {
  return {
    classify(request: string): ClassificationProposal {
      const normalized = request.trim();

      const directHits = DIRECT_PHRASES.filter((phrase) => phraseMatches(normalized, phrase));
      if (directHits.length > 0) {
        return {
          requestClassification: 'DIRECT',
          riskClassification: 'LOW',
          confidence: 'HIGH',
          decomposable: false,
          semanticCapabilities: [],
          requestedExecutionShape: 'DIRECT',
          rationale: `Matched explicit direct-intent phrase(s): ${directHits.join(', ')}. Direct/automatic bypass is outside the Stage 3 compiler.`,
        };
      }

      const scores: readonly FamilyScore[] = FAMILY_ORDER.map((family) => ({
        family,
        matched: FAMILY_PHRASES[family].filter((phrase) => phraseMatches(normalized, phrase)),
      }));
      const ranked = [...scores].sort((a, b) => b.matched.length - a.matched.length);
      const top = ranked[0];
      const second = ranked[1];
      const topCount = top?.matched.length ?? 0;
      const secondCount = second?.matched.length ?? 0;

      if (top === undefined || topCount === 0) {
        return {
          requestClassification: AMBIGUOUS_FALLBACK_FAMILY,
          riskClassification: 'MEDIUM',
          confidence: 'LOW',
          abstentionReason: 'No recognized task-family keyword fixture matched the request; classification abstained pending clarification.',
          decomposable: false,
          semanticCapabilities: [],
          rationale: 'No family-specific keyword phrases matched. Abstaining rather than guessing.',
        };
      }

      if (topCount === secondCount) {
        const tiedFamilies = ranked.filter((entry) => entry.matched.length === topCount).map((entry) => entry.family);
        return {
          requestClassification: tiedFamilies[0] ?? AMBIGUOUS_FALLBACK_FAMILY,
          riskClassification: 'MEDIUM',
          confidence: 'LOW',
          abstentionReason: `Request matched keyword phrases for multiple task families equally (${tiedFamilies.join(', ')}); classification abstained pending clarification.`,
          decomposable: false,
          semanticCapabilities: [],
          rationale: `Tied top score (${topCount}) between: ${tiedFamilies.map((f) => `${f}[${scores.find((s) => s.family === f)?.matched.join('/')}]`).join('; ')}.`,
        };
      }

      const family = top.family;
      const confidence = topCount >= 2 ? 'HIGH' : 'MEDIUM';
      return {
        requestClassification: family,
        riskClassification: RISK_BY_FAMILY[family],
        confidence,
        decomposable: true,
        semanticCapabilities: CAPABILITIES_BY_FAMILY[family],
        requestedExecutionShape: SHAPE_BY_FAMILY[family],
        rationale: `Matched ${family} keyword phrase(s): ${top.matched.join(', ')}.`,
      };
    },
  };
}

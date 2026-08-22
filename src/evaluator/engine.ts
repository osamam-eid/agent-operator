/** Stage-10 evaluator engine: disclosure scanning, budget enforcement,
 * harvesting, corpus construction with train/held-out isolation and an
 * adaptive-leakage cap, frozen scoring, hard-gate-precedent comparison, and
 * write-once candidate bundles verified against hash-bundle conventions. */

import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { SECRET_PATTERN } from '../stage7/qa/evidence.js';
import type {
  EvalBudget, EvalCase, EvalDisclosure, LocalOnlyEvalCase, HeldOutCaseId, TrainCaseId,
  MutationAllowlist, OperatorCandidateManifest, OperatorComparison, OperatorEvalCorpus,
  OperatorEvalRun, ScoringSpec, ComponentStatus, asHeldOut, asTrain,
} from './contracts.js';

// ---------------------------------------------------------------------------
// Disclosure scanning — automated secret hard floor.
// ---------------------------------------------------------------------------

export interface SecretScanResult { readonly clean: boolean; readonly detections: readonly string[] }

export function scanForSecrets(text: string): SecretScanResult {
  const lines = text.split('\n');
  const detections = lines.filter((line) => SECRET_PATTERN.test(line)).map((line) => line.trim().slice(0, 120));
  return { clean: detections.length === 0, detections };
}

export function caseText(caseContent: EvalCase): string {
  return [caseContent.originalRequest, ...(caseContent.expected?.notes ? [caseContent.expected.notes] : []), ...caseContent.observed.nodeSummaries.map((node) => node.summary)].join('\n');
}

/** Hard floor applied at curation-upgrade AND replay dispatch: a case that
 * fails the scan can never be typed ExternalReplayApprovedCase. */
export function assertCleanForExternalReplay(caseContent: EvalCase): void {
  const scan = scanForSecrets(caseText(caseContent));
  if (!scan.clean) throw new Error(`SECRET_DETECTED: ${JSON.stringify(scan.detections)}`);
}

// ---------------------------------------------------------------------------
export interface CaseScore {
  readonly caseId: string;
  readonly hardGateFailures: readonly string[];
  readonly softScores: Readonly<Record<string, number>>;
}
// Budget — every field required; fail closed on missing/invalid.
// ---------------------------------------------------------------------------

const TIERS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type ProviderTier = typeof TIERS[number];

export function validateBudget(raw: unknown): EvalBudget {
  const value = raw as Partial<EvalBudget>;
  const fail = (field: string): never => { throw new Error(`EvalBudget.${field} is required.`); };
  if (typeof value.maxCases !== 'number' || value.maxCases < 1) return fail('maxCases');
  if (typeof value.maxReplaysPerCase !== 'number' || value.maxReplaysPerCase < 1 || value.maxReplaysPerCase > 3) return fail('maxReplaysPerCase');
  if (value.maxProviderTier === undefined || !TIERS.includes(value.maxProviderTier)) return fail('maxProviderTier');
  if (typeof value.maxTokensPerCase !== 'number' || value.maxTokensPerCase < 1) return fail('maxTokensPerCase');
  if (typeof value.maxTotalCostUsd !== 'number' || value.maxTotalCostUsd < 0) return fail('maxTotalCostUsd');
  if (typeof value.maxWallClockMs !== 'number' || value.maxWallClockMs < 1) return fail('maxWallClockMs');
  if (typeof value.maxConcurrency !== 'number' || value.maxConcurrency < 1) return fail('maxConcurrency');
  return value as EvalBudget;
}

export function tierAtLeast(actual: ProviderTier, ceiling: ProviderTier): boolean {
  return TIERS.indexOf(actual) <= TIERS.indexOf(ceiling);
}

// ---------------------------------------------------------------------------
// Harvest — drafts are always LOCAL_ONLY and require human curation.
// ---------------------------------------------------------------------------

export interface SessionHarvestSource {
  listSessionIds(): Promise<readonly string[]>;
  load(operatorSessionId: string): Promise<unknown>;
}

export interface HarvestedDraft extends LocalOnlyEvalCase {
  readonly harvestedAt: string;
}

export async function harvestDrafts(source: SessionHarvestSource, maxSessions: number, now: () => string): Promise<readonly HarvestedDraft[]> {
  const ids = await source.listSessionIds();
  const drafts: HarvestedDraft[] = [];
  for (const sessionId of ids.slice(0, maxSessions)) {
    const record = await source.load(sessionId) as { session?: { originalRequest?: string; routeDecision?: { requestClassification?: string; riskClassification?: string; selectedWorkflow?: string }; humanDecisions?: readonly unknown[] }; nodeResultRefs?: Record<string, { summary?: string }>; gates?: readonly { decisionType?: string; optionSelected?: string }[] } | undefined;
    if (record?.session === undefined) continue;
    const summaries = Object.entries(record.nodeResultRefs ?? {}).map(([nodeId, ref]) => ({ nodeId, summary: ref.summary ?? '' }));
    drafts.push({
      caseId: `case-${sessionId}`,
      sourceSessionId: sessionId,
      originalRequest: record.session.originalRequest ?? '',
      observed: {
        requestClassification: record.session.routeDecision?.requestClassification ?? '',
        riskClassification: record.session.routeDecision?.riskClassification ?? '',
        selectedWorkflow: record.session.routeDecision?.selectedWorkflow ?? '',
        requiredGates: [],
        nodeSummaries: summaries,
        humanOverrideSignals: (record.gates ?? []).map((gate) => `${gate.decisionType ?? '?'}=${gate.optionSelected ?? '?'}`),
      },
      disclosure: 'LOCAL_ONLY',
      harvestedAt: now(),
    });
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Corpus — disjoint partitions, type-level isolation, leakage cap.
// ---------------------------------------------------------------------------

export const MAX_CAMPAIGNS_PER_CORPUS_REVISION = 3;

export function sha256Of(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildCorpus(corpusId: string, revision: number, createdAt: string, curated: readonly { caseId: string; disclosure: EvalDisclosure }[], heldOutCount: number): OperatorEvalCorpus {
  if (heldOutCount < 3 || heldOutCount * 5 < curated.length) throw new Error(`INSUFFICIENT_HELD_OUT: held-out=${heldOutCount}, total=${curated.length}.`);
  if (heldOutCount >= curated.length) throw new Error(`INSUFFICIENT_HELD_OUT: held-out partition must be strictly smaller than the corpus.`);
  const cases = curated.map((entry, index) => ({ ...entry, partition: index < heldOutCount ? ('HELD_OUT' as const) : ('TRAIN' as const) }));
  const trainIds = cases.filter((entry) => entry.partition === 'TRAIN').map((entry) => entry.caseId);
  const heldOutIds = cases.filter((entry) => entry.partition === 'HELD_OUT').map((entry) => entry.caseId);
  return {
    corpusId, revision, createdAt, cases,
    trainManifestHash: sha256Of(trainIds),
    heldOutManifestHash: sha256Of(heldOutIds),
  };
}

export function assertDisjoint(corpus: OperatorEvalCorpus): void {
  const train = new Set(corpus.cases.filter((entry) => entry.partition === 'TRAIN').map((entry) => entry.caseId));
  for (const entry of corpus.cases) {
    if (entry.partition === 'HELD_OUT' && train.has(entry.caseId)) throw new Error('ARTIFACT_TAMPERED: train/held-out overlap.');
  }
}

/** Generator input restriction: only train ids, branded, are representable. */
export function generatorInput(corpus: OperatorEvalCorpus): readonly TrainCaseId[] {
  return corpus.cases.filter((entry) => entry.partition === 'TRAIN').map((entry) => asTrainBrand(entry.caseId));
}
function asTrainBrand(id: string): TrainCaseId { return id as TrainCaseId; }
function asHeldOutBrand(id: string): HeldOutCaseId { return id as HeldOutCaseId; }
export { asHeldOutBrand };

// ---------------------------------------------------------------------------
// Candidate bundles — write-once, single verified loader, allowlist + clamp.
// ---------------------------------------------------------------------------

const PROHIBITED_COMPONENTS: readonly string[] = ['hardInvariants', 'permissionModel', 'humanApprovalRules', 'mutationClasses', 'providerTrustBoundaries', 'disclosureRules', 'publicationAuthority', 'promotionAuthority', 'evalTrustBoundaries'];

export function verifyCandidateBundle(dir: string): OperatorCandidateManifest {
  const manifestPath = join(dir, 'candidate.json');
  const stats = lstatSync(manifestPath);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('ARTIFACT_TAMPERED: candidate manifest is not a regular file.');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as OperatorCandidateManifest & { componentsStatusesSelfDeclared?: boolean };
  const recordedHash = readFileSync(join(dir, 'MANIFEST.sha256'), 'utf8').trim();
  const actual = bundleDigest(dir);
  if (recordedHash !== actual) throw new Error(`ARTIFACT_TAMPERED: candidate bundle digest mismatch (${recordedHash} != ${actual}).`);
  for (const component of manifest.components) {
    if ((PROHIBITED_COMPONENTS as readonly string[]).includes(component.component)) {
      throw new Error(`CANDIDATE_REJECTED: prohibited component "${component.component}" is present in the candidate (any status).`);
    }
  }
  return manifest;
}

function bundleDigest(dir: string): string {
  const hash = createHash('sha256');
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'MANIFEST.sha256') continue;
    const full = join(dir, entry);
    const stats = lstatSync(full);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('ARTIFACT_TAMPERED: candidate bundle contains a non-regular entry.');
    hash.update(entry);
    hash.update(readFileSync(full));
  }
  return hash.digest('hex');
}

export function writeCandidateBundle(dir: string, manifest: OperatorCandidateManifest, componentFiles: Readonly<Record<string, string>>): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(componentFiles)) writeFileSync(join(dir, name), content, { mode: 0o600 });
  writeFileSync(join(dir, 'candidate.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
  writeFileSync(join(dir, 'MANIFEST.sha256'), bundleDigest(dir), { mode: 0o600 });
}

/** Canonical digest of a VERIFIED candidate bundle (excludes MANIFEST.sha256).
 * Call verifyCandidateBundle first — this trusts the directory layout. */
export function candidateDigestFor(dir: string): string {
  return bundleDigest(dir);
}

/** Clamp: candidate-proposed tier/provider preferences may not exceed the run budget. */
export function clampTier(proposed: ProviderTier, budget: EvalBudget): ProviderTier {
  return tierAtLeast(proposed, budget.maxProviderTier) ? proposed : budget.maxProviderTier;
}

// ---------------------------------------------------------------------------
// Scoring + comparison — hard gates precede any weighting.
// ---------------------------------------------------------------------------

export function loadScoringSpec(spec: ScoringSpec): ScoringSpec {
  if (spec.specHash !== sha256Of({ hardGates: spec.hardGates, softWeights: spec.softWeights, tolerance: spec.tolerance })) {
    throw new Error('SCORING_SPEC_TAMPERED');
  }
  return spec;
}

export function softTotal(scores: CaseScore, spec: ScoringSpec): number {
  let total = 0;
  for (const [metric, weight] of Object.entries(spec.softWeights)) total += weight * (scores.softScores[metric] ?? 0);
  return total;
}

// ---------------------------------------------------------------------------
// Deterministic structural scoring — pure functions of the recorded case.
// ---------------------------------------------------------------------------

/** Hard gates this build can evaluate deterministically from recorded case
 * content alone (no provider call). A spec naming any other gate fails
 * closed: silently ignoring an unevaluatable gate would fake a pass. */
export const DETERMINISTIC_HARD_GATES: readonly string[] = ['expected-classification', 'expected-workflow', 'secret-free'];
export const DETERMINISTIC_SOFT_METRICS: readonly string[] = ['gateCoverage', 'summaryDepth'];

export function scoreCase(evalCase: EvalCase, spec: ScoringSpec): CaseScore {
  for (const gate of spec.hardGates) {
    if (!DETERMINISTIC_HARD_GATES.includes(gate)) throw new Error(`SCORING_SPEC_UNEVALUABLE: hard gate "${gate}" has no deterministic evaluator in this build.`);
  }
  for (const metric of Object.keys(spec.softWeights)) {
    if (!DETERMINISTIC_SOFT_METRICS.includes(metric)) throw new Error(`SCORING_SPEC_UNEVALUABLE: soft metric "${metric}" has no deterministic evaluator in this build.`);
  }
  const hardGateFailures: string[] = [];
  if (spec.hardGates.includes('expected-classification') && evalCase.expected?.requestClassification !== undefined && evalCase.expected.requestClassification !== evalCase.observed.requestClassification) {
    hardGateFailures.push('expected-classification');
  }
  if (spec.hardGates.includes('expected-workflow') && evalCase.expected?.selectedWorkflow !== undefined && evalCase.expected.selectedWorkflow !== evalCase.observed.selectedWorkflow) {
    hardGateFailures.push('expected-workflow');
  }
  if (spec.hardGates.includes('secret-free') && !scanForSecrets(caseText(evalCase)).clean) {
    hardGateFailures.push('secret-free');
  }
  const gates = evalCase.observed.requiredGates;
  const gateCoverage = gates.length === 0 ? 1 : gates.filter((gate) => gate.trim() !== '').length / gates.length;
  const summaryDepth = Math.min(1, evalCase.observed.nodeSummaries.length / 5);
  const softScores: Record<string, number> = {};
  if (spec.softWeights.gateCoverage !== undefined) softScores.gateCoverage = gateCoverage;
  if (spec.softWeights.summaryDepth !== undefined) softScores.summaryDepth = summaryDepth;
  return { caseId: evalCase.caseId, hardGateFailures, softScores };
}

export function compare(baselineScores: readonly (CaseScore & { readonly partition: 'TRAIN' | 'HELD_OUT' })[], candidateScores: readonly (CaseScore & { readonly partition: 'TRAIN' | 'HELD_OUT' })[], spec: ScoringSpec, run: OperatorEvalRun): OperatorComparison {
  const hardFailures = [...baselineScores, ...candidateScores].flatMap((score) => score.hardGateFailures.map((gate) => `${score.caseId}:${gate}`));
  if (hardFailures.length > 0) {
    return { runId: run.runId, verdict: 'REJECT', baselineTotal: -1, candidateTotal: -1, regressions: [], hardFailures, scoredCases: candidateScores.length };
  }
  const regressions: string[] = [];
  const byId = new Map(candidateScores.map((score) => [score.caseId, score]));
  let heldOutBaseline = 0;
  let heldOutCandidate = 0;
  let heldOutPairs = 0;
  for (const base of baselineScores) {
    const cand = byId.get(base.caseId);
    if (cand === undefined || cand.partition !== base.partition) continue;
    const baseScore = softTotal(base, spec);
    const candScore = softTotal(cand, spec);
    if (base.partition === 'HELD_OUT') {
      heldOutBaseline += baseScore;
      heldOutCandidate += candScore;
      heldOutPairs += 1;
    }
    for (const metric of Object.keys(spec.softWeights)) {
      if (base.softScores[metric] !== undefined && (cand.softScores[metric] ?? 0) < base.softScores[metric] - spec.tolerance) {
        regressions.push(`${base.caseId}:${metric}`);
      }
    }
  }
  let verdict: OperatorComparison['verdict'] = regressions.length > 0 ? 'REJECT' : 'INSUFFICIENT_EVIDENCE';
  if (verdict !== 'REJECT' && heldOutPairs > 0 && heldOutCandidate > heldOutBaseline) verdict = 'PROMOTE_RECOMMENDED';
  return { runId: run.runId, verdict, baselineTotal: heldOutBaseline, candidateTotal: heldOutCandidate, regressions, hardFailures, scoredCases: candidateScores.length };
}

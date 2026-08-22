/** Stage-10 evaluator command service. Dispatches `/operator improve …`
 * subcommands against the offline evaluation engine. Fail-closed on every
 * boundary: feature flag, secret scan, budget, tamper checks. */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OperatorCommandOutcome } from '../runtime-types.js';
import type { Stage7FeatureSet } from '../stage7/types.js';
import { MAX_CAMPAIGNS_PER_CORPUS_REVISION, assertDisjoint, buildCorpus, candidateDigestFor, caseText, compare as compareScores, generatorInput, harvestDrafts, loadScoringSpec, scanForSecrets, scoreCase, sha256Of, validateBudget, verifyCandidateBundle } from './engine.js';
import { SCORER_VERSION } from './contracts.js';
import type { BaselineScoresEnvelope, CandidateScoresEnvelope, EvalCase, OperatorEvalCorpus, OperatorEvalRun } from './contracts.js';
import type { HarvestedDraft } from './engine.js';

export interface EvaluatorServiceDeps {
  readonly store: { listSessionIds(): Promise<readonly string[]>; load(id: string): Promise<unknown> };
  readonly evaluatorDir: string;
  readonly featureSet: Stage7FeatureSet;
  readonly baselineDigest: string;
  /** Trusted candidate-execution boundary. The ONLY way candidate execution
   * evidence enters scoring: evaluate() runs it per corpus case and feeds
   * the result through the same deterministic scorer as the baseline.
   * Caller-authored score values are never accepted instead. */
  readonly executeCandidateCase?: (request: { readonly evalRunId: string; readonly attemptId: string; readonly evalCase: EvalCase }) => Promise<EvalCase>;
  readonly now?: () => string;
}

const SUBCOMMANDS: readonly string[] = ['status', 'harvest', 'corpus', 'evaluate', 'candidate', 'compare', 'generate'];

function ok(text: string): OperatorCommandOutcome { return { ok: true, text }; }
function fail(text: string, code: OperatorCommandOutcome extends never ? never : 'EVALUATOR_ERROR' | 'INVALID_COMMAND' | 'FEATURE_DISABLED'): OperatorCommandOutcome { return { ok: false, text, errorCode: code }; }

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 || args[index + 1] === undefined ? undefined : args[index + 1];
}

export function createEvaluatorHandler(deps: EvaluatorServiceDeps): (subcommand: string, args: readonly string[]) => Promise<OperatorCommandOutcome> {
  const now = deps.now ?? (() => new Date().toISOString());
  const draftsDir = join(deps.evaluatorDir, 'drafts');
  const corpusDir = join(deps.evaluatorDir, 'corpora');
  const candidatesDir = join(deps.evaluatorDir, 'candidates');
  const runsDir = join(deps.evaluatorDir, 'runs');

  function requireEnabled(): OperatorCommandOutcome | undefined {
    return deps.featureSet.stage10EvaluatorEnabled === true ? undefined : fail('The evaluator subsystem is disabled by immutable startup configuration.', 'FEATURE_DISABLED');
  }

  async function status(): Promise<OperatorCommandOutcome> {
    const drafts = existsSync(draftsDir) ? readdirSync(draftsDir) : [];
    const corpora = existsSync(corpusDir) ? readdirSync(corpusDir) : [];
    const candidates = existsSync(candidatesDir) ? readdirSync(candidatesDir) : [];
    const runs = existsSync(runsDir) ? readdirSync(runsDir) : [];
    return ok(`evaluator: enabled\ndrafts=${drafts.length}\ncorpora=${corpora.length}\ncandidates=${candidates.length}\nruns=${runs.length}\nbaseline=${deps.baselineDigest}`);
  }

  async function harvest(args: readonly string[]): Promise<OperatorCommandOutcome> {
    const maxSessions = Number(argValue(args, '--max-sessions') ?? '50');
    if (!Number.isInteger(maxSessions) || maxSessions < 1) return fail('--max-sessions must be a positive integer.', 'INVALID_COMMAND');
    mkdirSync(draftsDir, { recursive: true, mode: 0o700 });
    let drafts: readonly HarvestedDraft[];
    try {
      drafts = await harvestDrafts(deps.store, maxSessions, now);
    } catch (error) {
      return fail(`harvest failed: ${error instanceof Error ? error.message : String(error)}`, 'EVALUATOR_ERROR');
    }
    let written = 0;
    for (const draft of drafts) {
      if (existsSync(join(draftsDir, `${draft.caseId}.json`))) continue;
      writeFileSync(join(draftsDir, `${draft.caseId}.json`), JSON.stringify(draft, null, 2), { mode: 0o600 });
      written += 1;
    }
    return ok(`harvest complete: ${written} new draft(s), ${drafts.length} total. Drafts are LOCAL_ONLY and contain conversation excerpts from ALL projects on this machine — review before curation or sharing.`);
  }

  async function corpus(args: readonly string[]): Promise<OperatorCommandOutcome> {
    const heldOut = Number(argValue(args, '--held-out') ?? '0');
    const corpusId = argValue(args, '--id') ?? `corpus-${now().slice(0, 10)}-${Date.now()}`;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(corpusId)) return fail('corpus id contains unsupported characters.', 'INVALID_COMMAND');
    if (!existsSync(draftsDir)) return fail('No drafts directory; run harvest first.', 'EVALUATOR_ERROR');
    const curated: { caseId: string; disclosure: EvalCase['disclosure'] }[] = [];
    const detections: string[] = [];
    for (const file of readdirSync(draftsDir)) {
      let draft: { curated?: boolean; caseId: string; disclosure?: EvalCase['disclosure']; approvedBy?: string; originalRequest: string; observed: { nodeSummaries: { summary: string }[] } };
      try {
        draft = JSON.parse(readFileSync(join(draftsDir, file), 'utf8'));
      } catch {
        detections.push(`${file}: malformed draft skipped`);
        continue;
      }
      if (draft.curated !== true) continue;
      if (!scanForSecrets(caseText(draft as unknown as EvalCase)).clean) {
        detections.push(`${draft.caseId}: credential-bearing content`);
        continue;
      }
      if (draft.disclosure === 'EXTERNAL_REPLAY_APPROVED' && !('approvedBy' in draft)) {
        detections.push(`${draft.caseId}: EXTERNAL_REPLAY_APPROVED without recorded approver`);
        continue;
      }
      if (draft.disclosure !== undefined) curated.push({ caseId: draft.caseId, disclosure: draft.disclosure });
    }
    const corpusPath = join(corpusDir, `${corpusId}.json`);
    if (existsSync(corpusPath)) return fail(`Corpus ${corpusId} is already sealed; create a new corpus id for a fresh partition.`, 'EVALUATOR_ERROR');
    try {
      const corpus = buildCorpus(corpusId, 1, now(), curated, heldOut);
      mkdirSync(corpusDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(corpusDir, `${corpusId}.json`), JSON.stringify({ ...corpus, cases: corpus.cases }, null, 2), { mode: 0o600 });
      return ok(`corpus ${corpusId} created: ${curated.length} curated case(s), held-out=${heldOut}${detections.length > 0 ? `\nsecret-detected (excluded): ${detections.join('; ')}` : ''}`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 'EVALUATOR_ERROR');
    }
  }

  async function evaluate(args: readonly string[]): Promise<OperatorCommandOutcome> {
    const corpusId = argValue(args, '--corpus');
    const budgetPath = argValue(args, '--budget');
    const specPath = argValue(args, '--spec');
    if (corpusId === undefined || budgetPath === undefined || specPath === undefined) return fail('evaluate requires --corpus <id> --budget <file> --spec <file>.', 'INVALID_COMMAND');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(corpusId)) return fail('corpus id contains unsupported characters.', 'INVALID_COMMAND');
    const runId = `run-${Date.now()}`;
    let budget;
    let spec;
    try {
      budget = validateBudget(JSON.parse(readFileSync(budgetPath, 'utf8')));
      spec = loadScoringSpec(JSON.parse(readFileSync(specPath, 'utf8')));
    } catch (error) {
      return fail(`Budget/spec invalid: ${error instanceof Error ? error.message : String(error)}`, 'EVALUATOR_ERROR');
    }
    const corpusPath = join(corpusDir, `${corpusId}.json`);
    if (!existsSync(corpusPath)) return fail(`Corpus ${corpusId} not found.`, 'EVALUATOR_ERROR');
    let corpus;
    try {
      corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as OperatorEvalCorpus;
    } catch (error) {
      return fail(`Corpus unreadable: ${error instanceof Error ? error.message : String(error)}`, 'EVALUATOR_ERROR');
    }
    const campaignsPath = join(corpusDir, `${corpusId}.campaigns`);
    try {
      const priorCampaigns = existsSync(campaignsPath) ? Number(readFileSync(campaignsPath, 'utf8')) : 0;
      if (Number.isFinite(priorCampaigns) === false || priorCampaigns >= MAX_CAMPAIGNS_PER_CORPUS_REVISION) {
        return fail(`ADAPTIVE_LEAKAGE_CAP: campaign ledger for corpus ${corpusId} is unreadable or exhausted; create a fresh held-out revision before evaluating again.`, 'EVALUATOR_ERROR');
      }
      assertDisjoint(corpus);
      const missing: string[] = [];
      const contents = new Map<string, EvalCase>();
      for (const entry of corpus.cases) {
        const casePath = join(draftsDir, `${entry.caseId}.json`);
        if (!existsSync(casePath)) { missing.push(entry.caseId); continue; }
        contents.set(entry.caseId, JSON.parse(readFileSync(casePath, 'utf8')) as EvalCase);
      }
      if (missing.length > 0) return fail(`Corpus references missing curated drafts: ${missing.join(', ')}.`, 'EVALUATOR_ERROR');
      const ordered = [...corpus.cases].sort((a, b) => a.caseId.localeCompare(b.caseId));
      const scored = ordered.slice(0, budget.maxCases);
      const skipped = ordered.slice(budget.maxCases);
      let hardFailures = 0;
      const perCaseScores = scored.map((entry) => {
        const score = scoreCase(contents.get(entry.caseId)!, spec);
        if (score.hardGateFailures.length > 0) hardFailures += 1;
        return { ...score, partition: entry.partition };
      });
      const run = { runId, corpusId, corpusRevision: corpus.revision, baselineDigest: deps.baselineDigest, featureSetHash: deps.featureSet.hash, budget, startedAt: now(), perCase: [...scored.map((entry) => ({ caseId: entry.caseId, replays: 0, status: 'DONE' as const })), ...skipped.map((entry) => ({ caseId: entry.caseId, replays: 0, status: 'SKIPPED_BUDGET' as const }))], budgetExhausted: skipped.length > 0, specHash: spec.specHash };
      const baselineEnvelope: BaselineScoresEnvelope = { kind: 'BASELINE', evalRunId: runId, corpusId, corpusRevision: corpus.revision, trainManifestHash: corpus.trainManifestHash, heldOutManifestHash: corpus.heldOutManifestHash, baselineDigest: deps.baselineDigest, specHash: spec.specHash, scorerVersion: SCORER_VERSION, budgetHash: sha256Of(budget), scores: perCaseScores };
      let candidateEnvelope: CandidateScoresEnvelope | undefined;
      const candidateBundleDir = argValue(args, '--candidate');
      if (candidateBundleDir !== undefined) {
        if (deps.executeCandidateCase === undefined) return fail('Candidate scoring requires an injected trusted executor; operator-authored score values are not accepted.', 'EVALUATOR_ERROR');
        const manifest = verifyCandidateBundle(candidateBundleDir);
        const candidateDigest = candidateDigestFor(candidateBundleDir);
        if (budget.maxReplaysPerCase < 1) return fail('EvalBudget.maxReplaysPerCase is below 1; candidate execution does not fit the budget.', 'EVALUATOR_ERROR');
        const attemptId = `${runId}/candidate/${candidateDigest.slice(0, 16)}`;
        const candidateScores = [];
        for (const entry of scored) {
          const evidence = await deps.executeCandidateCase({ evalRunId: runId, attemptId, evalCase: contents.get(entry.caseId)! });
          if (evidence.caseId !== entry.caseId) throw new Error(`CANDIDATE_EVIDENCE_DRIFT: executor returned case ${evidence.caseId} for ${entry.caseId}.`);
          candidateScores.push({ ...scoreCase(evidence, spec), partition: entry.partition });
        }
        candidateEnvelope = { kind: 'CANDIDATE', evalRunId: runId, corpusId, corpusRevision: corpus.revision, trainManifestHash: corpus.trainManifestHash, heldOutManifestHash: corpus.heldOutManifestHash, specHash: spec.specHash, scorerVersion: SCORER_VERSION, budgetHash: sha256Of(budget), candidateId: manifest.candidateId, candidateDigest, attemptId, scores: candidateScores };
      }
      mkdirSync(runsDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(runsDir, `${runId}.json`), JSON.stringify(run, null, 2), { mode: 0o600 });
      writeFileSync(join(runsDir, `${runId}-scores.json`), JSON.stringify(baselineEnvelope, null, 2), { mode: 0o600 });
      if (candidateEnvelope !== undefined) writeFileSync(join(runsDir, `${runId}-candidate-scores.json`), JSON.stringify(candidateEnvelope, null, 2), { mode: 0o600 });
      writeFileSync(campaignsPath, String(priorCampaigns + 1), { mode: 0o600 });
      return ok(`evaluate ${runId}: deterministically scored ${perCaseScores.length}/${ordered.length} cases (hard-gate failures: ${hardFailures}${candidateEnvelope === undefined ? '' : `; candidate ${candidateEnvelope.candidateId} executed via trusted scorer`}); envelopes bound at runs/${runId}-scores.json${candidateEnvelope === undefined ? '' : ` + ${runId}-candidate-scores.json`}.`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 'EVALUATOR_ERROR');
    }
  }

  /** Candidate-generation input seam: emits ONLY train-partition material.
   * Held-out ids are structurally excluded by the branded TrainCaseId type —
   * the generated manifest cannot represent them. Write-once output dir. */
  async function generate(args: readonly string[]): Promise<OperatorCommandOutcome> {
    const corpusId = argValue(args, '--corpus');
    const out = argValue(args, '--out');
    if (corpusId === undefined || out === undefined) return fail('generate requires --corpus <id> --out <dir>.', 'INVALID_COMMAND');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(corpusId)) return fail('corpus id contains unsupported characters.', 'INVALID_COMMAND');
    const corpusPath = join(corpusDir, `${corpusId}.json`);
    if (!existsSync(corpusPath)) return fail(`Corpus ${corpusId} not found.`, 'EVALUATOR_ERROR');
    if (existsSync(out)) return fail(`Output directory ${out} already exists; generation input is write-once.`, 'EVALUATOR_ERROR');
    try {
      const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as OperatorEvalCorpus;
      assertDisjoint(corpus);
      const trainIds = generatorInput(corpus);
      const heldOutCount = corpus.cases.length - trainIds.length;
      const cases: { caseId: string; disclosure: EvalCase['disclosure']; originalRequest: string }[] = [];
      for (const id of trainIds) {
        const content = JSON.parse(readFileSync(join(draftsDir, `${id}.json`), 'utf8')) as EvalCase;
        if (!scanForSecrets(caseText(content)).clean) throw new Error(`SECRET_DETECTED: train case ${id} carries credential-bearing content; generate refused. Re-curate the draft.`);
        cases.push({ caseId: id as string, disclosure: content.disclosure, originalRequest: content.originalRequest });
      }
      mkdirSync(out, { recursive: true, mode: 0o700 });
      writeFileSync(join(out, 'generator-input.json'), JSON.stringify({ trainOnly: true, corpusId, corpusRevision: corpus.revision, heldOutExcluded: heldOutCount, cases }, null, 2), { mode: 0o600 });
      return ok(`generator input written to ${out}: ${cases.length} train case(s); ${heldOutCount} held-out case(s) excluded by type.`);
    } catch (error) {
      rmSync(out, { recursive: true, force: true });
      return fail(error instanceof Error ? error.message : String(error), 'EVALUATOR_ERROR');
    }
  }

  async function candidate(subcommand: string, args: readonly string[]): Promise<OperatorCommandOutcome> {
    if (subcommand !== 'verify') return fail('usage: /operator improve candidate verify <dir>', 'INVALID_COMMAND');
    const dir = args[0];
    if (dir === undefined) return fail('candidate dir required.', 'INVALID_COMMAND');
    try {
      const manifest = verifyCandidateBundle(dir);
      return ok(`candidate ${manifest.candidateId} verified (base ${manifest.baseDigest}).`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 'EVALUATOR_ERROR');
    }
  }

  async function compare(args: readonly string[]): Promise<OperatorCommandOutcome> {
    if (argValue(args, '--baseline-scores') !== undefined || argValue(args, '--candidate-scores') !== undefined) {
      return fail('Externally authored score files are not accepted: comparison consumes only evaluator-produced trusted envelopes. Run evaluate (optionally with --candidate).', 'INVALID_COMMAND');
    }
    const runId = args[0];
    const specPath = argValue(args, '--spec');
    const candidateBundleDir = argValue(args, '--candidate-bundle');
    if (runId === undefined || specPath === undefined) return fail('compare requires <runId> --spec <file> [--candidate-bundle <dir>].', 'INVALID_COMMAND');
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId)) return fail('run id contains unsupported characters.', 'INVALID_COMMAND');
    try {
      const storedRun = JSON.parse(readFileSync(join(runsDir, `${runId}.json`), 'utf8')) as OperatorEvalRun & { specHash?: string };
      const spec = loadScoringSpec(JSON.parse(readFileSync(specPath, 'utf8')));
      if (storedRun.specHash === undefined) return fail(`Run ${runId} has no pinned scoring spec; rerun evaluate with --spec.`, 'EVALUATOR_ERROR');
      if (spec.specHash !== storedRun.specHash) return fail(`Scoring spec hash mismatch against the spec pinned by run ${runId}.`, 'EVALUATOR_ERROR');
      const corpusNow = JSON.parse(readFileSync(join(corpusDir, `${storedRun.corpusId}.json`), 'utf8')) as OperatorEvalCorpus;
      const partitionByCase = new Map(corpusNow.cases.map((entry) => [entry.caseId, entry.partition]));
      const expectedBudgetHash = sha256Of(storedRun.budget);
      const loadTrusted = (fileName: string, kind: 'BASELINE' | 'CANDIDATE'): BaselineScoresEnvelope | CandidateScoresEnvelope => {
        const path = join(runsDir, fileName);
        if (!existsSync(path)) throw new Error(`TRUSTED_ENVELOPE_MISSING: ${fileName} not found; run evaluate first (with --candidate for the candidate side).`);
        const envelope = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        const str = (key: string): string => (typeof envelope[key] === 'string' ? envelope[key] as string : '');
        if (str('kind') !== kind) throw new Error(`${fileName}: expected a ${kind} envelope.`);
        if (str('evalRunId') !== storedRun.runId || Number(envelope.corpusRevision) !== storedRun.corpusRevision || str('corpusId') !== storedRun.corpusId) throw new Error(`${fileName}: envelope is not bound to run ${storedRun.runId}.`);
        if (str('specHash') !== spec.specHash) throw new Error(`${fileName}: scoring policy drift (specHash mismatch); stale score cannot compare.`);
        if (str('scorerVersion') !== SCORER_VERSION) throw new Error(`${fileName}: scorer version drift (${str('scorerVersion') || 'missing'} != ${SCORER_VERSION}).`);
        if (str('budgetHash') !== expectedBudgetHash) throw new Error(`${fileName}: budget state drift.`);
        if (str('trainManifestHash') !== corpusNow.trainManifestHash || str('heldOutManifestHash') !== corpusNow.heldOutManifestHash) throw new Error(`${fileName}: corpus manifest drift.`);
        if (!Array.isArray(envelope.scores)) throw new Error(`${fileName}: malformed scores array.`);
        for (const score of envelope.scores as readonly { caseId?: string; partition?: string }[]) {
          const partition = partitionByCase.get(score.caseId ?? '');
          if (partition === undefined || score.partition !== partition) throw new Error(`${fileName}: score for case ${score.caseId ?? '?'} is not a pinned corpus case or has a tampered partition.`);
        }
        return envelope as unknown as BaselineScoresEnvelope & CandidateScoresEnvelope;
      };
      const baseline = loadTrusted(`${runId}-scores.json`, 'BASELINE') as BaselineScoresEnvelope;
      if (baseline.baselineDigest !== deps.baselineDigest) throw new Error(`${runId}-scores.json: baseline digest drift against this build.`);
      const candidate = loadTrusted(`${runId}-candidate-scores.json`, 'CANDIDATE') as CandidateScoresEnvelope;
      if (candidateBundleDir !== undefined) {
        const manifest = verifyCandidateBundle(candidateBundleDir);
        if (manifest.candidateId !== candidate.candidateId || candidateDigestFor(candidateBundleDir) !== candidate.candidateDigest) {
          throw new Error(`CANDIDATE_MISMATCH: bundle in ${candidateBundleDir} is not the candidate scored in run ${runId} (score was bound to ${candidate.candidateId}).`);
        }
      }
      const comparison = compareScores(baseline.scores, candidate.scores, spec, storedRun);
      const persisted = { ...comparison, candidateId: candidate.candidateId, candidateDigest: candidate.candidateDigest, attemptId: candidate.attemptId, trusted: true };
      writeFileSync(join(runsDir, `${runId}-comparison.json`), JSON.stringify(persisted, null, 2), { mode: 0o600 });
      return ok(`comparison ${runId}: verdict=${comparison.verdict} baseline=${comparison.baselineTotal} candidate=${comparison.candidateTotal} regressions=${comparison.regressions.length} hardFailures=${comparison.hardFailures.length} candidate=${candidate.candidateId}@${candidate.candidateDigest.slice(0, 12)} (trusted scorer output only)`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error), 'EVALUATOR_ERROR');
    }
  }

  return async (subcommand: string, args: readonly string[]): Promise<OperatorCommandOutcome> => {
    const gate = requireEnabled();
    if (gate !== undefined) return gate;
    switch (subcommand) {
      case 'status': return status();
      case 'harvest': return harvest(args);
      case 'corpus': return corpus(args);
      case 'evaluate': return evaluate(args);
      case 'candidate': return candidate('verify', args[0] === 'verify' ? args.slice(1) : args);
      case 'compare': return compare(args);
      case 'generate': return generate(args);
      default: return fail(`Unknown evaluator subcommand "${subcommand}". Known: ${SUBCOMMANDS.join(', ')}.`, 'INVALID_COMMAND');
    }
  };
}

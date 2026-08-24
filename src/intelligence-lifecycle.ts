import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { OperatorCommandOutcome } from './runtime-types.js';
import type { OperatorComparison } from './evaluator/contracts.js';
import { calibratePredictions, intelligenceCandidateDigest, type ConfidencePrediction, type IntelligenceActivationPort, type IntelligenceCandidateManifest, type PredictionDimension } from './intelligence-activation.js';
import type { ProviderIntelligencePort } from './provider-intelligence.js';
import { buildDecisionBrief, evaluateRetention, normalizeEvidence, planAdaptiveContext, type ContextItem, type RawEvidenceReference, type RetentionRecord } from './context-intelligence.js';

export interface IntelligenceLifecycleOptions {
  readonly evaluatorDir: string;
  readonly projectRoot: string;
  readonly activation: IntelligenceActivationPort;
  readonly intelligence: ProviderIntelligencePort;
  readonly baseDigest: string;
  readonly policyDigest: string;
  readonly compilerVersion: string;
  readonly scorerVersion: string;
  readonly now?: () => string;
}

function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function safeInput(projectRoot: string, inputPath: string): string {
  const candidate = resolve(projectRoot, inputPath);
  const rel = relative(projectRoot, candidate);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Intelligence input must stay inside the project root.');
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Intelligence input must be a regular non-symlink file.');
  return candidate;
}

function readJson(projectRoot: string, inputPath: string): unknown {
  return JSON.parse(readFileSync(safeInput(projectRoot, inputPath), 'utf8')) as unknown;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
}

function ok(text: string): OperatorCommandOutcome { return { ok: true, text }; }
function fail(text: string): OperatorCommandOutcome { return { ok: false, text, errorCode: 'EVALUATOR_ERROR' }; }

export function createIntelligenceLifecycleHandler(options: IntelligenceLifecycleOptions): (args: readonly string[]) => Promise<OperatorCommandOutcome> {
  const now = options.now ?? (() => new Date().toISOString());
  const root = join(options.evaluatorDir, 'intelligence');
  const candidateDir = join(root, 'candidates');
  const reportDir = join(root, 'reports');
  mkdirSync(candidateDir, { recursive: true, mode: 0o700 });
  mkdirSync(reportDir, { recursive: true, mode: 0o700 });

  return async (args): Promise<OperatorCommandOutcome> => {
    try {
      const action = args[0];
      if (action === 'status') {
        const [active, status] = await Promise.all([options.activation.active(), options.intelligence.status()]);
        return ok(`intelligence status: active=${active === undefined ? 'none' : `${active.activeCandidateId}@${active.activeDigest.slice(0, 12)}`}; evidence=${status.admitted}/${status.evidence}; overrides=${status.overrides}; canaries=${status.canaries}`);
      }
      if (action === 'context-plan') {
        const inputPath = argValue(args, '--input');
        const maxTokens = Number(argValue(args, '--max-tokens'));
        if (inputPath === undefined || !Number.isInteger(maxTokens) || maxTokens < 1) return fail('context-plan requires --input <json> --max-tokens <positive integer>.');
        const raw = readJson(options.projectRoot, inputPath);
        if (!Array.isArray(raw)) return fail('context-plan input must be a ContextItem array.');
        const plan = planAdaptiveContext(raw as ContextItem[], { policyId: `candidate-${now()}`, maxTokens });
        writeJson(join(reportDir, `context-${plan.planId}.json`), plan);
        return ok(`context plan ${plan.planId}: blocked=${plan.blocked}, tokens=${plan.totalEstimatedTokens}/${plan.maxTokens}`);
      }
      if (action === 'evidence-brief') {
        const rawPath = argValue(args, '--raw');
        const claimsPath = argValue(args, '--claims');
        const decision = argValue(args, '--decision');
        if (rawPath === undefined || claimsPath === undefined || decision === undefined) return fail('evidence-brief requires --raw <json> --claims <json> --decision <token>.');
        const rawEvidence = readJson(options.projectRoot, rawPath) as RawEvidenceReference;
        const claims = readJson(options.projectRoot, claimsPath);
        if (!Array.isArray(claims) || claims.some((claim) => typeof claim !== 'string')) return fail('claims input must be a string array.');
        const normalized = normalizeEvidence(rawEvidence, claims, now());
        const brief = buildDecisionBrief([normalized], decision, ['INTELLIGENCE_BRIEF'], now());
        writeJson(join(reportDir, `normalized-${normalized.normalizedId}.json`), normalized);
        writeJson(join(reportDir, `brief-${brief.briefId}.json`), brief);
        return ok(`evidence brief ${brief.briefId} created; raw evidence remains authoritative.`);
      }
      if (action === 'retention') {
        const inputPath = argValue(args, '--input');
        if (inputPath === undefined) return fail('retention requires --input <json>.');
        const raw = readJson(options.projectRoot, inputPath);
        if (!Array.isArray(raw)) return fail('retention input must be a RetentionRecord array.');
        const active = await options.activation.active();
        const refs = new Set<string>(active === undefined ? [] : [active.activeCandidateId, active.activeDigest]);
        const decisions = evaluateRetention(raw as RetentionRecord[], now(), refs);
        const id = Buffer.from(now()).toString('hex').slice(0, 32);
        writeJson(join(reportDir, `retention-${id}.json`), decisions);
        return ok(`retention evaluation produced ${decisions.length} decision(s); no records were deleted.`);
      }
      if (action === 'calibrate') {
        const inputPath = argValue(args, '--input');
        const dimension = argValue(args, '--dimension') as PredictionDimension | undefined;
        const identity = argValue(args, '--identity');
        if (inputPath === undefined || dimension === undefined || identity === undefined) return fail('calibrate requires --input <json> --dimension <dimension> --identity <id>.');
        const raw = readJson(options.projectRoot, inputPath);
        if (!Array.isArray(raw)) return fail('calibration input must be a ConfidencePrediction array.');
        const report = calibratePredictions(raw as ConfidencePrediction[], dimension, identity, now());
        writeJson(join(reportDir, `calibration-${report.reportId}.json`), report);
        return ok(`calibration ${report.reportId}: ${report.status}, n=${report.sampleCount}`);
      }
      if (action === 'candidate') {
        const candidateId = argValue(args, '--id');
        const semanticClassifierDigest = argValue(args, '--semantic');
        const calibrationDigest = argValue(args, '--calibration');
        const competenceDigest = argValue(args, '--competence');
        const contextPolicyDigest = argValue(args, '--context');
        const evidenceSnapshotDigest = argValue(args, '--evidence');
        const digests = [semanticClassifierDigest, calibrationDigest, competenceDigest, contextPolicyDigest, evidenceSnapshotDigest];
        if (candidateId === undefined || digests.some((digest) => digest === undefined || !/^[0-9a-f]{64}$/.test(digest))) return fail('candidate requires --id plus five 64-hex intelligence digests.');
        const candidate: IntelligenceCandidateManifest = { schemaVersion: '1.0', candidateId, baseDigest: options.baseDigest, semanticClassifierDigest: semanticClassifierDigest!, calibrationDigest: calibrationDigest!, competenceDigest: competenceDigest!, contextPolicyDigest: contextPolicyDigest!, evidenceSnapshotDigest: evidenceSnapshotDigest!, policyDigest: options.policyDigest, compilerVersion: options.compilerVersion, scorerVersion: options.scorerVersion, createdAt: now() };
        const digest = intelligenceCandidateDigest(candidate);
        writeJson(join(candidateDir, `${candidateId}.json`), candidate);
        return ok(`intelligence candidate ${candidateId}@${digest} created for evaluator packaging; not active.`);
      }
      if (action === 'promote') {
        const candidateId = args[1];
        const runId = args[2];
        const approval = argValue(args, '--approval');
        if (candidateId === undefined || runId === undefined || approval === undefined) return fail('promote requires <candidate-id> <run-id> --approval <human-ref>.');
        const candidate = JSON.parse(readFileSync(join(candidateDir, `${candidateId}.json`), 'utf8')) as IntelligenceCandidateManifest;
        const trusted = JSON.parse(readFileSync(join(options.evaluatorDir, 'runs', `${runId}-comparison.json`), 'utf8')) as OperatorComparison & { readonly candidateId?: string; readonly candidateDigest?: string; readonly trusted?: boolean };
        const candidateDigest = intelligenceCandidateDigest(candidate);
        if (trusted.trusted !== true || trusted.candidateId !== candidateId || trusted.candidateDigest !== candidateDigest) throw new Error('Trusted evaluator comparison does not bind this intelligence candidate digest.');
        const pointer = await options.activation.promote({ candidate, candidateDigest, comparison: trusted, humanApprovalRef: approval, humanApproved: true, now: now() });
        return ok(`intelligence candidate ${pointer.activeCandidateId}@${pointer.activeDigest} promoted by human approval; restart Operator to activate.`);
      }
      if (action === 'rollback') {
        const approval = argValue(args, '--approval');
        if (approval === undefined) return fail('rollback requires --approval <human-ref>.');
        const pointer = await options.activation.rollback({ humanApprovalRef: approval, humanApproved: true, now: now() });
        return ok(`intelligence rollback selected ${pointer.activeCandidateId}@${pointer.activeDigest}; restart Operator to activate.`);
      }
      return fail('intelligence requires status, context-plan, evidence-brief, retention, calibrate, candidate, promote, or rollback.');
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Intelligence lifecycle failed.');
    }
  };
}

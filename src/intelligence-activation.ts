import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { OperatorCandidateManifest, OperatorComparison } from './evaluator/contracts.js';
import type { SemanticOperatorClassifier } from './semantic-classifier.js';
import type { ProviderCanaryObservation, ProviderIntelligencePort } from './provider-intelligence.js';
import { isPlainObject } from './validation/primitives.js';

export type PredictionDimension = 'CLASSIFICATION' | 'WORKFLOW' | 'PROVIDER' | 'RISK' | 'RECOMMENDATION';

export interface ConfidencePrediction {
  readonly predictionId: string;
  readonly dimension: PredictionDimension;
  readonly predictionIdentity: string;
  readonly rawConfidence: number;
  readonly correct: boolean;
  readonly observedAt: string;
}

export interface CalibrationBin {
  readonly lower: number;
  readonly upper: number;
  readonly count: number;
  readonly averageConfidence: number;
  readonly observedAccuracy: number;
}

export interface CalibrationReport {
  readonly schemaVersion: '1.0';
  readonly reportId: string;
  readonly dimension: PredictionDimension;
  readonly predictionIdentity: string;
  readonly sampleCount: number;
  readonly status: 'INSUFFICIENT' | 'CALIBRATED';
  readonly brierScore: number | null;
  readonly expectedCalibrationError: number | null;
  readonly bins: readonly CalibrationBin[];
  readonly generatedAt: string;
}

export interface ProviderCanaryCase {
  readonly caseId: string;
  readonly capabilityId: string;
  readonly taskFamily: ProviderCanaryObservation['taskFamily'];
  readonly mutationClass: 'READ_ONLY';
}

export interface ProviderCanaryBudget {
  readonly maxCases: number;
  readonly maxTokens: number;
  readonly maxCost: number;
  readonly maxWallClockMs: number;
}


export interface ProviderCanaryCommandPort {
  run(providerId: string, modelId?: string): Promise<readonly ProviderCanaryObservation[]>;
}
export interface ProviderCanaryRunner {
  run(input: { readonly providerId: string; readonly modelId: string; readonly testCase: ProviderCanaryCase }): Promise<{ readonly outcome: 'PASSED' | 'FAILED' | 'BLOCKED'; readonly qualityScore: number; readonly latencyMs: number; readonly tokens: number; readonly cost: number; readonly toolReliable: boolean; readonly evaluatorRunRef: string }>;
}

export interface IntelligenceCandidateManifest {
  readonly schemaVersion: '1.0';
  readonly candidateId: string;
  readonly baseDigest: string;
  readonly semanticClassifierDigest: string;
  readonly calibrationDigest: string;
  readonly competenceDigest: string;
  readonly contextPolicyDigest: string;
  readonly evidenceSnapshotDigest: string;
  readonly policyDigest: string;
  readonly compilerVersion: string;
  readonly scorerVersion: string;
  readonly createdAt: string;
}

export interface ActiveIntelligencePointer {
  readonly schemaVersion: '1.0';
  readonly activeCandidateId: string;
  readonly activeDigest: string;
  readonly previousCandidateId?: string;
  readonly previousDigest?: string;
  readonly humanApprovalRef: string;
  readonly promotedBySystem: false;
  readonly activatedAt: string;
}

export interface IntelligenceActivationStore {
  load(): Promise<ActiveIntelligencePointer | undefined>;
  save(pointer: ActiveIntelligencePointer): Promise<void>;
}

export interface IntelligenceActivationPort {
  promote(input: { readonly candidate: IntelligenceCandidateManifest; readonly candidateDigest: string; readonly comparison: OperatorComparison; readonly humanApprovalRef: string; readonly humanApproved: true; readonly now: string }): Promise<ActiveIntelligencePointer>;
  rollback(input: { readonly humanApprovalRef: string; readonly humanApproved: true; readonly now: string }): Promise<ActiveIntelligencePointer>;
  active(): Promise<ActiveIntelligencePointer | undefined>;
}

export function validateActiveIntelligencePointer(value: unknown): value is ActiveIntelligencePointer {
  if (!isPlainObject(value)) return false;
  return value['schemaVersion'] === '1.0'
    && typeof value['activeCandidateId'] === 'string'
    && typeof value['activeDigest'] === 'string' && /^[0-9a-f]{64}$/.test(value['activeDigest'])
    && (value['previousCandidateId'] === undefined || typeof value['previousCandidateId'] === 'string')
    && (value['previousDigest'] === undefined || (typeof value['previousDigest'] === 'string' && /^[0-9a-f]{64}$/.test(value['previousDigest'])))
    && typeof value['humanApprovalRef'] === 'string'
    && value['promotedBySystem'] === false
    && typeof value['activatedAt'] === 'string' && Number.isFinite(Date.parse(value['activatedAt']));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function intelligenceCandidateDigest(candidate: IntelligenceCandidateManifest): string {
  return createHash('sha256').update(canonical(candidate), 'utf8').digest('hex');
}

export function calibratePredictions(predictions: readonly ConfidencePrediction[], dimension: PredictionDimension, predictionIdentity: string, generatedAt: string): CalibrationReport {
  const compatible = predictions.filter((prediction) => prediction.dimension === dimension && prediction.predictionIdentity === predictionIdentity);
  const bins: CalibrationBin[] = [];
  for (let index = 0; index < 10; index += 1) {
    const lower = index / 10;
    const upper = (index + 1) / 10;
    const members = compatible.filter((prediction) => prediction.rawConfidence >= lower && (index === 9 ? prediction.rawConfidence <= upper : prediction.rawConfidence < upper));
    if (members.length === 0) continue;
    bins.push({ lower, upper, count: members.length, averageConfidence: members.reduce((sum, prediction) => sum + prediction.rawConfidence, 0) / members.length, observedAccuracy: members.filter((prediction) => prediction.correct).length / members.length });
  }
  const sufficient = compatible.length >= 20;
  const brierScore = sufficient ? compatible.reduce((sum, prediction) => sum + (prediction.rawConfidence - (prediction.correct ? 1 : 0)) ** 2, 0) / compatible.length : null;
  const expectedCalibrationError = sufficient ? bins.reduce((sum, bin) => sum + (bin.count / compatible.length) * Math.abs(bin.averageConfidence - bin.observedAccuracy), 0) : null;
  const reportBody: Omit<CalibrationReport, 'schemaVersion' | 'reportId'> = { dimension, predictionIdentity, sampleCount: compatible.length, status: sufficient ? 'CALIBRATED' : 'INSUFFICIENT', brierScore, expectedCalibrationError, bins, generatedAt };
  return { schemaVersion: '1.0', reportId: createHash('sha256').update(canonical(reportBody), 'utf8').digest('hex'), ...reportBody };
}

export async function runProviderCanaries(input: { readonly providerId: string; readonly modelId: string; readonly cases: readonly ProviderCanaryCase[]; readonly budget: ProviderCanaryBudget; readonly runner: ProviderCanaryRunner; readonly intelligence: ProviderIntelligencePort; readonly now: () => string }): Promise<readonly ProviderCanaryObservation[]> {
  if (input.cases.length > input.budget.maxCases) throw new Error('Canary case count exceeds budget.');
  const started = Date.now();
  let tokens = 0;
  let cost = 0;
  const observations: ProviderCanaryObservation[] = [];
  for (const testCase of input.cases) {
    if (testCase.mutationClass !== 'READ_ONLY') throw new Error('Provider canaries must be READ_ONLY.');
    if (Date.now() - started > input.budget.maxWallClockMs) throw new Error('Canary wall-clock budget exhausted.');
    const result = await input.runner.run({ providerId: input.providerId, modelId: input.modelId, testCase });
    tokens += result.tokens;
    cost += result.cost;
    if (tokens > input.budget.maxTokens || cost > input.budget.maxCost) throw new Error('Canary token/cost budget exhausted.');

    const observedAt = input.now();
    const canaryId = createHash('sha256').update(`${testCase.caseId}\n${input.providerId}\n${input.modelId}\n${observedAt}`, 'utf8').digest('hex');
    const observation: ProviderCanaryObservation = { schemaVersion: '1.0', canaryId, caseId: testCase.caseId, providerId: input.providerId, modelId: input.modelId, capabilityId: testCase.capabilityId, taskFamily: testCase.taskFamily, outcome: result.outcome, qualityScore: result.qualityScore, latencyMs: result.latencyMs, toolReliable: result.toolReliable, evaluatorRunRef: result.evaluatorRunRef, observedAt };
    await input.intelligence.recordCanary(observation);
    observations.push(observation);
  }
  return observations;
}
export function createSemanticCanaryCommand(input: { readonly classifier: SemanticOperatorClassifier; readonly intelligence: ProviderIntelligencePort; readonly resolveModel: () => { readonly provider: string; readonly id: string }; readonly projectRoot: string; readonly now: () => string }): ProviderCanaryCommandPort {
  const cases: readonly (ProviderCanaryCase & { readonly request: string })[] = [
    { caseId: 'semantic-plan-v1', capabilityId: 'planning', taskFamily: 'PLAN', mutationClass: 'READ_ONLY', request: 'Plan a bounded migration in three stages.' },
    { caseId: 'semantic-review-v1', capabilityId: 'code-review', taskFamily: 'REVIEW', mutationClass: 'READ_ONLY', request: 'Review a code change for correctness risks.' },
    { caseId: 'semantic-research-v1', capabilityId: 'research', taskFamily: 'RESEARCH', mutationClass: 'READ_ONLY', request: 'Research and compare two implementation options.' },
  ];
  return {
    async run(providerId, modelId): Promise<readonly ProviderCanaryObservation[]> {
      const selected = input.resolveModel();
      if (selected.provider !== providerId || (modelId !== undefined && selected.id !== modelId)) throw new Error('Canary provider/model must match the current OMP-selected model.');
      return runProviderCanaries({
        providerId,
        modelId: selected.id,
        cases,
        budget: { maxCases: cases.length, maxTokens: 20_000, maxCost: 5, maxWallClockMs: 120_000 },
        intelligence: input.intelligence,
        now: input.now,
        runner: {
          async run({ testCase }) {
            const current = cases.find((candidate) => candidate.caseId === testCase.caseId)!;
            const started = Date.now();
            const result = await input.classifier.classify({
              request: current.request,
              projectRoot: input.projectRoot,
              operatorSessionId: `canary-${testCase.caseId}-${input.now()}`,
              disclosureDecision: { schemaVersion: '1.0', disclosureClass: 'INTERNAL_REDACTABLE', predictionIdentity: 'DETERMINISTIC_FIXTURE', sensitiveSignalDetected: false, explicitFleetRoute: false, projectTrustStatus: 'ABSENT', reasonCodes: ['CANARY_FIXED_CASE'] },
            });
            const passed = result.proposal.requestClassification === testCase.taskFamily && result.disposition === 'EXECUTE';
            return { outcome: passed ? 'PASSED' as const : 'FAILED' as const, qualityScore: passed ? 1 : 0, latencyMs: Math.max(0, Date.now() - started), tokens: result.usage?.tokens ?? 0, cost: result.usage?.cost ?? 0, toolReliable: true, evaluatorRunRef: 'semantic-canary-v1' };
          },
        },
      });
    },
  };
}

export function toOperatorCandidateManifest(candidate: IntelligenceCandidateManifest): OperatorCandidateManifest {
  return {
    candidateId: candidate.candidateId,
    baseVersion: 'stage9-sealed',
    baseDigest: candidate.baseDigest,
    components: [
      { component: 'semantic-classifier', status: 'CHANGED' },
      { component: 'confidence-calibration', status: 'CHANGED' },
      { component: 'provider-competence', status: 'CHANGED' },
      { component: 'context-packing', status: 'CHANGED' },
      { component: 'hardInvariants', status: 'UNCHANGED' },
      { component: 'permissionModel', status: 'UNCHANGED' },
      { component: 'humanApprovalRules', status: 'UNCHANGED' },
      { component: 'disclosureRules', status: 'UNCHANGED' },
      { component: 'promotionAuthority', status: 'UNCHANGED' },
    ],
    createdAt: candidate.createdAt,
  };
}

export class MemoryIntelligenceActivationStore implements IntelligenceActivationStore {
  #pointer: ActiveIntelligencePointer | undefined;
  async load(): Promise<ActiveIntelligencePointer | undefined> { return this.#pointer === undefined ? undefined : structuredClone(this.#pointer); }
  async save(pointer: ActiveIntelligencePointer): Promise<void> { this.#pointer = structuredClone(pointer); }
}

export class FileIntelligenceActivationStore implements IntelligenceActivationStore {
  readonly #path: string;
  constructor(root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); this.#path = join(root, 'active-intelligence.json'); }
  async load(): Promise<ActiveIntelligencePointer | undefined> {
    try {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8')) as unknown;
      if (!validateActiveIntelligencePointer(parsed)) throw new Error('Invalid active intelligence pointer.');
      return parsed;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async save(pointer: ActiveIntelligencePointer): Promise<void> {
    if (!validateActiveIntelligencePointer(pointer)) throw new Error('Invalid active intelligence pointer.');
    writeFileSync(this.#path, `${JSON.stringify(pointer, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}

export function createIntelligenceActivationService(store: IntelligenceActivationStore): IntelligenceActivationPort {
  return {
    async promote(input): Promise<ActiveIntelligencePointer> {
      if (!input.humanApproved || input.humanApprovalRef.trim() === '') throw new Error('Human promotion approval is required.');
      if (input.comparison.verdict !== 'PROMOTE_RECOMMENDED' || input.comparison.hardFailures.length > 0 || input.comparison.regressions.length > 0) throw new Error('Evaluator comparison does not authorize promotion.');
      const actualDigest = intelligenceCandidateDigest(input.candidate);
      if (actualDigest !== input.candidateDigest) throw new Error('Candidate digest does not match the approved intelligence bundle.');
      const current = await store.load();
      const pointer: ActiveIntelligencePointer = {
        schemaVersion: '1.0', activeCandidateId: input.candidate.candidateId, activeDigest: actualDigest,
        ...(current === undefined ? {} : { previousCandidateId: current.activeCandidateId, previousDigest: current.activeDigest }),
        humanApprovalRef: input.humanApprovalRef, promotedBySystem: false, activatedAt: input.now,
      };
      await store.save(pointer);
      return pointer;
    },
    async rollback(input): Promise<ActiveIntelligencePointer> {
      if (!input.humanApproved || input.humanApprovalRef.trim() === '') throw new Error('Human rollback approval is required.');
      const current = await store.load();
      if (current?.previousCandidateId === undefined || current.previousDigest === undefined) throw new Error('No previous intelligence digest is available for rollback.');
      const pointer: ActiveIntelligencePointer = { schemaVersion: '1.0', activeCandidateId: current.previousCandidateId, activeDigest: current.previousDigest, previousCandidateId: current.activeCandidateId, previousDigest: current.activeDigest, humanApprovalRef: input.humanApprovalRef, promotedBySystem: false, activatedAt: input.now };
      await store.save(pointer);
      return pointer;
    },
    active: () => store.load(),
  };
}

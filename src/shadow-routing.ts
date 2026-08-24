import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CompiledWorkflow, CompilationResult, ClassificationProposal, WorkflowCompilerContext } from './stage3-types.js';
import type { SemanticClassificationResult, SemanticOperatorClassifier } from './semantic-classifier.js';
import { isPlainObject } from './validation/primitives.js';

export type ShadowCandidateStatus = 'COMPILED' | 'DO_NOT_EXECUTE' | 'NEEDS_CLARIFICATION' | 'BLOCKED_DISCLOSURE' | 'FAILED';

export interface ShadowRouteSummary {
  readonly family: string;
  readonly workflow: string;
  readonly providers: readonly string[];
  readonly riskClassification: string;
}

export interface ShadowCandidateSummary {
  readonly status: ShadowCandidateStatus;
  readonly family?: string;
  readonly workflow?: string;
  readonly providers?: readonly string[];
  readonly disposition?: SemanticClassificationResult['disposition'];
  readonly rawConfidence?: number;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly failureCode?: string;
}

export interface ShadowObservation {
  readonly schemaVersion: '1.0';
  readonly observationId: string;
  readonly requestHash: string;
  /** Raw request text retained locally for eval-case curation only.
   * Mirrors the harvest model: LOCAL_ONLY until a human curates the case,
   * never included in exported/shared observation schemas. */
  readonly requestText?: string;
  readonly createdAt: string;
  readonly primary: ShadowRouteSummary;
  readonly candidate: ShadowCandidateSummary;
  readonly divergences: readonly string[];
  readonly policyRefs: readonly string[];
}

export interface ShadowObservationStore {
  save(observation: ShadowObservation): Promise<void>;
  list(): Promise<readonly ShadowObservation[]>;
}

export interface ShadowRoutingStatus {
  readonly enabled: boolean;
  readonly latest?: ShadowObservation;
}

const OBSERVATION_KEYS = ['schemaVersion', 'observationId', 'requestHash', 'requestText', 'createdAt', 'primary', 'candidate', 'divergences', 'policyRefs'] as const;
const PRIMARY_KEYS = ['family', 'workflow', 'providers', 'riskClassification'] as const;
const CANDIDATE_KEYS = ['status', 'family', 'workflow', 'providers', 'disposition', 'rawConfidence', 'modelProvider', 'modelId', 'failureCode'] as const;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === new Set(actual).size && actual.every((key) => allowed.includes(key));
}

export function validateShadowObservation(value: unknown): value is ShadowObservation {
  if (!isPlainObject(value) || !exactKeys(value, OBSERVATION_KEYS)) return false;
  if (value['schemaVersion'] !== '1.0' || typeof value['observationId'] !== 'string' || !/^[0-9a-f]{64}$/.test(value['observationId'])) return false;
  if (typeof value['requestHash'] !== 'string' || !/^[0-9a-f]{64}$/.test(value['requestHash']) || typeof value['createdAt'] !== 'string' || !Number.isFinite(Date.parse(value['createdAt']))) return false;
  const primary = value['primary'];
  const candidate = value['candidate'];
  if (!isPlainObject(primary) || !exactKeys(primary, PRIMARY_KEYS) || typeof primary['family'] !== 'string' || typeof primary['workflow'] !== 'string' || typeof primary['riskClassification'] !== 'string' || !Array.isArray(primary['providers']) || primary['providers'].some((entry) => typeof entry !== 'string')) return false;
  if (!isPlainObject(candidate) || !exactKeys(candidate, CANDIDATE_KEYS)) return false;
  if (typeof candidate['status'] !== 'string' || !['COMPILED', 'DO_NOT_EXECUTE', 'NEEDS_CLARIFICATION', 'BLOCKED_DISCLOSURE', 'FAILED'].includes(candidate['status'])) return false;
  for (const key of ['family', 'workflow', 'modelProvider', 'modelId', 'failureCode']) if (key in candidate && typeof candidate[key] !== 'string') return false;
  if ('providers' in candidate && (!Array.isArray(candidate['providers']) || candidate['providers'].some((entry) => typeof entry !== 'string'))) return false;
  if ('rawConfidence' in candidate && (typeof candidate['rawConfidence'] !== 'number' || candidate['rawConfidence'] < 0 || candidate['rawConfidence'] > 1)) return false;
  if ('disposition' in candidate && (typeof candidate['disposition'] !== 'string' || !['EXECUTE', 'DO_NOT_EXECUTE', 'NEEDS_CLARIFICATION'].includes(candidate['disposition']))) return false;
  if ('requestText' in value && typeof value['requestText'] !== 'string') return false;
  if (!Array.isArray(value['divergences']) || value['divergences'].some((entry) => typeof entry !== 'string')) return false;
  return Array.isArray(value['policyRefs']) && value['policyRefs'].every((entry) => typeof entry === 'string');
}

export interface ShadowRoutingPort {
  setEnabled(enabled: boolean): void;
  status(): ShadowRoutingStatus;
  evaluate(request: string, primary: CompiledWorkflow, context: WorkflowCompilerContext): Promise<ShadowObservation>;
  observeIfEnabled(request: string, primary: CompiledWorkflow, context: WorkflowCompilerContext): Promise<ShadowObservation | undefined>;
}

export interface ShadowRoutingOptions {
  readonly classifier: SemanticOperatorClassifier;
  readonly compileCandidate: (proposal: ClassificationProposal, context: WorkflowCompilerContext) => Promise<CompilationResult>;
  readonly store: ShadowObservationStore;
}

function routeSummary(compiled: CompiledWorkflow): ShadowRouteSummary {
  return {
    family: compiled.classification.requestClassification,
    workflow: compiled.routeDecision.selectedWorkflow,
    providers: [...new Set(compiled.routeDecision.selectedRolesProviders.map((entry) => entry.provider))].sort(),
    riskClassification: compiled.routeDecision.riskClassification,
  };
}

function comparison(primary: ShadowRouteSummary, candidate: ShadowCandidateSummary): readonly string[] {
  const divergences: string[] = [];
  if (candidate.family !== undefined && candidate.family !== primary.family) divergences.push('TASK_FAMILY');
  if (candidate.workflow !== undefined && candidate.workflow !== primary.workflow) divergences.push('WORKFLOW');
  if (candidate.providers !== undefined && candidate.providers.join('\n') !== primary.providers.join('\n')) divergences.push('PROVIDERS');
  if (candidate.status !== 'COMPILED') divergences.push(candidate.status);
  return divergences;
}

function observationIdentity(request: string, createdAt: string, modelIdentity: string, sessionIdentity: string): { readonly observationId: string; readonly requestHash: string } {
  const requestHash = createHash('sha256').update(request, 'utf8').digest('hex');
  const observationId = createHash('sha256').update(`${requestHash}\n${createdAt}\n${modelIdentity}\n${sessionIdentity}`, 'utf8').digest('hex');
  return { observationId, requestHash };
}

export class MemoryShadowObservationStore implements ShadowObservationStore {
  readonly #records: ShadowObservation[] = [];
  async save(observation: ShadowObservation): Promise<void> {
    if (!validateShadowObservation(observation)) throw new Error('Invalid shadow observation.');
    this.#records.push(structuredClone(observation));
  }
  async list(): Promise<readonly ShadowObservation[]> {
    return this.#records.map((record) => structuredClone(record));
  }
}

export class FileShadowObservationStore implements ShadowObservationStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  async save(observation: ShadowObservation): Promise<void> {
    if (!validateShadowObservation(observation)) throw new Error('Invalid shadow observation.');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.root, `${observation.observationId}.json`), `${JSON.stringify(observation, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  }
  async list(): Promise<readonly ShadowObservation[]> {
    const records: ShadowObservation[] = [];
    for (const name of readdirSync(this.root).filter((entry) => /^[0-9a-f]{64}\.json$/.test(entry)).sort()) {
      const parsed = JSON.parse(readFileSync(join(this.root, name), 'utf8')) as unknown;
      if (!validateShadowObservation(parsed)) throw new Error(`Invalid shadow observation file: ${name}`);
      records.push(parsed);
    }
    return records;
  }
}

export function createShadowRoutingService(options: ShadowRoutingOptions): ShadowRoutingPort {
  let enabled = false;
  let latest: ShadowObservation | undefined;

  async function evaluate(request: string, primary: CompiledWorkflow, context: WorkflowCompilerContext): Promise<ShadowObservation> {
    const primarySummary = routeSummary(primary);
    const createdAt = context.now;
    let candidate: ShadowCandidateSummary;
    let modelIdentity = 'none';

    if (primary.disclosureDecision.disclosureClass === 'LOCAL_ONLY') {
      candidate = { status: 'BLOCKED_DISCLOSURE', failureCode: 'LOCAL_ONLY' };
    } else {
      try {
        const semantic = await options.classifier.classify({
          request,
          projectRoot: context.projectRoot,
          operatorSessionId: context.operatorSessionId,
          disclosureDecision: primary.disclosureDecision,
        });
        modelIdentity = `${semantic.modelProvider}/${semantic.modelId}`;
        if (semantic.disposition === 'DO_NOT_EXECUTE' || semantic.disposition === 'NEEDS_CLARIFICATION') {
          candidate = {
            status: semantic.disposition,
            family: semantic.proposal.requestClassification,
            disposition: semantic.disposition,
            rawConfidence: semantic.rawConfidence,
            modelProvider: semantic.modelProvider,
            modelId: semantic.modelId,
          };
        } else {
          const shadowContext: WorkflowCompilerContext = {
            ...context,
            disableSemanticPrimary: true,
            operatorSessionId: `shadow:${context.operatorSessionId}`,
            graphId: `shadow:${context.graphId}`,
            gateId: `shadow:${context.gateId}`,
          };
          const compiled = await options.compileCandidate(semantic.proposal, shadowContext);
          if (!compiled.ok) {
            candidate = {
              status: 'FAILED',
              family: semantic.proposal.requestClassification,
              disposition: semantic.disposition,
              rawConfidence: semantic.rawConfidence,
              modelProvider: semantic.modelProvider,
              modelId: semantic.modelId,
              ...(typeof compiled.code === 'string' && compiled.code.length > 0 ? { failureCode: compiled.code } : {}),
            };
          } else {
            const summary = routeSummary(compiled.compiled);
            candidate = {
              status: 'COMPILED',
              family: summary.family,
              workflow: summary.workflow,
              providers: summary.providers,
              disposition: semantic.disposition,
              rawConfidence: semantic.rawConfidence,
              modelProvider: semantic.modelProvider,
              modelId: semantic.modelId,
            };
          }
        }
      } catch (error) {
        const code = error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.length > 0 ? error.code : 'SEMANTIC_CLASSIFIER_FAILED';
        candidate = { status: 'FAILED', failureCode: code };
      }
    }

    const disclosureCurationAllowed = primary.disclosureDecision.disclosureClass !== 'LOCAL_ONLY' && !primary.disclosureDecision.sensitiveSignalDetected;
    const identity = observationIdentity(request, createdAt, modelIdentity, context.operatorSessionId);
    const observation: ShadowObservation = {
      schemaVersion: '1.0',
      ...identity,
      // Raw text is retained for eval-case curation only when disclosure
      // permits leaving the local boundary; LOCAL_ONLY stays hash-only.
      ...(disclosureCurationAllowed ? { requestText: request } : {}),
      createdAt,
      primary: primarySummary,
      candidate,
      divergences: comparison(primarySummary, candidate),
      policyRefs: primary.routeDecision.policyRefs,
    };
    await options.store.save(observation);
    latest = observation;
    return observation;
  }

  return {
    setEnabled(value): void { enabled = value; },
    status(): ShadowRoutingStatus { return latest === undefined ? { enabled } : { enabled, latest }; },
    evaluate,
    async observeIfEnabled(request, primary, context): Promise<ShadowObservation | undefined> {
      return enabled ? evaluate(request, primary, context) : undefined;
    },
  };
}

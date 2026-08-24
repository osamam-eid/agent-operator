import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { AgentResultStatus, HumanDecisionRecord, TaskFamily } from './contracts.js';
import type { StoredOperatorSession } from './runtime-types.js';
import { isPlainObject } from './validation/primitives.js';

export type IntelligenceEvidenceSource = 'LIVE_SESSION' | 'EVALUATOR' | 'CANARY';
export type EvidenceAdmissionReason = 'ADMITTED' | 'DUPLICATE' | 'INCOMPLETE_SESSION' | 'UNVERIFIED_OUTCOME' | 'UNRESOLVED_MUTATION' | 'HUMAN_SIGNAL_ONLY';

export interface ProviderEvidenceObservation {
  readonly schemaVersion: '1.0';
  readonly evidenceId: string;
  readonly source: IntelligenceEvidenceSource;
  readonly sourceRef: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly role: string;
  readonly taskFamily: TaskFamily;
  readonly capabilityId: string;
  readonly outcome: AgentResultStatus;
  readonly verified: boolean;
  readonly unresolvedMutation: boolean;
  readonly qualityScore: number;
  readonly durationMs?: number;
  readonly cost?: number;
  readonly observedAt: string;
  readonly policyRefs: readonly string[];
}

export interface EvidenceAdmissionDecision {
  readonly schemaVersion: '1.0';
  readonly evidenceId: string;
  readonly admitted: boolean;
  readonly reason: EvidenceAdmissionReason;
  readonly decidedAt: string;
}

export type HumanOverrideCategory = 'GATE_APPROVAL' | 'GATE_REJECTION' | 'WORKFLOW_OVERRIDE' | 'PROVIDER_OVERRIDE' | 'ROUTE_OVERRIDE' | 'REROUTE' | 'RETRY' | 'CANCELLATION' | 'FINDING_DISPOSITION_CHANGE' | 'PROMOTION_REJECTION';

export interface HumanOverrideSignal {
  readonly schemaVersion: '1.0';
  readonly signalId: string;
  readonly sessionId: string;
  readonly gateId: string;
  readonly decisionType: HumanDecisionRecord['decisionType'];
  readonly category: HumanOverrideCategory;
  readonly outcome: HumanDecisionRecord['outcome'];
  readonly workflow: string;
  readonly taskFamily: TaskFamily;
  readonly observedAt: string;
  readonly correctnessLabel: 'UNREVIEWED';
}

export interface ProviderCanaryObservation {
  readonly schemaVersion: '1.0';
  readonly canaryId: string;
  readonly caseId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilityId: string;
  readonly taskFamily: TaskFamily;
  readonly outcome: 'PASSED' | 'FAILED' | 'BLOCKED';
  readonly qualityScore: number;
  readonly latencyMs: number;
  readonly toolReliable: boolean;
  readonly evaluatorRunRef: string;
  readonly observedAt: string;
}

export interface ProviderCompetenceSnapshot {
  readonly schemaVersion: '1.0';
  readonly providerId: string;
  readonly modelId: string;
  readonly role: string;
  readonly taskFamily: TaskFamily;
  readonly capabilityId: string;
  readonly qualifiedSampleCount: number;
  readonly successCount: number;
  readonly hardFailureCount: number;
  readonly successRate: number;
  readonly confidenceInterval: readonly [number, number];
  readonly averageQuality: number;
  readonly averageLatencyMs?: number;
  readonly costPerSuccess?: number;
  readonly confidence: 'INSUFFICIENT' | 'LOW' | 'MEDIUM' | 'HIGH';
  readonly lastQualifiedAt: string;
  readonly provenanceRefs: readonly string[];
}

export interface HumanOverrideMetrics {
  readonly total: number;
  readonly approvals: number;
  readonly rejections: number;
  readonly byCategory: Readonly<Record<HumanOverrideCategory, number>>;
}

export type IntelligenceLedgerRecord =
  | { readonly kind: 'EVIDENCE'; readonly observation: ProviderEvidenceObservation; readonly admission: EvidenceAdmissionDecision }
  | { readonly kind: 'HUMAN_OVERRIDE'; readonly signal: HumanOverrideSignal }
  | { readonly kind: 'CANARY'; readonly observation: ProviderCanaryObservation };

export interface ProviderIntelligenceStore {
  append(recordId: string, record: IntelligenceLedgerRecord): Promise<boolean>;
  list(): Promise<readonly IntelligenceLedgerRecord[]>;
}

export interface ProviderIntelligencePort {
  recordTerminalSession(record: StoredOperatorSession): Promise<void>;
  recordHumanDecision(record: StoredOperatorSession, decision: HumanDecisionRecord): Promise<void>;
  recordCanary(observation: ProviderCanaryObservation): Promise<void>;
  scorecards(providerId?: string, modelId?: string): Promise<readonly ProviderCompetenceSnapshot[]>;
  overrideMetrics(): Promise<HumanOverrideMetrics>;
  status(): Promise<{ readonly evidence: number; readonly admitted: number; readonly overrides: number; readonly canaries: number }>;
}

export function validateIntelligenceLedgerRecord(value: unknown): value is IntelligenceLedgerRecord {
  if (!isPlainObject(value) || typeof value['kind'] !== 'string') return false;
  if (value['kind'] === 'EVIDENCE') {
    const observation = value['observation'];
    const admission = value['admission'];
    return isPlainObject(observation)
      && observation['schemaVersion'] === '1.0'
      && typeof observation['evidenceId'] === 'string'
      && /^[0-9a-f]{64}$/.test(observation['evidenceId'])
      && typeof observation['providerId'] === 'string'
      && typeof observation['modelId'] === 'string'
      && typeof observation['role'] === 'string'
      && typeof observation['taskFamily'] === 'string'
      && typeof observation['capabilityId'] === 'string'
      && typeof observation['outcome'] === 'string'
      && typeof observation['verified'] === 'boolean'
      && typeof observation['unresolvedMutation'] === 'boolean'
      && typeof observation['qualityScore'] === 'number'
      && typeof observation['observedAt'] === 'string'
      && Array.isArray(observation['policyRefs'])
      && isPlainObject(admission)
      && admission['schemaVersion'] === '1.0'
      && admission['evidenceId'] === observation['evidenceId']
      && typeof admission['admitted'] === 'boolean'
      && typeof admission['reason'] === 'string'
      && typeof admission['decidedAt'] === 'string';
  }
  if (value['kind'] === 'HUMAN_OVERRIDE') {
    const signal = value['signal'];
    return isPlainObject(signal)
      && signal['schemaVersion'] === '1.0'
      && typeof signal['signalId'] === 'string'
      && /^[0-9a-f]{64}$/.test(signal['signalId'])
      && typeof signal['sessionId'] === 'string'
      && typeof signal['gateId'] === 'string'
      && typeof signal['category'] === 'string'
      && typeof signal['outcome'] === 'string'
      && signal['correctnessLabel'] === 'UNREVIEWED';
  }
  if (value['kind'] === 'CANARY') {
    const observation = value['observation'];
    return isPlainObject(observation)
      && observation['schemaVersion'] === '1.0'
      && typeof observation['canaryId'] === 'string'
      && /^[0-9a-f]{64}$/.test(observation['canaryId'])
      && typeof observation['providerId'] === 'string'
      && typeof observation['modelId'] === 'string'
      && typeof observation['outcome'] === 'string'
      && typeof observation['qualityScore'] === 'number'
      && typeof observation['latencyMs'] === 'number'
      && typeof observation['toolReliable'] === 'boolean';
  }
  return false;
}

function digest(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

function terminalState(state: StoredOperatorSession['session']['currentState']): boolean {
  return state === 'COMPLETED' || state === 'FAILED' || state === 'BLOCKED' || state === 'CANCELLED';
}

function admissionFor(observation: ProviderEvidenceObservation, complete: boolean): EvidenceAdmissionDecision {
  let reason: EvidenceAdmissionReason = 'ADMITTED';
  if (!complete) reason = 'INCOMPLETE_SESSION';
  else if (!observation.verified) reason = 'UNVERIFIED_OUTCOME';
  else if (observation.unresolvedMutation) reason = 'UNRESOLVED_MUTATION';
  return { schemaVersion: '1.0', evidenceId: observation.evidenceId, admitted: reason === 'ADMITTED', reason, decidedAt: observation.observedAt };
}

function wilson(successes: number, total: number): readonly [number, number] {
  if (total === 0) return [0, 1];
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export class MemoryProviderIntelligenceStore implements ProviderIntelligenceStore {
  readonly #records = new Map<string, IntelligenceLedgerRecord>();
  async append(recordId: string, record: IntelligenceLedgerRecord): Promise<boolean> {
    if (!validateIntelligenceLedgerRecord(record)) throw new Error('Invalid provider intelligence record.');
    if (this.#records.has(recordId)) return false;
    this.#records.set(recordId, structuredClone(record));
    return true;
  }
  async list(): Promise<readonly IntelligenceLedgerRecord[]> {
    return [...this.#records.values()].map((record) => structuredClone(record));
  }
}

export class FileProviderIntelligenceStore implements ProviderIntelligenceStore {
  constructor(readonly root: string) { mkdirSync(root, { recursive: true, mode: 0o700 }); }
  async append(recordId: string, record: IntelligenceLedgerRecord): Promise<boolean> {
    if (!validateIntelligenceLedgerRecord(record)) throw new Error('Invalid provider intelligence record.');
    if (!/^[0-9a-f]{64}$/.test(recordId)) throw new Error('Invalid intelligence record id.');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(join(this.root, `${recordId}.json`), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      return true;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
      throw error;
    }
  }
  async list(): Promise<readonly IntelligenceLedgerRecord[]> {
    return readdirSync(this.root).filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort().map((name) => {
      const parsed = JSON.parse(readFileSync(join(this.root, name), 'utf8')) as unknown;
      if (!validateIntelligenceLedgerRecord(parsed)) throw new Error(`Invalid provider intelligence record: ${name}`);
      return parsed;
    });
  }
}

export function createProviderIntelligenceService(store: ProviderIntelligenceStore): ProviderIntelligencePort {
  return {
    async recordTerminalSession(record): Promise<void> {
      const session = record.session;
      const graph = session.executionGraph;
      const route = session.routeDecision;
      if (graph === null || route === null) return;
      const complete = terminalState(session.currentState);
      for (const [nodeId, refs] of Object.entries(record.nodeResultRefs)) {
        const node = graph.nodes.find((candidate) => candidate.nodeId === nodeId);
        if (node === undefined) continue;
        const durationMs = Math.max(0, Date.parse(refs.completedAt) - Date.parse(refs.startedAt));
        const evidenceId = digest([session.operatorSessionId, nodeId, refs.providerSessionId, refs.completedAt]);
        const observation: ProviderEvidenceObservation = {
          schemaVersion: '1.0',
          evidenceId,
          source: 'LIVE_SESSION',
          sourceRef: `${session.operatorSessionId}:${nodeId}`,
          providerId: refs.modelProvider,
          modelId: refs.modelId,
          role: node.role,
          taskFamily: route.requestClassification,
          capabilityId: node.capabilityId,
          outcome: refs.status,
          verified: complete,
          unresolvedMutation: node.mutation !== undefined && refs.status !== 'SUCCEEDED',
          qualityScore: refs.status === 'SUCCEEDED' ? 1 : 0,
          durationMs,
          ...(refs.usage?.cost === null || refs.usage?.cost === undefined ? {} : { cost: refs.usage.cost }),
          observedAt: refs.completedAt,
          policyRefs: [...new Set([...route.policyRefs, ...refs.policyRefs])],
        };
        const admission = admissionFor(observation, complete);
        await store.append(evidenceId, { kind: 'EVIDENCE', observation, admission });
      }
    },
    async recordHumanDecision(record, decision): Promise<void> {
      const route = record.session.routeDecision;
      if (route === null) return;
      const signalId = digest([record.session.operatorSessionId, decision.gateId, decision.decidedAt, decision.outcome]);
      const signal: HumanOverrideSignal = {
        schemaVersion: '1.0',
        signalId,
        sessionId: record.session.operatorSessionId,
        gateId: decision.gateId,
        decisionType: decision.decisionType,
        category: decision.outcome === 'REJECTED' ? 'GATE_REJECTION' : 'GATE_APPROVAL',
        outcome: decision.outcome,
        workflow: route.selectedWorkflow,
        taskFamily: route.requestClassification,
        observedAt: decision.decidedAt,
        correctnessLabel: 'UNREVIEWED',
      };
      await store.append(signalId, { kind: 'HUMAN_OVERRIDE', signal });
    },
    async recordCanary(observation): Promise<void> {
      await store.append(observation.canaryId, { kind: 'CANARY', observation });
    },
    async scorecards(providerId, modelId): Promise<readonly ProviderCompetenceSnapshot[]> {
      const evidence = (await store.list()).flatMap((record) => record.kind === 'EVIDENCE' && record.admission.admitted ? [record.observation] : []);
      const groups = new Map<string, ProviderEvidenceObservation[]>();
      for (const item of evidence) {
        if (providerId !== undefined && item.providerId !== providerId) continue;
        if (modelId !== undefined && item.modelId !== modelId) continue;
        const key = [item.providerId, item.modelId, item.role, item.taskFamily, item.capabilityId].join('\u0000');
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      return [...groups.values()].map((items) => {
        const first = items[0]!;
        const successes = items.filter((item) => item.outcome === 'SUCCEEDED').length;
        const hardFailures = items.filter((item) => item.outcome === 'FAILED' || item.outcome === 'BLOCKED' || item.outcome === 'UNKNOWN').length;
        const interval = wilson(successes, items.length);
        const totalCost = items.reduce((sum, item) => sum + (item.cost ?? 0), 0);
        const width = interval[1] - interval[0];
        return {
          schemaVersion: '1.0',
          providerId: first.providerId,
          modelId: first.modelId,
          role: first.role,
          taskFamily: first.taskFamily,
          capabilityId: first.capabilityId,
          qualifiedSampleCount: items.length,
          successCount: successes,
          hardFailureCount: hardFailures,
          successRate: successes / items.length,
          confidenceInterval: interval,
          averageQuality: items.reduce((sum, item) => sum + item.qualityScore, 0) / items.length,
          averageLatencyMs: items.reduce((sum, item) => sum + (item.durationMs ?? 0), 0) / items.length,
          ...(successes === 0 ? {} : { costPerSuccess: totalCost / successes }),
          confidence: items.length < 10 ? 'INSUFFICIENT' : width > 0.5 ? 'LOW' : width > 0.25 ? 'MEDIUM' : 'HIGH',
          lastQualifiedAt: items.map((item) => item.observedAt).sort().at(-1)!,
          provenanceRefs: items.map((item) => item.sourceRef).sort(),
        } satisfies ProviderCompetenceSnapshot;
      }).sort((a, b) => `${a.providerId}/${a.modelId}/${a.role}/${a.taskFamily}/${a.capabilityId}`.localeCompare(`${b.providerId}/${b.modelId}/${b.role}/${b.taskFamily}/${b.capabilityId}`));
    },
    async overrideMetrics(): Promise<HumanOverrideMetrics> {
      const signals = (await store.list()).flatMap((record) => record.kind === 'HUMAN_OVERRIDE' ? [record.signal] : []);
      const byCategory: Record<HumanOverrideCategory, number> = { GATE_APPROVAL: 0, GATE_REJECTION: 0, WORKFLOW_OVERRIDE: 0, PROVIDER_OVERRIDE: 0, ROUTE_OVERRIDE: 0, REROUTE: 0, RETRY: 0, CANCELLATION: 0, FINDING_DISPOSITION_CHANGE: 0, PROMOTION_REJECTION: 0 };
      for (const signal of signals) byCategory[signal.category] += 1;
      return { total: signals.length, approvals: signals.filter((signal) => signal.outcome === 'APPROVED').length, rejections: signals.filter((signal) => signal.outcome === 'REJECTED').length, byCategory };
    },
    async status() {
      const records = await store.list();
      return {
        evidence: records.filter((record) => record.kind === 'EVIDENCE').length,
        admitted: records.filter((record) => record.kind === 'EVIDENCE' && record.admission.admitted).length,
        overrides: records.filter((record) => record.kind === 'HUMAN_OVERRIDE').length,
        canaries: records.filter((record) => record.kind === 'CANARY').length,
      };
    },
  };
}

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PredictionDimension } from './intelligence-activation.js';


/** One raw model prediction recorded before any outcome label exists.
 * Labels are added later by explicit human curation only. */
export interface PredictionRecord {
  readonly schemaVersion: '1.0';
  readonly predictionId: string;
  readonly dimension: PredictionDimension;
  readonly predictionIdentity: string;
  /** Uncalibrated confidence in [0,1]. */
  readonly rawConfidence: number;
  /** Chosen value at prediction time (e.g. the selected task family). */
  readonly chosen: string;
  readonly operatorSessionId?: string;
  readonly observedAt: string;
  /** Absent until a human curates a label; never model-derived. */
  readonly labeledCorrect?: boolean;
  readonly labeledAt?: string;
}

export interface PredictionLedger {
  append(record: PredictionRecord): Promise<void>;
  list(): Promise<readonly PredictionRecord[]>;
  label(predictionId: string, correct: boolean, now: string): Promise<boolean>;
}

export function validatePredictionRecord(value: unknown): value is PredictionRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record['schemaVersion'] === '1.0'
    && typeof record['predictionId'] === 'string'
    && typeof record['dimension'] === 'string'
    && typeof record['predictionIdentity'] === 'string'
    && typeof record['rawConfidence'] === 'number' && record['rawConfidence'] >= 0 && record['rawConfidence'] <= 1
    && typeof record['chosen'] === 'string'
    && typeof record['observedAt'] === 'string'
    && (record['labeledCorrect'] === undefined || typeof record['labeledCorrect'] === 'boolean')
    && (record['labeledAt'] === undefined || typeof record['labeledAt'] === 'string');
}

export class MemoryPredictionLedger implements PredictionLedger {
  readonly #records = new Map<string, PredictionRecord>();
  async append(record: PredictionRecord): Promise<void> {
    if (!validatePredictionRecord(record)) throw new Error('Invalid prediction record.');
    this.#records.set(record.predictionId, structuredClone(record));
  }
  async list(): Promise<readonly PredictionRecord[]> { return [...this.#records.values()].map((record) => structuredClone(record)); }
  async label(predictionId: string, correct: boolean, now: string): Promise<boolean> {
    const existing = this.#records.get(predictionId);
    if (existing === undefined) return false;
    this.#records.set(predictionId, { ...structuredClone(existing), labeledCorrect: correct, labeledAt: now });
    return true;
  }
}

/** Append-only JSONL ledger; one record per line so concurrent appends and
 * crash-truncation cannot corrupt earlier entries. */
export class FilePredictionLedger implements PredictionLedger {
  readonly #path: string;
  constructor(rootDir: string) {
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
    this.#path = join(rootDir, 'predictions.jsonl');
  }
  async append(record: PredictionRecord): Promise<void> {
    if (!validatePredictionRecord(record)) throw new Error('Invalid prediction record.');
    writeFileSync(this.#path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  }
  async list(): Promise<readonly PredictionRecord[]> {
    let raw = '';
    try { raw = readFileSync(this.#path, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const records: PredictionRecord[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      const parsed: unknown = JSON.parse(line);
      if (!validatePredictionRecord(parsed)) throw new Error(`Invalid prediction record line for ${String((parsed as PredictionRecord).predictionId)}`);
      records.push(parsed);
    }
    return records;
  }
  async label(predictionId: string, correct: boolean, now: string): Promise<boolean> {
    const records = await this.list();
    let found = false;
    const rewritten = records.map((record) => {
      if (record.predictionId !== predictionId) return record;
      found = true;
      return { ...record, labeledCorrect: correct, labeledAt: now };
    });
    if (!found) return false;
    const tmpPath = `${this.#path}.tmp`;
    writeFileSync(tmpPath, rewritten.map((record) => JSON.stringify(record)).join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    writeFileSync(this.#path, readFileSync(tmpPath), { encoding: 'utf8', mode: 0o600, flag: 'w' });
    return true;
  }
}

export function makePredictionRecord(input: {
  readonly dimension: PredictionDimension;
  readonly predictionIdentity: string;
  readonly rawConfidence: number;
  readonly chosen: string;
  readonly operatorSessionId?: string;
  readonly observedAt: string;
}): PredictionRecord {
  if (!Number.isFinite(input.rawConfidence) || input.rawConfidence < 0 || input.rawConfidence > 1) throw new Error('Prediction confidence must be within [0,1].');
  const identitySource = [input.dimension, input.predictionIdentity, String(input.rawConfidence), input.chosen, input.observedAt].join('\u0000');
  return {
    schemaVersion: '1.0',
    predictionId: createHash('sha256').update(identitySource, 'utf8').digest('hex'),
    dimension: input.dimension,
    predictionIdentity: input.predictionIdentity,
    rawConfidence: input.rawConfidence,
    chosen: input.chosen,
    ...(input.operatorSessionId === undefined ? {} : { operatorSessionId: input.operatorSessionId }),
    observedAt: input.observedAt,
  };
}

import { createHash } from 'node:crypto';

import type { Stage7FeatureSet } from './types.js';

const STAGE7_ENVIRONMENT_FLAG = 'OMP_AGENT_OPERATOR_ENABLE_STAGE7';
const STAGE9_ENVIRONMENT_FLAG = 'OMP_AGENT_OPERATOR_ENABLE_STAGE9_EXTERNAL_PROVIDERS';
const STAGE10_ENVIRONMENT_FLAG = 'OMP_AGENT_OPERATOR_ENABLE_STAGE10_EVALUATOR';
const TRUE_VALUES = new Set(['1', 'true', 'enabled']);

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export function hashStage7FeatureSet(input: Omit<Stage7FeatureSet, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

export function createStage7FeatureSet(stage7Enabled: boolean, trustedStartup = false, stage9ExternalProviders = false, stage10Gym = false): Stage7FeatureSet {
  if ((stage7Enabled || stage9ExternalProviders || stage10Gym) && !trustedStartup) {
    throw new Error('Stage-7/Stage-9/Stage-10 features can only be enabled by trusted startup configuration.');
  }
  const base = {
    stage7Enabled,
    stage8PublicationEnabled: false as const,
    stage9ExternalProvidersEnabled: stage9ExternalProviders,
    stage10EvaluatorEnabled: stage10Gym,
    stage11QualificationEnabled: false as const,
  };
  return { ...base, hash: hashStage7FeatureSet(base) };
}

/** Reads the startup flag once. Workflow input, model output, artifacts, and
 * resumed state are intentionally not inputs to this function. */
export function readTrustedStage7StartupFeatureSet(env: Readonly<Record<string, string | undefined>> = process.env): Stage7FeatureSet {
  return createStage7FeatureSet(TRUE_VALUES.has(env[STAGE7_ENVIRONMENT_FLAG]?.toLowerCase() ?? ''), true, TRUE_VALUES.has(env[STAGE9_ENVIRONMENT_FLAG]?.toLowerCase() ?? ''), TRUE_VALUES.has(env[STAGE10_ENVIRONMENT_FLAG]?.toLowerCase() ?? ''));
}

export function assertStage7FeatureSetMatch(expectedHash: string | undefined, current: Stage7FeatureSet | undefined): void {
  const currentHash = current?.hash;
  if (expectedHash !== currentHash) {
    throw new Stage7FeatureSetMismatchError(expectedHash, currentHash);
  }
}

export class Stage7FeatureSetMismatchError extends Error {
  readonly expectedHash: string | undefined;
  readonly currentHash: string | undefined;

  constructor(expectedHash: string | undefined, currentHash: string | undefined) {
    super(`Startup feature-set hash mismatch: persisted=${expectedHash ?? '<absent>'}, current=${currentHash ?? '<absent>'}. Resume is refused.`);
    this.name = 'Stage7FeatureSetMismatchError';
    this.expectedHash = expectedHash;
    this.currentHash = currentHash;
  }
}

export type Stage7LaterFeature = 'publication' | 'external-providers' | 'evaluator' | 'qualification';
export class Stage7FeatureDisabledError extends Error {
  readonly feature: Stage7LaterFeature;
  constructor(feature: Stage7LaterFeature) {
    super(`Feature "${feature}" is disabled and unavailable in Work Package 7A.`);
    this.name = 'Stage7FeatureDisabledError';
    this.feature = feature;
  }
}

export function assertStage7LaterFeatureDisabled(featureSet: Stage7FeatureSet, feature: Stage7LaterFeature): void {
  const enabled = feature === 'publication'
    ? featureSet.stage8PublicationEnabled
    : feature === 'external-providers'
      ? featureSet.stage9ExternalProvidersEnabled
      : feature === 'evaluator'
        ? featureSet.stage10EvaluatorEnabled
        : featureSet.stage11QualificationEnabled;
  if (!enabled) throw new Stage7FeatureDisabledError(feature);
}

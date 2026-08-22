import * as nodePath from 'node:path';

import type {
  CapabilityRecord,
  ExecutionShape,
  HealthStatus,
  ModelTier,
  MutationClass,
} from './contracts.js';
import { SECRET_PATTERN } from './stage7/qa/evidence.js';

export type ProviderKind = 'omp-native' | 'external-cli';
export type ProviderHealth = HealthStatus;
export type ProviderAuthStatus = 'AUTHENTICATED' | 'UNAUTHENTICATED' | 'UNKNOWN';

export interface ProviderModelDescriptor {
  readonly id: string;
  readonly tier: ModelTier;
  readonly disclosed: boolean;
  readonly capabilities: readonly string[];
  readonly costClass: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly latencyClass: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface NormalizedProviderRecord {
  readonly providerId: string;
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly source: string;
  readonly health: ProviderHealth;
  readonly auth: ProviderAuthStatus;
  readonly capabilities: readonly string[];
  readonly models: readonly ProviderModelDescriptor[];
  readonly supports: readonly ExecutionShape[];
  readonly mutability: 'READ_ONLY' | 'MUTATING';
  readonly tools: readonly string[];
  readonly concurrency: number;
  readonly binary?: string;
  readonly sha256?: string;
  /** Strict spawn template for external-cli providers; known placeholders only: {prompt}, {sessionId}. */
  readonly argvTemplate: readonly string[];
  /** Names of process-env variables forwarded to the spawned CLI; never values from the catalog. */
  readonly envAllowlist: readonly string[];
}

export interface ProviderCatalog {
  readonly schemaVersion: '1.0';
  readonly generatedAt: string;
  readonly records: readonly NormalizedProviderRecord[];
}

export interface ProviderPreferencePolicy {
  readonly preferredProvider?: string;
  readonly preferredModel?: string;
  readonly fallbackProviders: readonly string[];
  readonly allowExternalProviders: boolean;
  readonly allowUndisclosedModels: boolean;
  readonly fallbackPolicy: 'COMPATIBLE_ONLY' | 'HUMAN_REQUIRED' | 'DISABLED';
}

export interface ProviderSelectionRequest {
  readonly role: string;
  readonly capability: string;
  readonly executionShape: 'SINGLE' | 'PARALLEL' | 'PIPELINE';
  readonly mutationClass: MutationClass;
  readonly minimumModelTier?: ModelTier;
  readonly requiredTools?: readonly string[];
  /** Compiled node tool ceiling (Stage 9): a candidate declaring any tool outside it is rejected with PRIVILEGE_ESCALATION instead of silently skipped. */
  readonly toolCeiling?: readonly string[];
  readonly preference: ProviderPreferencePolicy;
}

export interface ProviderSelection {
  readonly role: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilityId: string;
  readonly fallbackFrom?: string;
  readonly reasonCode: string;
  readonly humanRequired: boolean;
}

export type ProviderSelectionErrorCode =
  | 'CATALOG_INVALID'
  | 'NO_COMPATIBLE_PROVIDER'
  | 'PREFERENCE_REQUIRED'
  | 'FALLBACK_DISABLED'
  | 'EXTERNAL_PROVIDER_DISABLED'
  | 'MODEL_UNDISCLOSED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PRIVILEGE_ESCALATION';

export class ProviderSelectionError extends Error {
  readonly code: ProviderSelectionErrorCode;
  constructor(code: ProviderSelectionErrorCode, message: string) { super(message); this.name = 'ProviderSelectionError'; this.code = code; }
}

const MODEL_TIERS: readonly ModelTier[] = ['LOW', 'MEDIUM', 'HIGH'];
const EXECUTION_SHAPES: readonly ExecutionShape[] = ['SINGLE', 'PARALLEL', 'PIPELINE'];
const PROVIDER_HEALTH: readonly ProviderHealth[] = ['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN'];

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') throw new ProviderSelectionError('CATALOG_INVALID', `${path}.${key} must be a non-empty string`);
  return value;
}
function enumValue<T extends string>(value: unknown, values: readonly T[], path: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new ProviderSelectionError('CATALOG_INVALID', `${path} has an invalid value`);
  return value as T;
}
function stringList(value: unknown, path: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) throw new ProviderSelectionError('CATALOG_INVALID', `${path} must be a string array`);
  return [...new Set(value)];
}

export function normalizeProviderCatalog(input: unknown, generatedAt: string): ProviderCatalog {
  if (!isRecord(input) || !Array.isArray(input['providers'])) throw new ProviderSelectionError('CATALOG_INVALID', 'Provider discovery must return an object with providers[]');
  const records = input['providers'].map((raw, index) => {
    const path = `providers[${index}]`;
    if (!isRecord(raw)) throw new ProviderSelectionError('CATALOG_INVALID', `${path} must be an object`);
    const providerId = requiredString(raw, 'providerId', path);
    const kind = enumValue(raw['kind'], ['omp-native', 'external-cli'] as const, `${path}.kind`);
    const modelsRaw = raw['models'];
    if (!Array.isArray(modelsRaw)) throw new ProviderSelectionError('CATALOG_INVALID', `${path}.models must be an array`);
    const models = modelsRaw.map((model, modelIndex): ProviderModelDescriptor => {
      const modelPath = `${path}.models[${modelIndex}]`;
      if (!isRecord(model)) throw new ProviderSelectionError('CATALOG_INVALID', `${modelPath} must be an object`);
      return {
        id: requiredString(model, 'id', modelPath),
        tier: enumValue(model['tier'], MODEL_TIERS, `${modelPath}.tier`),
        disclosed: model['disclosed'] === true,
        capabilities: stringList(model['capabilities'], `${modelPath}.capabilities`),
        costClass: enumValue(model['costClass'], ['LOW', 'MEDIUM', 'HIGH'] as const, `${modelPath}.costClass`),
        latencyClass: enumValue(model['latencyClass'], ['LOW', 'MEDIUM', 'HIGH'] as const, `${modelPath}.latencyClass`),
      };
    });
    const concurrency = raw['concurrency'];
    if (typeof concurrency !== 'number' || !Number.isInteger(concurrency) || concurrency < 1) throw new ProviderSelectionError('CATALOG_INVALID', `${path}.concurrency must be a positive integer`);
    const binary = typeof raw['binary'] === 'string' ? raw['binary'] : undefined;
    const sha256 = typeof raw['sha256'] === 'string' ? raw['sha256'] : undefined;
    if (kind === 'external-cli') {
      if (binary === undefined || !nodePath.isAbsolute(binary)) throw new ProviderSelectionError('CATALOG_INVALID', `${path}.binary must be an absolute path for external-cli providers`);
      if (sha256 === undefined || /^[0-9a-f]{64}$/.test(sha256) === false) throw new ProviderSelectionError('CATALOG_INVALID', `${path}.sha256 must be a 64-hex binary pin for external-cli providers`);
    }
    if (kind === 'omp-native' && (binary !== undefined || sha256 !== undefined)) throw new ProviderSelectionError('CATALOG_INVALID', `${path}.binary/sha256 must be absent for omp-native providers`);
    const argvTemplate = stringList(raw['argvTemplate'] ?? ['{prompt}'], `${path}.argvTemplate`);
    for (const entry of argvTemplate) {
      const stripped = entry.replace(/\{(?:prompt|sessionId)\}/g, '');
      if (stripped.includes('{') || stripped.includes('}')) throw new ProviderSelectionError('CATALOG_INVALID', `${path}.argvTemplate may only contain {prompt} and {sessionId} placeholders`);
    }
    const envAllowlist = stringList(raw['envAllowlist'] ?? [], `${path}.envAllowlist`);
    if (envAllowlist.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))) throw new ProviderSelectionError('CATALOG_INVALID', `${path}.envAllowlist names must be valid environment-variable identifiers`);
    if (envAllowlist.includes('PATH')) throw new ProviderSelectionError('CATALOG_INVALID', `${path}.envAllowlist must not forward PATH`);
    const record: NormalizedProviderRecord = {
      providerId,
      kind,
      displayName: requiredString(raw, 'displayName', path),
      source: requiredString(raw, 'source', path),
      health: enumValue(raw['health'], PROVIDER_HEALTH, `${path}.health`),
      auth: enumValue(raw['auth'], ['AUTHENTICATED', 'UNAUTHENTICATED', 'UNKNOWN'] as const, `${path}.auth`),
      capabilities: stringList(raw['capabilities'], `${path}.capabilities`),
      models,
      supports: stringList(raw['supports'], `${path}.supports`).map((value) => enumValue(value, EXECUTION_SHAPES, `${path}.supports`)),
      mutability: enumValue(raw['mutability'], ['READ_ONLY', 'MUTATING'] as const, `${path}.mutability`),
      tools: stringList(raw['tools'], `${path}.tools`),
      concurrency,
      ...(binary !== undefined ? { binary } : {}),
      ...(sha256 !== undefined ? { sha256 } : {}),
      argvTemplate,
      envAllowlist,
    };
    auditProviderRecordSecrets(record, path);
    return record;
  });
  const ids = new Set<string>();
  for (const record of records) { if (ids.has(record.providerId)) throw new ProviderSelectionError('CATALOG_INVALID', `Duplicate provider ${record.providerId}`); ids.add(record.providerId); }
  return { schemaVersion: '1.0', generatedAt, records };
}

function tierAtLeast(actual: ModelTier, minimum: ModelTier | undefined): boolean {
  return minimum === undefined || MODEL_TIERS.indexOf(actual) >= MODEL_TIERS.indexOf(minimum);
}

function compatible(record: NormalizedProviderRecord, model: ProviderModelDescriptor, request: ProviderSelectionRequest): boolean {
  const requiredTools = request.requiredTools ?? [];
  return record.health === 'HEALTHY' && record.auth === 'AUTHENTICATED' && record.capabilities.includes(request.capability) && record.supports.includes(request.executionShape) && requiredTools.every((tool) => record.tools.includes(tool)) && tierAtLeast(model.tier, request.minimumModelTier) && (request.mutationClass === 'READ_ONLY' ? record.mutability === 'READ_ONLY' : record.mutability === 'MUTATING') && (model.disclosed || request.preference.allowUndisclosedModels);
}

function candidateOrder(request: ProviderSelectionRequest): readonly string[] {
  const preferred = request.preference.preferredProvider === undefined ? [] : [request.preference.preferredProvider];
  return [...new Set([...preferred, ...request.preference.fallbackProviders])];
}

export function selectProviderRecord(catalog: ProviderCatalog, request: ProviderSelectionRequest): { readonly selection: ProviderSelection; readonly record: NormalizedProviderRecord; readonly model: ProviderModelDescriptor } {
  const explicitOrder = candidateOrder(request);
  const metadataInsufficient = request.preference.preferredProvider === undefined && request.preference.preferredModel === undefined;
  if (metadataInsufficient && catalog.records.filter((record) => record.health === 'HEALTHY').length > 1) throw new ProviderSelectionError('PREFERENCE_REQUIRED', `Provider preference is required for role ${request.role}; competence metadata is insufficient for safe automatic selection.`);
  const ordered = request.preference.fallbackPolicy !== 'COMPATIBLE_ONLY'
    ? (request.preference.preferredProvider === undefined ? [] : [request.preference.preferredProvider])
    : (explicitOrder.length > 0 ? explicitOrder : catalog.records.map((record) => record.providerId).sort());
  const attempts = ordered.map((providerId) => {
    const record = catalog.records.find((candidate) => candidate.providerId === providerId);
    if (record === undefined) return undefined;
    if (record.kind === 'external-cli' && !request.preference.allowExternalProviders) throw new ProviderSelectionError('EXTERNAL_PROVIDER_DISABLED', `External provider ${providerId} is disabled by policy.`);
    const toolCeiling = request.toolCeiling;
    if (toolCeiling !== undefined && record.tools.some((tool) => !toolCeiling.includes(tool))) throw new ProviderSelectionError('PRIVILEGE_ESCALATION', `Provider ${providerId} declares tools outside the compiled ceiling for ${request.role}.`);
    if (record.mutability === 'MUTATING') throw new ProviderSelectionError('PRIVILEGE_ESCALATION', `Mutating external provider ${providerId} cannot be selected; Stage-9 fleet execution is READ_ONLY.`);
    const model = record.models.find((candidate) => (request.preference.preferredModel === undefined || candidate.id === request.preference.preferredModel) && compatible(record, candidate, request));
    return model === undefined ? undefined : { record, model };
  }).filter((entry): entry is { readonly record: NormalizedProviderRecord; readonly model: ProviderModelDescriptor } => entry !== undefined);
  const selected = attempts[0];
  if (selected === undefined) {
    if (request.preference.fallbackPolicy === 'DISABLED') throw new ProviderSelectionError('FALLBACK_DISABLED', `No compatible preferred provider for ${request.role}; fallback is disabled.`);
    if (request.preference.fallbackPolicy === 'HUMAN_REQUIRED') throw new ProviderSelectionError('PREFERENCE_REQUIRED', `No compatible preferred provider for ${request.role}; human provider selection is required.`);
    throw new ProviderSelectionError('NO_COMPATIBLE_PROVIDER', `No compatible provider/model exists for ${request.role}.`);
  }
  const preferred = request.preference.preferredProvider;
  const fallbackFrom = preferred !== undefined && selected.record.providerId !== preferred ? preferred : undefined;
  const selection: ProviderSelection = { role: request.role, providerId: selected.record.providerId, modelId: selected.model.id, capabilityId: `${selected.record.providerId}:${request.capability}`, ...(fallbackFrom !== undefined ? { fallbackFrom } : {}), reasonCode: fallbackFrom === undefined ? 'PREFERRED_COMPATIBLE' : 'DISPATCH_FALLBACK_COMPATIBLE', humanRequired: false };
  return { selection, record: selected.record, model: selected.model };
}

export function selectProvider(catalog: ProviderCatalog, request: ProviderSelectionRequest): ProviderSelection {
  return selectProviderRecord(catalog, request).selection;
}

/** Inverse of `capabilityRecordToProviderRecord`: builds the compiled-graph
 * CapabilityRecord a fleet selection persists, keeping binary/sha256 only
 * for external-cli providers. */
export function normalizedProviderToCapabilityRecord(record: NormalizedProviderRecord, model: ProviderModelDescriptor, capability: string): CapabilityRecord {
  return {
    id: `${record.providerId}:${capability}`,
    kind: record.kind === 'external-cli' ? 'external-cli' : 'omp-role',
    capabilities: [capability],
    mutability: record.mutability,
    modelTiers: [model.tier],
    tools: [...record.tools],
    spawns: record.kind === 'external-cli',
    supports: [...record.supports],
    ...(record.binary !== undefined ? { binary: record.binary } : {}),
    ...(record.sha256 !== undefined ? { sha256: record.sha256 } : {}),
    costClass: model.costClass,
    latencyClass: model.latencyClass,
    concurrency: record.concurrency,
    health: record.health,
    source: `fleet-catalog:${record.providerId}`,
  };
}

function auditProviderRecordSecrets(record: NormalizedProviderRecord, at: string): void {
  const scalars: readonly string[] = [record.providerId, record.displayName, record.source, ...(record.binary === undefined ? [] : [record.binary]), ...(record.sha256 === undefined ? [] : [record.sha256])];
  const lists: readonly string[] = [...record.capabilities, ...record.tools, ...record.models.flatMap((model) => [model.id])];
  for (const value of [...scalars, ...lists]) {
    if (SECRET_PATTERN.test(value)) throw new ProviderSelectionError('CATALOG_INVALID', `${at} contains a credential-bearing pattern`);
  }
}

export interface ProviderDiscoverySource { discover(): Promise<unknown>; }
export interface ProviderFleet { discover(): Promise<ProviderCatalog>; select(request: ProviderSelectionRequest): Promise<ProviderSelection>; }

export function createProviderFleet(sources: readonly ProviderDiscoverySource[], clock: () => string): ProviderFleet {
  let catalog: ProviderCatalog | undefined;
  return {
    async discover(): Promise<ProviderCatalog> {
      const discovered = await Promise.all(sources.map((source) => source.discover()));
      const merged = { providers: discovered.flatMap((entry) => isRecord(entry) && Array.isArray(entry['providers']) ? entry['providers'] : []) };
      catalog = normalizeProviderCatalog(merged, clock());
      return catalog;
    },
    async select(request): Promise<ProviderSelection> {
      const current = catalog ?? await this.discover();
      return selectProvider(current, request);
    },
  };
}

export function capabilityRecordToProviderRecord(record: CapabilityRecord, providerId: string, modelId: string): NormalizedProviderRecord {
  return {
    providerId,
    kind: record.kind === 'external-cli' ? 'external-cli' : 'omp-native',
    displayName: providerId,
    source: record.source,
    health: record.health,
    auth: 'UNKNOWN',
    capabilities: record.capabilities,
    models: [{ id: modelId, tier: record.modelTiers[0] ?? 'LOW', disclosed: true, capabilities: record.capabilities, costClass: record.costClass, latencyClass: record.latencyClass }],
    supports: record.supports,
    mutability: record.mutability,
    tools: record.tools,
    concurrency: record.concurrency,
    ...(record.binary !== undefined ? { binary: record.binary } : {}),
    argvTemplate: ['{prompt}'],
    envAllowlist: [],
  };
}

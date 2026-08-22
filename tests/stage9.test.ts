import { describe, expect, test } from 'bun:test';

import type { NodeExecutionAdapter } from '../src/runtime-types.js';
import { createStage7FeatureSet, readTrustedStage7StartupFeatureSet } from '../src/stage7/feature-config.js';
import { createNodeExecutionAdapterResolver, Stage7RouteResolutionError } from '../src/stage7/index.js';
import { getWorkflowTemplateById } from '../src/workflow-templates.js';
import { normalizeProviderCatalog, normalizedProviderToCapabilityRecord, ProviderSelectionError, selectProviderRecord } from '../src/provider-fleet.js';
import { validateCapabilityRecord } from '../src/validation/core-contracts.js';

const fleetAdapter: NodeExecutionAdapter = {
  adapterId: 'external-cli',
  launchBatch: () => {
    throw new Error('fixture fleet adapter must not launch.');
  },
};

const frozenOmpTask: NodeExecutionAdapter = {
  adapterId: 'omp-task',
  launchBatch: () => {
    throw new Error('fixture frozen adapter must not launch.');
  },
};

const fleetTuple = { workflowTemplateId: 'fleet.v1', nodeId: 'fleet-task', role: 'fleet-v1-executor', capabilityId: 'stage7-impeccable', requiredCapability: 'fleet-execution', mutationClass: 'READ_ONLY' } as const;

function validExternalCliRecord(): Record<string, unknown> {
  return {
    providerId: 'claude-cli',
    kind: 'external-cli',
    displayName: 'Claude CLI',
    source: 'operator catalog',
    health: 'HEALTHY',
    auth: 'AUTHENTICATED',
    capabilities: ['fleet-execution'],
    supports: ['SINGLE'],
    mutability: 'READ_ONLY',
    models: [{ id: 'claude-default', tier: 'MEDIUM', disclosed: true, capabilities: ['fleet-execution'], costClass: 'MEDIUM', latencyClass: 'MEDIUM' }],
    tools: [],
    concurrency: 1,
    binary: '/usr/local/bin/claude',
    sha256: 'a'.repeat(64),
  };
}

describe('Stage-9A feature flags', () => {
  test('stage-9 enablement requires trusted startup even when stage-7 stays off', () => {
    expect(() => createStage7FeatureSet(false, false, true)).toThrow(/trusted startup/);
    const enabled = createStage7FeatureSet(false, true, true);
    expect(enabled.stage7Enabled).toBe(false);
    expect(enabled.stage9ExternalProvidersEnabled).toBe(true);
  });

  test('stage-9 participation changes the immutable feature-set hash', () => {
    const off = createStage7FeatureSet(true, true, false);
    const on = createStage7FeatureSet(true, true, true);
    expect(off.hash).not.toBe(on.hash);
  });

  test('trusted startup reader consumes both environment flags exactly once', () => {
    const both = readTrustedStage7StartupFeatureSet({ OMP_AGENT_OPERATOR_ENABLE_STAGE7: '1', OMP_AGENT_OPERATOR_ENABLE_STAGE9_EXTERNAL_PROVIDERS: 'enabled' });
    expect(both.stage7Enabled).toBe(true);
    expect(both.stage9ExternalProvidersEnabled).toBe(true);
    const onlyNine = readTrustedStage7StartupFeatureSet({ OMP_AGENT_OPERATOR_ENABLE_STAGE9_EXTERNAL_PROVIDERS: 'true' });
    expect(onlyNine.stage7Enabled).toBe(false);
    expect(onlyNine.stage9ExternalProvidersEnabled).toBe(true);
  });
});

describe('Stage-9A catalog validation', () => {
  test('external-cli records require an absolute binary and a 64-hex pin', () => {
    expect(() => normalizeProviderCatalog({ providers: [{ ...validExternalCliRecord(), sha256: undefined }] }, '2026-08-21T00:00:00.000Z')).toThrow(/sha256/);
    expect(() => normalizeProviderCatalog({ providers: [{ ...validExternalCliRecord(), binary: 'claude' }] }, '2026-08-21T00:00:00.000Z')).toThrow(/absolute path/);
    expect(() => normalizeProviderCatalog({ providers: [{ ...validExternalCliRecord(), binary: '../claude' }] }, '2026-08-21T00:00:00.000Z')).toThrow(/absolute path/);
  });

  test('credential-bearing catalog fields are rejected before selection', () => {
    expect(() => normalizeProviderCatalog({ providers: [{ ...validExternalCliRecord(), displayName: 'Claude api_key: sk-123' }] }, '2026-08-21T00:00:00.000Z')).toThrow(/credential-bearing/);
    expect(() => normalizeProviderCatalog({ providers: [{ ...validExternalCliRecord(), source: 'password: hunter2' }] }, '2026-08-21T00:00:00.000Z')).toThrow(/credential-bearing/);
  });

  test('omp-native records reject binary pins and valid external records normalize', () => {
    const native = { ...validExternalCliRecord(), kind: 'omp-native', binary: undefined, sha256: 'a'.repeat(64) };
    expect(() => normalizeProviderCatalog({ providers: [native] }, '2026-08-21T00:00:00.000Z')).toThrow(/absent for omp-native/);
    const catalog = normalizeProviderCatalog({ providers: [validExternalCliRecord()] }, '2026-08-21T00:00:00.000Z');
    expect(catalog.records).toHaveLength(1);
    expect(catalog.records[0]?.sha256).toBe('a'.repeat(64));
  });
});

describe('Stage-9A provider selection', () => {
  const catalog = normalizeProviderCatalog({ providers: [validExternalCliRecord()] }, '2026-08-21T00:00:00.000Z');

  function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      role: 'fleet-v1-executor',
      capability: 'fleet-execution',
      executionShape: 'SINGLE',
      mutationClass: 'READ_ONLY',
      preference: { fallbackProviders: [], allowExternalProviders: true, allowUndisclosedModels: false, fallbackPolicy: 'COMPATIBLE_ONLY' },
      ...overrides,
    };
  }

  test('external selection is dead while the trusted flag is false', () => {
    expect(() => selectProviderRecord(catalog, request({ preference: { fallbackProviders: [], allowExternalProviders: false, allowUndisclosedModels: false, fallbackPolicy: 'COMPATIBLE_ONLY' } }) as never)).toThrow(ProviderSelectionError);
  });

  test('tool-ceiling violations fail closed with PRIVILEGE_ESCALATION', () => {
    const escalating = { ...validExternalCliRecord(), tools: ['write'] };
    const ceilingCatalog = normalizeProviderCatalog({ providers: [escalating] }, '2026-08-21T00:00:00.000Z');
    try {
      selectProviderRecord(ceilingCatalog, request({ toolCeiling: ['read', 'grep'] }) as never);
      throw new Error('expected PRIVILEGE_ESCALATION');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSelectionError);
      expect((error as ProviderSelectionError).code).toBe('PRIVILEGE_ESCALATION');
    }
  });

  test('a compatible external provider returns selection with record and model identity', () => {
    const picked = selectProviderRecord(catalog, request() as never);
    expect(picked.selection.providerId).toBe('claude-cli');
    expect(picked.record.binary).toBe('/usr/local/bin/claude');
    expect(picked.model.id).toBe('claude-default');
  });

  test('multi-provider catalogs select the curated preference instead of throwing PREFERENCE_REQUIRED', () => {
    const second = { ...validExternalCliRecord(), providerId: 'aaa-cli', displayName: 'AAA CLI' };
    const multi = normalizeProviderCatalog({ providers: [validExternalCliRecord(), second] }, '2026-08-21T00:00:00.000Z');
    const picked = selectProviderRecord(multi, request({ preference: { preferredProvider: 'claude-cli', fallbackProviders: ['aaa-cli'], allowExternalProviders: true, allowUndisclosedModels: false, fallbackPolicy: 'COMPATIBLE_ONLY' } }) as never);
    expect(picked.selection.providerId).toBe('claude-cli');
    expect(picked.selection.reasonCode).toBe('PREFERRED_COMPATIBLE');
  });

  test('mutating external providers are rejected with PRIVILEGE_ESCALATION regardless of ceilings', () => {
    const mutating = normalizeProviderCatalog({ providers: [{ ...validExternalCliRecord(), mutability: 'MUTATING' }] }, '2026-08-21T00:00:00.000Z');
    try {
      selectProviderRecord(mutating, request() as never);
      throw new Error('expected PRIVILEGE_ESCALATION');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderSelectionError);
      expect((error as ProviderSelectionError).code).toBe('PRIVILEGE_ESCALATION');
    }
  });
});

describe('Stage-9A capability record contract', () => {
  test('external-cli requires sha256 and an absolute binary; omp-role rejects both', () => {
    const valid = validateCapabilityRecord({ id: 'claude-cli:fleet-execution', kind: 'external-cli', capabilities: ['fleet-execution'], mutability: 'READ_ONLY', modelTiers: ['MEDIUM'], tools: [], spawns: true, supports: ['SINGLE'], binary: '/usr/local/bin/claude', sha256: 'b'.repeat(64), costClass: 'MEDIUM', latencyClass: 'MEDIUM', concurrency: 1, health: 'HEALTHY', source: 'fleet-catalog:claude-cli' });
    expect(valid.ok).toBe(true);
    expect(validateCapabilityRecord({ id: 'x', kind: 'external-cli', capabilities: ['c'], mutability: 'READ_ONLY', modelTiers: ['LOW'], tools: [], spawns: true, supports: ['SINGLE'], binary: '/bin/x', costClass: 'LOW', latencyClass: 'LOW', concurrency: 1, health: 'HEALTHY', source: 's' }).ok).toBe(false);
    expect(validateCapabilityRecord({ id: 'x', kind: 'external-cli', capabilities: ['c'], mutability: 'READ_ONLY', modelTiers: ['LOW'], tools: [], spawns: true, supports: ['SINGLE'], binary: 'relative/x', sha256: 'b'.repeat(64), costClass: 'LOW', latencyClass: 'LOW', concurrency: 1, health: 'HEALTHY', source: 's' }).ok).toBe(false);
    expect(validateCapabilityRecord({ id: 'x', kind: 'omp-role', capabilities: ['c'], mutability: 'READ_ONLY', modelTiers: ['LOW'], tools: [], spawns: false, supports: ['SINGLE'], sha256: 'b'.repeat(64), costClass: 'LOW', latencyClass: 'LOW', concurrency: 1, health: 'HEALTHY', source: 's' }).ok).toBe(false);
  });

  test('normalized provider to capability record keeps pins only for external-cli', () => {
    const catalog = normalizeProviderCatalog({ providers: [validExternalCliRecord()] }, '2026-08-21T00:00:00.000Z');
    const record = catalog.records[0]!;
    const model = record.models[0]!;
    const capability = normalizedProviderToCapabilityRecord(record, model, 'fleet-execution');
    expect(capability.kind).toBe('external-cli');
    expect(capability.binary).toBe('/usr/local/bin/claude');
    expect(capability.sha256).toBe('a'.repeat(64));
    expect(capability.source).toBe('fleet-catalog:claude-cli');
  });
});

describe('Stage-9A resolver and template gating', () => {
  test('fleet tuples fail closed while disabled or unwired', () => {
    const disabled = createNodeExecutionAdapterResolver({ frozenAdapter: frozenOmpTask, featureSet: createStage7FeatureSet(true, true, false), bindings: [], fleetAdapter });
    expect(() => disabled.resolve(fleetTuple)).toThrow(/Fleet execution is disabled/);
    const enabledUnwired = createNodeExecutionAdapterResolver({ frozenAdapter: frozenOmpTask, featureSet: createStage7FeatureSet(true, true, true), bindings: [] });
    expect(() => enabledUnwired.resolve(fleetTuple)).toThrow(/no concrete external-cli adapter/);
  });

  test('enabled fleet tuples route to the exact registered external-cli adapter', () => {
    const resolver = createNodeExecutionAdapterResolver({ frozenAdapter: frozenOmpTask, featureSet: createStage7FeatureSet(true, true, true), bindings: [], fleetAdapter });
    expect(resolver.resolve(fleetTuple)).toBe(fleetAdapter);
  });

  test('v1 tuples never reach the fleet adapter', () => {
    const resolver = createNodeExecutionAdapterResolver({ frozenAdapter: frozenOmpTask, featureSet: createStage7FeatureSet(true, true, true), bindings: [], fleetAdapter });
    expect(resolver.resolve({ workflowTemplateId: 'plan.v1', nodeId: 'planner', role: 'planner', capabilityId: 'omp-task-native-planner-v1', requiredCapability: 'planning', mutationClass: 'READ_ONLY' })).toBe(frozenOmpTask);
  });

  test('fleet.v1 template is registered only while stage-9 is enabled', () => {
    expect(getWorkflowTemplateById('fleet.v1', createStage7FeatureSet(true, true, false))).toBeUndefined();
    expect(getWorkflowTemplateById('fleet.v1', createStage7FeatureSet(true, true, true))?.template.templateId).toBe('fleet.v1');
  });
});

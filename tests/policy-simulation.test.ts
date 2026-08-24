import { describe, expect, test } from 'bun:test';

import { createPolicySimulationService, estimateCompiledWorkflow, validatePolicyDiffReport } from '../src/policy-simulation.js';
import type { CompilationResult, ResolvedOperatorConfig, WorkflowCompilerContext } from '../src/stage3-types.js';
import { makeCompiledWorkflow, makeResolvedPolicy } from './helpers/runtime-fixtures.js';

const context: WorkflowCompilerContext = { projectRoot: '/project', operatorSessionId: 'session-1', graphId: 'graph-1', gateId: 'gate-1', now: '2026-01-01T00:00:00.000Z' };

function config(): ResolvedOperatorConfig {
  return makeResolvedPolicy([], 2).config;
}

function compiledFor(currentContext: WorkflowCompilerContext, budgetProfile: 'CHEAP' | 'QUALITY'): CompilationResult {
  const base = makeCompiledWorkflow(currentContext, {
    templateId: budgetProfile === 'CHEAP' ? 'cheap.v1' : 'quality.v1',
    nodes: [
      { nodeId: 'first', mandatory: true, dependsOn: [] },
      { nodeId: 'second', mandatory: true, dependsOn: ['first'] },
    ],
    requiredGates: ['EXECUTION_APPROVAL'],
  });
  return { ok: true, compiled: { ...base, policy: { ...base.policy, budgetProfile }, routeDecision: { ...base.routeDecision, selectedWorkflow: budgetProfile === 'CHEAP' ? 'cheap.v1' : 'quality.v1', budgetEffect: { profile: budgetProfile } } } };
}

describe('policy simulation', () => {
  test('computes exact graph calls/depth and keeps unknown financial cost explicit', () => {
    const result = compiledFor(context, 'CHEAP');
    if (!result.ok) throw new Error('expected compile');
    const estimate = estimateCompiledWorkflow(result.compiled);
    expect(estimate).toMatchObject({ expectedProviderCalls: 2, maximumDepth: 2, maximumParallelWidth: 1, estimatedCost: null, costConfidence: 'UNAVAILABLE' });
  });

  test('compares current and proposed overlays through the injected compiler without applying them', async () => {
    const currentConfig = config();
    let currentLoads = 0;
    const service = createPolicySimulationService({
      loadCurrentConfig: async () => { currentLoads += 1; return currentConfig; },
      readProposed: async () => JSON.stringify({ schemaVersion: '1.0', budgetProfile: 'QUALITY' }),
      compileWithConfig: async (_request, compileContext, resolved) => compiledFor(compileContext, resolved.profile.budgetProfile === 'QUALITY' ? 'QUALITY' : 'CHEAP'),
    });
    const report = await service.test('/project/proposed.json', 'plan the rollout', context);
    expect(currentLoads).toBe(1);
    expect(report.current.workflow).toBe('cheap.v1');
    expect(report.proposed.workflow).toBe('quality.v1');
    expect(report.changes).toContain('WORKFLOW');
    expect(report.changes).toContain('BUDGETPROFILE');
    expect(report.unchangedHardInvariants).toContain('NO_AUTOMATIC_PUSH');
    expect(validatePolicyDiffReport(report)).toBe(true);
    expect(currentConfig.profile.budgetProfile).toBe('CHEAP');
  });

  test('rejects malformed proposed policy before compilation', async () => {
    let compileCalls = 0;
    const service = createPolicySimulationService({
      loadCurrentConfig: async () => config(),
      readProposed: async () => '{"schemaVersion":"1.0","unknown":true}',
      compileWithConfig: async () => { compileCalls += 1; return { ok: false, code: 'CONFIG_INVALID', message: 'unused', policyRefs: [] }; },
    });
    await expect(service.test('/project/bad.json', 'plan', context)).rejects.toThrow(/invalid/i);
    expect(compileCalls).toBe(0);
  });

  test('rejects unsafe broadening before any comparison', async () => {
    let compileCalls = 0;
    const service = createPolicySimulationService({
      loadCurrentConfig: async () => config(),
      readProposed: async () => JSON.stringify({ schemaVersion: '1.0', features: { automaticRouting: true } }),
      compileWithConfig: async () => { compileCalls += 1; return { ok: false, code: 'CONFIG_INVALID', message: 'unused', policyRefs: [] }; },
    });
    await expect(service.test('/project/unsafe.json', 'plan', context)).rejects.toThrow(/unsafe broadening/i);
    expect(compileCalls).toBe(0);
  });
});

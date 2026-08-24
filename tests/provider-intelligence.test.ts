import { describe, expect, test } from 'bun:test';

import { createProviderIntelligenceService, MemoryProviderIntelligenceStore, type ProviderCanaryObservation } from '../src/provider-intelligence.js';
import { isTransitionError, startSession } from '../src/state.js';
import type { StoredOperatorSession } from '../src/runtime-types.js';
import { makeCompiledWorkflow } from './helpers/runtime-fixtures.js';

const now = '2026-01-01T00:00:00.000Z';

function terminalRecord(id: string, status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED'): StoredOperatorSession {
  const context = { projectRoot: '/project', operatorSessionId: id, graphId: `graph-${id}`, gateId: `gate-${id}`, now };
  const compiled = makeCompiledWorkflow(context, { templateId: 'mock.v1', nodes: [{ nodeId: 'node-1', mandatory: true, dependsOn: [] }], requiredGates: ['EXECUTION_APPROVAL'] });
  const started = startSession('plan the work', 'EXECUTE', id, compiled, now);
  if (isTransitionError(started)) throw new Error(started.message);
  return {
    ...started,
    session: { ...started.session, currentState: status === 'SUCCEEDED' ? 'COMPLETED' : 'FAILED', currentPhase: 'Terminal' },
    nodeResultRefs: {
      'node-1': {
        status,
        summary: status === 'SUCCEEDED' ? 'Verified success.' : 'Verified failure.',
        producedArtifactRefs: [], consumedArtifactRefs: [], evidenceIds: [], findingIds: [], policyRefs: [],
        providerSessionId: `provider-${id}`, modelProvider: 'provider-a', modelId: 'model-a', startedAt: now,
        completedAt: '2026-01-01T00:00:01.000Z', usage: { tokens: 10, cost: 0.1 },
      },
    },
  };
}

describe('provider intelligence service', () => {
  test('deduplicates admitted terminal evidence and produces scoped low-sample scorecards', async () => {
    const store = new MemoryProviderIntelligenceStore();
    const service = createProviderIntelligenceService(store);
    const record = terminalRecord('session-1');
    await service.recordTerminalSession(record);
    await service.recordTerminalSession(record);

    const status = await service.status();
    expect(status).toEqual({ evidence: 1, admitted: 1, overrides: 0, canaries: 0 });
    const cards = await service.scorecards('provider-a', 'model-a');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ providerId: 'provider-a', modelId: 'model-a', qualifiedSampleCount: 1, successCount: 1, confidence: 'INSUFFICIENT' });
    expect(cards[0]?.confidenceInterval[0]).toBeLessThan(0.5);
  });

  test('keeps hard failures in empirical competence evidence', async () => {
    const service = createProviderIntelligenceService(new MemoryProviderIntelligenceStore());
    await service.recordTerminalSession(terminalRecord('session-success'));
    await service.recordTerminalSession(terminalRecord('session-failure', 'FAILED'));
    const card = (await service.scorecards())[0];
    expect(card).toMatchObject({ qualifiedSampleCount: 2, successCount: 1, hardFailureCount: 1, successRate: 0.5 });
  });

  test('records human gate decisions as unreviewed signals, never correctness labels', async () => {
    const service = createProviderIntelligenceService(new MemoryProviderIntelligenceStore());
    const record = terminalRecord('session-override');
    const decision = { gateId: 'gate-session-override', decisionType: 'EXECUTION_APPROVAL' as const, optionSelected: 'REJECT', outcome: 'REJECTED' as const, decidedAt: now, graphHashAtDecision: 'a'.repeat(64), artifactHashesAtDecision: [] };
    await service.recordHumanDecision(record, decision);
    const metrics = await service.overrideMetrics();
    expect(metrics.rejections).toBe(1);
    expect(metrics.byCategory.GATE_REJECTION).toBe(1);
    expect((await service.status()).overrides).toBe(1);
  });

  test('stores canary observations without changing competence scorecards', async () => {
    const service = createProviderIntelligenceService(new MemoryProviderIntelligenceStore());
    const canary: ProviderCanaryObservation = { schemaVersion: '1.0', canaryId: 'c'.repeat(64), caseId: 'plan-1', providerId: 'provider-a', modelId: 'model-a', capabilityId: 'planning', taskFamily: 'PLAN', outcome: 'PASSED', qualityScore: 1, latencyMs: 100, toolReliable: true, evaluatorRunRef: 'run-1', observedAt: now };
    await service.recordCanary(canary);
    expect((await service.status()).canaries).toBe(1);
    expect(await service.scorecards()).toEqual([]);
  });
});

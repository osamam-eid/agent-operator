import { describe, expect, test } from 'bun:test';

import { createShadowRoutingService, MemoryShadowObservationStore, validateShadowObservation } from '../src/shadow-routing.js';
import { createExplicitFamilyClassification } from '../src/classifier.js';
import type { SemanticClassificationResult, SemanticOperatorClassifier } from '../src/semantic-classifier.js';
import type { WorkflowCompilerContext } from '../src/stage3-types.js';
import { makeCompiledWorkflow } from './helpers/runtime-fixtures.js';

const context: WorkflowCompilerContext = {
  projectRoot: '/project',
  operatorSessionId: 'session-shadow',
  graphId: 'graph-shadow',
  gateId: 'gate-shadow',
  now: '2026-01-01T00:00:00.000Z',
};

function semanticResult(disposition: SemanticClassificationResult['disposition'], family: 'PLAN' | 'RESEARCH' = 'PLAN'): SemanticClassificationResult {
  return {
    schemaVersion: '1.0',
    disposition,
    proposal: createExplicitFamilyClassification(family),
    rawConfidence: 0.9,
    alternatives: [],
    evidence: ['Bounded semantic evidence.'],
    modelProvider: 'provider-a',
    modelId: 'model-a',
  };
}

function primaryWorkflow() {
  return makeCompiledWorkflow(context, {
    templateId: 'incumbent.v1',
    nodes: [{ nodeId: 'read', mandatory: true, dependsOn: [] }],
    requiredGates: ['EXECUTION_APPROVAL'],
  });
}

describe('shadow routing service', () => {
  test('blocks semantic calls for LOCAL_ONLY input and stores no raw request', async () => {
    let classifierCalls = 0;
    const classifier: SemanticOperatorClassifier = { async classify() { classifierCalls += 1; return semanticResult('EXECUTE'); } };
    const store = new MemoryShadowObservationStore();
    const service = createShadowRoutingService({ classifier, store, compileCandidate: async () => { throw new Error('must not compile'); } });
    const base = primaryWorkflow();
    const primary = { ...base, disclosureDecision: { ...base.disclosureDecision, disclosureClass: 'LOCAL_ONLY' as const, sensitiveSignalDetected: true, reasonCodes: ['LOCAL_ONLY_INSTRUCTION'] } };

    const observation = await service.evaluate('keep secret-value local-only', primary, context);
    expect(observation.candidate.status).toBe('BLOCKED_DISCLOSURE');
    expect(classifierCalls).toBe(0);
    expect(JSON.stringify(observation)).not.toContain('keep secret-value local-only');
    expect(validateShadowObservation(observation)).toBe(true);
  });

  test('records DO_NOT_EXECUTE without candidate graph compilation', async () => {
    let compileCalls = 0;
    const classifier: SemanticOperatorClassifier = { async classify() { return semanticResult('DO_NOT_EXECUTE', 'RESEARCH'); } };
    const store = new MemoryShadowObservationStore();
    const service = createShadowRoutingService({ classifier, store, compileCandidate: async () => { compileCalls += 1; throw new Error('must not compile'); } });

    const observation = await service.evaluate('repeat completed work', primaryWorkflow(), context);
    expect(observation.candidate.status).toBe('DO_NOT_EXECUTE');
    expect(observation.candidate.disposition).toBe('DO_NOT_EXECUTE');
    expect(compileCalls).toBe(0);
    expect(observation.divergences).toContain('DO_NOT_EXECUTE');
  });

  test('compiles EXECUTE candidates through the injected real compiler seam and compares routes', async () => {
    let compiledProposalFamily: string | undefined;
    const classifier: SemanticOperatorClassifier = { async classify() { return semanticResult('EXECUTE', 'PLAN'); } };
    const store = new MemoryShadowObservationStore();
    const candidate = makeCompiledWorkflow({ ...context, graphId: 'candidate-graph' }, {
      templateId: 'plan.v1',
      nodes: [{ nodeId: 'planner', mandatory: true, dependsOn: [] }],
      requiredGates: ['EXECUTION_APPROVAL'],
    });
    const service = createShadowRoutingService({
      classifier,
      store,
      compileCandidate: async (proposal) => {
        compiledProposalFamily = proposal.requestClassification;
        return { ok: true, compiled: { ...candidate, classification: proposal, routeDecision: { ...candidate.routeDecision, requestClassification: proposal.requestClassification, selectedWorkflow: 'plan.v1' } } };
      },
    });

    const observation = await service.evaluate('plan the rollout', primaryWorkflow(), context);
    expect(compiledProposalFamily).toBe('PLAN');
    expect(observation.candidate.status).toBe('COMPILED');
    expect(observation.candidate.workflow).toBe('plan.v1');
    expect(observation.divergences).toContain('TASK_FAMILY');
    expect(observation.divergences).toContain('WORKFLOW');
  });

  test('passive collection is default-off and cannot alter the primary workflow', async () => {
    let classifierCalls = 0;
    const classifier: SemanticOperatorClassifier = { async classify() { classifierCalls += 1; return semanticResult('EXECUTE'); } };
    const service = createShadowRoutingService({ classifier, store: new MemoryShadowObservationStore(), compileCandidate: async () => ({ ok: true, compiled: primaryWorkflow() }) });
    const primary = primaryWorkflow();

    expect(await service.observeIfEnabled('plan', primary, context)).toBeUndefined();
    service.setEnabled(true);
    const observation = await service.observeIfEnabled('plan', primary, context);
    expect(observation).toBeDefined();
    expect(classifierCalls).toBe(1);
    expect(primary.routeDecision.selectedWorkflow).toBe('incumbent.v1');
  });
});

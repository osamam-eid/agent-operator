import { describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  validateAgentResult,
  validateArtifactManifest,
  validateCapabilityRecord,
  validateContract,
  validateEvidence,
  validateExecutionGraph,
  validateFinalOperatorResult,
  validateFinding,
  validateHumanGate,
  validateOperatorSession,
  validatePolicyDecision,
  validateRouteDecision,
  validateWorkflowTemplate,
  type ContractName,
} from '../src/index.js';

const TS = '2026-08-13T12:00:00Z';
const LATER = '2026-08-13T12:01:00Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const POLICY = 'default@1:workflow.contracts';

const capability = {
  id: 'omp-reviewer',
  kind: 'omp-role',
  capabilities: ['independent-review'],
  mutability: 'READ_ONLY',
  modelTiers: ['HIGH'],
  tools: ['read'],
  spawns: false,
  supports: ['SINGLE'],
  costClass: 'MEDIUM',
  latencyClass: 'MEDIUM',
  concurrency: 1,
  health: 'HEALTHY',
  source: 'configured OMP role',
};

const routeDecision = {
  requestClassification: 'IMPLEMENT',
  riskClassification: 'HIGH',
  selectedWorkflow: 'implement.v1',
  selectedRolesProviders: [
    { role: 'implementer', capabilityId: 'omp-implementer', provider: 'omp' },
    { role: 'independent-reviewer', capabilityId: 'omp-reviewer', provider: 'omp' },
  ],
  rejectedAlternatives: [{ option: 'direct', reasonCode: 'INDEPENDENCE_REQUIRED' }],
  requiredGates: ['EXECUTION_APPROVAL'],
  budgetEffect: { profile: 'QUALITY', estimatedTokens: 1000 },
  fallbackDecisions: [],
  reasonCodes: ['HIGH_RISK_CHANGE'],
  policyRefs: [POLICY],
  confidence: 'HIGH',
  abstention: { abstained: false },
};

const workflowTemplate = {
  templateId: 'implement.v1',
  version: 1,
  taskFamilies: ['IMPLEMENT'],
  executionShape: 'PIPELINE',
  description: 'Implementation followed by independent verification.',
  nodes: [
    { nodeId: 'implement', role: 'implementer', mandatory: true, dependsOn: [], mutationClass: 'LOCAL' },
    { nodeId: 'verify', role: 'independent-reviewer', mandatory: true, dependsOn: ['implement'] },
  ],
  requiredGateTypes: ['EXECUTION_APPROVAL'],
};

const executionGraph = {
  graphId: 'graph-1',
  graphRevision: 1,
  workflowTemplateId: 'implement.v1',
  executionShape: 'PIPELINE',
  nodes: [
    {
      nodeId: 'implement',
      capabilityId: 'omp-implementer',
      role: 'implementer',
      mandatory: true,
      dependsOn: [],
      verificationOwnerNodeId: 'verify',
      mutation: { mutationId: 'mutation-1', mutationClass: 'LOCAL', retryPolicy: 'RECONCILE_FIRST' },
      contextPolicy: 'isolated',
      consumes: ['implementation-plan.v1'],
      produces: ['patch.v1'],
    },
    {
      nodeId: 'verify',
      capabilityId: 'omp-reviewer',
      role: 'independent-reviewer',
      mandatory: true,
      dependsOn: ['implement'],
      contextPolicy: 'evidence-only',
      consumes: ['patch.v1'],
      produces: ['review-result.v1'],
    },
  ],
  graphHash: HASH_A,
};

const agentResult = {
  resultId: 'result-1',
  operatorSessionId: 'session-1',
  nodeId: 'verify',
  capabilityId: 'omp-reviewer',
  status: 'SUCCEEDED',
  summary: 'Independent review completed without blocking findings.',
  producedArtifactRefs: ['review-artifact'],
  consumedArtifactRefs: ['patch-artifact'],
  findingIds: [],
  evidenceIds: ['evidence-1'],
  startedAt: TS,
  completedAt: LATER,
  policyRefs: [POLICY],
};

const evidence = {
  evidenceId: 'evidence-1',
  type: 'TEST_RESULT',
  source: 'bun test',
  artifact: 'test-artifact',
  claim: 'Contract tests passed.',
  timestamp: TS,
  producer: 'verifier',
  verificationStatus: 'VERIFIED',
  verifiedBy: 'independent-reviewer',
};

const artifact = {
  artifactId: 'patch-artifact',
  artifactType: 'patch.v1',
  producedByNodeId: 'implement',
  operatorSessionId: 'session-1',
  hash: HASH_B,
  location: 'artifacts/patch.json',
  sizeBytes: 128,
  createdAt: TS,
  contentSummary: 'Candidate patch.',
  policyRefs: [POLICY],
};

const finding = {
  findingId: 'finding-1',
  producer: 'independent-reviewer',
  category: 'CORRECTNESS',
  severity: 'LOW',
  reportedClassification: 'NON_BLOCKING',
  effectiveDisposition: 'DEFER',
  summary: 'Non-critical naming improvement.',
  impact: 'No correctness impact.',
  evidenceRefs: ['evidence-1'],
  recommendedAction: 'Address during cleanup.',
  blocksProgression: false,
  introducedAtRound: 1,
  status: 'DEFERRED',
  policyRefs: [POLICY],
  policyDecisionId: 'decision-1',
};

const policyDecision = {
  decisionId: 'decision-1',
  subjectType: 'finding',
  subjectId: 'finding-1',
  decision: 'DEFER',
  decisionSource: 'POLICY',
  reasonCodes: ['FINAL_ROUND_NON_BLOCKING'],
  policyRefs: [POLICY],
  inputs: { reportedClassification: 'NON_BLOCKING', round: '2' },
  timestamp: TS,
};

const humanGate = {
  gateId: 'gate-1',
  operatorSessionId: 'session-1',
  reason: 'Execution requires approval.',
  decisionType: 'EXECUTION_APPROVAL',
  requestedDecision: 'Approve candidate execution.',
  availableOptions: ['APPROVE', 'REJECT'],
  recommendedOption: 'APPROVE',
  evidenceRefs: ['evidence-1'],
  consequences: {
    APPROVE: 'Dispatch the validated graph.',
    REJECT: 'Record DECLINED and do not dispatch.',
  },
  resumeNode: 'implement',
  graphRevision: 1,
  graphHash: HASH_A,
  artifactRefs: ['patch-artifact'],
  artifactHashes: [HASH_B],
  policyRefs: [POLICY],
  createdAt: TS,
  expiresAt: LATER,
  status: 'OPEN',
};

const finalResult = {
  identity: { operatorSessionId: 'session-1', workflowTemplate: 'implement.v1', graphRevision: 1 },
  status: { executionStatus: 'SUCCEEDED', workflowStatus: 'COMPLETED' },
  decision: {
    recommendation: 'GO',
    recommendationRationale:
      'Required conditions were satisfied; no conditions remain unsatisfied; no blockers or deferred findings remain; remaining risk is recorded; default@1:workflow.contracts permits progression.',
    confidence: 'HIGH',
  },
  humanDecision: { required: false },
  scope: {
    scopeStatus: 'IN_SCOPE',
    requirementCoverage: {
      items: [{ requirementId: 'req-1', description: 'Validate all Stage 1 contracts.', status: 'SATISFIED' }],
      requiredCount: 1,
      satisfiedCount: 1,
      unsatisfiedCount: 0,
      deferredCount: 0,
    },
    deviations: [],
  },
  execution: {
    workPerformed: ['Implemented contract validators.'],
    changesMade: ['Created isolated candidate files.'],
    actionsNotPerformed: ['No live publication or deployment.'],
  },
  verification: {
    behavioralVerification: 'PASSED',
    conformanceVerification: 'PASSED',
    independentReview: 'PASSED',
    adversarialReview: 'NOT_APPLICABLE',
  },
  findings: {
    fundamentalBlockers: [],
    blockingFindings: [],
    nonBlockingFindings: [],
    deferredFindings: [],
    observations: [],
  },
  risk: { remainingRisks: ['Stage 1 has no dispatch path.'] },
  evidence: { evidenceRefs: ['evidence-1'] },
  artifacts: { artifactRefs: ['patch-artifact'] },
  policy: { policyRefs: [POLICY] },
  usage: { providers: ['omp'], models: ['test-model'], tokens: 0, cost: 0, duration: 1 },
  next: { allowedActions: ['REQUEST_SANDBOX_APPROVAL'], recommendedAction: 'REQUEST_SANDBOX_APPROVAL' },
};

const operatorSession = {
  operatorSessionId: 'session-1',
  schemaVersion: '1.0',
  originalRequest: 'Implement Stage 1 contracts.',
  createdAt: TS,
  updatedAt: LATER,
  currentState: 'IDLE',
  currentPhase: 'contracts',
  routeDecision: null,
  workflowTemplateId: null,
  executionGraph: null,
  nodeStates: {},
  providerSessionIds: {},
  humanDecisions: [],
  artifacts: [],
  evidence: [],
  verificationState: {
    behavioralVerification: 'NOT_STARTED',
    conformanceVerification: 'NOT_STARTED',
    independentReview: 'NOT_STARTED',
    adversarialReview: 'NOT_APPLICABLE',
  },
  budgetState: { profile: 'BALANCED', tokensUsed: 0, costUsed: 0 },
  journal: [],
  terminalResult: null,
};

const validFixtures: Readonly<Record<ContractName, unknown>> = {
  CapabilityRecord: capability,
  RouteDecision: routeDecision,
  WorkflowTemplate: workflowTemplate,
  ExecutionGraph: executionGraph,
  AgentResult: agentResult,
  OperatorSession: operatorSession,
  HumanGate: humanGate,
  Evidence: evidence,
  ArtifactManifest: artifact,
  Finding: finding,
  PolicyDecision: policyDecision,
  FinalOperatorResult: finalResult,
};


function expectInvalid(result: { ok: boolean; errors?: readonly { path: string; message: string }[] }, pathPart?: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok && pathPart) {
    const errors = result.errors ?? [];
    expect(errors.some((error) => error.path.includes(pathPart))).toBe(true);
  }
}


describe('all Stage 1 contracts', () => {
  for (const [name, fixture] of Object.entries(validFixtures) as [ContractName, unknown][]) {
    test(`${name} accepts its canonical fixture`, () => {
      expect(validateContract(name, fixture).ok).toBe(true);
    });

    test(`${name} rejects unknown top-level fields`, () => {
      expectInvalid(validateContract(name, { ...(fixture as object), chainOfThought: 'private trace' }), 'chainOfThought');
    });
  }
});

describe('routing and graph invariants', () => {
  test('rejects invalid enums', () => {
    expectInvalid(validateCapabilityRecord({ ...capability, kind: 'plugin' }), 'kind');
  });

  test('rejects unversioned policy references', () => {
    expectInvalid(validateRouteDecision({ ...routeDecision, policyRefs: ['default'] }), 'policyRefs');
    expectInvalid(validateFinding({ ...finding, policyRefs: ['default'] }), 'policyRefs');
    expectInvalid(validatePolicyDecision({ ...policyDecision, policyRefs: ['default'] }), 'policyRefs');
  });

  test('rejects graph cycles', () => {
    const cyclic = {
      ...executionGraph,
      nodes: executionGraph.nodes.map((node) =>
        node.nodeId === 'implement' ? { ...node, dependsOn: ['verify'] } : node),
    };
    expectInvalid(validateExecutionGraph(cyclic), 'nodes');
    expectInvalid(validateExecutionGraph(cyclic), 'dependsOn');
  });

  test('rejects missing dependencies and duplicate node ids', () => {
    const missing = {
      ...executionGraph,
      nodes: executionGraph.nodes.map((node) =>
        node.nodeId === 'verify' ? { ...node, dependsOn: ['absent'] } : node),
    };
    expectInvalid(validateExecutionGraph(missing), 'dependsOn');

    const duplicate = {
      ...executionGraph,
      nodes: executionGraph.nodes.map((node) =>
        node.nodeId === 'verify' ? { ...node, nodeId: 'implement' } : node),
    };
    expectInvalid(validateExecutionGraph(duplicate), 'nodeId');
  });

  test('requires independent verification metadata for mutation nodes', () => {
    const noOwner = {
      ...executionGraph,
      nodes: executionGraph.nodes.map((node) => {
        if (node.nodeId !== 'implement') return node;
        const { verificationOwnerNodeId: _omitted, ...withoutOwner } = node;
        return withoutOwner;
      }),
    };
    expectInvalid(validateExecutionGraph(noOwner), 'verificationOwnerNodeId');

    const selfOwned = {
      ...executionGraph,
      nodes: executionGraph.nodes.map((node) =>
        node.nodeId === 'implement' ? { ...node, verificationOwnerNodeId: 'implement' } : node),
    };
    expectInvalid(validateExecutionGraph(selfOwned), 'verificationOwnerNodeId');
  });

  test('requires a real group and exactly one synthesis owner for parallel work', () => {
    const ungrouped = { ...workflowTemplate, executionShape: 'PARALLEL' };
    expectInvalid(validateWorkflowTemplate(ungrouped), 'nodes');

    const grouped = {
      ...workflowTemplate,
      executionShape: 'PARALLEL',
      nodes: workflowTemplate.nodes.map((node) => ({ ...node, groupId: 'parallel-1' })),
    };
    expectInvalid(validateWorkflowTemplate(grouped), 'nodes');

    expectInvalid(validateWorkflowTemplate(grouped), 'synthesisOwner');

    const withOwner = {
      ...grouped,
      nodes: grouped.nodes.map((node) =>
        node.nodeId === 'verify' ? { ...node, synthesisOwner: true } : node),
    };
    expect(validateWorkflowTemplate(withOwner).ok).toBe(true);
  });

  test('aligns core validator boundaries with the schemas', () => {
    expectInvalid(validateExecutionGraph({ ...executionGraph, graphRevision: 0 }), 'graphRevision');
    expectInvalid(validateExecutionGraph({ ...executionGraph, graphHash: 'a'.repeat(63) }), 'graphHash');
    expectInvalid(validateRouteDecision({
      ...routeDecision,
      selectedRolesProviders: [{ role: 'Independent Reviewer', capabilityId: 'omp-reviewer', provider: 'omp' }],
    }), 'role');
    expectInvalid(validateHumanGate({ ...humanGate, availableOptions: ['approve', 'REJECT'] }), 'availableOptions');
    expectInvalid(validateHumanGate({ ...humanGate, availableOptions: ['APPROVE'] }), 'availableOptions');

    expect(validateCapabilityRecord({
      ...capability,
      id: 'claude-cli',
      kind: 'external-cli',
      binary: '/usr/local/bin/claude',
      sha256: HASH_A,
    }).ok).toBe(true);
  });

});

describe('gates, findings, and session binding', () => {
  test('binds a gate to aligned artifact references and hashes', () => {
    expectInvalid(validateHumanGate({ ...humanGate, artifactHashes: [] }), 'artifactHashes');
    expectInvalid(validateHumanGate({ ...humanGate, recommendedOption: 'DEFER' }), 'recommendedOption');
  });

  test('keeps reviewer classification separate from policy disposition', () => {
    expectInvalid(validateFinding({ ...finding, reportedClassification: 'OBSERVATION', effectiveDisposition: 'BLOCK' }), 'effectiveDisposition');
  });

  test('rejects skipped mandatory nodes', () => {
    const session = {
      ...operatorSession,
      currentState: 'EXECUTING',
      routeDecision,
      workflowTemplateId: 'implement.v1',
      executionGraph,
      nodeStates: { implement: 'SKIPPED', verify: 'READY' },
    };
    expectInvalid(validateOperatorSession(session), 'nodeStates');
  });

  test('rejects graph and artifact hash mismatches in recorded decisions', () => {
    const session = {
      ...operatorSession,
      currentState: 'EXECUTING',
      routeDecision,
      workflowTemplateId: 'implement.v1',
      executionGraph,
      humanDecisions: [{
        gateId: 'gate-1',
        decisionType: 'EXECUTION_APPROVAL',
        outcome: 'APPROVED',
        optionSelected: 'APPROVE',
        decidedAt: TS,
        graphHashAtDecision: HASH_B,
        artifactHashesAtDecision: [HASH_A],
      }],
    };
    const result = validateOperatorSession(session);
    expectInvalid(result, 'humanDecisions');
  });

  test('requires an open gate id exactly while awaiting a human', () => {
    expectInvalid(validateOperatorSession({
      ...operatorSession,
      currentState: 'AWAITING_HUMAN',
    }), 'openGateId');
    expect(validateOperatorSession({
      ...operatorSession,
      currentState: 'AWAITING_HUMAN',
      openGateId: 'gate-1',
    }).ok).toBe(true);
    expectInvalid(validateOperatorSession({
      ...operatorSession,
      openGateId: 'gate-1',
    }), 'openGateId');
  });

  test('requires typed human override provenance', () => {
    expectInvalid(validatePolicyDecision({
      ...policyDecision,
      decisionSource: 'HUMAN_OVERRIDE',
    }), 'overrideGateId');
    expectInvalid(validatePolicyDecision({
      ...policyDecision,
      overrideGateId: 'gate-1',
    }), 'overrideGateId');
    expect(validatePolicyDecision({
      ...policyDecision,
      decisionSource: 'HUMAN_OVERRIDE',
      overrideGateId: 'gate-1',
    }).ok).toBe(true);
  });

  test('prevents required gate bypass in successful terminal sessions', () => {
    const completedSession = {
      ...operatorSession,
      currentState: 'COMPLETED',
      routeDecision,
      workflowTemplateId: 'implement.v1',
      executionGraph,
      nodeStates: { implement: 'SUCCEEDED', verify: 'SUCCEEDED' },
      artifacts: [artifact],
      terminalResult: finalResult,
    };
    expectInvalid(validateOperatorSession(completedSession), 'humanDecisions');

    const approvedSession = {
      ...completedSession,
      humanDecisions: [{
        gateId: 'gate-1',
        decisionType: 'EXECUTION_APPROVAL',
        outcome: 'APPROVED',
        optionSelected: 'APPROVE',
        decidedAt: TS,
        graphHashAtDecision: HASH_A,
        artifactHashesAtDecision: [HASH_B],
      }],
    };
    expect(validateOperatorSession(approvedSession).ok).toBe(true);
  });

  test('binds terminal result presence and identity to the session', () => {
    expectInvalid(validateOperatorSession({
      ...operatorSession,
      currentState: 'COMPLETED',
    }), 'terminalResult');

    expectInvalid(validateOperatorSession({
      ...operatorSession,
      currentState: 'COMPLETED',
      routeDecision: { ...routeDecision, requiredGates: [] },
      workflowTemplateId: 'implement.v1',
      executionGraph,
      nodeStates: { implement: 'SUCCEEDED', verify: 'SUCCEEDED' },
      terminalResult: {
        ...finalResult,
        identity: { ...finalResult.identity, operatorSessionId: 'different-session' },
      },
    }), 'operatorSessionId');
  });
});

describe('evidence and result invariants', () => {
  test('requires verifier identity for verified evidence', () => {
    const { verifiedBy: _omitted, ...invalid } = evidence;
    expectInvalid(validateEvidence(invalid), 'verifiedBy');
  });

  test('rejects raw reasoning fields on agent results', () => {
    expectInvalid(validateAgentResult({ ...agentResult, reasoning: 'hidden trace' }), 'reasoning');
  });

  test('rejects incomplete requirement coverage aggregates', () => {
    const result = {
      ...finalResult,
      scope: {
        ...finalResult.scope,
        requirementCoverage: {
          ...finalResult.scope.requirementCoverage,
          requiredCount: 2,
        },
      },
    };
    expectInvalid(validateFinalOperatorResult(result), 'requirementCoverage');
  });

  test('requires actionsNotPerformed as a distinct result field', () => {
    const { actionsNotPerformed: _omitted, ...incompleteExecution } = finalResult.execution;
    expectInvalid(validateFinalOperatorResult({
      ...finalResult,
      execution: incompleteExecution,
    }), 'actionsNotPerformed');
  });

  test('keeps execution status independent from workflow success', () => {
    expect(validateFinalOperatorResult({
      ...finalResult,
      status: { executionStatus: 'SUCCEEDED', workflowStatus: 'FAILED' },
      decision: { ...finalResult.decision, recommendation: 'HOLD' },
    }).ok).toBe(true);

    expectInvalid(validateFinalOperatorResult({
      ...finalResult,
      status: { executionStatus: 'FAILED', workflowStatus: 'COMPLETED' },
    }), 'executionStatus');
  });

  test('requires recommended action to be allowed', () => {
    expectInvalid(validateFinalOperatorResult({
      ...finalResult,
      next: { ...finalResult.next, recommendedAction: 'PUBLISH' },
    }), 'recommendedAction');
  });

  test('enforces approved-deviation and detected-drift semantics', () => {
    expectInvalid(validateFinalOperatorResult({
      ...finalResult,
      scope: { ...finalResult.scope, scopeStatus: 'IN_SCOPE_WITH_APPROVED_DEVIATION', deviations: [] },
    }), 'deviations');

    const unapprovedDeviation = {
      deviationId: 'deviation-1',
      description: 'Unapproved scope change.',
      approved: false,
      policyRefs: [POLICY],
    };
    expectInvalid(validateFinalOperatorResult({
      ...finalResult,
      scope: {
        ...finalResult.scope,
        scopeStatus: 'IN_SCOPE_WITH_APPROVED_DEVIATION',
        deviations: [unapprovedDeviation],
      },
    }), 'deviations');

    expectInvalid(validateFinalOperatorResult({
      ...finalResult,
      scope: {
        ...finalResult.scope,
        scopeStatus: 'SCOPE_DRIFT_DETECTED',
        deviations: [{ ...unapprovedDeviation, approved: true }],
      },
    }), 'deviations');

    expect(validateFinalOperatorResult({
      ...finalResult,
      scope: {
        ...finalResult.scope,
        scopeStatus: 'SCOPE_DRIFT_DETECTED',
        deviations: [unapprovedDeviation],
      },
    }).ok).toBe(true);
  });
});
describe('JSON Schema inventory', () => {
  test('contains exactly 52 strict draft-2020-12 schemas with stable ids', async () => {
    const schemaDir = join(import.meta.dir, '..', 'schemas');
    const files = (await readdir(schemaDir)).filter((file) => file.endsWith('.json')).sort();
    const expected = [
      'active-intelligence-pointer.v1.json',
      'agent-result.v1.json',
      'artifact-manifest.v1.json',
      'capability-record.v1.json',
      'calibration-report.v1.json',
      'context-packing-plan.v1.json',
      'decision-brief.v1.json',
      'decision-trace.v1.json',
      'deployment-context.v1.json',
      'design-review.v1.json',
      'evidence.v1.json',
      'execution-graph.v1.json',
      'execution-estimate.v1.json',
      'failure-fingerprint.v1.json',
      'final-operator-result.v1.json',
      'finding.v1.json',
      'intelligence-candidate.v1.json',
      'human-gate.v1.json',
      'human-override-signal.v1.json',
      'operator-command-outcome.v1.json',
      'operator-session.v1.json',
      'normalized-evidence.v1.json',
      'policy-decision.v1.json',
      'qa-environment-approval.v1.json',
      'qa-evidence.v1.json',
      'policy-diff-report.v1.json',
      'qa-execution-log.v1.json',
      'qa-report.v1.json',
      'qa-review.v1.json',
      'provider-canary-observation.v1.json',
      'provider-competence-snapshot.v1.json',
      'provider-evidence-observation.v1.json',
      'provider-fallback-journal.v1.json',
      'recovery-package.v1.json',
      'route-decision.v1.json',
      'retention-decision.v1.json',
      'runtime-disclosure-decision.v1.json',
      'simulation-result.v1.json',
      'semantic-classification-result.v1.json',
      'shadow-observation.v1.json',
      'stored-operator-session.v1.json',
      'ui-candidate-bundle.v1.json',
      'ui-design-spec.v1.json',
      'ui-implementation-diff.v1.json',
      'ui-visual-verification.v1.json',
      'workflow-template.v1.json',
      'operator-eval-case.v1.json',
      'operator-eval-corpus.v1.json',
      'operator-candidate.v1.json',
      'operator-eval-run.v1.json',
      'operator-comparison.v1.json',
      'operator-promotion-decision.v1.json',
    ];
    expect(files).toEqual([...expected].sort());

    for (const file of files) {
      const schema = JSON.parse(await Bun.file(join(schemaDir, file)).text()) as Record<string, unknown>;
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id).toBe(`https://omp.local/agent-operator/schemas/${file}`);
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
      expect(Array.isArray(schema.required)).toBe(true);
      expect((schema.required as unknown[]).length).toBeGreaterThan(0);
    }
  });

  test('pins boundary and provenance constraints in parsed schemas', async () => {
    const schemaDir = join(import.meta.dir, '..', 'schemas');
    const graphSchema = JSON.parse(
      await Bun.file(join(schemaDir, 'execution-graph.v1.json')).text(),
    ) as {
      properties: {
        graphRevision: { minimum: number };
        graphHash: { pattern: string };
      };
      $defs: {
        ExecutionGraphNode: { properties: { role: { pattern: string } } };
      };
      allOf: readonly unknown[];
    };
    expect(graphSchema.properties.graphRevision.minimum).toBe(1);
    expect(graphSchema.properties.graphHash.pattern).toBe('^[0-9a-f]{64}$');
    expect(graphSchema.$defs.ExecutionGraphNode.properties.role.pattern).toBe('^[a-z][a-z0-9-]*$');
    expect(graphSchema.allOf.length).toBeGreaterThan(0);

    const gateSchema = JSON.parse(
      await Bun.file(join(schemaDir, 'human-gate.v1.json')).text(),
    ) as {
      properties: {
        availableOptions: { minItems: number; items: { pattern: string } };
      };
    };
    expect(gateSchema.properties.availableOptions.minItems).toBe(2);
    expect(gateSchema.properties.availableOptions.items.pattern).toBe('^[A-Z][A-Z0-9_]*$');

    const capabilitySchema = JSON.parse(
      await Bun.file(join(schemaDir, 'capability-record.v1.json')).text(),
    ) as { allOf: readonly { then: { required: readonly string[] } }[] };
    expect(capabilitySchema.allOf[0]?.then.required).toEqual(['binary', 'sha256']);
    expect(capabilitySchema.allOf.length).toBe(2);

    const sessionSchema = JSON.parse(
      await Bun.file(join(schemaDir, 'operator-session.v1.json')).text(),
    ) as {
      properties: { openGateId: unknown };
      $defs: { HumanDecisionRecord: { required: readonly string[] } };
      allOf: readonly unknown[];
    };
    expect(sessionSchema.properties.openGateId).toBeDefined();
    expect(sessionSchema.$defs.HumanDecisionRecord.required).toContain('decisionType');
    expect(sessionSchema.$defs.HumanDecisionRecord.required).toContain('outcome');
    expect(sessionSchema.allOf.length).toBeGreaterThanOrEqual(2);

    const policySchema = JSON.parse(
      await Bun.file(join(schemaDir, 'policy-decision.v1.json')).text(),
    ) as {
      required: readonly string[];
      properties: { overrideGateId: unknown };
      allOf: readonly unknown[];
    };
    expect(policySchema.required).toContain('decisionSource');
    expect(policySchema.properties.overrideGateId).toBeDefined();
    expect(policySchema.allOf.length).toBe(2);

    const resultSchema = JSON.parse(
      await Bun.file(join(schemaDir, 'final-operator-result.v1.json')).text(),
    ) as {
      $defs: { FinalOperatorResultScope: { allOf: readonly unknown[] } };
    };
    expect(resultSchema.$defs.FinalOperatorResultScope.allOf.length).toBeGreaterThanOrEqual(2);
  });
});


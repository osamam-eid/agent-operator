/**
 * Agent Operator — truthful action/evidence/artifact/finding aggregation
 * and `FinalOperatorResult` construction.
 *
 * Every ref aggregated here comes from real `NodeResultRefs` already recorded
 * on the session. A node's recommendation is treated as an effective,
 * fail-closed disposition for every finding id it reports; it is never allowed
 * to disappear merely because the node itself returned `SUCCEEDED`.
 */

import type {
  ExecutionGraph,
  ExecutionStatus,
  FinalOperatorResult,
  FindingEffectiveDisposition,
  NodeState,
  OperatorSession,
  PolicyRef,
  Recommendation,
  WorkflowStatus,
} from '../contracts.js';
import type { NodeResultRefs } from '../runtime-types.js';
import { RUNTIME_POLICY_REF } from './policy-ref.js';

/** Every dispatched node in this rollout is compiled `READ_ONLY` (Stage 4
 * excludes any `MUTATING` capability before a node can ever reach dispatch).
 * This remains a defense-in-depth check, not the primary enforcement point. */
export function buildActionsNotPerformed(graph: ExecutionGraph, nodeStates: Readonly<Record<string, NodeState>>): readonly string[] {
  const dispatchedMutatingNodes = graph.nodes.filter((node) => {
    const state = nodeStates[node.nodeId];
    return node.mutation !== undefined && state !== undefined && state !== 'PENDING';
  });
  if (dispatchedMutatingNodes.length === 0) {
    return [
      'No repository, provider, or credential mutation was requested or performed by any node in this workflow (every dispatched node in this rollout is READ_ONLY).',
    ];
  }
  return dispatchedMutatingNodes.map(
    (node) =>
      `Node "${node.nodeId}" declared mutation "${node.mutation?.mutationId ?? 'unknown'}" (class ${node.mutation?.mutationClass ?? 'unknown'}); this rollout does not compute a detailed post-hoc mutation ledger.`,
  );
}

function dedupe(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

interface AggregatedNodeRefs {
  readonly artifactRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly policyRefs: readonly PolicyRef[];
  readonly providers: readonly string[];
  readonly models: readonly string[];
  readonly tokens: number | null;
  readonly cost: number | null;
  readonly usageUnavailable: boolean;
  readonly duration: number;
}

function aggregateNodeRefs(nodeResultRefs: Readonly<Record<string, NodeResultRefs>>): AggregatedNodeRefs {
  const refs = Object.values(nodeResultRefs);
  const startedAt = refs.map((ref) => Date.parse(ref.startedAt));
  const completedAt = refs.map((ref) => Date.parse(ref.completedAt));
  const duration = refs.length === 0 ? 0 : Math.max(0, Math.max(...completedAt) - Math.min(...startedAt));
  const tokenValues = refs.map((ref) => ref.usage?.tokens);
  const costValues = refs.map((ref) => ref.usage?.cost);
  const tokens = refs.length > 0 && tokenValues.every((value): value is number => value !== undefined) ? tokenValues.reduce((total, value) => total + value, 0) : null;
  const cost = refs.length > 0 && costValues.every((value): value is number => value !== undefined && value !== null) ? costValues.reduce((total, value) => total + value, 0) : null;
  return {
    artifactRefs: dedupe(refs.flatMap((ref) => [...ref.producedArtifactRefs, ...ref.consumedArtifactRefs])),
    evidenceRefs: dedupe(refs.flatMap((ref) => ref.evidenceIds)),
    policyRefs: dedupe(refs.flatMap((ref) => ref.policyRefs)),
    providers: dedupe(refs.map((ref) => ref.modelProvider)),
    models: dedupe(refs.map((ref) => ref.modelId)),
    tokens,
    cost,
    usageUnavailable: tokens === null || cost === null,
    duration,
  };
}

export interface FindingDispositionAssessment {
  readonly fundamentalBlockers: readonly string[];
  readonly blockingFindings: readonly string[];
  readonly nonBlockingFindings: readonly string[];
  readonly deferredFindings: readonly string[];
  readonly observations: readonly string[];
  readonly humanDecisionRequired: boolean;
  readonly workflowStatus?: 'BLOCKED' | 'HUMAN_DECISION_REQUIRED';
  readonly executionStatus?: 'FAILED' | 'PARTIAL';
  readonly recommendation?: 'STOP' | 'HOLD';
}

const DISPOSITION_PRIORITY: Readonly<Record<FindingEffectiveDisposition, number>> = {
  RECORD: 1,
  DEFER: 2,
  CONTINUE: 3,
  CORRECT: 4,
  HUMAN_DECISION: 5,
  BLOCK: 6,
};

/** Classifies each reported finding id from the node's effective disposition.
 * Conflicting reports choose the most restrictive disposition, so a later
 * permissive result can never erase an earlier blocker. */
export function assessFindingDispositions(nodeResultRefs: Readonly<Record<string, NodeResultRefs>>): FindingDispositionAssessment {
  const dispositions = new Map<string, FindingEffectiveDisposition | undefined>();
  for (const ref of Object.values(nodeResultRefs)) {
    for (const findingId of ref.findingIds) {
      const next = ref.recommendedDisposition;
      if (next === undefined) {
        // A report without a disposition is only an observation. Preserve it
        // when it is the sole report, but never let it erase or suppress a
        // concrete disposition reported by another node.
        if (!dispositions.has(findingId)) dispositions.set(findingId, undefined);
        continue;
      }
      const previous = dispositions.get(findingId);
      if (previous === undefined || DISPOSITION_PRIORITY[next] > DISPOSITION_PRIORITY[previous]) dispositions.set(findingId, next);
    }
  }

  const fundamentalBlockers: string[] = [];
  const blockingFindings: string[] = [];
  const nonBlockingFindings: string[] = [];
  const deferredFindings: string[] = [];
  const observations: string[] = [];
  let humanDecisionRequired = false;
  for (const [findingId, disposition] of dispositions) {
    switch (disposition) {
      case 'BLOCK':
        fundamentalBlockers.push(findingId);
        break;
      case 'CORRECT':
        blockingFindings.push(findingId);
        break;
      case 'HUMAN_DECISION':
        blockingFindings.push(findingId);
        humanDecisionRequired = true;
        break;
      case 'CONTINUE':
        nonBlockingFindings.push(findingId);
        break;
      case 'DEFER':
        deferredFindings.push(findingId);
        break;
      case 'RECORD':
      case undefined:
        observations.push(findingId);
        break;
    }
  }

  if (fundamentalBlockers.length > 0 || (blockingFindings.length > 0 && !humanDecisionRequired)) {
    return {
      fundamentalBlockers,
      blockingFindings,
      nonBlockingFindings,
      deferredFindings,
      observations,
      humanDecisionRequired: false,
      workflowStatus: 'BLOCKED',
      executionStatus: 'FAILED',
      recommendation: 'STOP',
    };
  }
  if (humanDecisionRequired) {
    return {
      fundamentalBlockers,
      blockingFindings,
      nonBlockingFindings,
      deferredFindings,
      observations,
      humanDecisionRequired: true,
      workflowStatus: 'HUMAN_DECISION_REQUIRED',
      executionStatus: 'PARTIAL',
      recommendation: 'HOLD',
    };
  }
  return { fundamentalBlockers, blockingFindings, nonBlockingFindings, deferredFindings, observations, humanDecisionRequired: false };
}

interface FinalResultParams {
  readonly session: OperatorSession;
  readonly workflowStatus: WorkflowStatus;
  readonly executionStatus: ExecutionStatus;
  readonly recommendation: Recommendation;
  readonly recommendationRationale: string;
  readonly workPerformed: readonly string[];
  readonly changesMade: readonly string[];
  readonly actionsNotPerformed: readonly string[];
  readonly degradedOptionalNodeIds?: readonly string[];
  readonly nodeResultRefs?: Readonly<Record<string, NodeResultRefs>>;
}

export function buildFinalResult(params: FinalResultParams): FinalOperatorResult {
  const graphRevision = params.session.executionGraph !== null ? params.session.executionGraph.graphRevision : 1;
  const degradedNodeIds = params.degradedOptionalNodeIds ?? [];
  const nodeResultRefs = params.nodeResultRefs ?? {};
  const aggregated = aggregateNodeRefs(nodeResultRefs);
  const findings = assessFindingDispositions(nodeResultRefs);
  const dispositionOverrides = findings.workflowStatus !== undefined;
  const hasDeferredItems = degradedNodeIds.length > 0 || findings.deferredFindings.length > 0;
  const workflowStatus = findings.workflowStatus ?? (hasDeferredItems && params.workflowStatus === 'COMPLETED' ? 'COMPLETED_WITH_DEFERRED_ITEMS' : params.workflowStatus);
  const executionStatus = findings.executionStatus ?? (hasDeferredItems && params.executionStatus === 'SUCCEEDED' ? 'PARTIAL' : params.executionStatus);
  const recommendation = findings.recommendation ?? (hasDeferredItems && params.recommendation === 'GO' ? 'GO_WITH_DEFERRED_ITEMS' : params.recommendation);
  const recommendationRationale = dispositionOverrides
    ? findings.humanDecisionRequired
      ? `Progression is held because finding(s) ${findings.blockingFindings.join(', ')} require an explicit human decision; the node's SUCCEEDED status does not authorize GO.`
      : `Progression is stopped because finding(s) ${[...findings.fundamentalBlockers, ...findings.blockingFindings].join(', ')} have an effective blocking disposition; the node's SUCCEEDED status does not authorize GO.`
    : params.recommendationRationale;
  const deferredFindings = dedupe([...degradedNodeIds.map((nodeId) => `optional-degradation-${nodeId}`), ...findings.deferredFindings]);
  const observations = [
    ...findings.observations,
    ...(aggregated.usageUnavailable ? ['Provider token and cost usage was not fully exposed by the native provider; unavailable values remain null.'] : []),
  ];
  const decisionFindingId = findings.blockingFindings[0] ?? findings.fundamentalBlockers[0] ?? 'finding';
  const humanDecision = findings.humanDecisionRequired
    ? {
        required: true as const,
        gateId: `finding-decision-${decisionFindingId}`,
        decisionType: 'CUSTOM_DECISION' as const,
        options: ['APPROVE', 'REJECT'],
        recommendedOption: 'APPROVE',
      }
    : { required: false as const };
  return {
    identity: {
      operatorSessionId: params.session.operatorSessionId,
      workflowTemplate: params.session.workflowTemplateId ?? 'unknown.v1',
      graphRevision,
    },
    status: { executionStatus, workflowStatus },
    decision: { recommendation, recommendationRationale, confidence: 'HIGH' },
    humanDecision,
    scope: {
      scopeStatus: degradedNodeIds.length > 0 ? 'IN_SCOPE_WITH_APPROVED_DEVIATION' : 'IN_SCOPE',
      requirementCoverage: { items: [], requiredCount: 0, satisfiedCount: 0, unsatisfiedCount: 0, deferredCount: 0 },
      deviations: degradedNodeIds.map((nodeId) => ({
        deviationId: `optional-degradation-${nodeId}`,
        description: `Optional node "${nodeId}" did not succeed; its result was deferred as a degraded outcome.`,
        approved: true,
        policyRefs: [`${RUNTIME_POLICY_REF}:optional.degradation`],
      })),
    },
    execution: { workPerformed: params.workPerformed, changesMade: params.changesMade, actionsNotPerformed: params.actionsNotPerformed },
    verification: params.session.verificationState,
    findings: {
      fundamentalBlockers: findings.fundamentalBlockers,
      blockingFindings: findings.blockingFindings,
      nonBlockingFindings: findings.nonBlockingFindings,
      deferredFindings,
      observations,
    },
    risk: {
      remainingRisks: [
        ...degradedNodeIds.map((nodeId) => `Optional node "${nodeId}" did not succeed; downstream synthesis proceeded without its successful result.`),
        ...findings.fundamentalBlockers.map((findingId) => `Finding "${findingId}" has an effective BLOCK disposition.`),
        ...findings.blockingFindings.map((findingId) => `Finding "${findingId}" has an effective progression-blocking disposition.`),
      ],
    },
    evidence: { evidenceRefs: aggregated.evidenceRefs },
    artifacts: { artifactRefs: aggregated.artifactRefs },
    policy: { policyRefs: dedupe([`${RUNTIME_POLICY_REF}:result.aggregate`, ...aggregated.policyRefs]) },
    usage: { providers: aggregated.providers, models: aggregated.models, tokens: aggregated.tokens, cost: aggregated.cost, duration: aggregated.duration },
    next: { allowedActions: findings.humanDecisionRequired ? ['REQUEST_HUMAN_DECISION'] : [] },
  };
}

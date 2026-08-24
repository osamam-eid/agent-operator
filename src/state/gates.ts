/**
 * Agent Operator — post-execution gate construction.
 *
 * The compiler supplies the first (pre-execution) required gate. Every
 * subsequent required gate in `RouteDecision.requiredGates` is opened by
 * `buildPostExecutionGate`, deterministically, once all mandatory nodes
 * have succeeded (or once the previously-required gate was approved, for
 * gates chained back-to-back).
 */

import type { ArtifactManifest, ExecutionGraph, GateDecisionType, GateRiskSummary, HumanGate } from '../contracts.js';
import { RUNTIME_POLICY_REF } from './policy-ref.js';

interface GateCopy {
  readonly reason: string;
  readonly requestedDecision: string;
  readonly consequences: Readonly<Record<string, string>>;
}

function describePostExecutionGate(decisionType: GateDecisionType, templateId: string): GateCopy {
  const base = `All mandatory nodes of the "${templateId}" workflow have succeeded.`;
  const chained = 'The session proceeds toward completion (or the next required approval).';
  switch (decisionType) {
    case 'PLAN_APPROVAL':
      return {
        reason: `${base} The resolved policy requires plan re-approval before completion.`,
        requestedDecision: `Approve the plan for the "${templateId}" workflow now that execution has completed?`,
        consequences: { APPROVE: chained, REJECT: 'The session moves to NEEDS_REPLAN; this runtime does not implement automatic replanning.' },
      };
    case 'EXECUTION_APPROVAL':
      return {
        reason: `${base} The resolved policy requires a further execution approval before completion.`,
        requestedDecision: `Approve the completed execution of the "${templateId}" workflow?`,
        consequences: { APPROVE: chained, REJECT: 'The session is declined; the results are discarded.' },
      };
    case 'RESULT_APPROVAL':
      return {
        reason: `${base} The resolved policy requires human approval of the results before completion.`,
        requestedDecision: `Approve the results produced by the "${templateId}" workflow?`,
        consequences: { APPROVE: chained, REJECT: 'The session is declined; the results are discarded.' },
      };
    case 'PUBLICATION_APPROVAL':
      return {
        reason: `${base} The resolved policy requires approval before the results are considered published.`,
        requestedDecision: `Approve publication of the results produced by the "${templateId}" workflow?`,
        consequences: { APPROVE: chained, REJECT: 'The session is declined; the results are not published.' },
      };
    case 'APPROVE_PROGRESSION':
      return {
        reason: `${base} The resolved policy requires explicit approval to progress past this point.`,
        requestedDecision: `Approve progression for the "${templateId}" workflow?`,
        consequences: { APPROVE: chained, REJECT: 'The session is declined; progression is not approved.' },
      };
    case 'CUSTOM_DECISION':
      return {
        reason: `${base} The resolved policy requires an additional custom human decision before completion.`,
        requestedDecision: `Provide the custom decision required by the "${templateId}" workflow?`,
        consequences: { APPROVE: chained, REJECT: 'The session is declined.' },
      };
  }
}

export function buildPostExecutionGate(
  decisionType: GateDecisionType,
  operatorSessionId: string,
  graph: ExecutionGraph,
  resumeNode: string,
  artifacts: readonly ArtifactManifest[],
  gateId: string,
  now: string,
  riskSummary?: GateRiskSummary,
): HumanGate {
  const { reason, requestedDecision, consequences } = describePostExecutionGate(decisionType, graph.workflowTemplateId);
  return {
    gateId,
    operatorSessionId,
    reason,
    decisionType,
    requestedDecision,
    availableOptions: ['APPROVE', 'REJECT'],
    recommendedOption: 'APPROVE',
    evidenceRefs: [],
    consequences,
    resumeNode,
    graphRevision: graph.graphRevision,
    graphHash: graph.graphHash,
    artifactRefs: artifacts.map((artifact) => artifact.artifactId),
    artifactHashes: artifacts.map((artifact) => artifact.hash),
    policyRefs: [`${RUNTIME_POLICY_REF}:gate.${decisionType.toLowerCase()}`],
    ...(riskSummary === undefined ? {} : { riskSummary }),
    createdAt: now,
    status: 'OPEN',
  };
}

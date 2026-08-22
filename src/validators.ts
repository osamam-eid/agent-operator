/**
 * Agent Operator — Stage 1 deterministic contract validators.
 *
 * Pure, synchronous, side-effect-free validation. No filesystem, network,
 * OMP runtime, provider, or persistence calls. Every validator collects all
 * structural and cross-field errors rather than stopping at the first one,
 * and rejects unknown properties at every contract-owned object boundary.
 *
 * Normalization is limited to trimming permitted human-facing prose fields
 * in the returned value; every other field is validated and returned
 * byte-for-byte as provided (no type coercion).
 *
 * This file is a thin compatibility facade: the twelve contract validators
 * and their shared engine live in src/validation/ (primitives.ts, enums.ts,
 * core-contracts.ts, session.ts, results.ts), split by domain so each stays
 * comfortably under 1,000 lines. Runtime consumers that only need one or
 * two validators (see e.g. compiler.ts, controller.ts, runtime-validators.ts)
 * import the narrow src/validation/* module directly instead of this
 * barrel, so they never eagerly load unrelated validation logic. This
 * facade exists for src/index.ts's public API and for callers that
 * genuinely want the full contract surface (e.g. validateContract below).
 */

import type {
  AgentResult,
  ArtifactManifest,
  CapabilityRecord,
  Evidence,
  ExecutionGraph,
  FinalOperatorResult,
  Finding,
  HumanGate,
  OperatorSession,
  PolicyDecision,
  RouteDecision,
  WorkflowTemplate,
} from './contracts.js';

import type { ValidationError, ValidationResult } from './validation/primitives.js';

import {
  validateCapabilityRecord,
  validateExecutionGraph,
  validateRouteDecision,
  validateWorkflowTemplate,
} from './validation/core-contracts.js';

import { validateHumanGate, validateOperatorSession } from './validation/session.js';

import {
  validateAgentResult,
  validateArtifactManifest,
  validateEvidence,
  validateFinalOperatorResult,
  validateFinding,
  validatePolicyDecision,
} from './validation/results.js';

export type { ValidationError, ValidationResult };

export {
  validateCapabilityRecord,
  validateRouteDecision,
  validateWorkflowTemplate,
  validateExecutionGraph,
  validateAgentResult,
  validateEvidence,
  validateArtifactManifest,
  validateFinding,
  validatePolicyDecision,
  validateHumanGate,
  validateOperatorSession,
  validateFinalOperatorResult,
};

export type ContractName =
  | 'CapabilityRecord'
  | 'RouteDecision'
  | 'WorkflowTemplate'
  | 'ExecutionGraph'
  | 'AgentResult'
  | 'OperatorSession'
  | 'HumanGate'
  | 'Evidence'
  | 'ArtifactManifest'
  | 'Finding'
  | 'PolicyDecision'
  | 'FinalOperatorResult';

interface ContractTypeMap {
  CapabilityRecord: CapabilityRecord;
  RouteDecision: RouteDecision;
  WorkflowTemplate: WorkflowTemplate;
  ExecutionGraph: ExecutionGraph;
  AgentResult: AgentResult;
  OperatorSession: OperatorSession;
  HumanGate: HumanGate;
  Evidence: Evidence;
  ArtifactManifest: ArtifactManifest;
  Finding: Finding;
  PolicyDecision: PolicyDecision;
  FinalOperatorResult: FinalOperatorResult;
}


// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function validateContract<N extends ContractName>(name: N, input: unknown): ValidationResult<ContractTypeMap[N]> {
  switch (name) {
    case 'CapabilityRecord':
      return validateCapabilityRecord(input) as ValidationResult<ContractTypeMap[N]>;
    case 'RouteDecision':
      return validateRouteDecision(input) as ValidationResult<ContractTypeMap[N]>;
    case 'WorkflowTemplate':
      return validateWorkflowTemplate(input) as ValidationResult<ContractTypeMap[N]>;
    case 'ExecutionGraph':
      return validateExecutionGraph(input) as ValidationResult<ContractTypeMap[N]>;
    case 'AgentResult':
      return validateAgentResult(input) as ValidationResult<ContractTypeMap[N]>;
    case 'OperatorSession':
      return validateOperatorSession(input) as ValidationResult<ContractTypeMap[N]>;
    case 'HumanGate':
      return validateHumanGate(input) as ValidationResult<ContractTypeMap[N]>;
    case 'Evidence':
      return validateEvidence(input) as ValidationResult<ContractTypeMap[N]>;
    case 'ArtifactManifest':
      return validateArtifactManifest(input) as ValidationResult<ContractTypeMap[N]>;
    case 'Finding':
      return validateFinding(input) as ValidationResult<ContractTypeMap[N]>;
    case 'PolicyDecision':
      return validatePolicyDecision(input) as ValidationResult<ContractTypeMap[N]>;
    case 'FinalOperatorResult':
      return validateFinalOperatorResult(input) as ValidationResult<ContractTypeMap[N]>;
    default: {
      const exhaustive: never = name;
      throw new Error(`Unknown contract name: ${String(exhaustive)}`);
    }
  }
}

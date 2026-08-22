import { createHash } from 'node:crypto';
import type { CapabilityRecord, MutationClass } from '../contracts.js';
import type { CapabilitySelection, CapabilityRequirement } from '../stage3-types.js';
import type { NodeExecutionBinding, NodeExecutionTuple, Stage7AdapterId } from './types.js';
import { serializeNodeExecutionTuple } from './adapter-resolver.js';

export const STAGE7_BINDINGS: readonly NodeExecutionBinding[] = [
  binding('qa.v2', 'qa-v2-preflight', 'qa-v2-preflight', 'qa-v2-preflight', 'READ_ONLY', 'stage7-qa-preflight'),
  binding('qa.v2', 'qa-v2-execution', 'qa-v2-executor', 'qa-v2-execution', 'READ_ONLY', 'stage7-qa-execution'),
  binding('qa.v2', 'qa-v2-evidence', 'qa-v2-evidence-collector', 'qa-v2-evidence', 'READ_ONLY', 'stage7-qa-evidence'),
  binding('qa.v2', 'qa-v2-terra-review', 'qa-v2-terra-reviewer', 'qa-v2-independent-review', 'READ_ONLY', 'stage7-qa-review'),
  binding('qa.v2', 'qa-v2-report', 'qa-v2-synthesizer', 'qa-v2-synthesis', 'READ_ONLY', 'stage7-qa-synthesis'),
  binding('ui-change.v2', 'ui-v2-impeccable-design', 'ui-v2-impeccable-designer', 'ui-v2-design', 'READ_ONLY', 'stage7-impeccable'),
  binding('ui-change.v2', 'ui-v2-governed-implementation', 'ui-v2-implementer', 'ui-v2-implementation', 'LOCAL', 'stage7-ui-implementation'),
  binding('ui-change.v2', 'ui-v2-sol-review', 'ui-v2-sol-reviewer', 'ui-v2-sol-assurance', 'READ_ONLY', 'stage7-sol-assurance', 'ui-v2-sol-assurance', 'kiro/gpt-5.6-sol'),
  binding('ui-change.v2', 'ui-v2-visual-verification', 'ui-v2-visual-verifier', 'ui-v2-visual-verification', 'READ_ONLY', 'stage7-visual'),
  binding('ui-change.v2', 'ui-v2-synthesis', 'ui-v2-synthesizer', 'ui-v2-synthesis', 'READ_ONLY', 'stage7-ui-synthesis'),
];

function binding(
  workflowTemplateId: string,
  nodeId: string,
  role: string,
  requiredCapability: string,
  mutationClass: MutationClass,
  adapterId: Stage7AdapterId,
  assuranceRole?: 'ui-v2-sol-assurance',
  runtimeImplementation?: string,
): NodeExecutionBinding {
  const tuple: NodeExecutionTuple = {
    workflowTemplateId,
    nodeId,
    role,
    capabilityId: adapterId,
    requiredCapability,
    mutationClass,
  };
  return {
    tuple,
    adapterId,
    ...(assuranceRole !== undefined ? { assuranceRole } : {}),
    ...(runtimeImplementation !== undefined ? { runtimeImplementation } : {}),
  };
}

export const STAGE7_BINDING_MANIFEST_HASH = createHash('sha256').update(STAGE7_BINDINGS.map((binding) => serializeNodeExecutionTuple(binding.tuple) + `:${binding.adapterId}`).join('\n'), 'utf8').digest('hex');

export function getStage7Binding(tuple: NodeExecutionTuple): NodeExecutionBinding | undefined {
  const key = serializeNodeExecutionTuple(tuple);
  return STAGE7_BINDINGS.find((entry) => serializeNodeExecutionTuple(entry.tuple) === key);
}

export function stage7CapabilityRecord(binding: NodeExecutionBinding): CapabilityRecord {
  const mutability = binding.tuple.mutationClass === 'READ_ONLY' ? 'READ_ONLY' : 'MUTATING';
  return {
    id: binding.adapterId,
    kind: 'omp-role',
    capabilities: [binding.tuple.requiredCapability],
    mutability,
    modelTiers: ['LOW', 'MEDIUM', 'HIGH'],
    tools: [],
    spawns: false,
    supports: ['SINGLE', 'PIPELINE'],
    costClass: 'MEDIUM',
    latencyClass: 'MEDIUM',
    concurrency: 1,
    health: 'HEALTHY',
    source: `stage7-binding:${binding.adapterId}`,
  };
}

export function selectStage7Capability(requirement: CapabilityRequirement, binding: NodeExecutionBinding): CapabilitySelection {
  if (requirement.role !== binding.tuple.role || requirement.capability !== binding.tuple.requiredCapability || requirement.mutationClass !== binding.tuple.mutationClass) {
    throw new Error(`Stage-7 capability requirement does not match binding ${binding.adapterId}.`);
  }
  const selected = stage7CapabilityRecord(binding);
  return { requirement, selected, provider: 'stage7-fixed', reasonCode: 'STAGE7_FIXED_BINDING' };
}

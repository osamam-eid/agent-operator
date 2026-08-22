import { createHash } from 'node:crypto';
import type { NodeExecutionTuple } from '../types.js';
import type { QaNativeBinding } from './types.js';

const QA_ROLE_TOOLS = ['browser', 'bash', 'read', 'grep', 'glob', 'debug', 'write'] as const;
const QA_REVIEW_ROLE_TOOLS = ['read', 'grep', 'glob', 'bash'] as const;

export const QA_EXECUTION_BINDING: QaNativeBinding = Object.freeze({
  adapterId: 'stage7-qa-execution',
  workflowTemplateId: 'qa.v2',
  nodeId: 'qa-v2-execution',
  role: 'qa-v2-executor',
  capabilityId: 'stage7-qa-execution',
  requiredCapability: 'qa-v2-execution',
  mutationClass: 'READ_ONLY',
  agentName: 'qa',
  provider: 'kiro',
  modelId: 'gpt-5.6-luna',
  roleContentSha256: '9a70a3f24923c45f8d804bcf7f287ba9bc34de49b4a86902425390c87fb98b22',
  requiredRoleTools: QA_ROLE_TOOLS,
  allowedDispatchTools: ['browser', 'bash', 'read', 'grep', 'glob', 'debug'],
  outputSchemaId: 'agent-result.v1',
});

export const QA_REVIEW_BINDING: QaNativeBinding = Object.freeze({
  adapterId: 'stage7-qa-review',
  workflowTemplateId: 'qa.v2',
  nodeId: 'qa-v2-terra-review',
  role: 'qa-v2-terra-reviewer',
  capabilityId: 'stage7-qa-review',
  requiredCapability: 'qa-v2-independent-review',
  mutationClass: 'READ_ONLY',
  agentName: 'qa-review',
  provider: 'kiro',
  modelId: 'gpt-5.6-terra',
  roleContentSha256: 'e50dc1d567f9996a747795ab39384cf0c248c99ca49e4f244b1b2c09770a6a69',
  requiredRoleTools: QA_REVIEW_ROLE_TOOLS,
  allowedDispatchTools: ['read', 'grep', 'glob'],
  outputSchemaId: 'agent-result.v1',
});

export const QA_NATIVE_BINDINGS: readonly QaNativeBinding[] = Object.freeze([QA_EXECUTION_BINDING, QA_REVIEW_BINDING]);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function manifestMaterial(binding: QaNativeBinding): Record<string, unknown> {
  return {
    adapterId: binding.adapterId,
    workflowTemplateId: binding.workflowTemplateId,
    nodeId: binding.nodeId,
    role: binding.role,
    capabilityId: binding.capabilityId,
    requiredCapability: binding.requiredCapability,
    mutationClass: binding.mutationClass,
    agentName: binding.agentName,
    provider: binding.provider,
    modelId: binding.modelId,
    roleContentSha256: binding.roleContentSha256,
    requiredRoleTools: [...binding.requiredRoleTools],
    allowedDispatchTools: [...binding.allowedDispatchTools],
    outputSchemaId: binding.outputSchemaId,
  };
}

export const QA_BINDING_ARTIFACT_HASH = '6c75f61d4c4471603c759de45c2aada19ab67ad6a8814fede97a7cbb0d9bd4dc';

export function qaBindingTuple(binding: QaNativeBinding): NodeExecutionTuple {
  return {
    workflowTemplateId: binding.workflowTemplateId,
    nodeId: binding.nodeId,
    role: binding.role,
    capabilityId: binding.capabilityId,
    requiredCapability: binding.requiredCapability,
    mutationClass: binding.mutationClass,
  };
}

export function findQaBinding(adapterId: QaNativeBinding['adapterId']): QaNativeBinding {
  const binding = QA_NATIVE_BINDINGS.find((candidate) => candidate.adapterId === adapterId);
  if (binding === undefined) throw new Error(`QA binding ${adapterId} is not present in the closed Stage-7 binding artifact.`);
  return binding;
}

export function assertQaBindingArtifactIntegrity(): void {
  const material = QA_NATIVE_BINDINGS.map(manifestMaterial);
  const actual = createHash('sha256').update(canonical(material), 'utf8').digest('hex');
  if (actual !== QA_BINDING_ARTIFACT_HASH) throw new Error('Stage-7 QA binding artifact integrity mismatch.');
  const ids = new Set(QA_NATIVE_BINDINGS.map((binding) => binding.adapterId));
  if (ids.size !== 2 || !ids.has('stage7-qa-execution') || !ids.has('stage7-qa-review')) throw new Error('Stage-7 QA binding artifact must contain exactly execution and Terra review bindings.');
}

export function validateQaBinding(binding: QaNativeBinding): void {
  assertQaBindingArtifactIntegrity();
  if (binding.mutationClass !== 'READ_ONLY') throw new Error(`QA binding ${binding.adapterId} must be READ_ONLY.`);
  if (binding.provider !== 'kiro') throw new Error(`QA binding ${binding.adapterId} must use the fixed Kiro provider.`);
  if (binding.outputSchemaId !== 'agent-result.v1') throw new Error(`QA binding ${binding.adapterId} has an unsupported output schema.`);
  if (binding.agentName === 'qa' && binding.modelId !== 'gpt-5.6-luna') throw new Error('QA execution must use Luna.');
  if (binding.agentName === 'qa-review' && binding.modelId !== 'gpt-5.6-terra') throw new Error('QA review must use Terra.');
  if (binding.allowedDispatchTools.some((tool) => !binding.requiredRoleTools.includes(tool))) throw new Error(`QA binding ${binding.adapterId} dispatches a tool not declared by its authoritative role.`);
  if (binding.allowedDispatchTools.includes('write')) throw new Error(`QA binding ${binding.adapterId} cannot dispatch source/configuration write access.`);
}

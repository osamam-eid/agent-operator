import type { NodeExecutionAdapter } from '../runtime-types.js';
import type { NodeExecutionAdapterResolver, NodeExecutionTuple, ProductionNodeExecutionAdapterId, Stage7AdapterId, Stage7FeatureSet, NodeExecutionBinding, Stage7RouteErrorCode } from './types.js';

export class Stage7RouteResolutionError extends Error {
  readonly code: Stage7RouteErrorCode;
  readonly tuple: NodeExecutionTuple;
  readonly adapterId: ProductionNodeExecutionAdapterId | undefined;

  constructor(code: Stage7RouteErrorCode, tuple: NodeExecutionTuple, message: string, adapterId: ProductionNodeExecutionAdapterId | undefined = undefined) {
    super(message);
    this.name = 'Stage7RouteResolutionError';
    this.code = code;
    this.tuple = tuple;
    this.adapterId = adapterId;
  }
}

export function serializeNodeExecutionTuple(tuple: NodeExecutionTuple): string {
  return [tuple.workflowTemplateId, tuple.nodeId, tuple.role, tuple.capabilityId, tuple.requiredCapability, tuple.mutationClass].map((part) => JSON.stringify(part)).join('|');
}

function isStage7Template(templateId: string): boolean {
  return templateId === 'qa.v2' || templateId === 'ui-change.v2';
}

export interface Stage7ResolverOptions {
  readonly frozenAdapter: NodeExecutionAdapter;
  readonly featureSet?: Stage7FeatureSet;
  readonly bindings: readonly NodeExecutionBinding[];
  readonly implementations?: ReadonlyMap<Stage7AdapterId, NodeExecutionAdapter>;
  /** Concrete external-cli executor for fleet.v1 tuples (Stage 9); absent keeps fleet fail-closed. */
  readonly fleetAdapter?: NodeExecutionAdapter;
}

export function createFrozenNodeExecutionAdapterResolver(adapter: NodeExecutionAdapter, allowMockAdapter = false): NodeExecutionAdapterResolver {
  return {
    resolve(tuple): NodeExecutionAdapter {
      if (isStage7Template(tuple.workflowTemplateId)) {
        throw new Stage7RouteResolutionError('STAGE7_FEATURE_DISABLED', tuple, `Stage-7 tuple "${tuple.workflowTemplateId}/${tuple.nodeId}" is unavailable while Stage 7 is disabled.`);
      }
      if (adapter.adapterId === 'mock') {
        if (allowMockAdapter) return adapter;
        throw new Stage7RouteResolutionError('UNSUPPORTED_ADAPTER_ID', tuple, 'Mock adapter id is not permitted in production frozen resolution.');
      }
      if (adapter.adapterId !== 'omp-task') {
        throw new Stage7RouteResolutionError('UNSUPPORTED_ADAPTER_ID', tuple, `Unsupported frozen adapter id "${String(adapter.adapterId)}".`, adapter.adapterId);
      }
      return adapter;
    },
  };
}

export function createNodeExecutionAdapterResolver(options: Stage7ResolverOptions): NodeExecutionAdapterResolver {
  const featureSet = options.featureSet;
  const frozen = createFrozenNodeExecutionAdapterResolver(options.frozenAdapter);
  const bindingsByTuple = new Map<string, NodeExecutionBinding>();
  for (const binding of options.bindings) {
    const key = serializeNodeExecutionTuple(binding.tuple);
    if (bindingsByTuple.has(key)) {
      throw new Stage7RouteResolutionError('STAGE7_ROUTE_COLLISION', binding.tuple, `Duplicate Stage-7 tuple manifest entry for ${key}.`, binding.adapterId);
    }
    bindingsByTuple.set(key, binding);
  }
  return {
    resolve(tuple): NodeExecutionAdapter {
      if (tuple.workflowTemplateId === 'fleet.v1') {
        if (featureSet?.stage9ExternalProvidersEnabled !== true) {
          throw new Stage7RouteResolutionError('STAGE7_FEATURE_DISABLED', tuple, 'Fleet execution is disabled by immutable startup configuration.');
        }
        const fleet = options.fleetAdapter;
        if (fleet === undefined) {
          throw new Stage7RouteResolutionError('STAGE7_CAPABILITY_UNAVAILABLE', tuple, 'Fleet execution has no concrete external-cli adapter yet.', 'external-cli');
        }
        return fleet;
      }
      if (!isStage7Template(tuple.workflowTemplateId)) return frozen.resolve(tuple);
      if (featureSet?.stage7Enabled !== true) {
        throw new Stage7RouteResolutionError('STAGE7_FEATURE_DISABLED', tuple, 'Stage-7 execution is disabled by immutable startup configuration.');
      }
      const binding = bindingsByTuple.get(serializeNodeExecutionTuple(tuple));
      if (binding === undefined) {
        throw new Stage7RouteResolutionError('STAGE7_ROUTE_MISMATCH', tuple, `No exact Stage-7 binding matches tuple ${serializeNodeExecutionTuple(tuple)}.`);
      }
      if (binding.adapterId === 'omp-task') {
        throw new Stage7RouteResolutionError('UNSUPPORTED_ADAPTER_ID', tuple, 'Stage-7 tuples cannot route through the frozen omp-task adapter.', binding.adapterId);
      }
      if (binding.adapterId === 'external-cli') {
        throw new Stage7RouteResolutionError('UNSUPPORTED_ADAPTER_ID', tuple, 'Stage-7 tuples cannot route through the external-cli fleet adapter.', binding.adapterId);
      }
      const implementation = options.implementations?.get(binding.adapterId);
      if (implementation === undefined) {
        throw new Stage7RouteResolutionError('STAGE7_CAPABILITY_UNAVAILABLE', tuple, `Stage-7 capability "${binding.adapterId}" has no concrete 7B/7C executor yet.`, binding.adapterId);
      }
      if (implementation.adapterId !== binding.adapterId) {
        if (implementation.adapterId === 'mock') {
          throw new Stage7RouteResolutionError('UNSUPPORTED_ADAPTER_ID', tuple, 'Mock adapter id is not permitted in production Stage-7 resolution.');
        }
        throw new Stage7RouteResolutionError('STAGE7_ROUTE_MISMATCH', tuple, `Implementation id "${implementation.adapterId}" does not match binding id "${binding.adapterId}".`, implementation.adapterId);
      }
      return implementation;
    },
  };
}

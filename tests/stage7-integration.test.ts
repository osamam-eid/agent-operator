import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import type { NodeExecutionAdapter } from '../src/runtime-types.js';
import type { OmpSessionFactory } from '../src/adapters/omp-task.js';
import {
  assertStage7LaterFeatureDisabled,
  createNodeExecutionAdapterResolver,
  createStage7FeatureSet,
  serializeNodeExecutionTuple,
  STAGE7_BINDINGS,
  STAGE7_BINDING_MANIFEST_HASH,
  Stage7FeatureDisabledError,
} from '../src/stage7/index.js';
import type { NodeExecutionTuple, Stage7AdapterId } from '../src/stage7/types.js';
import { createQaAdapterImplementations } from '../src/stage7/qa/implementations.js';
import type { QaExecutionContextResolver, QaReviewContextResolver } from '../src/stage7/qa/types.js';
import { composeStage7UiImplementations } from '../src/stage7/ui/composition.js';
import type { UiAdapter, UiAdapterId } from '../src/stage7/ui/contracts.js';

const frozenOmpTask: NodeExecutionAdapter = {
  adapterId: 'omp-task',
  launchBatch: () => {
    throw new Error('integration proof must not launch frozen batches.');
  },
};

const qaSessionFactory: OmpSessionFactory = {
  createSession: () => {
    throw new Error('integration proof must not dispatch OMP sessions.');
  },
};

function neverContext(): never {
  throw new Error('integration proof must not resolve execution contexts.');
}

const executionContext: QaExecutionContextResolver = { resolve: () => neverContext() };
const reviewContext: QaReviewContextResolver = { resolve: () => neverContext() };

function uiAdapter(adapterId: UiAdapterId): UiAdapter {
  return {
    adapterId,
    launchBatch: () => {
      throw new Error('fixture UI adapter must not launch.');
    },
  };
}

const qaMap = createQaAdapterImplementations({
  execution: { sessionFactory: qaSessionFactory, roleRoot: '/roles/unused-by-construction', outputSchema: {}, context: executionContext },
  review: { sessionFactory: qaSessionFactory, roleRoot: '/roles/unused-by-construction', outputSchema: {}, context: reviewContext },
});

const uiMap = composeStage7UiImplementations({
  design: uiAdapter('stage7-impeccable'),
  implementation: uiAdapter('stage7-ui-implementation'),
  sol: uiAdapter('stage7-sol-assurance'),
  visual: uiAdapter('stage7-visual'),
});

function combineLaneImplementations(...maps: readonly ReadonlyMap<Stage7AdapterId, NodeExecutionAdapter>[]): ReadonlyMap<Stage7AdapterId, NodeExecutionAdapter> {
  const combined = new Map<Stage7AdapterId, NodeExecutionAdapter>();
  for (const map of maps) {
    for (const [id, adapter] of map) {
      if (combined.has(id)) throw new Error(`Cross-lane adapter collision for ${id}.`);
      combined.set(id, adapter);
    }
  }
  return combined;
}

describe('Stage-7D cross-lane assurance', () => {
  test('binding manifest keeps every cross-lane tuple unique and hash-bound', () => {
    const keys = STAGE7_BINDINGS.map((binding) => serializeNodeExecutionTuple(binding.tuple));
    expect(new Set(keys).size).toBe(STAGE7_BINDINGS.length);
    const recomputed = createHash('sha256')
      .update(STAGE7_BINDINGS.map((binding) => `${serializeNodeExecutionTuple(binding.tuple)}:${binding.adapterId}`).join('\n'), 'utf8')
      .digest('hex');
    expect(recomputed).toBe(STAGE7_BINDING_MANIFEST_HASH);
    const qaIds = STAGE7_BINDINGS.filter((binding) => binding.tuple.workflowTemplateId === 'qa.v2').map((binding) => binding.adapterId).sort();
    const uiIds = STAGE7_BINDINGS.filter((binding) => binding.tuple.workflowTemplateId === 'ui-change.v2').map((binding) => binding.adapterId).sort();
    expect(qaIds).toEqual(['stage7-qa-evidence', 'stage7-qa-execution', 'stage7-qa-preflight', 'stage7-qa-review', 'stage7-qa-synthesis']);
    expect(uiIds).toEqual(['stage7-impeccable', 'stage7-sol-assurance', 'stage7-ui-implementation', 'stage7-ui-synthesis', 'stage7-visual']);
  });

  test('lane composition helpers produce disjoint exact-ID maps', () => {
    expect([...qaMap.keys()].sort()).toEqual(['stage7-qa-execution', 'stage7-qa-review']);
    expect([...uiMap.keys()].sort()).toEqual(['stage7-impeccable', 'stage7-sol-assurance', 'stage7-ui-implementation', 'stage7-visual']);
    for (const [id, adapter] of qaMap) expect(adapter.adapterId).toBe(id);
    for (const [id, adapter] of uiMap) expect(adapter.adapterId).toBe(id);
    expect([...qaMap.keys()].filter((id) => uiMap.has(id))).toEqual([]);
  });

  test('combined implementations route concrete tuples to their exact lane adapters and leave native ports closed', () => {
    const combined = combineLaneImplementations(qaMap, uiMap);
    expect(combined.size).toBe(6);
    const resolver = createNodeExecutionAdapterResolver({
      frozenAdapter: frozenOmpTask,
      featureSet: createStage7FeatureSet(true, true),
      bindings: STAGE7_BINDINGS,
      implementations: combined,
    });
    for (const binding of STAGE7_BINDINGS) {
      if (binding.adapterId === 'omp-task' || binding.adapterId === 'external-cli') throw new Error('stage-7 bindings must never bind the frozen omp-task or fleet adapters.');
      const adapter = combined.get(binding.adapterId);
      if (adapter !== undefined) {
        expect(resolver.resolve(binding.tuple)).toBe(adapter);
      } else {
        expect(() => resolver.resolve(binding.tuple)).toThrow(/no concrete 7B\/7C executor/);
      }
    }
  });

  test('cross-lane adapter collisions and role-only lookalikes fail closed', () => {
    const impostorEntry = new Map<Stage7AdapterId, NodeExecutionAdapter>([['stage7-qa-execution', frozenOmpTask]]);
    expect(() => combineLaneImplementations(qaMap, impostorEntry)).toThrow(/collision/);
    const resolver = createNodeExecutionAdapterResolver({
      frozenAdapter: frozenOmpTask,
      featureSet: createStage7FeatureSet(true, true),
      bindings: STAGE7_BINDINGS,
      implementations: combineLaneImplementations(qaMap, uiMap),
    });
    const execution = STAGE7_BINDINGS.find((binding) => binding.adapterId === 'stage7-qa-execution');
    if (execution === undefined) throw new Error('qa execution binding missing from manifest.');
    const lookalike: NodeExecutionTuple = { ...execution.tuple, role: 'generic-reviewer' };
    expect(() => resolver.resolve(lookalike)).toThrow(/No exact Stage-7 binding/);
  });

  test('later-stage features remain negatively activated under trusted startup', () => {
    const featureSet = createStage7FeatureSet(true, true);
    for (const feature of ['publication', 'external-providers', 'evaluator', 'qualification'] as const) {
      expect(() => assertStage7LaterFeatureDisabled(featureSet, feature)).toThrow(Stage7FeatureDisabledError);
    }
  });
});

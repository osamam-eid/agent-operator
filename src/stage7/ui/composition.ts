import type { NodeExecutionAdapter } from '../../runtime-types.js';
import type { Stage7AdapterId } from '../types.js';
import type { UiAdapter, UiAdapterId } from './contracts.js';

export const UI_ADAPTER_IDS: readonly UiAdapterId[] = ['stage7-impeccable', 'stage7-ui-implementation', 'stage7-sol-assurance', 'stage7-visual'];

export interface UiAdapterComposition {
  readonly design: UiAdapter;
  readonly implementation: UiAdapter;
  readonly sol: UiAdapter;
  readonly visual: UiAdapter;
}

export function composeStage7UiImplementations(composition: UiAdapterComposition): ReadonlyMap<Stage7AdapterId, NodeExecutionAdapter> {
  const entries: readonly [Stage7AdapterId, NodeExecutionAdapter][] = [
    ['stage7-impeccable', composition.design],
    ['stage7-ui-implementation', composition.implementation],
    ['stage7-sol-assurance', composition.sol],
    ['stage7-visual', composition.visual],
  ];
  for (const [id, adapter] of entries) if (adapter.adapterId !== id) throw new Error(`UI adapter composition mismatch for ${id}.`);
  return new Map(entries);
}

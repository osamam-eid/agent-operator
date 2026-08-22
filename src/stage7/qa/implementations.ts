import type { NodeExecutionAdapter } from '../../runtime-types.js';
import type { Stage7AdapterId } from '../types.js';
import { QaExecutionAdapter } from '../../adapters/qa-execution.js';
import { QaReviewAdapter } from '../../adapters/qa-review.js';
import type { QaExecutionAdapterDeps, QaReviewAdapterDeps } from './types.js';

export interface QaAdapterImplementationOptions {
  readonly execution: QaExecutionAdapterDeps;
  readonly review: QaReviewAdapterDeps;
}

export function createQaAdapterImplementations(options: QaAdapterImplementationOptions): ReadonlyMap<Stage7AdapterId, NodeExecutionAdapter> {
  const execution = new QaExecutionAdapter(options.execution);
  const review = new QaReviewAdapter(options.review);
  return new Map<Stage7AdapterId, NodeExecutionAdapter>([
    ['stage7-qa-execution', execution],
    ['stage7-qa-review', review],
  ]);
}

/**
 * Agent Operator — illegal-transition result type.
 *
 * Every reducer that can reject an illegal transition returns
 * `StoredOperatorSession | OperatorTransitionError` instead of throwing;
 * `isTransitionError` narrows the union and `transitionError` is the sole
 * constructor, shared by every module under `src/state/` and by
 * `state.ts` itself.
 */

import type { OperatorCommandErrorCode, StoredOperatorSession } from '../runtime-types.js';

export interface OperatorTransitionError {
  readonly kind: 'TRANSITION_ERROR';
  readonly errorCode: OperatorCommandErrorCode;
  readonly message: string;
}

export function isTransitionError(value: StoredOperatorSession | OperatorTransitionError): value is OperatorTransitionError {
  return 'kind' in value && value.kind === 'TRANSITION_ERROR';
}

export function transitionError(errorCode: OperatorCommandErrorCode, message: string): OperatorTransitionError {
  return { kind: 'TRANSITION_ERROR', errorCode, message };
}

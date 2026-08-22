import type { GatePresentation } from './types.js';

export function presentStage7QaGate(artifactIds: readonly string[], cleanupOutcome: 'BLOCKING' | 'PROCEED_BY_POLICY' | 'HUMAN_DECISION_HOLD'): GatePresentation {
  return {
    lane: 'QA',
    artifactIds: [...artifactIds],
    actionsNotPerformed: ['commit', 'push', 'PR', 'merge', 'publish', 'deploy', 'Jira transition', 'live installation'],
    ...(cleanupOutcome === 'HUMAN_DECISION_HOLD' ? { candidateHash: 'HUMAN_DECISION_REQUIRED' } : {}),
  };
}

export function presentStage7UiGate(artifactIds: readonly string[], candidateHash: string): GatePresentation {
  return {
    lane: 'UI',
    artifactIds: [...artifactIds],
    candidateHash,
    assuranceRole: 'ui-v2-sol-assurance',
    actionsNotPerformed: ['commit', 'push', 'PR', 'merge', 'publish', 'deploy', 'Jira transition', 'live installation'],
  };
}

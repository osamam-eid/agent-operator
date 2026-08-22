import type { Stage7ArtifactEnvelope } from '../types.js';
import { assertDesignReviewPayload, assertRenderEvidence, verifySameCandidateHash } from './artifacts.js';

export interface UiHumanGatePresentation {
  readonly lane: 'UI';
  readonly candidateHash: string;
  readonly solReviewArtifactId: string;
  readonly visualArtifactId: string;
  readonly screenshots: readonly unknown[];
  readonly actionsNotPerformed: readonly string[];
}

export interface UiHumanGateDecision {
  readonly status: 'APPROVED' | 'DECLINED';
  readonly candidateHash: string;
  readonly publicationAuthority: 'NONE';
  readonly actionsNotPerformed: readonly string[];
}

export function decideUiHumanGate(presentation: UiHumanGatePresentation, decision: 'APPROVE' | 'REJECT'): UiHumanGateDecision {
  return { status: decision === 'APPROVE' ? 'APPROVED' : 'DECLINED', candidateHash: presentation.candidateHash, publicationAuthority: 'NONE', actionsNotPerformed: presentation.actionsNotPerformed };
}

export function presentUiHumanVisualGate(candidate: Stage7ArtifactEnvelope, solReview: Stage7ArtifactEnvelope, visual: Stage7ArtifactEnvelope): UiHumanGatePresentation {
  verifySameCandidateHash(candidate, candidate.hash);
  if (solReview.artifactType !== 'design-review.v1') throw new Error('UI human gate requires design-review.v1.');
  if (visual.artifactType !== 'ui-visual-verification.v1') throw new Error('UI human gate requires ui-visual-verification.v1.');
  assertDesignReviewPayload(solReview.payload, candidate.hash);
  if (solReview.payload.outcome !== 'APPROVE') throw new Error('UI human gate cannot present a Sol-blocked candidate.');
  if (visual.payload.candidateBundleHash !== candidate.hash) throw new Error('UI human gate candidate hash differs from visual evidence.');
  assertRenderEvidence(visual.payload, candidate.hash);
  return { lane: 'UI', candidateHash: candidate.hash, solReviewArtifactId: solReview.artifactId, visualArtifactId: visual.artifactId, screenshots: [...visual.payload.screenshots], actionsNotPerformed: ['commit', 'push', 'PR', 'merge', 'publish', 'deploy', 'Jira transition', 'live installation'] };
}

import { validateUiCandidateBundle } from './artifact-registry.js';
import type { Stage7ArtifactEnvelope, ProvisionalCandidate, ProvisionalCandidateStore } from './types.js';

export function createProvisionalCandidateStore(): ProvisionalCandidateStore {
  const candidates = new Map<string, ProvisionalCandidate>();
  return {
    quarantine(candidate): void {
      if (candidate.status !== 'QUARANTINED') throw new Error('Only quarantined candidates may enter the provisional store.');
      if (candidates.has(candidate.candidateId)) throw new Error(`Provisional candidate "${candidate.candidateId}" already exists.`);
      candidates.set(candidate.candidateId, structuredClone(candidate));
    },
    promote(candidateId): Stage7ArtifactEnvelope {
      const candidate = candidates.get(candidateId);
      if (candidate === undefined || candidate.status !== 'QUARANTINED') throw new Error(`Provisional candidate "${candidateId}" is not promotable.`);
      const validation = validateUiCandidateBundle(candidate.bundle);
      if (!validation.ok) throw new Error(`Provisional candidate "${candidateId}" failed promotion validation: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`);
      const promoted = { ...candidate, status: 'PROMOTED' as const };
      candidates.set(candidateId, promoted);
      return structuredClone(validation.value);
    },
    invalidate(candidateId, reason): void {
      const candidate = candidates.get(candidateId);
      if (candidate === undefined) return;
      candidates.set(candidateId, { ...candidate, status: 'INVALIDATED', invalidationReason: reason });
    },
    get(candidateId): ProvisionalCandidate | undefined {
      const candidate = candidates.get(candidateId);
      return candidate === undefined ? undefined : structuredClone(candidate);
    },
  };
}

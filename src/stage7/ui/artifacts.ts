import { createHash } from 'node:crypto';
import type { Stage7ArtifactEnvelope, Stage7ArtifactType } from '../types.js';
import type { DesignReviewPayload, DesignSpecPayload, RenderEvidence } from './contracts.js';

export function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function createUiArtifact(
  artifactType: Stage7ArtifactType,
  payload: Readonly<Record<string, unknown>>,
  identity: { readonly artifactId: string; readonly nodeId: string; readonly sessionId: string; readonly producer: string; readonly location: string; readonly createdAt: string; readonly policyRefs?: readonly string[] },
): Stage7ArtifactEnvelope {
  const hash = sha256(JSON.stringify({ artifactType, payload }));
  const serialized = JSON.stringify(payload);
  return {
    artifactId: identity.artifactId,
    artifactType,
    producedByNodeId: identity.nodeId,
    operatorSessionId: identity.sessionId,
    hash,
    location: identity.location,
    sizeBytes: Buffer.byteLength(serialized, 'utf8'),
    createdAt: identity.createdAt,
    contentSummary: `${artifactType} produced by ${identity.producer}`,
    policyRefs: identity.policyRefs === undefined ? [] : [...identity.policyRefs],
    producer: identity.producer,
    payload,
  };
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`UI artifact payload contains unknown field "${key}".`);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) throw new Error(`UI artifact payload is missing "${key}".`);
}
function nonEmptyString(value: unknown, name: string): asserts value is string { if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string.`); }
function sha(value: unknown, name: string): asserts value is string { nonEmptyString(value, name); if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${name} must be a sha256 hash.`); }

export function assertDesignSpecPayload(value: unknown): asserts value is DesignSpecPayload {
  if (!object(value)) throw new Error('Impeccable output must be an object.');
  exactKeys(value, ['surface', 'incumbentTruth', 'layout', 'typography', 'color', 'spacing', 'responsiveStates', 'accessibility', 'nonGoals']);
  nonEmptyString(value.surface, 'surface');
  nonEmptyString(value.incumbentTruth, 'incumbentTruth');
  for (const key of ['layout', 'typography', 'color', 'spacing']) if (!object(value[key])) throw new Error(`${key} must be an object.`);
  const layout = value.layout as Readonly<Record<string, unknown>>;
  for (const key of ['mode', 'preservation', 'replacement']) nonEmptyString(layout[key], `layout.${key}`);
  if (!Array.isArray(layout.paths) || layout.paths.some((entry) => typeof entry !== 'string' || entry.length === 0)) throw new Error('layout.paths must list exact non-empty paths.');
  if (!Array.isArray(layout.interaction)) throw new Error('layout.interaction must be an array.');
  for (const key of ['responsiveStates', 'accessibility', 'nonGoals']) if (!Array.isArray(value[key])) throw new Error(`${key} must be an array.`);
}

export function assertDesignReviewPayload(value: unknown, expectedHash: string): asserts value is DesignReviewPayload {
  if (!object(value)) throw new Error('Sol output must be an object.');
  exactKeys(value, ['assuranceRole', 'candidateBundleHash', 'outcome', 'findings']);
  if (value.assuranceRole !== 'ui-v2-sol-assurance') throw new Error('Sol assurance role is not exact.');
  sha(value.candidateBundleHash, 'candidateBundleHash');
  if (value.candidateBundleHash !== expectedHash) throw new Error('Sol reviewed a different candidate hash.');
  if (value.outcome !== 'APPROVE' && value.outcome !== 'BLOCK') throw new Error('Sol outcome must be APPROVE or BLOCK.');
  if (!Array.isArray(value.findings) || value.findings.some((finding) => !object(finding))) throw new Error('Sol findings must be structured objects.');
}

export function assertRenderEvidence(value: unknown, candidateHash: string): asserts value is RenderEvidence {
  if (!object(value)) throw new Error('Visual verifier output must be an object.');
  exactKeys(value, ['candidateBundleHash', 'screenshots', 'routes', 'viewports', 'accessibility', 'consoleFailures', 'networkFailures']);
  sha(value.candidateBundleHash, 'candidateBundleHash');
  if (value.candidateBundleHash !== candidateHash) throw new Error('Visual evidence references a different candidate hash.');
  if (!Array.isArray(value.screenshots) || value.screenshots.length === 0) throw new Error('At least one screenshot is required.');
  for (const screenshot of value.screenshots) {
    if (!object(screenshot)) throw new Error('Screenshot evidence must be an object.');
    exactKeys(screenshot, ['route', 'state', 'viewport', 'hash', 'location']);
    for (const key of ['route', 'state', 'viewport', 'location']) nonEmptyString(screenshot[key], `screenshot.${key}`);
    sha(screenshot.hash, 'screenshot.hash');
    if (screenshot.hash === candidateHash) throw new Error('Screenshot hash must identify rendered bytes, not the candidate bundle.');
  }
  for (const key of ['routes', 'viewports', 'accessibility', 'consoleFailures', 'networkFailures']) if (!Array.isArray(value[key])) throw new Error(`${key} must be an array.`);
}

export function assertCandidateArtifact(value: Stage7ArtifactEnvelope): void {
  if (value.artifactType !== 'ui-candidate-bundle.v1') throw new Error('Expected ui-candidate-bundle.v1.');
  if (!object(value.payload)) throw new Error('Candidate payload must be an object.');
  exactKeys(value.payload, ['baselineIdentity', 'changedPaths', 'materializationManifest', 'dependencyInputs', 'fileHashes', 'secretScan', 'capturedAt', 'producer']);
  nonEmptyString(value.payload.baselineIdentity, 'baselineIdentity');
  if (!Array.isArray(value.payload.changedPaths) || value.payload.changedPaths.some((path) => typeof path !== 'string' || path.length === 0)) throw new Error('Candidate changedPaths must be non-empty strings.');
  if (!object(value.payload.materializationManifest) || !object(value.payload.fileHashes)) throw new Error('Candidate manifests must be objects.');
  if (!Array.isArray(value.payload.dependencyInputs)) throw new Error('Candidate dependencyInputs must be an array.');
  if (!object(value.payload.secretScan) || value.payload.secretScan.status !== 'CLEAN') throw new Error('Candidate secret scan must be structured and CLEAN.');
  nonEmptyString(value.payload.capturedAt, 'capturedAt');
  nonEmptyString(value.payload.producer, 'producer');
}

export function expectedArtifactHash(artifact: Stage7ArtifactEnvelope): string { return sha256(JSON.stringify({ artifactType: artifact.artifactType, payload: artifact.payload })); }
export function verifyArtifactHash(artifact: Stage7ArtifactEnvelope): boolean { return artifact.hash === expectedArtifactHash(artifact); }
export function verifySameCandidateHash(candidate: Stage7ArtifactEnvelope, claimedHash: string): void {
  assertCandidateArtifact(candidate);
  if (!verifyArtifactHash(candidate) || candidate.hash !== claimedHash) throw new Error('Candidate artifact hash is invalid or mismatched.');
}

export function renderPayload(evidence: RenderEvidence, candidateBundleHash: string): Readonly<Record<string, unknown>> {
  assertRenderEvidence(evidence, candidateBundleHash);
  return {
    candidateBundleHash,
    screenshots: evidence.screenshots,
    routes: evidence.routes,
    viewports: evidence.viewports,
    accessibility: evidence.accessibility,
    consoleFailures: evidence.consoleFailures,
    networkFailures: evidence.networkFailures,
  };
}

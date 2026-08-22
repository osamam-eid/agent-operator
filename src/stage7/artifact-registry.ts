import { validateArtifactManifest } from '../validation/results.js';
import { validateQaAuthorityEnvelope } from './grants.js';
import type { Stage7ArtifactEnvelope, Stage7ArtifactRegistry, Stage7ArtifactType, Stage7SecretScan } from './types.js';
import type { Stage7ValidationError, Stage7ValidationResult } from './grants.js';

const ARTIFACT_TYPES: readonly Stage7ArtifactType[] = [
  'qa-environment-approval.v1', 'deployment-context.v1', 'qa-execution-log.v1', 'qa-evidence.v1', 'qa-review.v1', 'qa-report.v1',
  'ui-design-spec.v1', 'ui-implementation-diff.v1', 'ui-candidate-bundle.v1', 'design-review.v1', 'ui-visual-verification.v1',
];
const PAYLOAD_KEYS: Readonly<Record<Stage7ArtifactType, readonly string[]>> = {
  'qa-environment-approval.v1': ['approvalId', 'environmentType', 'environmentUrl', 'tenant', 'permittedActions', 'fixtureIds', 'expiresAt', 'scopeHash'],
  'deployment-context.v1': ['environmentIdentity', 'buildIdentity', 'specRevision', 'retrievedAt'],
  'qa-execution-log.v1': ['qaRunId', 'authority', 'entries', 'cleanupDisposition'],
  'qa-evidence.v1': ['qaRunId', 'evidenceRefs', 'checksumManifest', 'roleCoverage', 'authority', 'cleanupDisposition'],
  'qa-review.v1': ['reviewerRole', 'reviewOutcome', 'challengedEvidenceRefs', 'authority', 'cleanupDisposition'],
  'qa-report.v1': ['qaRunId', 'finalStatus', 'findingIds', 'authority', 'cleanupDisposition'],
  'ui-design-spec.v1': ['surface', 'incumbentTruth', 'layout', 'typography', 'color', 'spacing', 'responsiveStates', 'accessibility', 'nonGoals'],
  'ui-implementation-diff.v1': ['baselineIdentity', 'changedPaths', 'verificationEvidenceRefs', 'candidateBundleId'],
  'ui-candidate-bundle.v1': ['baselineIdentity', 'changedPaths', 'materializationManifest', 'dependencyInputs', 'fileHashes', 'secretScan', 'capturedAt', 'producer'],
  'design-review.v1': ['assuranceRole', 'candidateBundleHash', 'outcome', 'findings'],
  'ui-visual-verification.v1': ['candidateBundleHash', 'screenshots', 'routes', 'viewports', 'accessibility', 'consoleFailures', 'networkFailures'],
};
const FORBIDDEN_KEYS = /secret|token|password|cookie|authorization|authheader|private.?reasoning|chain.?of.?thought/i;

function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function issue(path: string, message: string): Stage7ValidationError { return { path, message }; }
function scan(value: unknown, path: string, list: Stage7ValidationError[]): void {
  if (Array.isArray(value)) { value.forEach((item, index) => scan(item, `${path}[${index}]`, list)); return; }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(key) && !(key === 'secretScan' && path === '<root>.payload')) list.push(issue(`${path}.${key}`, 'secret-bearing and private-reasoning fields are forbidden'));
    scan(child, `${path}.${key}`, list);
  }
}

const SECRET_SCAN_KEYS = ['status', 'scannerVersion', 'scannedAt', 'coverage'] as const;
const SECRET_SCAN_COVERAGE_KEYS = ['filesScanned', 'bytesScanned'] as const;
function validateSecretScan(value: unknown, path: string, list: Stage7ValidationError[]): value is Stage7SecretScan {
  if (!isObject(value)) {
    list.push(issue(path, 'must be a structured clean secret-scan result'));
    return false;
  }
  for (const key of Object.keys(value)) if (!SECRET_SCAN_KEYS.includes(key as (typeof SECRET_SCAN_KEYS)[number])) list.push(issue(`${path}.${key}`, 'unknown property'));
  if (value.status !== 'CLEAN') list.push(issue(`${path}.status`, 'must be exactly CLEAN'));
  if (typeof value.scannerVersion !== 'string' || value.scannerVersion.length === 0 || value.scannerVersion.length > 256) list.push(issue(`${path}.scannerVersion`, 'must be a non-empty scanner version'));
  if (typeof value.scannedAt !== 'string' || !Number.isFinite(Date.parse(value.scannedAt))) list.push(issue(`${path}.scannedAt`, 'must be an ISO timestamp'));
  if (!isObject(value.coverage)) {
    list.push(issue(`${path}.coverage`, 'must be a structured coverage object'));
  } else {
    for (const key of Object.keys(value.coverage)) if (!SECRET_SCAN_COVERAGE_KEYS.includes(key as (typeof SECRET_SCAN_COVERAGE_KEYS)[number])) list.push(issue(`${path}.coverage.${key}`, 'unknown property'));
    for (const key of SECRET_SCAN_COVERAGE_KEYS) {
      const count = value.coverage[key];
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) list.push(issue(`${path}.coverage.${key}`, 'must be a non-negative integer'));
    }
  }
  return list.length === 0 && value.status === 'CLEAN' && typeof value.scannerVersion === 'string' && typeof value.scannedAt === 'string' && isObject(value.coverage) && typeof value.coverage.filesScanned === 'number' && typeof value.coverage.bytesScanned === 'number';
}

export function validateStage7Artifact(input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> {
  const list: Stage7ValidationError[] = [];
  if (!isObject(input)) return { ok: false, errors: [issue('<root>', 'must be an object')] };
  const allowed = ['artifactId', 'artifactType', 'producedByNodeId', 'operatorSessionId', 'hash', 'location', 'sizeBytes', 'createdAt', 'contentSummary', 'policyRefs', 'producer', 'payload'];
  for (const key of Object.keys(input)) if (!allowed.includes(key)) list.push(issue(`<root>.${key}`, 'unknown property'));
  const artifactType = input.artifactType;
  if (typeof artifactType !== 'string' || !ARTIFACT_TYPES.includes(artifactType as Stage7ArtifactType)) list.push(issue('<root>.artifactType', 'must be an approved Stage-7 artifact type'));
  const manifestInput: Record<string, unknown> = { artifactId: input.artifactId, artifactType: input.artifactType, producedByNodeId: input.producedByNodeId, operatorSessionId: input.operatorSessionId, hash: input.hash, location: input.location, sizeBytes: input.sizeBytes, createdAt: input.createdAt, contentSummary: input.contentSummary, policyRefs: input.policyRefs };
  const manifest = validateArtifactManifest(manifestInput);
  if (!manifest.ok) for (const error of manifest.errors) list.push(issue(error.path, error.message));
  if (typeof input.producer !== 'string' || input.producer.length === 0) list.push(issue('<root>.producer', 'must be a non-empty string'));
  if (typeof input.sizeBytes !== 'number' || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 0) list.push(issue('<root>.sizeBytes', 'must be a non-negative integer'));
  if (!isObject(input.payload)) list.push(issue('<root>.payload', 'must be an object'));
  else if (typeof artifactType === 'string' && ARTIFACT_TYPES.includes(artifactType as Stage7ArtifactType)) {
    const permitted = PAYLOAD_KEYS[artifactType as Stage7ArtifactType];
    for (const key of Object.keys(input.payload)) if (!permitted.includes(key)) list.push(issue(`<root>.payload.${key}`, 'unknown property'));
    if (artifactType === 'ui-candidate-bundle.v1') {
      validateSecretScan(input.payload.secretScan, '<root>.payload.secretScan', list);
    }
    if (artifactType === 'qa-execution-log.v1' || artifactType === 'qa-evidence.v1' || artifactType === 'qa-review.v1' || artifactType === 'qa-report.v1') {
      const authority = validateQaAuthorityEnvelope(input.payload.authority);
      if (!authority.ok) for (const error of authority.errors) list.push(issue(`<root>.payload.authority${error.path === '<root>' ? '' : error.path.slice('<root>'.length)}`, error.message));
    }
  }
  scan(input, '<root>', list);
  if (list.length > 0 || !manifest.ok || typeof artifactType !== 'string' || !isObject(input.payload) || typeof input.producer !== 'string') return { ok: false, errors: list };
  return { ok: true, value: { ...manifest.value, artifactType: artifactType as Stage7ArtifactType, sizeBytes: input.sizeBytes as number, producer: input.producer, payload: input.payload } };
}

export function validateArtifactType(input: unknown, artifactType: Stage7ArtifactType): Stage7ValidationResult<Stage7ArtifactEnvelope> {
  const result = validateStage7Artifact(input);
  if (!result.ok) return result;
  return result.value.artifactType === artifactType ? result : { ok: false, errors: [issue('artifactType', `must be ${artifactType}`)] };
}

export function createStage7ArtifactRegistry(): Stage7ArtifactRegistry {
  const artifacts = new Map<string, Stage7ArtifactEnvelope>();
  return {
    register(artifact): void {
      const validation = validateStage7Artifact(artifact);
      if (!validation.ok) throw new Error(`Artifact rejected: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`);
      if (artifacts.has(artifact.artifactId)) throw new Error(`Artifact id "${artifact.artifactId}" is already registered.`);
      artifacts.set(artifact.artifactId, structuredClone(artifact));
    },
    get(artifactId): Stage7ArtifactEnvelope | undefined {
      const artifact = artifacts.get(artifactId);
      return artifact === undefined ? undefined : structuredClone(artifact);
    },
    list(): readonly Stage7ArtifactEnvelope[] { return [...artifacts.values()].map((artifact) => structuredClone(artifact)); },
  };
}

export { ARTIFACT_TYPES };

export const validateQaEnvironmentApproval = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'qa-environment-approval.v1');
export const validateDeploymentContext = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'deployment-context.v1');
export const validateQaExecutionLog = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'qa-execution-log.v1');
export const validateQaEvidence = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'qa-evidence.v1');
export const validateQaReview = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'qa-review.v1');
export const validateQaReport = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'qa-report.v1');
export const validateUiDesignSpec = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'ui-design-spec.v1');
export const validateUiImplementationDiff = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'ui-implementation-diff.v1');
export const validateUiCandidateBundle = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'ui-candidate-bundle.v1');
export const validateDesignReview = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'design-review.v1');
export const validateUiVisualVerification = (input: unknown): Stage7ValidationResult<Stage7ArtifactEnvelope> => validateArtifactType(input, 'ui-visual-verification.v1');

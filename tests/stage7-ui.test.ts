import { describe, expect, test } from 'bun:test';
import type { ArtifactManifest } from '../src/contracts.js';
import type { NodeExecutionAdapterId, NodeExecutionRequest } from '../src/runtime-types.js';
import type { WorktreePort } from '../src/mutation/worktree.js';
import type { CandidateCaptureFilesystem, CandidateFile, DesignReviewPayload, RenderEvidence, SolProcessSupervisor } from '../src/stage7/ui/contracts.js';
import { LocalCandidateCapturePort } from '../src/stage7/ui/candidate-capture.js';
import { assertDesignSpecPayload, assertRenderEvidence, createUiArtifact, sha256 } from '../src/stage7/ui/artifacts.js';
import { KiroSolAssurancePort } from '../src/stage7/ui/sol-assurance.js';
import { presentUiHumanVisualGate, decideUiHumanGate } from '../src/stage7/ui/gate.js';
import { composeStage7UiImplementations } from '../src/stage7/ui/composition.js';

const now = '2026-08-21T20:00:00.000Z';
const design = { surface: 'fixture', incumbentTruth: 'existing fixture UI', layout: { mode: 'Operate', preservation: 'preserve behavior', replacement: 'none', paths: ['src/ui.ts'], interaction: [] }, typography: {}, color: {}, spacing: {}, responsiveStates: ['desktop'], accessibility: ['keyboard'], nonGoals: [] } as const;
const delegate: WorktreePort = {
  createIsolated: async () => ({ worktreeId: 'wt-1', path: '/approved/wt-1', projectRoot: '/project' }),
  realpath: async (value) => value,
  remove: async () => {},
  snapshot: async () => ({ identity: 'baseline-1', digest: 'd'.repeat(64), capturedAt: now }),
  executeMutation: async () => {},
  diff: async () => ['src/ui.ts'],
};
function captureRequest(): Parameters<LocalCandidateCapturePort['capture']>[0] {
  return { worktree: { worktreeId: 'wt-1', path: '/approved/wt-1', projectRoot: '/project' }, baseline: { identity: 'baseline-1', digest: 'd'.repeat(64), capturedAt: now }, changedPaths: ['src/ui.ts'], scope: { scopeHash: 's'.repeat(64), contractHash: 'c'.repeat(64), allowedPaths: ['src/ui.ts'], baselineIdentity: 'baseline-1', mutationClass: 'LOCAL' }, operatorSessionId: 'session-1', nodeId: 'ui-v2-governed-implementation' };
}
function filesystem(status: 'CLEAN' | 'FINDINGS'): CandidateCaptureFilesystem {
  const file: CandidateFile = { path: 'src/ui.ts', mode: 'FULL', content: new TextEncoder().encode('fixture'), location: '/approved/wt-1/src/ui.ts' };
  return { collect: async () => [file], materializationManifest: async () => ({ recipe: 'fixture-render-v1' }), dependencyInputs: async () => [{ lockfileHash: 'l'.repeat(64) }], secretScan: async () => ({ status, scannerVersion: 'fake-secret-scan-1', scannedAt: now, coverage: { filesScanned: 1, bytesScanned: 7 }, findings: status === 'CLEAN' ? [] : [{ category: 'credential-pattern', path: 'src/ui.ts' }] }) };
}
function request(nodeId: string, role: string, capabilityId: NodeExecutionAdapterId, requiredCapability: string, mutationClass: 'READ_ONLY' | 'LOCAL', consumedArtifacts: readonly ArtifactManifest[] = []): NodeExecutionRequest {
  return {
    node: { nodeId, role, capabilityId, requiredCapability, mandatory: true, dependsOn: [], contextPolicy: 'isolated', consumes: [], produces: [] },
    mutationClass,
    consumedArtifacts,
    allocation: { attemptId: 'attempt-1', batchId: 'batch-1', operatorSessionId: 'session-1', graphRevision: 1, nodeId, capabilityId, adapterId: capabilityId, providerSessionId: 'provider-1', startedAt: now, timeoutAt: now },
    requestOrSummary: 'fixture',
    dependencyResultSummaries: [],
    consumedEvidence: [],
    projection: { projectionRoot: '/project', allowedPaths: ['src/ui.ts'], manifestHash: 'm'.repeat(64), sourceLabels: [] },
    policyRefs: [],
    instructions: 'fixture',
    acceptanceCriteria: [],
    toolGrant: [],
    outputSchemaId: 'fixture',
  };
}

describe('Stage-7C isolated UI controls', () => {
  test('clean local capture is quarantined and positive scan blocks without candidate', async () => {
    const clean = new LocalCandidateCapturePort(delegate, filesystem('CLEAN'), () => now);
    const captured = await clean.capture(captureRequest());
    expect(captured.candidate.status).toBe('QUARANTINED');
    expect(captured.candidate.bundle.payload.secretScan).toMatchObject({ status: 'CLEAN' });
    const blocked = new LocalCandidateCapturePort(delegate, filesystem('FINDINGS'), () => now);
    await expect(blocked.capture(captureRequest())).rejects.toThrow(/secret scan blocked/);
  });

  test('strict design and screenshot evidence enforce craft floor and visual proof', () => {
    expect(() => assertDesignSpecPayload(design)).not.toThrow();
    expect(() => assertDesignSpecPayload({ ...design, layout: { ...design.layout, mode: undefined } })).toThrow();
    const candidateHash = 'a'.repeat(64);
    const screenshot = { route: '/', state: 'default', viewport: '1280x800', hash: sha256('pixels'), location: '/evidence/shot.png' };
    const evidence: RenderEvidence = { candidateBundleHash: candidateHash, screenshots: [screenshot], routes: ['/'], viewports: ['1280x800'], accessibility: [], consoleFailures: [], networkFailures: [] };
    expect(() => assertRenderEvidence(evidence, candidateHash)).not.toThrow();
    const { candidateBundleHash: omittedCandidateBundleHash, ...missingCandidateHash } = evidence;
    void omittedCandidateBundleHash;
    expect(() => assertRenderEvidence(missingCandidateHash, candidateHash)).toThrow(/missing "candidateBundleHash"/);
    expect(() => assertRenderEvidence({ ...evidence, candidateBundleHash: 'b'.repeat(64) }, candidateHash)).toThrow(/different candidate hash/);
    expect(() => assertRenderEvidence({ ...evidence, screenshots: [] }, candidateHash)).toThrow(/screenshot/);
  });

  test('Sol port is fixed Kiro, read-only, and returns exact candidate hash', async () => {
    const candidate = createUiArtifact('ui-candidate-bundle.v1', { baselineIdentity: 'baseline-1', changedPaths: ['src/ui.ts'], materializationManifest: {}, dependencyInputs: [], fileHashes: { 'src/ui.ts': sha256('fixture') }, secretScan: { status: 'CLEAN', scannerVersion: 'fake', scannedAt: now, coverage: { filesScanned: 1, bytesScanned: 7 } }, capturedAt: now, producer: 'fixture' }, { artifactId: 'candidate-1', nodeId: 'node-1', sessionId: 'session-1', producer: 'fixture', location: '/candidate-1', createdAt: now });
    const review: DesignReviewPayload = { assuranceRole: 'ui-v2-sol-assurance', candidateBundleHash: candidate.hash, outcome: 'APPROVE', findings: [] };
    let called = false;
    const supervisor: SolProcessSupervisor = { runtimeImplementation: 'kiro/gpt-5.6-sol', available: () => true, reviewReadOnly: async (input) => { called = input.candidateBundle.hash === candidate.hash; return review; }, terminate: async () => {} };
    const port = new KiroSolAssurancePort(supervisor);
    const result = await port.review({ designSpec: candidate, implementationDiff: candidate, candidateBundle: candidate, candidateBundleHash: candidate.hash, signal: new AbortController().signal });
    expect(called).toBe(true);
    expect(result.candidateBundleHash).toBe(candidate.hash);
    expect(port.runtimeImplementation).toBe('kiro/gpt-5.6-sol');
  });

  test('UI gate requires the same reviewed/rendered candidate and screenshots', () => {
    const candidate = createUiArtifact('ui-candidate-bundle.v1', { baselineIdentity: 'b', changedPaths: ['src/ui.ts'], materializationManifest: {}, dependencyInputs: [], fileHashes: {}, secretScan: { status: 'CLEAN', scannerVersion: 'fake', scannedAt: now, coverage: { filesScanned: 1, bytesScanned: 0 } }, capturedAt: now, producer: 'fixture' }, { artifactId: 'candidate-2', nodeId: 'node', sessionId: 'session', producer: 'fixture', location: '/candidate-2', createdAt: now });
    const review = createUiArtifact('design-review.v1', { assuranceRole: 'ui-v2-sol-assurance', candidateBundleHash: candidate.hash, outcome: 'APPROVE', findings: [] }, { artifactId: 'review-2', nodeId: 'sol', sessionId: 'session', producer: 'fixture', location: '/review-2', createdAt: now });
    const visual = createUiArtifact('ui-visual-verification.v1', { candidateBundleHash: candidate.hash, screenshots: [{ route: '/', state: 'default', viewport: '1280x800', hash: sha256('pixels'), location: '/shot' }], routes: ['/'], viewports: ['1280x800'], accessibility: [], consoleFailures: [], networkFailures: [] }, { artifactId: 'visual-2', nodeId: 'visual', sessionId: 'session', producer: 'fixture', location: '/visual-2', createdAt: now });
    const presentation = presentUiHumanVisualGate(candidate, review, visual);
    expect(presentation.candidateHash).toBe(candidate.hash);
    expect(decideUiHumanGate(presentation, 'REJECT')).toMatchObject({ status: 'DECLINED', publicationAuthority: 'NONE' });
    expect(() => presentUiHumanVisualGate(candidate, { ...review, payload: { ...review.payload, candidateBundleHash: 'f'.repeat(64) } }, visual)).toThrow();
  });

  test('composition exposes only the four fixed UI adapter IDs', () => {
    const adapter = (adapterId: 'stage7-impeccable' | 'stage7-ui-implementation' | 'stage7-sol-assurance' | 'stage7-visual') => ({ adapterId, launchBatch: () => { throw new Error('fixture adapter must not launch'); } });
    const map = composeStage7UiImplementations({ design: adapter('stage7-impeccable'), implementation: adapter('stage7-ui-implementation'), sol: adapter('stage7-sol-assurance'), visual: adapter('stage7-visual') });
    expect([...map.keys()]).toEqual(['stage7-impeccable', 'stage7-ui-implementation', 'stage7-sol-assurance', 'stage7-visual']);
    expect(map.has('stage7-qa-execution')).toBe(false);
  });
});

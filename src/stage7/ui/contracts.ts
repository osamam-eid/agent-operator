import type { AgentResult, AgentResultStatus } from '../../contracts.js';
import type { ActiveExecutionBatch, ExecutionBatchRequest, NodeExecutionAdapter, NodeExecutionRequest, NodeExecutionOutcome } from '../../runtime-types.js';
import type { GovernedMutationRequest, GovernedMutationResult, VerificationPorts, WorktreeHandle, WorktreePort, WorktreeSnapshot } from '../../mutation/worktree.js';
import type { MutationClock } from '../../mutation/governed.js';
import type { CandidateCapturePort, CandidateCaptureRequest, CandidateCaptureResult, GovernedUiImplementationPort, ProvisionalCandidateStore, Stage7ArtifactEnvelope, Stage7SecretScan, UiExecutionGrant } from '../types.js';

export const UI_WORKFLOW_TEMPLATE = 'ui-change.v2' as const;
export const IMPECCABLE_NODE = 'ui-v2-impeccable-design' as const;
export const IMPLEMENTATION_NODE = 'ui-v2-governed-implementation' as const;
export const SOL_NODE = 'ui-v2-sol-review' as const;
export const VISUAL_NODE = 'ui-v2-visual-verification' as const;
export const IMPECCABLE_SKILL_URI = 'skill://impeccable' as const;
export const SOL_ASSURANCE_ROLE = 'ui-v2-sol-assurance' as const;
export const SOL_RUNTIME_IMPLEMENTATION = 'kiro/gpt-5.6-sol' as const;
export const FROZEN_RENDER_RECIPE_ID = 'stage7-ui-render-v1' as const;

export type UiAdapterId = 'stage7-impeccable' | 'stage7-ui-implementation' | 'stage7-sol-assurance' | 'stage7-visual';
export type UiOutcome = 'APPROVE' | 'BLOCK';

export interface UiAdapterFailure extends Error {
  readonly code: 'UI_SKILL_UNAVAILABLE' | 'UI_ROUTE_MISMATCH' | 'UI_CANDIDATE_BLOCKED' | 'UI_HASH_MISMATCH' | 'UI_ASSURANCE_UNAVAILABLE' | 'UI_RENDER_BLOCKED' | 'UI_CLEANUP_UNKNOWN';
}

export interface DesignSpecPayload {
  readonly surface: string;
  readonly incumbentTruth: string;
  readonly layout: Readonly<Record<string, unknown>>;
  readonly typography: Readonly<Record<string, unknown>>;
  readonly color: Readonly<Record<string, unknown>>;
  readonly spacing: Readonly<Record<string, unknown>>;
  readonly responsiveStates: readonly unknown[];
  readonly accessibility: readonly unknown[];
  readonly nonGoals: readonly unknown[];
}

export interface ImpeccableDesignRequest {
  readonly request: NodeExecutionRequest;
  readonly surface: string;
  readonly mode: 'Persuade' | 'Operate' | 'Read' | 'Experience';
  readonly projectRoot: string;
  readonly allowedPaths: readonly string[];
  readonly incumbentTruth: string;
}

export interface ImpeccableExecutionInput {
  readonly skillUri: typeof IMPECCABLE_SKILL_URI;
  readonly mode: ImpeccableDesignRequest['mode'];
  readonly target: string;
  readonly projectRoot: string;
  readonly allowedPaths: readonly string[];
  readonly incumbentTruth: string;
  readonly craftFloorLoaded: true;
  readonly signal: AbortSignal;
}

export interface ImpeccableDesignPort {
  readonly skillUri: typeof IMPECCABLE_SKILL_URI;
  readonly available: () => boolean;
  readonly execute: (input: ImpeccableExecutionInput) => Promise<DesignSpecPayload>;
  readonly terminate: (reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN') => Promise<void>;
}

export interface ApprovedImpeccableOmpSeam {
  readonly skillUri: typeof IMPECCABLE_SKILL_URI;
  readonly available: () => boolean;
  readonly execute: (input: ImpeccableExecutionInput) => Promise<DesignSpecPayload>;
  readonly terminate: (reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN') => Promise<void>;
}

export class CanonicalImpeccableDesignPort implements ImpeccableDesignPort {
  readonly skillUri = IMPECCABLE_SKILL_URI;
  constructor(private readonly seam: ApprovedImpeccableOmpSeam) {
    if (seam.skillUri !== IMPECCABLE_SKILL_URI) throw new Error('Canonical Impeccable OMP seam has the wrong skill identity.');
  }
  available(): boolean { return this.seam.skillUri === IMPECCABLE_SKILL_URI && this.seam.available(); }
  execute(input: ImpeccableExecutionInput): Promise<DesignSpecPayload> {
    if (input.skillUri !== IMPECCABLE_SKILL_URI || input.craftFloorLoaded !== true || !this.available()) throw new Error('Canonical Impeccable skill is unavailable or craft floor is not loaded.');
    return this.seam.execute(input);
  }
  terminate(reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN'): Promise<void> { return this.seam.terminate(reason); }
}


export interface CandidateFile {
  readonly path: string;
  readonly mode: 'PATCH' | 'FULL';
  readonly content: Uint8Array;
  readonly location: string;
}

export interface CandidateCaptureFilesystem {
  readonly collect: (worktree: WorktreeHandle, changedPaths: readonly string[], baseline: WorktreeSnapshot, signal: AbortSignal) => Promise<readonly CandidateFile[]>;
  readonly materializationManifest: (worktree: WorktreeHandle, changedPaths: readonly string[]) => Promise<Readonly<Record<string, unknown>>>;
  readonly dependencyInputs: (worktree: WorktreeHandle) => Promise<readonly Readonly<Record<string, unknown>>[]>;
  readonly secretScan: (files: readonly CandidateFile[], signal: AbortSignal) => Promise<SecretScanResult>;
}

export interface SecretScanResult {
  readonly status: 'CLEAN' | 'FINDINGS' | 'ERROR';
  readonly scannerVersion: string;
  readonly scannedAt: string;
  readonly coverage: { readonly filesScanned: number; readonly bytesScanned: number };
  readonly findings: readonly { readonly category: string; readonly path: string }[];
}

export interface UiCandidateCapturePort extends CandidateCapturePort {
  readonly capture: (request: CandidateCaptureRequest & { readonly signal?: AbortSignal }) => Promise<CandidateCaptureResult>;
}

export interface UiImplementationDependencies {
  readonly worktrees: WorktreePort;
  readonly capture: UiCandidateCapturePort;
  readonly provisional: ProvisionalCandidateStore;
  readonly verification: VerificationPorts;
  readonly clock: MutationClock;
  readonly captureContext: () => Omit<CandidateCaptureRequest, 'worktree' | 'baseline' | 'changedPaths'>;
}

export interface UiImplementationRequest {
  readonly request: NodeExecutionRequest;
  readonly grant: UiExecutionGrant;
  readonly operation: string;
  readonly signal: AbortSignal;
}

export interface UiImplementationResult {
  readonly mutation: GovernedMutationResult;
  readonly candidate: Stage7ArtifactEnvelope;
  readonly diff: Stage7ArtifactEnvelope;
}

export interface SolReviewInput {
  readonly designSpec: Stage7ArtifactEnvelope;
  readonly implementationDiff: Stage7ArtifactEnvelope;
  readonly candidateBundle: Stage7ArtifactEnvelope;
  readonly candidateBundleHash: string;
  readonly signal: AbortSignal;
}

export interface DesignReviewPayload {
  readonly assuranceRole: typeof SOL_ASSURANCE_ROLE;
  readonly candidateBundleHash: string;
  readonly outcome: UiOutcome;
  readonly findings: readonly Readonly<Record<string, unknown>>[];
}

export interface SolProcessSupervisor {
  readonly runtimeImplementation: typeof SOL_RUNTIME_IMPLEMENTATION;
  readonly available: () => boolean;
  readonly reviewReadOnly: (input: SolReviewInput, signal: AbortSignal) => Promise<DesignReviewPayload>;
  readonly terminate: (reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN') => Promise<void>;
}

export interface UiSolAssurancePort {
  readonly assuranceRole: typeof SOL_ASSURANCE_ROLE;
  readonly runtimeImplementation: typeof SOL_RUNTIME_IMPLEMENTATION;
  readonly available: () => boolean;
  readonly review: (input: SolReviewInput) => Promise<DesignReviewPayload>;
}

export interface RenderPolicy {
  readonly approvedParent: string;
  readonly network: 'DENY';
  readonly inheritedCredentials: 'NONE';
  readonly hostWrites: 'DENY';
  readonly scripts: 'DISABLED';
  readonly dependencyInputsPinned: true;
  readonly recipeId: string;
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly processLimit: number;
}

export interface RenderSandbox {
  readonly path: string;
  readonly realpath: string;
  readonly cleanup: () => Promise<void>;
}

export interface RenderEvidence {
  readonly candidateBundleHash: string;
  readonly screenshots: readonly { readonly route: string; readonly state: string; readonly viewport: string; readonly hash: string; readonly location: string }[];
  readonly routes: readonly string[];
  readonly viewports: readonly string[];
  readonly accessibility: readonly Readonly<Record<string, unknown>>[];
  readonly consoleFailures: readonly string[];
  readonly networkFailures: readonly string[];
}

export interface RenderSandboxPort {
  readonly canonicalize: (candidate: string) => Promise<string>;
  readonly create: (policy: RenderPolicy, signal: AbortSignal) => Promise<RenderSandbox>;
  readonly materialize: (sandbox: RenderSandbox, candidate: Stage7ArtifactEnvelope, policy: RenderPolicy, signal: AbortSignal) => Promise<void>;
  readonly render: (sandbox: RenderSandbox, recipeId: string, policy: RenderPolicy, signal: AbortSignal) => Promise<RenderEvidence>;
}

export interface VisualVerificationInput {
  readonly candidateBundle: Stage7ArtifactEnvelope;
  readonly designReview: Stage7ArtifactEnvelope;
  readonly policy: RenderPolicy;
  readonly signal: AbortSignal;
}

export interface UiAdapterBatch extends ActiveExecutionBatch {
  readonly cancel: (reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN') => Promise<void>;
}

export type UiExecutionOutcome = NodeExecutionOutcome;
export type UiResultStatus = AgentResultStatus;
export type UiAdapter = NodeExecutionAdapter;

export type UiImplementationPort = GovernedUiImplementationPort;
export type UiArtifact = Stage7ArtifactEnvelope;
export type UiSecretScan = Stage7SecretScan;
export type UiGrant = UiExecutionGrant;
export type UiMutationRequest = GovernedMutationRequest & { readonly grant: UiExecutionGrant };
export type UiMutationResult = GovernedMutationResult;
export type UiFilesystem = CandidateCaptureFilesystem;
export type UiWorktree = WorktreeHandle;
export type UiWorktreeSnapshot = WorktreeSnapshot;
export type UiWorktreePort = WorktreePort;
export type UiClock = MutationClock;
export type UiBatchRequest = ExecutionBatchRequest;
export type UiBatchOutcome = NodeExecutionOutcome;
export type UiBatchResult = AgentResult;

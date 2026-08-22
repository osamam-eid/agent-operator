import type { AgentResult } from '../contracts.js';
import type {
  ActiveExecutionBatch,
  ExecutionBatchRequest,
  NodeExecutionAdapter,
  NodeExecutionAttempt,
  NodeExecutionOutcome,
  NodeExecutionRequest,
  NodeExecutionUsage,
} from '../runtime-types.js';
import { validateAgentResult } from '../validators.js';
import { loadPackageRole, PackageRoleIntegrityError, resolvePackageRoleName, type LoadedPackageRole, type PackageRoleName } from './roles.js';

export interface OmpCustomToolDefinition {
  readonly name: string;
  readonly [key: string]: unknown;
}

export interface OmpToolFactories {
  readonly createReadToolDefinition: (cwd: string, options?: unknown) => OmpCustomToolDefinition;
  readonly createGrepToolDefinition: (cwd: string, options?: unknown) => OmpCustomToolDefinition;
  readonly createFindToolDefinition: (cwd: string, options?: unknown) => OmpCustomToolDefinition;
  readonly defineTool: (definition: Record<string, unknown>) => OmpCustomToolDefinition;
}

export interface OmpChildSession {
  prompt(text: string): Promise<unknown>;
  getLastAssistantText(): string | undefined;
  getLastAssistantMessage(): { readonly stopReason?: string; readonly errorMessage?: string | null } | undefined;
  getUsage?(): { readonly tokens: number; readonly cost?: number | null } | undefined;
  subscribe(listener: (event: { readonly type: string; readonly toolName?: string; readonly args?: unknown }) => void): () => void;
  abort(options?: { readonly reason?: string }): Promise<unknown>;
  beginDispose(): void;
  dispose(): Promise<void>;
}

export interface OmpChildSessionHandle {
  readonly session: OmpChildSession;
  readonly mcpManager?: { disconnectAll(): Promise<void>; close?(): Promise<void> };
  readonly lspServers?: readonly unknown[];
  readonly modelFallbackMessage?: string;
}

export interface OmpSelectedModel {
  readonly provider: string;
  readonly id: string;
  readonly sdkModel?: unknown;
}

export interface OmpCreateChildSessionOptions {
  readonly cwd: string;
  readonly agentId: string;
  readonly model: OmpSelectedModel;
  readonly toolNames: readonly string[];
  readonly customTools: readonly OmpCustomToolDefinition[];
  readonly appendSystemPrompt: string;
  readonly outputSchema: unknown;
}

export interface OmpSessionFactory {
  createSession(options: OmpCreateChildSessionOptions): Promise<OmpChildSessionHandle>;
}

export type OmpTaskAdapterErrorCode = 'BLOCKED_CAPABILITY' | 'BLOCKED_SECURITY' | 'BLOCKED_PROVIDER_UNAVAILABLE' | 'OUTPUT_INVALID';

export interface OmpTaskAdapterDeps {
  readonly sessionFactory: OmpSessionFactory;
  readonly resolveModel: () => OmpSelectedModel;
  readonly toolFactories: OmpToolFactories;
  readonly createSafeTools: (projectionRoot: string, factories: OmpToolFactories) => readonly OmpCustomToolDefinition[];
  readonly safeToolNames: readonly string[];
  readonly loadRole?: (roleName: PackageRoleName) => Promise<LoadedPackageRole>;
}

function untrusted(label: string, content: string): string {
  return `<UNTRUSTED-DATA label=${JSON.stringify(label)}>\n${content}\n</UNTRUSTED-DATA>`;
}

function buildPrompt(request: NodeExecutionRequest, attempt: NodeExecutionAttempt): string {
  const sections = [
    ['# Attempt identity', `resultId: ${attempt.attemptId}`, `operatorSessionId: ${attempt.operatorSessionId}`, `nodeId: ${attempt.nodeId}`, `capabilityId: ${attempt.capabilityId}`, `startedAt: ${attempt.startedAt}`].join('\n'),
    `# Request\n${untrusted('request-or-summary', request.requestOrSummary)}`,
    `# Projection\nroot: ${request.projection.projectionRoot}\nallowed: ${request.projection.allowedPaths.join(', ')}\nmanifest: ${request.projection.manifestHash}`,
    `# Instructions\n${request.instructions}`,
    `# Acceptance criteria\n${request.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join('\n')}`,
  ];
  if (request.dependencyResultSummaries.length > 0) sections.push(`# Dependencies\n${request.dependencyResultSummaries.map((entry) => untrusted(`dependency:${entry.nodeId}`, `status: ${entry.status}\nsummary: ${entry.summary}`)).join('\n')}`);
  if (request.consumedArtifacts.length > 0) sections.push(`# Artifacts\n${request.consumedArtifacts.map((artifact) => untrusted(`artifact:${artifact.artifactId}`, JSON.stringify(artifact))).join('\n')}`);
  if (request.consumedEvidence.length > 0) sections.push(`# Evidence\n${request.consumedEvidence.map((evidence) => untrusted(`evidence:${evidence.evidenceId}`, JSON.stringify(evidence))).join('\n')}`);
  if (request.policyRefs.length > 0) sections.push(`# Policy references\n${request.policyRefs.join(', ')}`);
  return sections.join('\n\n');
}

function exactJson(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined;
  try { return JSON.parse(text.trim()) as unknown; } catch { return undefined; }
}

function yieldPayload(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const result = (input as Record<string, unknown>)['result'];
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  return Object.prototype.hasOwnProperty.call(result, 'data') ? (result as Record<string, unknown>)['data'] : result;
}

function failure(attempt: NodeExecutionAttempt, code: OmpTaskAdapterErrorCode, message: string, status: AgentResult['status'] = 'FAILED'): AgentResult {
  const completedAt = new Date().toISOString();
  return {
    resultId: attempt.attemptId,
    operatorSessionId: attempt.operatorSessionId,
    nodeId: attempt.nodeId,
    capabilityId: attempt.capabilityId,
    status,
    summary: `[${code}] ${message}`,
    producedArtifactRefs: [],
    consumedArtifactRefs: [],
    findingIds: [],
    evidenceIds: [],
    providerSessionId: attempt.providerSessionId,
    startedAt: attempt.startedAt,
    completedAt,
    policyRefs: [],
  };
}

function identityMatches(attempt: NodeExecutionAttempt, result: AgentResult): boolean {
  return result.resultId === attempt.attemptId && result.operatorSessionId === attempt.operatorSessionId && result.nodeId === attempt.nodeId && result.capabilityId === attempt.capabilityId;
}

function readUsage(session: OmpChildSession): NodeExecutionUsage | undefined {
  const usage = session.getUsage?.();
  if (usage === undefined || !Number.isInteger(usage.tokens) || usage.tokens < 0) return undefined;
  const cost = usage.cost === undefined || usage.cost === null ? null : Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
  return cost === undefined ? undefined : { tokens: usage.tokens, cost };
}

function normalizeOutput(session: OmpChildSession, attempt: NodeExecutionAttempt, yielded: unknown): AgentResult {
  if (session.getLastAssistantMessage()?.stopReason === 'error') return failure(attempt, 'BLOCKED_PROVIDER_UNAVAILABLE', 'Provider ended with an error before producing output.', 'BLOCKED');
  const parsed = yielded ?? exactJson(session.getLastAssistantText());
  if (parsed === undefined) return failure(attempt, 'OUTPUT_INVALID', 'No exact JSON AgentResult was produced.');
  const validated = validateAgentResult(parsed);
  if (!validated.ok) return failure(attempt, 'OUTPUT_INVALID', `AgentResult validation failed: ${validated.errors.map((error) => `${error.path}: ${error.message}`).join('; ')}`);
  if (!identityMatches(attempt, validated.value)) return failure(attempt, 'OUTPUT_INVALID', 'AgentResult identity does not match the dispatched attempt.');
  return validated.value;
}

async function disposeChildSession(handle: OmpChildSessionHandle): Promise<void> {
  handle.session.beginDispose();
  const cleanup: Promise<unknown>[] = [handle.session.dispose()];
  if (handle.mcpManager !== undefined) {
    cleanup.push(handle.mcpManager.disconnectAll());
    if (handle.mcpManager.close !== undefined) cleanup.push(handle.mcpManager.close());
  }
  await Promise.allSettled(cleanup);
}

async function runNode(deps: OmpTaskAdapterDeps, request: NodeExecutionRequest, signal: AbortSignal, model: OmpSelectedModel): Promise<NodeExecutionOutcome> {
  const attempt: NodeExecutionAttempt = { ...request.allocation, modelProvider: model.provider, modelId: model.id };
  const roleName = resolvePackageRoleName(request.node.role);
  if (roleName === undefined) return { attempt, result: failure(attempt, 'BLOCKED_CAPABILITY', `Role "${request.node.role}" is not available to the native read-only adapter.`, 'BLOCKED') };
  if (request.mutationClass !== 'READ_ONLY' || request.toolGrant.some((tool) => !deps.safeToolNames.includes(tool))) {
    return { attempt, result: failure(attempt, 'BLOCKED_CAPABILITY', 'Native OMP execution accepts only READ_ONLY nodes with the compiled safe-tool grant.', 'BLOCKED') };
  }
  let role: LoadedPackageRole;
  try { role = deps.loadRole === undefined ? await loadPackageRole(roleName) : await deps.loadRole(roleName); }
  catch (error) { return { attempt, result: failure(attempt, 'BLOCKED_SECURITY', error instanceof PackageRoleIntegrityError ? error.message : 'Package role loading failed.', 'BLOCKED') }; }
  if (role.output !== request.outputSchemaId) return { attempt, result: failure(attempt, 'BLOCKED_SECURITY', `Role output ${role.output} does not match ${request.outputSchemaId}.`, 'BLOCKED') };

  const toolNames = role.tools.filter((tool) => request.toolGrant.includes(tool) && deps.safeToolNames.includes(tool));
  const customTools = deps.createSafeTools(request.projection.projectionRoot, deps.toolFactories);
  let handle: OmpChildSessionHandle | undefined;
  let removeListener: (() => void) | undefined;
  let yielded: unknown;
  const onAbort = (): void => { void handle?.session.abort({ reason: 'Agent Operator cancellation requested' }).catch(() => undefined); };
  try {
    handle = await deps.sessionFactory.createSession({ cwd: request.projection.projectionRoot, agentId: `${attempt.operatorSessionId}-${attempt.nodeId}-${attempt.attemptId}`, model, toolNames, customTools, appendSystemPrompt: role.systemPrompt, outputSchema: role.outputSchema });
    if (handle.modelFallbackMessage !== undefined && handle.modelFallbackMessage.length > 0) return { attempt, result: failure(attempt, 'BLOCKED_PROVIDER_UNAVAILABLE', `OMP reported an unapproved model fallback: ${handle.modelFallbackMessage}`, 'BLOCKED') };
    removeListener = handle.session.subscribe((event) => { if (event.type === 'tool_execution_start' && event.toolName === 'yield') yielded = yieldPayload(event.args); });
    if (signal.aborted) { onAbort(); return { attempt, result: failure(attempt, 'OUTPUT_INVALID', 'Node execution was cancelled before prompt dispatch.', 'CANCELLED') }; }
    signal.addEventListener('abort', onAbort, { once: true });
    await handle.session.prompt(buildPrompt(request, attempt));
    if (signal.aborted) return { attempt, result: failure(attempt, 'OUTPUT_INVALID', 'Node execution was cancelled.', 'CANCELLED') };
    const result = normalizeOutput(handle.session, attempt, yielded);
    const usage = readUsage(handle.session);
    return usage === undefined ? { attempt, result } : { attempt, result, usage };
  } catch (error) {
    return { attempt, result: failure(attempt, signal.aborted ? 'OUTPUT_INVALID' : 'BLOCKED_PROVIDER_UNAVAILABLE', signal.aborted ? 'Node execution was cancelled.' : `Native child execution failed: ${error instanceof Error ? error.message : String(error)}`, signal.aborted ? 'CANCELLED' : 'BLOCKED') };
  } finally {
    removeListener?.();
    signal.removeEventListener('abort', onAbort);
    if (handle !== undefined) await disposeChildSession(handle);
  }
}

class OmpTaskBatch implements ActiveExecutionBatch {
  readonly batchId: string;
  readonly attempts: readonly NodeExecutionAttempt[];
  readonly completion: Promise<readonly NodeExecutionOutcome[]>;
  readonly #controller: AbortController;
  #cancelled = false;
  constructor(batchId: string, attempts: readonly NodeExecutionAttempt[], completion: Promise<readonly NodeExecutionOutcome[]>, controller: AbortController) { this.batchId = batchId; this.attempts = attempts; this.completion = completion; this.#controller = controller; }
  async cancel(reason: 'USER' | 'TIMEOUT' | 'SHUTDOWN'): Promise<void> { if (this.#cancelled) { await this.completion.catch(() => undefined); return; } this.#cancelled = true; this.#controller.abort(reason); await this.completion.catch(() => undefined); }
}

export class OmpTaskAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'omp-task' as const;
  constructor(private readonly deps: OmpTaskAdapterDeps) {}
  launchBatch(request: ExecutionBatchRequest): ActiveExecutionBatch {
    const controller = new AbortController();
    const model = this.deps.resolveModel();
    const attempts = request.nodes.map((node) => ({ ...node.allocation, modelProvider: model.provider, modelId: model.id }));
    const completion = Promise.allSettled(request.nodes.map((node) => runNode(this.deps, node, controller.signal, model))).then((settled) => settled.map((entry, index) => {
      const attempt = attempts[index] as NodeExecutionAttempt;
      if (entry.status === 'fulfilled') return entry.value;
      return { attempt, result: failure(attempt, 'BLOCKED_PROVIDER_UNAVAILABLE', `Unhandled native adapter failure: ${entry.reason instanceof Error ? entry.reason.message : String(entry.reason)}`, 'BLOCKED') };
    }));
    return new OmpTaskBatch(request.batchId, attempts, completion, controller);
  }
}

export function createOmpTaskAdapter(deps: OmpTaskAdapterDeps): OmpTaskAdapter { return new OmpTaskAdapter(deps); }

export interface OmpHostSdk {
  createAgentSession(options: Record<string, unknown>): Promise<{ readonly session: OmpChildSession; readonly mcpManager?: OmpChildSessionHandle['mcpManager']; readonly lspServers?: readonly unknown[]; readonly modelFallbackMessage?: string }>;
  createAgentRegistry(): unknown;
  createSessionManager(cwd: string, providerSessionId: string): unknown;
  createIsolatedSettings(): unknown;
}

export function createOmpSdkSessionFactory(sdk: OmpHostSdk, providerSessionRoot: string): OmpSessionFactory {
  return {
    async createSession(options): Promise<OmpChildSessionHandle> {
      const providerSessionId = `${providerSessionRoot}/${options.agentId}`;
      const modelOptions = options.model.sdkModel === undefined ? { modelPattern: `${options.model.provider}/${options.model.id}` } : { model: options.model.sdkModel };
      const created = await sdk.createAgentSession({
        cwd: options.cwd,
        agentId: options.agentId,
        agentRegistry: sdk.createAgentRegistry(),
        sessionManager: sdk.createSessionManager(options.cwd, providerSessionId),
        providerSessionId,
        settings: sdk.createIsolatedSettings(),
        ...modelOptions,
        toolNames: options.toolNames,
        restrictToolNames: true,
        customTools: options.customTools,
        allowRestrictedCustomTools: true,
        disableExtensionDiscovery: true,
        enableLsp: false,
        appendSystemPrompt: options.appendSystemPrompt,
        outputSchema: options.outputSchema,
        outputSchemaMode: 'strict',
        requireYieldTool: true,
      });
      return { session: created.session, ...(created.mcpManager !== undefined ? { mcpManager: created.mcpManager } : {}), ...(created.lspServers !== undefined ? { lspServers: created.lspServers } : {}), ...(created.modelFallbackMessage !== undefined ? { modelFallbackMessage: created.modelFallbackMessage } : {}) };
    },
  };
}

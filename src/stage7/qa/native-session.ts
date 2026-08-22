import type { AgentResult } from '../../contracts.js';
import { validateAgentResult } from '../../validators.js';
import type { NodeExecutionAttempt, NodeExecutionUsage } from '../../runtime-types.js';
import type { QaNativeBinding, QaNativeSessionRunner, QaSessionRunInput, QaSessionRunResult } from './types.js';
import { QaAgentIntegrityError, loadVerifiedQaAgent } from './agent-loader.js';
import type { OmpChildSession, OmpChildSessionHandle, OmpSessionFactory } from '../../adapters/omp-task.js';

function safeSummary(code: string): string { return `[${code}] QA native task did not produce an accepted terminal result.`; }

function failure(attempt: NodeExecutionAttempt, status: AgentResult['status'], code: string): AgentResult {
  const completedAt = new Date().toISOString();
  return {
    resultId: attempt.attemptId,
    operatorSessionId: attempt.operatorSessionId,
    nodeId: attempt.nodeId,
    capabilityId: attempt.capabilityId,
    status,
    summary: safeSummary(code),
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

function extractYield(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const result = (input as Record<string, unknown>).result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return result;
  return Object.prototype.hasOwnProperty.call(result, 'data') ? (result as Record<string, unknown>).data : result;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined || text.trim() === '') return undefined;
  try { return JSON.parse(text.trim()) as unknown; } catch { return undefined; }
}

function usageOf(session: OmpChildSession): NodeExecutionUsage | undefined {
  const raw = session.getUsage?.();
  if (raw === undefined || !Number.isInteger(raw.tokens) || raw.tokens < 0) return undefined;
  if (raw.cost === undefined || raw.cost === null) return { tokens: raw.tokens, cost: null };
  return Number.isFinite(raw.cost) && raw.cost >= 0 ? { tokens: raw.tokens, cost: raw.cost } : undefined;
}

function identityMatches(attempt: NodeExecutionAttempt, result: AgentResult): boolean {
  return result.resultId === attempt.attemptId && result.operatorSessionId === attempt.operatorSessionId && result.nodeId === attempt.nodeId && result.capabilityId === attempt.capabilityId;
}

function normalize(attempt: NodeExecutionAttempt, session: OmpChildSession, yielded: unknown): AgentResult {
  if (session.getLastAssistantMessage()?.stopReason === 'error') return failure(attempt, 'BLOCKED', 'PROVIDER_ERROR');
  const parsed = yielded ?? parseJson(session.getLastAssistantText());
  if (parsed === undefined) return failure(attempt, 'FAILED', 'OUTPUT_INVALID');
  const checked = validateAgentResult(parsed);
  if (!checked.ok || !identityMatches(attempt, checked.value)) return failure(attempt, 'FAILED', 'OUTPUT_INVALID');
  if (checked.value.providerSessionId !== undefined && checked.value.providerSessionId !== attempt.providerSessionId) return failure(attempt, 'FAILED', 'IDENTITY_MISMATCH');
  return { ...checked.value, providerSessionId: attempt.providerSessionId };
}

async function dispose(handle: OmpChildSessionHandle): Promise<void> {
  handle.session.beginDispose();
  await Promise.allSettled([
    handle.session.dispose(),
    ...(handle.mcpManager === undefined ? [] : [handle.mcpManager.disconnectAll(), ...(handle.mcpManager.close === undefined ? [] : [handle.mcpManager.close()])]),
  ]);
}

export interface NativeQaSessionRunnerDeps {
  readonly sessionFactory: OmpSessionFactory;
  readonly roleRoot: string;
}

export class NativeQaSessionRunner implements QaNativeSessionRunner {
  constructor(private readonly deps: NativeQaSessionRunnerDeps) {}

  async run(input: QaSessionRunInput): Promise<QaSessionRunResult> {
    const role = await loadVerifiedQaAgent(input.binding, this.deps.roleRoot);
    const attempt: NodeExecutionAttempt = { ...input.request.allocation, modelProvider: input.binding.provider, modelId: input.binding.modelId };
    const agentSessionId = `stage7/${input.binding.agentName}/${attempt.providerSessionId}/${attempt.attemptId}`;
    let handle: OmpChildSessionHandle | undefined;
    let unsubscribe: (() => void) | undefined;
    let yielded: unknown;
    try {
      if (input.signal.aborted) return { result: failure(attempt, 'CANCELLED', 'CANCELLED') };
      input.signal.addEventListener('abort', () => { void handle?.session.abort({ reason: 'QA execution cancelled' }).catch(() => undefined); }, { once: true });
      handle = await this.deps.sessionFactory.createSession({
        cwd: input.request.projection.projectionRoot,
        agentId: agentSessionId,
        model: { provider: input.binding.provider, id: input.binding.modelId },
        toolNames: input.toolNames,
        customTools: [],
        appendSystemPrompt: role.systemPrompt,
        outputSchema: input.outputSchema,
      });
      if (handle.modelFallbackMessage !== undefined && handle.modelFallbackMessage.length > 0) return { result: failure(attempt, 'BLOCKED', 'MODEL_FALLBACK') };
      unsubscribe = handle.session.subscribe((event) => { if (event.type === 'tool_execution_start' && event.toolName === 'yield') yielded = extractYield(event.args); });
      if (input.signal.aborted) return { result: failure(attempt, 'CANCELLED', 'CANCELLED') };
      await handle.session.prompt(input.prompt);
      if (input.signal.aborted) return { result: failure(attempt, 'CANCELLED', 'CANCELLED') };
      const result = normalize(attempt, handle.session, yielded);
      const usage = usageOf(handle.session);
      return usage === undefined ? { result } : { result, usage };
    } catch (error) {
      const code = error instanceof QaAgentIntegrityError ? `ROLE_${error.code}` : 'NATIVE_SESSION_FAILURE';
      return { result: failure(attempt, input.signal.aborted ? 'CANCELLED' : 'BLOCKED', code) };
    } finally {
      unsubscribe?.();
      if (handle !== undefined) await dispose(handle);
    }
  }
}

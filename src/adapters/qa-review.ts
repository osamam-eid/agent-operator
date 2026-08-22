import type { ExecutionBatchRequest, NodeExecutionAdapter, NodeExecutionOutcome, NodeExecutionRequest } from '../runtime-types.js';
import { QA_EXECUTION_BINDING, QA_REVIEW_BINDING, validateQaBinding } from '../stage7/qa/bindings.js';
import { createQaBatch, createRunner, assertQaRequest, inputForRunner, normalizeAdapterResult, reviewPrompt, safeQaFailure } from '../stage7/qa/adapter-common.js';
import type { QaReviewAdapterDeps, QaReviewContext } from '../stage7/qa/types.js';

const FORBIDDEN_REVIEW_TOOLS = new Set(['browser', 'debug', 'write', 'api', 'database', 'db', 'test', 'test-runner']);

export class QaReviewAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'stage7-qa-review' as const;
  private readonly runner;
  constructor(private readonly deps: QaReviewAdapterDeps) { validateQaBinding(QA_REVIEW_BINDING); this.runner = createRunner(deps.sessionFactory, deps.roleRoot); }

  launchBatch(request: ExecutionBatchRequest) {
    return createQaBatch(request, QA_REVIEW_BINDING, async (node, signal) => this.runNode(node, signal));
  }

  private async runNode(request: NodeExecutionRequest, signal: AbortSignal): Promise<NodeExecutionOutcome> {
    const attempt = { ...request.allocation, modelProvider: QA_REVIEW_BINDING.provider, modelId: QA_REVIEW_BINDING.modelId };
    try {
      assertQaRequest(request, QA_REVIEW_BINDING);
      if (request.toolGrant.some((tool) => FORBIDDEN_REVIEW_TOOLS.has(tool))) throw new Error('Terra review tool grant is not read-only.');
      const context = await this.deps.context.resolve(request);
      this.assertContext(context, attempt.providerSessionId);
      await context.validateArtifacts(request);
      const run = await this.runner.run(inputForRunner(request, QA_REVIEW_BINDING, '', this.deps.outputSchema, reviewPrompt(request, context.lunaProviderSessionId, context.authority.applicationDataAuthority), signal));
      return { attempt, ...normalizeAdapterResult(run, true) };
    } catch (error) {
      const code = error instanceof Error && error.message.includes('artifact') ? 'BLOCKED_EVIDENCE' : error instanceof Error && error.message.includes('identity') ? 'REVIEW_IDENTITY_SEPARATION_REQUIRED' : 'QA_REVIEW_BLOCKED';
      return { attempt, result: safeQaFailure(attempt, signal.aborted ? 'CANCELLED' : 'BLOCKED', code) };
    }
  }

  private assertContext(context: QaReviewContext, terraProviderSessionId: string): void {
    if (context.authority.repositoryMutationClass !== 'READ_ONLY') throw new Error('Terra review authority is not READ_ONLY.');
    if (context.lunaProviderSessionId === terraProviderSessionId || context.lunaProviderSessionId.trim() === '' || context.lunaAgentIdentity !== QA_EXECUTION_BINDING.agentName || terraProviderSessionId.trim() === '' || context.lunaAgentIdentity === QA_REVIEW_BINDING.agentName) throw new Error('Terra and Luna identities must remain distinct.');
  }
}

export function createQaReviewAdapter(deps: QaReviewAdapterDeps): QaReviewAdapter { return new QaReviewAdapter(deps); }

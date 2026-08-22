import type { ExecutionBatchRequest, NodeExecutionAdapter, NodeExecutionOutcome, NodeExecutionRequest } from '../runtime-types.js';
import { validateQaExecutionGrant } from '../stage7/grants.js';
import { qaEnvironmentIdentity, assertApprovedPreflight } from '../stage7/qa/preflight.js';
import { QA_EXECUTION_BINDING, validateQaBinding } from '../stage7/qa/bindings.js';
import { createQaBatch, createRunner, assertQaRequest, executionPrompt, inputForRunner, safeQaFailure } from '../stage7/qa/adapter-common.js';
import type { QaExecutionAdapterDeps, QaExecutionContext } from '../stage7/qa/types.js';

export class QaExecutionAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'stage7-qa-execution' as const;
  private readonly runner;
  constructor(private readonly deps: QaExecutionAdapterDeps) { validateQaBinding(QA_EXECUTION_BINDING); this.runner = createRunner(deps.sessionFactory, deps.roleRoot); }

  launchBatch(request: ExecutionBatchRequest) {
    return createQaBatch(request, QA_EXECUTION_BINDING, async (node, signal) => this.runNode(node, signal));
  }

  private async runNode(request: NodeExecutionRequest, signal: AbortSignal): Promise<NodeExecutionOutcome> {
    const attempt = { ...request.allocation, modelProvider: QA_EXECUTION_BINDING.provider, modelId: QA_EXECUTION_BINDING.modelId };
    try {
      assertQaRequest(request, QA_EXECUTION_BINDING);
      const context = await this.deps.context.resolve(request);
      this.assertContext(context);
      context.dataAuthorization.preDispatch();
      const run = await this.runner.run(inputForRunner(request, QA_EXECUTION_BINDING, '', this.deps.outputSchema, executionPrompt(request, context.grant.applicationDataAuthority, context.approval.approvalId), signal));
      if (run.result.status === 'SUCCEEDED') await context.validateOutput(run.result, request);
      return { attempt, result: run.result, ...(run.usage === undefined ? {} : { usage: run.usage }) };
    } catch (error) {
      const code = error instanceof Error && error.message.includes('evidence') ? 'BLOCKED_EVIDENCE' : error instanceof Error && error.message.includes('environment') ? 'BLOCKED_ENVIRONMENT' : 'QA_EXECUTION_BLOCKED';
      return { attempt, result: safeQaFailure(attempt, signal.aborted ? 'CANCELLED' : 'BLOCKED', code) };
    }
  }

  private assertContext(context: QaExecutionContext): void {
    const grant = validateQaExecutionGrant(context.grant);
    if (!grant.ok) throw new Error('QA execution grant validation failed.');
    assertApprovedPreflight(context.preflight);
    if (context.grant.qaEnvironmentApprovalRef !== context.approval.approvalId || context.grant.qaEnvironmentApprovalHash !== context.approval.artifactHash || context.grant.qaEnvironmentApprovalHash !== context.preflight.approvalHash) throw new Error('QA environment approval identity mismatch.');
    if (context.grant.applicationDataAuthority === 'TRACKED_DISPOSABLE_ONLY') {
    if (context.grant.environmentIdentity !== qaEnvironmentIdentity(context.preflight.deploymentContext.environment)) throw new Error('QA environment identity mismatch.');
      for (const entry of context.grant.applicationDataAuthorities) {
        const action = entry.kind === 'CREATE' ? 'CREATE' : entry.action;
        const canonical = entry.kind === 'CREATE' ? `CREATE|${entry.entityType}|${[...entry.allowedFields].sort().join(',')}` : `${entry.action}|${entry.recordId}|${entry.entityType}|${[...entry.allowedFields].sort().join(',')}`;
        if (!context.approval.permittedActions.includes(action) && !context.approval.permittedActions.includes(canonical)) throw new Error('QA approval action scope mismatch.');
      }
      if (context.grant.exactApprovedFixtureIds.some((id) => !context.approval.exactFixtureIds.includes(id))) throw new Error('QA fixture scope exceeds human approval.');
    }
    if (context.grant.repositoryMutationClass !== 'READ_ONLY') throw new Error('QA repository mutation authority is not READ_ONLY.');
  }
}

export function createQaExecutionAdapter(deps: QaExecutionAdapterDeps): QaExecutionAdapter { return new QaExecutionAdapter(deps); }

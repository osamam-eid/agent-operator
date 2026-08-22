/**
 * Agent Operator — Stage 9 external-CLI fleet adapter.
 *
 * Dispatches `fleet.v1` nodes to human-curated external-CLI providers. Every
 * launch re-verifies the pinned binary (regular file, no symlink, SHA-256
 * match) before spawn; the child receives a strict argv template, an empty
 * environment plus operator-named allowlisted variables, and no shell. Bounded
 * fallback (initial candidate + at most one fallback) happens entirely inside
 * one runtime attempt: one `attemptId`, one terminal outcome, trials recorded
 * in the outcome summary. A launched candidate that produces a terminal
 * AgentResult is never retried; only pre-launch failures (pin/probe/verify)
 * fall through to the next candidate.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';

import type { AgentResult, AgentResultStatus } from '../contracts.js';
import type { ActiveExecutionBatch, ExecutionBatchRequest, NodeExecutionAdapter, NodeExecutionAttempt, NodeExecutionOutcome, NodeExecutionRequest } from '../runtime-types.js';
import type { NormalizedProviderRecord } from '../provider-fleet.js';
import { SECRET_PATTERN } from '../stage7/qa/evidence.js';

export interface FleetProviderChain {
  readonly policy: 'COMPATIBLE_ONLY' | 'HUMAN_REQUIRED' | 'DISABLED';
  readonly candidates: readonly NormalizedProviderRecord[];
}

export interface ExternalCliAdapterDeps {
  /** Resolves the ordered candidate chain for one node; empty chain fails closed. */
  resolveChain(request: NodeExecutionRequest): FleetProviderChain;
  readonly now?: () => string;
}

export class ExternalCliAdapterError extends Error {
  readonly code: 'FLEET_ROUTE_MISMATCH' | 'FLEET_CHAIN_EMPTY' | 'BINARY_VERIFY_FAILED' | 'OUTPUT_INVALID' | 'FLEET_CANDIDATES_EXHAUSTED';
  constructor(code: ExternalCliAdapterError['code'], message: string) {
    super(message);
    this.name = 'ExternalCliAdapterError';
    this.code = code;
  }
}

const KNOWN_PLACEHOLDERS = /\{(?:prompt|sessionId)\}/g;
const GRACE_MS = 2_000;

function requireFleetNode(request: NodeExecutionRequest): void {
  if (request.node.nodeId !== 'fleet-task' || request.node.requiredCapability !== 'fleet-execution' || request.node.role !== 'fleet-v1-executor') {
    throw new ExternalCliAdapterError('FLEET_ROUTE_MISMATCH', `External-cli adapter only executes fleet.v1 "fleet-task" nodes; got "${request.node.nodeId}".`);
  }
  if (request.mutationClass !== 'READ_ONLY') throw new ExternalCliAdapterError('FLEET_ROUTE_MISMATCH', 'External-cli fleet execution is READ_ONLY by invariant.');
}

function buildArgv(record: NormalizedProviderRecord, request: NodeExecutionRequest): string[] {
  return record.argvTemplate.map((entry) => {
    const filled = entry.replaceAll('{prompt}', request.requestOrSummary).replaceAll('{sessionId}', request.allocation.operatorSessionId);
    if (filled.includes('{') || filled.includes('}')) throw new ExternalCliAdapterError('OUTPUT_INVALID', `Argv template entry produced an unknown placeholder: "${entry}".`);
    return filled;
  });
}

function childEnv(record: NormalizedProviderRecord, request: NodeExecutionRequest): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of record.envAllowlist) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const grantedTools = record.tools.filter((tool) => request.toolGrant.includes(tool));
  if (grantedTools.length > 0) env.FLEET_TOOL_GRANT = JSON.stringify(grantedTools);
  return env;
}

async function verifyBinary(record: NormalizedProviderRecord): Promise<void> {
  if (record.binary === undefined || record.sha256 === undefined) throw new ExternalCliAdapterError('BINARY_VERIFY_FAILED', `Provider ${record.providerId} lacks a binary pin.`);
  const stats = await fs.lstat(record.binary).catch(() => undefined);
  if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) throw new ExternalCliAdapterError('BINARY_VERIFY_FAILED', `Provider ${record.providerId} binary is missing or not a regular file.`);
  const hash = createHash('sha256');
  const stream = createReadStream(record.binary);
  const { promise: hashed, resolve: hashDone, reject: hashFailed } = Promise.withResolvers<void>();
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', hashFailed);
  stream.on('end', hashDone);
  await hashed;
  if (hash.digest('hex') !== record.sha256) throw new ExternalCliAdapterError('BINARY_VERIFY_FAILED', `Provider ${record.providerId} binary does not match its pinned SHA-256.`);
}

function scrub(text: string): string {
  return text.split('\n').map((line) => (SECRET_PATTERN.test(line) ? '[redacted credential-bearing line]' : line)).join('\n');
}

function timeoutMs(request: NodeExecutionRequest, now: () => string): number {
  const at = Date.parse(request.allocation.timeoutAt);
  if (Number.isNaN(at)) return 900_000;
  return Math.max(0, at - Date.parse(now()));
}

function runCandidate(record: NormalizedProviderRecord, request: NodeExecutionRequest, signal: AbortSignal, now: () => string): Promise<NodeExecutionOutcome> {
  const { promise, resolve } = Promise.withResolvers<NodeExecutionOutcome>();
  const attempt: NodeExecutionAttempt = { ...request.allocation, modelProvider: 'external-cli', modelId: record.models[0]?.id ?? record.providerId };
  let settled = false;
  const finish = (status: AgentResultStatus, summary: string, extra: Partial<AgentResult> = {}): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child?.removeAllListeners();
    const result: AgentResult = {
      resultId: attempt.attemptId,
      operatorSessionId: attempt.operatorSessionId,
      nodeId: attempt.nodeId,
      capabilityId: attempt.capabilityId,
      status,
      summary,
      producedArtifactRefs: [],
      consumedArtifactRefs: [],
      findingIds: [],
      evidenceIds: [],
      providerSessionId: `${record.providerId}:${attempt.attemptId}`,
      startedAt: attempt.startedAt,
      completedAt: now(),
      policyRefs: [],
      ...extra,
    };
    resolve({ attempt, result });
  };
  let child: ChildProcess | undefined;
  const killHard = (): void => {
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  };
  const timer = setTimeout(() => {
    if (child?.pid !== undefined) {
      child.kill('SIGTERM');
      setTimeout(killHard, GRACE_MS).unref();
    }
  }, timeoutMs(request, now));
  const onAbort = (): void => {
    if (child?.pid !== undefined) {
      child.kill('SIGTERM');
      setTimeout(killHard, GRACE_MS).unref();
    }
    setTimeout(() => finish(signal.reason === 'TIMEOUT' ? 'FAILED' : 'UNKNOWN', signal.reason === 'TIMEOUT' ? `Fleet provider ${record.providerId} timed out.` : `Fleet provider ${record.providerId} was cancelled.`), GRACE_MS + 100).unref();
  };
  if (signal.aborted) {
    onAbort();
    return promise;
  }
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    child = spawn(record.binary as string, buildArgv(record, request), { shell: false, env: childEnv(record, request), stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    finish('BLOCKED', `Fleet provider ${record.providerId} failed to spawn: ${error instanceof Error ? error.message : String(error)}`);
    return promise;
  }
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    finish('BLOCKED', `Fleet provider ${record.providerId} could not be executed: ${error.message}`);
  });
  child.on('close', (code) => {
    if (signal.aborted) return;
    const lines = stdout.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const last = lines[lines.length - 1];
    let parsed: unknown;
    try {
      parsed = last === undefined ? undefined : JSON.parse(last) as unknown;
    } catch {
      parsed = undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      finish('FAILED', `Fleet provider ${record.providerId} produced no parseable JSON result line.${stderr.trim() === '' ? '' : `\nstderr: ${scrub(stderr.trim()).slice(0, 2_000)}`}`);
      return;
    }
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate['resultId'] !== 'string' || candidate['resultId'] === '' || typeof candidate['status'] !== 'string') {
      finish('FAILED', `Fleet provider ${record.providerId} output failed result identity validation.`);
      return;
    }
    const status = candidate['status'] as AgentResultStatus;
    let summary = typeof candidate['summary'] === 'string' ? candidate['summary'] : 'Fleet provider produced a result without a summary.';
    if (SECRET_PATTERN.test(summary)) summary = scrub(summary);
    if (code !== 0 && status === 'SUCCEEDED') {
      finish('FAILED', `Fleet provider ${record.providerId} exited with code ${code} but claimed success.`);
      return;
    }
    finish(status, summary);
  });
  return promise;
}

function trialsSuffix(trials: readonly { readonly providerId: string; readonly failure: string }[]): string {
  if (trials.length === 0) return '';
  return ` [fleet-trials: ${JSON.stringify(trials)}]`;
}

export class ExternalCliAdapter implements NodeExecutionAdapter {
  readonly adapterId = 'external-cli' as const;
  private readonly now: () => string;

  constructor(private readonly deps: ExternalCliAdapterDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  launchBatch(request: ExecutionBatchRequest): ActiveExecutionBatch {
    const controller = new AbortController();
    const completion = Promise.allSettled(request.nodes.map((node) => this.runNode(node, controller.signal))).then((settled) => settled.map((entry, index) => {
      const node = request.nodes[index];
      if (node === undefined) throw new Error('Fleet batch lost node ordering.');
      if (entry.status === 'fulfilled') return entry.value;
      const reason = entry.reason instanceof Error ? entry.reason.message : String(entry.reason);
      const attempt: NodeExecutionAttempt = { ...node.allocation, modelProvider: 'external-cli', modelId: 'external-cli' };
      const result: AgentResult = {
        resultId: attempt.attemptId,
        operatorSessionId: attempt.operatorSessionId,
        nodeId: attempt.nodeId,
        capabilityId: attempt.capabilityId,
        status: controller.signal.aborted ? 'UNKNOWN' : 'BLOCKED',
        summary: `Fleet execution failed before any candidate launched: ${reason}`,
        producedArtifactRefs: [],
        consumedArtifactRefs: [],
        findingIds: [],
        evidenceIds: [],
        startedAt: attempt.startedAt,
        completedAt: this.now(),
        policyRefs: [],
      };
      return { attempt, result };
    }));
    return {
      batchId: request.batchId,
      attempts: request.nodes.map((node) => ({ ...node.allocation, modelProvider: 'external-cli', modelId: 'external-cli' })),
      completion,
      async cancel(reason): Promise<void> {
        controller.abort(reason);
        await completion;
      },
    };
  }

  private async runNode(node: NodeExecutionRequest, signal: AbortSignal): Promise<NodeExecutionOutcome> {
    requireFleetNode(node);
    const chain = this.deps.resolveChain(node);
    if (chain.candidates.length === 0) throw new ExternalCliAdapterError('FLEET_CHAIN_EMPTY', 'Fleet provider chain is empty; nothing is dispatched.');
    const limit = chain.policy === 'COMPATIBLE_ONLY' ? 2 : 1;
    const candidates = chain.candidates.slice(0, limit);
    const trials: { readonly providerId: string; readonly failure: string }[] = [];
    for (const [index, record] of candidates.entries()) {
      if (record.mutability !== 'READ_ONLY') {
        trials.push({ providerId: record.providerId, failure: `mutating providers cannot serve READ_ONLY fleet nodes` });
        continue;
      }
      const outsideTools = record.tools.filter((tool) => !node.toolGrant.includes(tool));
      if (outsideTools.length > 0) {
        trials.push({ providerId: record.providerId, failure: `declares tools outside the compiled grant: ${outsideTools.join(',')}` });
        continue;
      }
      try {
        await verifyBinary(record);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        trials.push({ providerId: record.providerId, failure });
        continue;
      }
      const outcome = await runCandidate(record, node, signal, this.now);
      if (signal.aborted && outcome.result.status === 'UNKNOWN') return outcome;
      if (outcome.result.status === 'SUCCEEDED' || index === candidates.length - 1 || chain.policy === 'HUMAN_REQUIRED') {
        const suffix = trialsSuffix(trials);
        if (suffix !== '') {
          return { ...outcome, result: { ...outcome.result, summary: `${outcome.result.summary}${suffix}` } };
        }
        return outcome;
      }
      trials.push({ providerId: record.providerId, failure: `terminal status ${outcome.result.status} is not fallback-eligible` });
      return { ...outcome, result: { ...outcome.result, summary: `${outcome.result.summary}${trialsSuffix(trials)}` } };
    }
    throw new ExternalCliAdapterError('FLEET_CANDIDATES_EXHAUSTED', `All ${trials.length} fleet candidate(s) failed pre-launch verification.${trialsSuffix(trials)}`);
  }
}

export function createExternalCliAdapter(deps: ExternalCliAdapterDeps): ExternalCliAdapter {
  return new ExternalCliAdapter(deps);
}

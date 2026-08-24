import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { NodeExecutionRequest } from '../src/runtime-types.js';
import type { ProviderFallbackJournal } from '../src/execution-safety.js';
import type { NormalizedProviderRecord } from '../src/provider-fleet.js';
import { ExternalCliAdapter, type FleetProviderChain } from '../src/adapters/external-cli.js';

function writeBinary(dir: string, name: string, body: string): NormalizedProviderRecord {
  const binary = join(dir, name);
  writeFileSync(binary, body);
  chmodSync(binary, 0o755);
  return {
    providerId: name.replace(/\.[^.]+$/, ''),
    kind: 'external-cli',
    displayName: name,
    source: 'test catalog',
    health: 'HEALTHY',
    auth: 'AUTHENTICATED',
    capabilities: ['fleet-execution'],
    models: [{ id: `${name}-model`, tier: 'MEDIUM', disclosed: true, capabilities: ['fleet-execution'], costClass: 'MEDIUM', latencyClass: 'MEDIUM' }],
    supports: ['SINGLE'],
    mutability: 'READ_ONLY',
    tools: [],
    concurrency: 1,
    binary,
    sha256: createHash('sha256').update(body).digest('hex'),
    argvTemplate: ['{prompt}', '{sessionId}'],
    envAllowlist: ['FLEET_ALLOWED_VAR'],
  };
}

function request(overrides: Partial<NodeExecutionRequest> = {}): NodeExecutionRequest {
  return {
    mutationClass: 'READ_ONLY',
    node: { nodeId: 'fleet-task', role: 'fleet-v1-executor', capabilityId: 'good-cli:fleet-execution', requiredCapability: 'fleet-execution', mandatory: true, dependsOn: [], contextPolicy: 'shared', consumes: [], produces: [] },
    allocation: { attemptId: 'attempt-1', batchId: 'batch-1', operatorSessionId: 'session-1', graphRevision: 1, nodeId: 'fleet-task', capabilityId: 'good-cli:fleet-execution', adapterId: 'external-cli', providerSessionId: 'provider-1', startedAt: new Date().toISOString(), timeoutAt: new Date(Date.now() + 60_000).toISOString() },
    requestOrSummary: 'run the fleet task',
    consumedArtifacts: [],
    consumedEvidence: [],
    dependencyResultSummaries: [],
    projection: { projectionRoot: '/tmp/fleet-fixture', allowedPaths: [], manifestHash: 'a'.repeat(64), sourceLabels: [] },
    policyRefs: [],
    instructions: '',
    acceptanceCriteria: [],
    toolGrant: [],
    outputSchemaId: 'agent-result.v1',
    ...overrides,
  } as NodeExecutionRequest;
}

function chain(policy: FleetProviderChain['policy'], candidates: readonly NormalizedProviderRecord[]): (request: NodeExecutionRequest) => FleetProviderChain {
  return () => ({ policy, candidates });
}

const NOW = (): string => new Date().toISOString();

async function launch(adapter: ExternalCliAdapter, nodeRequest: NodeExecutionRequest): Promise<{ readonly status: string; readonly summary: string; readonly fallbackJournal?: ProviderFallbackJournal }> {
  const batch = adapter.launchBatch({ batchId: 'batch-1', nodes: [nodeRequest], launchedBy: 'test', requestedBy: 'test', graphHash: 'a'.repeat(64), workflowTemplateId: 'fleet.v1' } as never);
  const outcomes = await batch.completion;
  const outcome = outcomes[0]!;
  return { status: outcome.result.status, summary: outcome.result.summary, ...(outcome.fallbackJournal === undefined ? {} : { fallbackJournal: outcome.fallbackJournal }) };
}

describe('Stage-9B external-cli adapter', () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'fleet-adapter-'));

  const goodBody = [
    '#!/bin/sh',
    'printf \'{"resultId":"fixture-result","status":"SUCCEEDED","summary":"prompt=%s session=%s allowed=%s missing=%s"}\' "$1" "$2" "${FLEET_ALLOWED_VAR:-unset}" "${FLEET_FORBIDDEN_VAR:-unset}"',
    '',
  ].join('\n');
  const good = writeBinary(dir, 'good-cli.sh', goodBody);
  const brokenPin = { ...writeBinary(dir, 'broken-pin.sh', '#!/bin/sh\n'), sha256: 'b'.repeat(64) };
  const missing = { ...good, providerId: 'missing-cli', binary: join(dir, 'does-not-exist.sh') };
  const secretStderr = writeBinary(dir, 'secret-stderr.sh', '#!/bin/sh\necho "password: hunter2" >&2\nexit 1\n');

  test('happy path substitutes argv placeholders, forwards only allowlisted env, and succeeds', async () => {
    process.env.FLEET_ALLOWED_VAR = 'yes';
    process.env.FLEET_FORBIDDEN_VAR = 'leak';
    try {
      const adapter = new ExternalCliAdapter({ resolveChain: chain('COMPATIBLE_ONLY', [good]), now: NOW });
      const { status, summary } = await launch(adapter, request());
      expect(status).toBe('SUCCEEDED');
      expect(summary).toContain('prompt=run the fleet task');
      expect(summary).toContain('session=session-1');
      expect(summary).toContain('allowed=yes');
      expect(summary).toContain('missing=unset');
    } finally {
      delete process.env.FLEET_ALLOWED_VAR;
      delete process.env.FLEET_FORBIDDEN_VAR;
    }
  });

  test('pin mismatch fails closed before spawn', async () => {
    const adapter = new ExternalCliAdapter({ resolveChain: chain('COMPATIBLE_ONLY', [brokenPin]), now: NOW });
    const { status, summary } = await launch(adapter, request());
    expect(status).toBe('BLOCKED');
    expect(summary).toContain('failed before any candidate launched');
  });

  test('bounded fallback tries the second candidate after a pre-launch failure of the first', async () => {
    const adapter = new ExternalCliAdapter({ resolveChain: chain('COMPATIBLE_ONLY', [missing, good]), now: NOW });
    const { status, summary, fallbackJournal } = await launch(adapter, request());
    expect(status).toBe('SUCCEEDED');
    expect(summary).toContain('fleet-trials');
    expect(fallbackJournal?.initialProvider).toBe('missing-cli');
    expect(fallbackJournal?.selectedProvider).toBe('good-cli');
    expect(fallbackJournal?.attempts.map((attempt) => attempt.reasonCode)).toEqual(['BINARY_VERIFY_FAILED', 'FALLBACK_SELECTED', 'TERMINAL_SUCCEEDED']);
    expect(fallbackJournal?.finalOutcome).toBe('SUCCEEDED');
    expect(summary).toContain('missing-cli');
  });

  test('HUMAN_REQUIRED policy never reaches a second candidate', async () => {
    const adapter = new ExternalCliAdapter({ resolveChain: chain('HUMAN_REQUIRED', [missing, good]), now: NOW });
    const { status, summary } = await launch(adapter, request());
    expect(status).toBe('BLOCKED');
    expect(summary).toContain('failed before any candidate launched');
    expect(summary).not.toContain('fleet ok');
  });

  test('stderr secrets are scrubbed from failure evidence', async () => {
    const adapter = new ExternalCliAdapter({ resolveChain: chain('DISABLED', [secretStderr]), now: NOW });
    const { status, summary } = await launch(adapter, request());
    expect(status).toBe('FAILED');
    expect(summary).toContain('[redacted credential-bearing line]');
    expect(summary).not.toContain('hunter2');
  });

  test('mutating candidates are skipped and the tool grant is forwarded to eligible ones', async () => {
    const mutating = { ...writeBinary(dir, 'mutating-cli.sh', '#!/bin/sh\n'), mutability: 'MUTATING' as const };
    const granted = { ...good, tools: ['operator_read'] };
    process.env.FLEET_ALLOWED_VAR = 'unused';
    try {
      const adapter = new ExternalCliAdapter({ resolveChain: chain('COMPATIBLE_ONLY', [mutating, granted]), now: NOW });
      const nodeRequest = request();
      const { status, summary } = await launch(adapter, { ...nodeRequest, toolGrant: ['operator_read'] } as NodeExecutionRequest);
      expect(status).toBe('SUCCEEDED');
      expect(summary).toContain('fleet-trials');
      expect(summary).toContain('mutating providers cannot serve READ_ONLY fleet nodes');
      void granted;
    } finally {
      delete process.env.FLEET_ALLOWED_VAR;
    }
  });

  test('success summaries are scrubbed for credential-bearing patterns', async () => {
    const leaking = writeBinary(dir, 'leak-cli.sh', '#!/bin/sh\nprintf \'{"resultId":"r","status":"SUCCEEDED","summary":"token bearer abc123 done"}\'\n');
    const adapter = new ExternalCliAdapter({ resolveChain: chain('DISABLED', [leaking]), now: NOW });
    const { status, summary } = await launch(adapter, request());
    expect(status).toBe('SUCCEEDED');
    expect(summary).not.toContain('bearer abc123');
    expect(summary).toContain('[redacted credential-bearing line]');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Stage-9B fleet route guard', () => {
  test('non-fleet nodes fail closed before any chain resolution', async () => {
    const adapter = new ExternalCliAdapter({ resolveChain: () => ({ policy: 'COMPATIBLE_ONLY', candidates: [] }), now: NOW });
    const { status, summary } = await launch(adapter, request({ node: { ...request().node, nodeId: 'planner', role: 'planner', requiredCapability: 'planning' } }));
    expect(status).toBe('BLOCKED');
    expect(summary).toContain('fleet-task');
  });

  test('empty chains fail closed without dispatch', async () => {
    const adapter = new ExternalCliAdapter({ resolveChain: chain('COMPATIBLE_ONLY', []), now: NOW });
    const { status, summary } = await launch(adapter, request());
    expect(status).toBe('BLOCKED');
    expect(summary).toContain('chain is empty');
  });

});

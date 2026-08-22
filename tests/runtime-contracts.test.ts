import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { validateOperatorCommandOutcome, validateStoredOperatorSession } from '../src/runtime-validators.js';

const TS = '2026-08-13T12:00:00Z';
const LATER = '2026-08-13T12:01:00Z';
const HASH_A = 'a'.repeat(64);
const POLICY = 'default@1:workflow.contracts';

const operatorSession = {
  operatorSessionId: 'session-1',
  schemaVersion: '1.0',
  originalRequest: 'Implement Stage 2 runtime.',
  createdAt: TS,
  updatedAt: LATER,
  currentState: 'IDLE',
  currentPhase: 'idle',
  routeDecision: null,
  workflowTemplateId: null,
  executionGraph: null,
  nodeStates: {},
  providerSessionIds: {},
  humanDecisions: [],
  artifacts: [],
  evidence: [],
  verificationState: {
    behavioralVerification: 'NOT_STARTED',
    conformanceVerification: 'NOT_STARTED',
    independentReview: 'NOT_STARTED',
    adversarialReview: 'NOT_APPLICABLE',
  },
  budgetState: { profile: 'BALANCED', tokensUsed: 0, costUsed: 0 },
  journal: [],
  terminalResult: null,
};

const humanGate = {
  gateId: 'gate-1',
  operatorSessionId: 'session-1',
  reason: 'Execution requires approval.',
  decisionType: 'EXECUTION_APPROVAL',
  requestedDecision: 'Approve candidate execution.',
  availableOptions: ['APPROVE', 'REJECT'],
  recommendedOption: 'APPROVE',
  evidenceRefs: [],
  consequences: {
    APPROVE: 'Dispatch the validated graph.',
    REJECT: 'Record DECLINED and do not dispatch.',
  },
  resumeNode: 'implement',
  graphRevision: 1,
  graphHash: HASH_A,
  artifactRefs: [],
  artifactHashes: [],
  policyRefs: [POLICY],
  createdAt: TS,
  status: 'OPEN',
};

const storedSession = {
  schemaVersion: '1.0' as const,
  session: operatorSession,
  gates: [humanGate],
  maxConcurrency: 1,
  activeAttempts: {},
  nodeResultRefs: {},
};

function expectInvalid(result: { ok: boolean; errors?: readonly { path: string; message: string }[] }, pathPart?: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok && pathPart) {
    const errors = result.errors ?? [];
    expect(errors.some((error) => error.path.includes(pathPart))).toBe(true);
  }
}

describe('validateStoredOperatorSession', () => {
  test('accepts a session with its owned gates', () => {
    expect(validateStoredOperatorSession(storedSession).ok).toBe(true);
  });

  test('accepts a session with zero gates', () => {
    expect(validateStoredOperatorSession({ ...storedSession, gates: [] }).ok).toBe(true);
  });

  test('rejects a non-1.0 schemaVersion', () => {
    expectInvalid(validateStoredOperatorSession({ ...storedSession, schemaVersion: '2.0' }), 'schemaVersion');
  });

  test('rejects unknown top-level properties', () => {
    expectInvalid(validateStoredOperatorSession({ ...storedSession, extra: true }), 'extra');
  });

  test('rejects a malformed nested session, prefixing errors with session', () => {
    const { operatorSessionId: _omitted, ...invalidSession } = operatorSession;
    expectInvalid(validateStoredOperatorSession({ ...storedSession, session: invalidSession }), 'session.operatorSessionId');
  });

  test('rejects duplicate gateIds', () => {
    expectInvalid(validateStoredOperatorSession({ ...storedSession, gates: [humanGate, humanGate] }), 'gateId');
  });

  test('rejects a gate whose operatorSessionId does not match the session', () => {
    const mismatched = { ...humanGate, operatorSessionId: 'session-other' };
    expectInvalid(validateStoredOperatorSession({ ...storedSession, gates: [mismatched] }), 'operatorSessionId');
  });

  test('never mutates its input', () => {
    const input = JSON.parse(JSON.stringify(storedSession)) as typeof storedSession;
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    validateStoredOperatorSession(input);
    expect(input).toEqual(snapshot as typeof storedSession);
  });
});

describe('validateOperatorCommandOutcome', () => {
  test('accepts a minimal successful outcome', () => {
    expect(validateOperatorCommandOutcome({ ok: true, text: 'Session started.' }).ok).toBe(true);
  });

  test('accepts a failed outcome with an errorCode', () => {
    expect(validateOperatorCommandOutcome({ ok: false, text: 'No active session.', errorCode: 'NO_ACTIVE_SESSION' }).ok).toBe(true);
  });

  test('accepts a successful outcome carrying session and gate state with agreeing ids', () => {
    const outcome = {
      ok: true,
      text: 'Awaiting execution approval.',
      operatorSessionId: 'session-1',
      session: operatorSession,
      gate: humanGate,
    };
    expect(validateOperatorCommandOutcome(outcome).ok).toBe(true);
  });

  test('rejects unknown properties', () => {
    expectInvalid(validateOperatorCommandOutcome({ ok: true, text: 'ok', extra: 1 }), 'extra');
  });

  test('rejects an unknown errorCode', () => {
    expectInvalid(validateOperatorCommandOutcome({ ok: false, text: 'boom', errorCode: 'NOT_A_REAL_CODE' }), 'errorCode');
  });

  test('rejects ok:true paired with an errorCode', () => {
    expectInvalid(validateOperatorCommandOutcome({ ok: true, text: 'ok', errorCode: 'INVALID_COMMAND' }), 'errorCode');
  });

  test('rejects ok:false missing an errorCode', () => {
    expectInvalid(validateOperatorCommandOutcome({ ok: false, text: 'failed' }), 'errorCode');
  });

  test('rejects a top-level operatorSessionId that disagrees with session.operatorSessionId', () => {
    const outcome = {
      ok: true,
      text: 'ok',
      operatorSessionId: 'session-mismatch',
      session: operatorSession,
    };
    expectInvalid(validateOperatorCommandOutcome(outcome), 'operatorSessionId');
  });

  test('rejects a gate whose operatorSessionId disagrees with session.operatorSessionId', () => {
    const outcome = {
      ok: true,
      text: 'ok',
      session: operatorSession,
      gate: { ...humanGate, operatorSessionId: 'session-mismatch' },
    };
    expectInvalid(validateOperatorCommandOutcome(outcome), 'gate.operatorSessionId');
  });

  test('never mutates its input', () => {
    const input = { ok: true, text: 'ok', session: operatorSession, gate: humanGate };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    validateOperatorCommandOutcome(input);
    expect(input).toEqual(snapshot as typeof input);
  });
});

describe('Stage 2 JSON Schema inventory', () => {

  test('stored-operator-session.v1.json references OperatorSession.v1 and HumanGate.v1 by stable id', async () => {
    const schemaDir = join(import.meta.dir, '..', 'schemas');
    const schema = JSON.parse(await Bun.file(join(schemaDir, 'stored-operator-session.v1.json')).text()) as {
      properties: {
        schemaVersion: { const: string };
        session: { $ref: string };
        gates: { items: { $ref: string } };
      };
      required: readonly string[];
    };
    expect(schema.properties.schemaVersion.const).toBe('1.0');
    expect(schema.properties.session.$ref).toBe('https://omp.local/agent-operator/schemas/operator-session.v1.json');
    expect(schema.properties.gates.items.$ref).toBe('https://omp.local/agent-operator/schemas/human-gate.v1.json');
    expect(schema.required).toEqual(['schemaVersion', 'session', 'gates']);
  });

  test('operator-command-outcome.v1.json enforces the ok/errorCode contradiction and enumerates every error code', async () => {
    const schemaDir = join(import.meta.dir, '..', 'schemas');
    const schema = JSON.parse(await Bun.file(join(schemaDir, 'operator-command-outcome.v1.json')).text()) as {
      required: readonly string[];
      allOf: readonly { if: { properties: { ok: { const: boolean } } }; then: Record<string, unknown> }[];
      $defs: { OperatorCommandErrorCode: { enum: readonly string[] } };
    };
    expect(schema.required).toEqual(['ok', 'text']);
    expect(schema.allOf).toHaveLength(2);
    expect(schema.allOf[0]?.if.properties.ok.const).toBe(true);
    expect(schema.allOf[1]?.if.properties.ok.const).toBe(false);
    expect(schema.$defs.OperatorCommandErrorCode.enum).toEqual([
      'INVALID_COMMAND',
      'NO_ACTIVE_SESSION',
      'SESSION_NOT_FOUND',
      'SESSION_ALREADY_ACTIVE',
      'INVALID_TRANSITION',
      'GATE_NOT_FOUND',
      'GATE_NOT_OPEN',
      'GATE_MISMATCH',
      'CONTRACT_INVALID',
      'STORE_CONFLICT',
      'NODE_EXECUTION_FAILED',
      'COMPILATION_FAILED',
      'ADAPTER_UNAVAILABLE',
      'EXECUTION_ACTIVE',
      'EXECUTION_TIMEOUT',
      'INVALID_OUTPUT',
      'BLOCKED_REQUIRED_CONTEXT',
      'BLOCKED_PROVIDER_UNAVAILABLE',
      'BLOCKED_CAPABILITY',
      'BLOCKED_SECURITY',
      'FEATURE_SET_MISMATCH',
      'STAGE7_ROUTE_UNAVAILABLE',
      'STAGE7_CAPABILITY_UNAVAILABLE',
    ]);
  });
});

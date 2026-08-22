import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { HumanGate, JournalEntry, OperatorSession } from '../src/contracts.js';
import type { StoredOperatorSession } from '../src/runtime-types.js';
import { appendJournal, FileOperatorSessionStore, MemoryOperatorSessionStore, StoreConflictError, StoreCorruptionError } from '../src/store.js';

const TS = '2026-08-13T12:00:00Z';
const LATER = '2026-08-13T12:05:00Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function makeSession(overrides: Partial<OperatorSession> = {}): OperatorSession {
  return {
    operatorSessionId: 'session-1',
    schemaVersion: '1.0',
    originalRequest: 'Implement Stage 2 mock runtime.',
    createdAt: TS,
    updatedAt: TS,
    currentState: 'IDLE',
    currentPhase: 'contracts',
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
    ...overrides,
  };
}

function makeGate(overrides: Partial<HumanGate> = {}): HumanGate {
  return {
    gateId: 'gate-1',
    operatorSessionId: 'session-1',
    reason: 'Execution requires approval.',
    decisionType: 'EXECUTION_APPROVAL',
    requestedDecision: 'Approve candidate execution.',
    availableOptions: ['APPROVE', 'REJECT'],
    recommendedOption: 'APPROVE',
    evidenceRefs: ['evidence-1'],
    consequences: {
      APPROVE: 'Dispatch the validated graph.',
      REJECT: 'Record DECLINED and do not dispatch.',
    },
    resumeNode: 'implement',
    graphRevision: 1,
    graphHash: HASH_A,
    artifactRefs: ['patch-artifact'],
    artifactHashes: [HASH_B],
    policyRefs: [],
    createdAt: TS,
    status: 'OPEN',
    ...overrides,
  };
}

function makeRecord(overrides: Partial<StoredOperatorSession> = {}): StoredOperatorSession {
  return {
    schemaVersion: '1.0',
    session: makeSession(),
    gates: [makeGate()],
    maxConcurrency: 1,
    activeAttempts: {},
    nodeResultRefs: {},
    ...overrides,
  };
}

function makeJournalEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    timestamp: LATER,
    eventType: 'GATE_APPROVED',
    operatorSessionId: 'session-1',
    message: 'Human approved execution.',
    ...overrides,
  };
}

describe('appendJournal', () => {
  test('appends immutably and advances updatedAt to the entry timestamp', () => {
    const session = makeSession({ journal: [makeJournalEntry({ timestamp: TS, eventType: 'STARTED', message: 'Session started.' })] });
    const originalJournal = session.journal;
    const entry = makeJournalEntry();

    const next = appendJournal(session, entry);

    expect(next.journal).toEqual([...originalJournal, entry]);
    expect(next.updatedAt).toBe('2026-08-13T12:05:00.000Z');
    expect(session.journal).toBe(originalJournal);
    expect(session.journal).toHaveLength(1);
    expect(session.updatedAt).toBe(TS);
    expect(next.journal).not.toBe(originalJournal);
  });

  test('never mutates the session object identity', () => {
    const session = makeSession();
    const next = appendJournal(session, makeJournalEntry());
    expect(next).not.toBe(session);
  });

  test('advances updatedAt by 1ms when two appends land at the same instant (CAS-safety, plan §4.3)', () => {
    const session = makeSession({ updatedAt: TS });
    const first = appendJournal(session, makeJournalEntry({ timestamp: TS }));
    expect(first.updatedAt).toBe('2026-08-13T12:00:00.001Z');

    const second = appendJournal(first, makeJournalEntry({ timestamp: TS }));
    expect(second.updatedAt).toBe('2026-08-13T12:00:00.002Z');
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });

  test('never regresses updatedAt when entry.timestamp is earlier than the session', () => {
    const session = makeSession({ updatedAt: LATER });
    const next = appendJournal(session, makeJournalEntry({ timestamp: TS }));
    expect(Date.parse(next.updatedAt)).toBeGreaterThan(Date.parse(LATER));
  });
});

describe('MemoryOperatorSessionStore', () => {
  test('round-trips a saved record', async () => {
    const store = new MemoryOperatorSessionStore();
    const record = makeRecord();

    await store.save(record);
    const loaded = await store.load('session-1');

    expect(loaded).toEqual(record);
  });

  test('returns undefined for an absent session', async () => {
    const store = new MemoryOperatorSessionStore();
    expect(await store.load('nonexistent')).toBeUndefined();
  });

  test('defensively clones on save so later caller mutation is invisible', async () => {
    const store = new MemoryOperatorSessionStore();
    const gates = [makeGate()];
    const record = makeRecord({ gates });

    await store.save(record);
    gates.push(makeGate({ gateId: 'gate-2' }));

    const loaded = await store.load('session-1');
    expect(loaded?.gates).toHaveLength(1);
  });

  test('defensively clones on load so caller mutation never reaches the store', async () => {
    const store = new MemoryOperatorSessionStore();
    await store.save(makeRecord());

    const first = await store.load('session-1');
    expect(first).toBeDefined();
    // Test-only: bypass readonly to prove the store's internal copy is
    // isolated from this returned clone.
    const mutableFirst = first as unknown as { session: { currentPhase: string } };
    mutableFirst.session.currentPhase = 'tampered';

    const second = await store.load('session-1');
    expect(second?.session.currentPhase).toBe('contracts');
  });

  test('rejects a stale expectedUpdatedAt with StoreConflictError', async () => {
    const store = new MemoryOperatorSessionStore();
    await store.save(makeRecord());

    await expect(store.save(makeRecord({ session: makeSession({ updatedAt: LATER }) }), 'wrong-timestamp')).rejects.toBeInstanceOf(
      StoreConflictError,
    );
  });

  test('rejects an expectedUpdatedAt check against a session that was never saved', async () => {
    const store = new MemoryOperatorSessionStore();
    await expect(store.save(makeRecord(), TS)).rejects.toBeInstanceOf(StoreConflictError);
  });

  test('accepts a matching expectedUpdatedAt and applies the write', async () => {
    const store = new MemoryOperatorSessionStore();
    await store.save(makeRecord());

    await store.save(makeRecord({ session: makeSession({ updatedAt: LATER, currentPhase: 'execution' }) }), TS);

    const loaded = await store.load('session-1');
    expect(loaded?.session.currentPhase).toBe('execution');
  });

  test('overwrites unconditionally when expectedUpdatedAt is omitted', async () => {
    const store = new MemoryOperatorSessionStore();
    await store.save(makeRecord());
    await store.save(makeRecord({ session: makeSession({ updatedAt: LATER, currentPhase: 'blind-overwrite' }) }));

    const loaded = await store.load('session-1');
    expect(loaded?.session.currentPhase).toBe('blind-overwrite');
  });

  test('under two concurrent racing saves against the same expectedUpdatedAt, exactly one wins and the other sees StoreConflictError (Stage 4 §6.2 CAS-safety)', async () => {
    const store = new MemoryOperatorSessionStore();
    await store.save(makeRecord({ session: makeSession({ updatedAt: TS }) }));

    const winnerRecord = makeRecord({ session: makeSession({ updatedAt: '2026-08-13T12:00:00.001Z', currentPhase: 'winner' }) });
    const loserRecord = makeRecord({ session: makeSession({ updatedAt: '2026-08-13T12:00:00.001Z', currentPhase: 'loser' }) });

    const [winnerResult, loserResult] = await Promise.allSettled([
      store.save(winnerRecord, TS),
      store.save(loserRecord, TS),
    ]);

    // Both raced against the same expectedUpdatedAt (TS); the in-process
    // Map-backed store is synchronous per call, so exactly one settles and
    // the other necessarily observes the winner's new updatedAt and
    // rejects with StoreConflictError - never a silent lost update.
    const settled = [winnerResult, loserResult];
    const fulfilledCount = settled.filter((r) => r.status === 'fulfilled').length;
    const rejectedCount = settled.filter((r) => r.status === 'rejected').length;
    expect(fulfilledCount).toBe(1);
    expect(rejectedCount).toBe(1);
    const rejected = settled.find((r) => r.status === 'rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(StoreConflictError);
    }

    const loaded = await store.load('session-1');
    if (loaded === undefined) throw new Error('expected session to have been persisted by the winning save');
    expect(['winner', 'loser']).toContain(loaded.session.currentPhase);
  });
});

describe('FileOperatorSessionStore', () => {
  let rootDir: string;
  let store: FileOperatorSessionStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-operator-store-test-'));
    store = new FileOperatorSessionStore({ rootDir });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  test('round-trips a saved record through disk', async () => {
    const record = makeRecord();
    await store.save(record);

    const loaded = await store.load('session-1');
    expect(loaded).toEqual(record);
  });

  test('returns undefined for an absent session without creating anything', async () => {
    expect(await store.load('nonexistent')).toBeUndefined();
  });

  test('leaves no partial temp file behind after a successful save', async () => {
    await store.save(makeRecord());
    const entries = await fs.readdir(rootDir);
    expect(entries).toEqual(['session-1.json']);
  });

  test('creates the root directory as 0700 and the session file as 0600', async () => {
    if (process.platform === 'win32') return;
    await store.save(makeRecord());

    const dirMode = (await fs.stat(rootDir)).mode & 0o777;
    const fileMode = (await fs.stat(path.join(rootDir, 'session-1.json'))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  test('rejects malformed JSON as an error, not a missing session', async () => {
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(path.join(rootDir, 'session-1.json'), '{ not valid json', 'utf8');

    await expect(store.load('session-1')).rejects.toBeInstanceOf(StoreCorruptionError);
  });

  test('rejects a stored record that fails contract validation as an error, not a missing session', async () => {
    await fs.mkdir(rootDir, { recursive: true });
    const broken = { schemaVersion: '1.0', session: { ...makeSession(), currentState: 'NOT_A_REAL_STATE' }, gates: [] };
    await fs.writeFile(path.join(rootDir, 'session-1.json'), JSON.stringify(broken), 'utf8');

    await expect(store.load('session-1')).rejects.toBeInstanceOf(StoreCorruptionError);
  });

  test('rejects unknown stored envelope fields instead of silently dropping them', async () => {
    await fs.mkdir(rootDir, { recursive: true });
    const unknown = { ...makeRecord(), unexpected: true };
    await fs.writeFile(path.join(rootDir, 'session-1.json'), JSON.stringify(unknown), 'utf8');

    await expect(store.load('session-1')).rejects.toBeInstanceOf(StoreCorruptionError);
  });

  test('rejects a stored file whose session id does not match its file name', async () => {
    await store.save(makeRecord());
    const content = await fs.readFile(path.join(rootDir, 'session-1.json'), 'utf8');
    await fs.writeFile(path.join(rootDir, 'session-2.json'), content, 'utf8');

    await expect(store.load('session-2')).rejects.toBeInstanceOf(StoreCorruptionError);
  });

  test('rejects a gate bound to a different session than its stored session', async () => {
    await fs.mkdir(rootDir, { recursive: true });
    const mismatched = {
      schemaVersion: '1.0',
      session: makeSession(),
      gates: [makeGate({ operatorSessionId: 'someone-elses-session' })],
    };
    await fs.writeFile(path.join(rootDir, 'session-1.json'), JSON.stringify(mismatched), 'utf8');

    await expect(store.load('session-1')).rejects.toBeInstanceOf(StoreCorruptionError);
  });

  test('rejects operator session ids that attempt path traversal', async () => {
    await expect(store.load('../escape')).rejects.toBeInstanceOf(StoreCorruptionError);
    await expect(store.load('nested/path')).rejects.toBeInstanceOf(StoreCorruptionError);

    const outside = path.join(rootDir, '..', 'escape.json');
    await expect(fs.access(outside)).rejects.toThrow();
  });

  test('refuses to persist an invalid OperatorSession and writes nothing', async () => {
    const invalid = makeRecord({ session: { ...makeSession(), currentState: 'NOT_A_REAL_STATE' } as unknown as OperatorSession });

    await expect(store.save(invalid)).rejects.toBeInstanceOf(StoreCorruptionError);
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  test('refuses to persist a gate bound to a different session and writes nothing', async () => {
    const invalid = makeRecord({ gates: [makeGate({ operatorSessionId: 'different-session' })] });

    await expect(store.save(invalid)).rejects.toBeInstanceOf(StoreCorruptionError);
    expect(await fs.readdir(rootDir)).toEqual([]);
  });

  test('rejects a stale expectedUpdatedAt with StoreConflictError', async () => {
    await store.save(makeRecord());
    await expect(store.save(makeRecord({ session: makeSession({ updatedAt: LATER }) }), 'wrong-timestamp')).rejects.toBeInstanceOf(
      StoreConflictError,
    );
  });

  test('rejects an expectedUpdatedAt check against a session that was never saved', async () => {
    await expect(store.save(makeRecord(), TS)).rejects.toBeInstanceOf(StoreConflictError);
  });

  test('accepts a matching expectedUpdatedAt and persists the write', async () => {
    await store.save(makeRecord());
    await store.save(makeRecord({ session: makeSession({ updatedAt: LATER, currentPhase: 'execution' }) }), TS);

    const loaded = await store.load('session-1');
    expect(loaded?.session.currentPhase).toBe('execution');
  });

  test('serializes cross-instance compare-and-swap writes for one session', async () => {
    const competingStore = new FileOperatorSessionStore({ rootDir });
    await store.save(makeRecord());
    const first = makeRecord({ session: makeSession({ updatedAt: LATER, currentPhase: 'first' }) });
    const second = makeRecord({ session: makeSession({ updatedAt: LATER, currentPhase: 'second' }) });

    const results = await Promise.allSettled([
      store.save(first, TS),
      competingStore.save(second, TS),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect(rejected.reason).toBeInstanceOf(StoreConflictError);
    expect((await fs.readdir(rootDir)).filter((entry) => entry.endsWith('.lock'))).toEqual([]);
  });


  test('creates the root directory on first save when it does not yet exist', async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
    await store.save(makeRecord());

    const loaded = await store.load('session-1');
    expect(loaded?.session.operatorSessionId).toBe('session-1');
  });
});

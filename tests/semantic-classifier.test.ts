import { describe, expect, test } from 'bun:test';

import { createSemanticOperatorClassifier, SemanticClassifierError } from '../src/semantic-classifier.js';
import type { OmpChildSession, OmpChildSessionHandle, OmpCreateChildSessionOptions, OmpSessionFactory } from '../src/adapters/omp-task.js';

class FakeSemanticSession implements OmpChildSession {
  readonly prompts: string[] = [];
  aborted = 0;
  disposed = 0;
  beganDispose = 0;
  readonly #text: string | undefined;
  readonly #neverResolve: boolean;
  constructor(text?: string, neverResolve: boolean = false) { this.#text = text; this.#neverResolve = neverResolve; }
  async prompt(text: string): Promise<unknown> {
    this.prompts.push(text);
    if (this.#neverResolve) return Promise.withResolvers<never>().promise;
    return undefined;
  }
  getLastAssistantText(): string | undefined { return this.#text; }
  getLastAssistantMessage(): { readonly stopReason?: string; readonly errorMessage?: string | null } | undefined { return undefined; }
  subscribe(): () => void { return () => undefined; }
  async abort(): Promise<void> { this.aborted += 1; }
  beginDispose(): void { this.beganDispose += 1; }
  async dispose(): Promise<void> { this.disposed += 1; }
}

class FakeSemanticFactory implements OmpSessionFactory {
  readonly options: OmpCreateChildSessionOptions[] = [];
  constructor(readonly handle: OmpChildSessionHandle) {}
  async createSession(options: OmpCreateChildSessionOptions): Promise<OmpChildSessionHandle> {
    this.options.push(options);
    return this.handle;
  }
}

const validOutput = JSON.stringify({
  family: 'PLAN',
  rawConfidence: 0.91,
  alternatives: [{ family: 'RESEARCH', confidence: 0.09 }],
  disposition: 'EXECUTE',
  evidence: ['The request asks for a staged implementation plan.'],
});

function classifierFor(session: FakeSemanticSession, fallback?: string, timeoutMs?: number) {
  const factory = new FakeSemanticFactory({ session, ...(fallback === undefined ? {} : { modelFallbackMessage: fallback }) });
  return {
    classifier: createSemanticOperatorClassifier({
      sessionFactory: factory,
      resolveModel: () => ({ provider: 'provider-a', id: 'model-a' }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
    factory,
  };
}

const allowedDisclosure = {
  schemaVersion: '1.0' as const,
  disclosureClass: 'INTERNAL_REDACTABLE' as const,
  predictionIdentity: 'DETERMINISTIC_FIXTURE' as const,
  sensitiveSignalDetected: false,
  explicitFleetRoute: false,
  projectTrustStatus: 'ABSENT' as const,
  reasonCodes: ['DEFAULT_NATIVE_INTENT'],
};

function semanticInput(request: string, operatorSessionId: string) {
  return { request, projectRoot: '/project', operatorSessionId, disclosureDecision: allowedDisclosure };
}

describe('semantic classifier', () => {
  test('uses the exact selected model with zero tools and deterministic family policy defaults', async () => {
    const session = new FakeSemanticSession(validOutput);
    const { classifier, factory } = classifierFor(session);
    const result = await classifier.classify(semanticInput('plan the rollout', 'session-1'));

    expect(result.disposition).toBe('EXECUTE');
    expect(result.proposal.requestClassification).toBe('PLAN');
    expect(result.proposal.confidence).toBe('HIGH');
    expect(result.proposal.semanticCapabilities).toEqual(['planning']);
    expect(result.modelProvider).toBe('provider-a');
    expect(result.modelId).toBe('model-a');
    expect(factory.options[0]?.toolNames).toEqual([]);
    expect(factory.options[0]?.customTools).toEqual([]);
    expect(factory.options[0]?.model).toEqual({ provider: 'provider-a', id: 'model-a' });
    expect(session.prompts[0]).toContain('<UNTRUSTED-REQUEST>');
    expect(session.beganDispose).toBe(1);
    expect(session.disposed).toBe(1);
  });

  test('preserves a structured no-action disposition without dispatching a workflow', async () => {
    const output = JSON.stringify({ family: 'RESEARCH', rawConfidence: 0.88, alternatives: [], disposition: 'DO_NOT_EXECUTE', evidence: ['The requested action is already satisfied.'] });
    const { classifier } = classifierFor(new FakeSemanticSession(output));
    const result = await classifier.classify(semanticInput('repeat completed work', 'session-2'));
    expect(result.disposition).toBe('DO_NOT_EXECUTE');
    expect(result.evidence).toEqual(['The requested action is already satisfied.']);
  });

  test('fails closed on invalid output and always aborts and disposes', async () => {
    const session = new FakeSemanticSession('{"family":"PLAN"}');
    const { classifier } = classifierFor(session);
    await expect(classifier.classify(semanticInput('plan', 'session-3'))).rejects.toMatchObject({ code: 'OUTPUT_INVALID' });
    expect(session.aborted).toBe(1);
    expect(session.beganDispose).toBe(1);
    expect(session.disposed).toBe(1);
  });

  test('rejects unapproved model fallback before prompting', async () => {
    const session = new FakeSemanticSession(validOutput);
    const { classifier } = classifierFor(session, 'fallback occurred');
    await expect(classifier.classify(semanticInput('plan', 'session-4'))).rejects.toMatchObject({ code: 'MODEL_FALLBACK' });
    expect(session.prompts).toEqual([]);
    expect(session.disposed).toBe(1);
  });

  test('blocks LOCAL_ONLY requests before model resolution or session creation', async () => {
    const session = new FakeSemanticSession(validOutput);
    const { classifier, factory } = classifierFor(session);
    await expect(classifier.classify({
      ...semanticInput('keep this local-only', 'session-local'),
      disclosureDecision: { ...allowedDisclosure, disclosureClass: 'LOCAL_ONLY', sensitiveSignalDetected: true, reasonCodes: ['LOCAL_ONLY_INSTRUCTION'] },
    })).rejects.toMatchObject({ code: 'DISCLOSURE_BLOCKED' });
    expect(factory.options).toEqual([]);
  });

  test('times out, aborts, and disposes a stalled classifier session', async () => {
    const session = new FakeSemanticSession(undefined, true);
    const { classifier } = classifierFor(session, undefined, 5);
    try {
      await classifier.classify(semanticInput('plan', 'session-5'));
      throw new Error('expected timeout');
    } catch (error) {
      expect(error).toBeInstanceOf(SemanticClassifierError);
      expect((error as SemanticClassifierError).code).toBe('TIMEOUT');
    }
    expect(session.aborted).toBe(1);
    expect(session.disposed).toBe(1);
  });
});

import { describe, expect, test } from 'bun:test';
import {
  DECISION_TRACE_STAGES,
  DISCLOSURE_CLASSES,
  PREDICTION_IDENTITIES,
  createDefaultRuntimeDisclosureClassifier,
  validateDecisionTrace,
  validateRuntimeDisclosureDecision,
  type DecisionTrace,
  type RuntimeDisclosureDecision,
} from '../src/intelligence.js';

const SECRET_LINE = 'api_key=sk-live-abcdef1234567890';

const classifier = createDefaultRuntimeDisclosureClassifier();

// ---------------------------------------------------------------------------
// Default classifier: all three disclosure classes
// ---------------------------------------------------------------------------

describe('createDefaultRuntimeDisclosureClassifier', () => {
  test('classifies an ordinary native request as INTERNAL_REDACTABLE', () => {
    const decision = classifier.classify({
      request: 'summarize the release notes for the last sprint',
      predictionIdentity: 'DETERMINISTIC_FIXTURE',
      explicitFleetRoute: false,
    });
    expect(decision.disclosureClass).toBe('INTERNAL_REDACTABLE');
    expect(decision.sensitiveSignalDetected).toBe(false);
    expect(decision.reasonCodes.length).toBeGreaterThan(0);
  });

  test('classifies an explicit fleet route with no sensitive signal as EXTERNAL_ALLOWED', () => {
    const decision = classifier.classify({
      request: 'draft a public changelog entry',
      predictionIdentity: 'DETERMINISTIC_FIXTURE',
      explicitFleetRoute: true,
    });
    expect(decision.disclosureClass).toBe('EXTERNAL_ALLOWED');
    expect(decision.sensitiveSignalDetected).toBe(false);
    expect(decision.explicitFleetRoute).toBe(true);
  });

  test('untrusted project policy blocks external disclosure eligibility', () => {
    const decision = classifier.classify({
      request: 'draft a public changelog entry',
      predictionIdentity: 'DETERMINISTIC_FIXTURE',
      explicitFleetRoute: true,
      projectTrustStatus: 'UNTRUSTED',
    });
    expect(decision.disclosureClass).toBe('LOCAL_ONLY');
    expect(decision.projectTrustStatus).toBe('UNTRUSTED');
    expect(decision.reasonCodes).toEqual(['PROJECT_OVERLAY_UNTRUSTED']);
  });

  test('explicit local-only instruction takes precedence over fleet intent', () => {
    const decision = classifier.classify({
      request: 'keep this confidential and local-only',
      predictionIdentity: 'DETERMINISTIC_FIXTURE',
      explicitFleetRoute: true,
    });
    expect(decision.disclosureClass).toBe('LOCAL_ONLY');
    expect(decision.reasonCodes).toEqual(['LOCAL_ONLY_INSTRUCTION']);
  });

  test('classifies a credential-bearing request as LOCAL_ONLY even without fleet intent', () => {
    const decision = classifier.classify({
      request: `deploy using this token\n${SECRET_LINE}`,
      predictionIdentity: 'DETERMINISTIC_FIXTURE',
      explicitFleetRoute: false,
    });
    expect(decision.disclosureClass).toBe('LOCAL_ONLY');
    expect(decision.sensitiveSignalDetected).toBe(true);
  });

  test('sensitive signal takes precedence over an explicit fleet route', () => {
    const decision = classifier.classify({
      request: `push this to the external fleet\n${SECRET_LINE}`,
      predictionIdentity: 'EXPLICIT_FAMILY',
      explicitFleetRoute: true,
    });
    expect(decision.disclosureClass).toBe('LOCAL_ONLY');
    expect(decision.sensitiveSignalDetected).toBe(true);
    expect(decision.explicitFleetRoute).toBe(true);
  });

  test('echoes the caller-supplied predictionIdentity for both identities', () => {
    for (const predictionIdentity of PREDICTION_IDENTITIES) {
      const decision = classifier.classify({ request: 'plain request', predictionIdentity, explicitFleetRoute: false });
      expect(decision.predictionIdentity).toBe(predictionIdentity);
    }
  });

  test('never retains the matched secret value anywhere on the decision', () => {
    const decision = classifier.classify({
      request: `here is the secret\n${SECRET_LINE}\nplease use it`,
      predictionIdentity: 'DETERMINISTIC_FIXTURE',
      explicitFleetRoute: false,
    });
    const serialized = JSON.stringify(decision);
    expect(serialized).not.toContain('sk-live-abcdef1234567890');
    expect(serialized).not.toContain(SECRET_LINE);
  });

  test('is a pure function: identical input yields identical output', () => {
    const input = { request: 'plan the rollout', predictionIdentity: 'DETERMINISTIC_FIXTURE' as const, explicitFleetRoute: false };
    expect(classifier.classify(input)).toEqual(classifier.classify(input));
  });
});

// ---------------------------------------------------------------------------
// validateRuntimeDisclosureDecision
// ---------------------------------------------------------------------------

const validDecision: RuntimeDisclosureDecision = {
  schemaVersion: '1.0',
  disclosureClass: 'INTERNAL_REDACTABLE',
  predictionIdentity: 'DETERMINISTIC_FIXTURE',
  sensitiveSignalDetected: false,
  explicitFleetRoute: false,
  projectTrustStatus: 'ABSENT',
  reasonCodes: ['DEFAULT_NATIVE_INTENT'],
};

describe('validateRuntimeDisclosureDecision', () => {
  test('accepts a valid decision for every disclosure class', () => {
    expect(validateRuntimeDisclosureDecision(validDecision).ok).toBe(true);
    expect(
      validateRuntimeDisclosureDecision({
        ...validDecision,
        disclosureClass: 'EXTERNAL_ALLOWED',
        explicitFleetRoute: true,
        reasonCodes: ['EXPLICIT_FLEET_ROUTE_NO_SENSITIVE_SIGNAL'],
      }).ok,
    ).toBe(true);
    expect(
      validateRuntimeDisclosureDecision({
        ...validDecision,
        disclosureClass: 'LOCAL_ONLY',
        sensitiveSignalDetected: true,
        reasonCodes: ['SENSITIVE_CONTENT_DETECTED'],
      }).ok,
    ).toBe(true);
  });

  test('rejects an unknown property', () => {
    const result = validateRuntimeDisclosureDecision({ ...validDecision, extra: true });
    expect(result.ok).toBe(false);
  });

  test('rejects an empty reasonCodes array', () => {
    const result = validateRuntimeDisclosureDecision({ ...validDecision, reasonCodes: [] });
    expect(result.ok).toBe(false);
  });

  test('rejects an invalid disclosureClass', () => {
    const result = validateRuntimeDisclosureDecision({ ...validDecision, disclosureClass: 'PUBLIC' });
    expect(result.ok).toBe(false);
  });

  test('rejects an invalid predictionIdentity', () => {
    const result = validateRuntimeDisclosureDecision({ ...validDecision, predictionIdentity: 'MODEL_INFERENCE' });
    expect(result.ok).toBe(false);
  });

  test('rejects a malformed schemaVersion', () => {
    const result = validateRuntimeDisclosureDecision({ ...validDecision, schemaVersion: '2.0' });
    expect(result.ok).toBe(false);
  });

  test('rejects a sensitive signal resolved to anything other than LOCAL_ONLY', () => {
    const result = validateRuntimeDisclosureDecision({ ...validDecision, sensitiveSignalDetected: true, disclosureClass: 'INTERNAL_REDACTABLE' });
    expect(result.ok).toBe(false);
  });

  test('rejects EXTERNAL_ALLOWED without an explicit fleet route', () => {
    const result = validateRuntimeDisclosureDecision({
      ...validDecision,
      disclosureClass: 'EXTERNAL_ALLOWED',
      explicitFleetRoute: false,
      reasonCodes: ['EXPLICIT_FLEET_ROUTE_NO_SENSITIVE_SIGNAL'],
    });
    expect(result.ok).toBe(false);
  });

  test('rejects EXTERNAL_ALLOWED alongside a detected sensitive signal', () => {
    const result = validateRuntimeDisclosureDecision({
      ...validDecision,
      disclosureClass: 'EXTERNAL_ALLOWED',
      explicitFleetRoute: true,
      sensitiveSignalDetected: true,
      reasonCodes: ['EXPLICIT_FLEET_ROUTE_NO_SENSITIVE_SIGNAL'],
    });
    expect(result.ok).toBe(false);
  });

  test('rejects EXTERNAL_ALLOWED for an untrusted project overlay', () => {
    const result = validateRuntimeDisclosureDecision({
      ...validDecision,
      disclosureClass: 'EXTERNAL_ALLOWED',
      explicitFleetRoute: true,
      projectTrustStatus: 'UNTRUSTED',
      reasonCodes: ['EXPLICIT_FLEET_ROUTE_NO_SENSITIVE_SIGNAL'],
    });
    expect(result.ok).toBe(false);
  });

  test('round-trips every disclosure class produced by the default classifier through the validator', () => {
    for (const explicitFleetRoute of [false, true]) {
      for (const request of ['plain request', `has secret\n${SECRET_LINE}`]) {
        const decision = classifier.classify({ request, predictionIdentity: 'DETERMINISTIC_FIXTURE', explicitFleetRoute });
        expect(validateRuntimeDisclosureDecision(decision).ok).toBe(true);
      }
    }
  });

  test('DISCLOSURE_CLASSES contains exactly the three documented classes', () => {
    expect([...DISCLOSURE_CLASSES].sort()).toEqual(['EXTERNAL_ALLOWED', 'INTERNAL_REDACTABLE', 'LOCAL_ONLY']);
  });
});

// ---------------------------------------------------------------------------
// validateDecisionTrace
// ---------------------------------------------------------------------------

const validTrace: DecisionTrace = {
  schemaVersion: '1.0',
  entries: [
    { stage: 'CLASSIFICATION', summary: 'Classified as IMPLEMENT via the deterministic fixture classifier.', reasonCodes: ['CLASSIFIED_IMPLEMENT'] },
    { stage: 'DISCLOSURE', summary: 'No sensitive signal detected; no explicit fleet route.', reasonCodes: ['DEFAULT_NATIVE_INTENT'] },
    {
      stage: 'POLICY',
      summary: 'Applied default policy pack.',
      reasonCodes: ['POLICY_APPLIED'],
      policyRefs: ['default@1:workflow.contracts'],
    },
  ],
};

describe('validateDecisionTrace', () => {
  test('accepts a valid, ordered, partial trace', () => {
    expect(validateDecisionTrace(validTrace).ok).toBe(true);
  });

  test('accepts a trace containing every stage in order', () => {
    const entries = DECISION_TRACE_STAGES.map((stage) => ({ stage, summary: `Recorded ${stage}.`, reasonCodes: ['RECORDED'] }));
    expect(validateDecisionTrace({ schemaVersion: '1.0', entries }).ok).toBe(true);
  });

  test('rejects an unknown top-level property', () => {
    expect(validateDecisionTrace({ ...validTrace, extra: 1 }).ok).toBe(false);
  });

  test('rejects an unknown entry property', () => {
    const bad = { schemaVersion: '1.0', entries: [{ ...validTrace.entries[0], extra: 1 }] };
    expect(validateDecisionTrace(bad).ok).toBe(false);
  });

  test('rejects an empty entries array', () => {
    expect(validateDecisionTrace({ schemaVersion: '1.0', entries: [] }).ok).toBe(false);
  });

  test('rejects an entry with an empty reasonCodes array', () => {
    const bad = { schemaVersion: '1.0', entries: [{ stage: 'CLASSIFICATION', summary: 'x', reasonCodes: [] }] };
    expect(validateDecisionTrace(bad).ok).toBe(false);
  });

  test('rejects an invalid stage value', () => {
    const bad = { schemaVersion: '1.0', entries: [{ stage: 'INFERENCE', summary: 'x', reasonCodes: ['X'] }] };
    expect(validateDecisionTrace(bad).ok).toBe(false);
  });

  test('rejects a malformed schemaVersion', () => {
    expect(validateDecisionTrace({ ...validTrace, schemaVersion: '1' }).ok).toBe(false);
  });

  test('rejects a repeated stage', () => {
    const bad = {
      schemaVersion: '1.0',
      entries: [
        { stage: 'CLASSIFICATION', summary: 'first', reasonCodes: ['A'] },
        { stage: 'CLASSIFICATION', summary: 'second', reasonCodes: ['B'] },
      ],
    };
    expect(validateDecisionTrace(bad).ok).toBe(false);
  });

  test('rejects entries out of the fixed compiler-sequence order', () => {
    const bad = {
      schemaVersion: '1.0',
      entries: [
        { stage: 'POLICY', summary: 'policy first', reasonCodes: ['A'] },
        { stage: 'CLASSIFICATION', summary: 'classification second', reasonCodes: ['B'] },
      ],
    };
    expect(validateDecisionTrace(bad).ok).toBe(false);
  });

  test('rejects a credential-bearing entry summary', () => {
    const bad = {
      schemaVersion: '1.0',
      entries: [{ stage: 'DISCLOSURE', summary: `matched line: ${SECRET_LINE}`, reasonCodes: ['SENSITIVE_CONTENT_DETECTED'] }],
    };
    expect(validateDecisionTrace(bad).ok).toBe(false);
  });

  test('rejects an entry with an empty summary', () => {
    const bad = { schemaVersion: '1.0', entries: [{ stage: 'CLASSIFICATION', summary: '   ', reasonCodes: ['A'] }] };
    expect(validateDecisionTrace(bad).ok).toBe(false);
  });
});

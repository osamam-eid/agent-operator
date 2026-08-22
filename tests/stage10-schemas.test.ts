import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const schemaDir = join(import.meta.dir, '..', 'schemas');

/** Minimal JSON-Schema-subset document shape covering exactly the draft-2020-12
 * keywords the six evaluator schemas use. */
interface JsonSchema {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly additionalProperties?: false;
  readonly allOf?: readonly {
    readonly if?: { readonly properties?: Readonly<Record<string, { readonly const?: unknown }>>; readonly required?: readonly string[] };
    readonly then?: JsonSchema;
  }[];
  readonly anyOf?: readonly JsonSchema[];
  readonly not?: JsonSchema;
}

function load(name: string): JsonSchema {
  return JSON.parse(readFileSync(join(schemaDir, name), 'utf8')) as JsonSchema;
}

/** Dependency-free subset validator: returns a list of human-readable errors
 * (empty list = valid). Supports the keyword surface defined by JsonSchema. */
function validate(instance: unknown, schema: JsonSchema): string[] {
  const errors: string[] = [];
  walk(instance, schema, '$');
  return errors;

  function matchesCondition(record: Record<string, unknown>, condition: NonNullable<JsonSchema['allOf']>[number]['if']): boolean {
    if (condition === undefined) return true;
    for (const key of condition.required ?? []) {
      if (!(key in record)) return false;
    }
    for (const [key, sub] of Object.entries(condition.properties ?? {})) {
      if (!(key in record)) return false;
      if (sub.const !== undefined && record[key] !== sub.const) return false;
    }
    return true;
  }

  function walk(value: unknown, s: JsonSchema, path: string): void {
    if (s.anyOf !== undefined && !s.anyOf.some((branch) => validate(value, branch).length === 0)) {
      errors.push(`${path}: does not match any of the anyOf branches`);
    }
    if (s.not !== undefined && validate(value, s.not).length === 0) {
      errors.push(`${path}: matches the forbidden "not" schema`);
    }
    if (s.type !== undefined) {
      const actual = Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
      const ok = s.type === 'number' ? ['integer', 'number'].includes(actual) : actual === s.type || (s.type === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value));
      if (!ok) {
        errors.push(`${path}: expected type ${s.type}, got ${actual}`);
        return;
      }
    }
    if (s.const !== undefined && value !== s.const) errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
    if (s.enum !== undefined && !s.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(s.enum)}`);
    if (typeof value === 'string') {
      if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) errors.push(`${path}: does not match ${s.pattern}`);
      if (s.minLength !== undefined && value.length < s.minLength) errors.push(`${path}: shorter than minLength`);
      if (s.maxLength !== undefined && value.length > s.maxLength) errors.push(`${path}: longer than maxLength`);
    }
    if (typeof value === 'number') {
      if (s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below minimum`);
      if (s.maximum !== undefined && value > s.maximum) errors.push(`${path}: above maximum`);
    }
    if (Array.isArray(value)) {
      if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: fewer than minItems`);
      if (s.uniqueItems === true && new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length) errors.push(`${path}: duplicate items`);
      const items = s.items;
      if (items !== undefined) value.forEach((entry, index) => walk(entry, items, `${path}[${index}]`));
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>; // structural object already narrowed by typeof/array checks
      for (const key of s.required ?? []) {
        if (!(key in record)) errors.push(`${path}: missing required property "${key}"`);
      }
      if (s.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (s.properties === undefined || !(key in s.properties)) errors.push(`${path}: additional property "${key}" is not allowed`);
        }
      }
      for (const [key, subschema] of Object.entries(s.properties ?? {})) {
        if (key in record) walk(record[key], subschema, `${path}.${key}`);
      }
      for (const branch of s.allOf ?? []) {
        if (matchesCondition(record, branch.if) && branch.then !== undefined) walk(value, branch.then, path);
      }
    }
  }
}

function evalCaseFixture(disclosure: 'LOCAL_ONLY' | 'EXTERNAL_REPLAY_APPROVED'): Record<string, unknown> {
  const base: Record<string, unknown> = {
    caseId: 'case-s1', sourceSessionId: 's1', originalRequest: 'run the checks',
    observed: {
      requestClassification: 'QA', riskClassification: 'LOW', selectedWorkflow: 'qa.v2',
      requiredGates: ['RESULT_APPROVAL'],
      nodeSummaries: [{ nodeId: 'n1', summary: 'done' }],
      humanOverrideSignals: [],
    },
    disclosure,
  };
  if (disclosure === 'EXTERNAL_REPLAY_APPROVED') {
    base.approvedBy = 'operator';
    base.approvedAt = '2026-08-21T00:00:00.000Z';
  }
  return base;
}

describe('Stage-10 finalization: schema/contract alignment', () => {
  test('eval-case accepts contract fixtures and rejects disclosure violations', () => {
    const schema = load('operator-eval-case.v1.json');
    expect(validate(evalCaseFixture('LOCAL_ONLY'), schema)).toEqual([]);
    expect(validate(evalCaseFixture('EXTERNAL_REPLAY_APPROVED'), schema)).toEqual([]);
    const missingApproval = evalCaseFixture('EXTERNAL_REPLAY_APPROVED') as Record<string, unknown>;
    delete missingApproval.approvedBy;
    expect(validate(missingApproval, schema).length).toBeGreaterThan(0);
    const localWithApprover = evalCaseFixture('LOCAL_ONLY') as Record<string, unknown>;
    localWithApprover.approvedBy = 'operator';
    expect(validate(localWithApprover, schema).length).toBeGreaterThan(0);
    const badDisclosure = evalCaseFixture('LOCAL_ONLY') as Record<string, unknown>;
    badDisclosure.disclosure = 'MACHINE_WIDE';
    expect(validate(badDisclosure, schema).some((error) => error.includes('MACHINE_WIDE'))).toBe(true);
    const missingRequired = evalCaseFixture('LOCAL_ONLY') as Record<string, unknown>;
    delete missingRequired.originalRequest;
    expect(validate(missingRequired, schema).some((error) => error.includes('originalRequest'))).toBe(true);
    const extra = evalCaseFixture('LOCAL_ONLY') as Record<string, unknown>;
    extra.chainOfThought = 'internal reasoning';
    expect(validate(extra, schema).some((error) => error.includes('chainOfThought'))).toBe(true);
  });

  test('corpus schema enforces partition enum, hex hashes, and integer revision', () => {
    const schema = load('operator-eval-corpus.v1.json');
    const valid = {
      corpusId: 'corpus-a', revision: 1, createdAt: '2026-08-21T00:00:00.000Z',
      cases: [
        { caseId: 'case-0', disclosure: 'LOCAL_ONLY', partition: 'TRAIN' },
        { caseId: 'case-1', disclosure: 'EXTERNAL_REPLAY_APPROVED', partition: 'HELD_OUT' },
      ],
      trainManifestHash: 'a'.repeat(64),
      heldOutManifestHash: 'b'.repeat(64),
    };
    expect(validate(valid, schema)).toEqual([]);
    const badPartition = structuredClone(valid);
    (badPartition.cases as { partition: string }[])[0]!.partition = 'TRAIN_DEV';
    expect(validate(badPartition, schema).length).toBeGreaterThan(0);
    const badHash = structuredClone(valid);
    (badHash as { trainManifestHash: string }).trainManifestHash = 'nothex'; // test-fixture mutation of a locally constructed literal
    expect(validate(badHash, schema).length).toBeGreaterThan(0);
  });

  test('candidate schema pins baseVersion and component status enum', () => {
    const schema = load('operator-candidate.v1.json');
    const valid = { candidateId: 'cand-1', baseVersion: 'stage9-sealed', baseDigest: 'c'.repeat(64), createdAt: 'now', components: [{ component: 'classifier', status: 'CHANGED' }] };
    expect(validate(valid, schema)).toEqual([]);
    const wrongBase = { ...valid, baseVersion: 'stage8-sealed' };
    expect(validate(wrongBase, schema).length).toBeGreaterThan(0);
    const badStatus = structuredClone(valid);
    (badStatus.components as { status: string }[])[0]!.status = 'DELETED';
    expect(validate(badStatus, schema).length).toBeGreaterThan(0);
  });

  test('eval-run validates budget shape and per-case status enum', () => {
    const schema = load('operator-eval-run.v1.json');
    const run = {
      runId: 'run-1', corpusId: 'corpus-a', corpusRevision: 1,
      baselineDigest: 'd'.repeat(64), featureSetHash: 'e'.repeat(64),
      budget: { maxCases: 5, maxReplaysPerCase: 1, maxProviderTier: 'HIGH', maxTokensPerCase: 1000, maxTotalCostUsd: 2, maxWallClockMs: 60000, maxConcurrency: 2 },
      startedAt: 'now',
      perCase: [{ caseId: 'case-0', replays: 1, status: 'DONE' }],
      budgetExhausted: false,
    };
    expect(validate(run, schema)).toEqual([]);
    const exhausted = structuredClone(run);
    (exhausted.perCase as { status: string }[])[0]!.status = 'SKIPPED_FOREVER';
    expect(validate(exhausted, schema).length).toBeGreaterThan(0);
    const noBudget: Record<string, unknown> = structuredClone(exhausted);
    delete noBudget.budget;
    expect(validate(noBudget, schema).some((error) => error.includes('budget'))).toBe(true);
  });

  test('comparison and promotion-decision pin verdict enums and promotedBySystem=false', () => {
    const comparisonSchema = load('operator-comparison.v1.json');
    const comparison = { runId: 'r1', verdict: 'PROMOTE_RECOMMENDED', baselineTotal: 4, candidateTotal: 6, regressions: [], hardFailures: [], scoredCases: 2 };
    expect(validate(comparison, comparisonSchema)).toEqual([]);
    const badVerdict = { ...comparison, verdict: 'AUTO_PROMOTE' };
    expect(validate(badVerdict, comparisonSchema).length).toBeGreaterThan(0);
    const promotionSchema = load('operator-promotion-decision.v1.json');
    const decision = { comparisonRunId: 'r1', recommendation: 'PROMOTE_RECOMMENDED', promotedBySystem: false, evidencePackagePath: '/tmp/pkg' };
    expect(validate(decision, promotionSchema)).toEqual([]);
    const selfPromoted = { ...decision, promotedBySystem: true };
    expect(validate(selfPromoted, promotionSchema).length).toBeGreaterThan(0);
  });
});

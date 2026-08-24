/**
 * Agent Operator — WP12 shared intelligence contracts: runtime disclosure
 * classification and the compiler decision trace.
 *
 * Deliberately minimal: this module has no dependency on any model call,
 * dashboard, or online-learning state. It reuses the existing
 * credential-bearing pattern (src/stage7/qa/evidence.ts) as the sole
 * sensitive-content signal, and every export here is a pure, synchronous,
 * side-effect-free type, constant, classifier factory, or validator.
 *
 * The real compiler (src/compiler.ts) is responsible for calling
 * `RuntimeDisclosureClassifier.classify()` after resolving config/trust but
 * before selecting fleet/provider capabilities, for gating fleet
 * compilation on `disclosureClass === 'EXTERNAL_ALLOWED'`, and for
 * assembling the single `DecisionTrace` from its actual decisions. No
 * second compiler or explanation planner is permitted to exist alongside
 * this one.
 */

import { SECRET_PATTERN } from './stage7/qa/evidence.js';
import {
  type Ctx,
  type Path,
  type ValidationResult,
  MAX_MEDIUM_TEXT,
  MAX_SHORT_TEXT,
  REASON_CODE_PATTERN,
  checkObjectShape,
  finalize,
  hasOwn,
  newCtx,
  pushErr,
  requireArray,
  requireBoolean,
  requireEnum,
  requireExactString,
  requireHumanText,
  requirePolicyRefsArray,
  requireStringArray,
} from './validation/primitives.js';

// ---------------------------------------------------------------------------
// Disclosure classes and prediction identity
// ---------------------------------------------------------------------------

/** Disclosure eligibility class for a compiled request. `LOCAL_ONLY` never
 * leaves the local compiler; `INTERNAL_REDACTABLE` may reach configured
 * native (`omp-role`) capabilities; only `EXTERNAL_ALLOWED` may reach
 * external-CLI/fleet capabilities. */
export type DisclosureClass = 'LOCAL_ONLY' | 'INTERNAL_REDACTABLE' | 'EXTERNAL_ALLOWED';

export const DISCLOSURE_CLASSES: readonly DisclosureClass[] = ['LOCAL_ONLY', 'INTERNAL_REDACTABLE', 'EXTERNAL_ALLOWED'];

/** Identity of whatever produced the request's task-family classification
 * that this disclosure decision rides alongside: the Stage 3 deterministic
 * fixture classifier, or an explicit `--family` override supplied by the
 * caller. Carried on the decision purely as audit metadata for `/operator
 * why`; it does not itself affect disclosure logic. */
export type PredictionIdentity = 'DETERMINISTIC_FIXTURE' | 'EXPLICIT_FAMILY';

export const PREDICTION_IDENTITIES: readonly PredictionIdentity[] = ['DETERMINISTIC_FIXTURE', 'EXPLICIT_FAMILY'];

// ---------------------------------------------------------------------------
// Runtime disclosure classifier
// ---------------------------------------------------------------------------

export interface DisclosureClassifierInput {
  readonly request: string;
  readonly predictionIdentity: PredictionIdentity;
  /** Set only by explicit fleet invocation, mirroring
   * `WorkflowCompilerContext.fleetRoute === true`; never inferred from
   * classification. */
  readonly explicitFleetRoute: boolean;
  /** Resolved project-overlay trust. Omitted callers are treated as ABSENT. */
  readonly projectTrustStatus?: 'ABSENT' | 'TRUSTED' | 'UNTRUSTED';
}

export interface RuntimeDisclosureDecision {
  readonly schemaVersion: '1.0';
  readonly disclosureClass: DisclosureClass;
  readonly predictionIdentity: PredictionIdentity;
  /** Whether any line of `request` matched the credential-bearing pattern.
   * The matched text itself is never retained on this decision or anywhere
   * else this module touches. */
  readonly sensitiveSignalDetected: boolean;
  readonly explicitFleetRoute: boolean;
  readonly projectTrustStatus: 'ABSENT' | 'TRUSTED' | 'UNTRUSTED';
  readonly reasonCodes: readonly string[];
}

export interface RuntimeDisclosureClassifier {
  classify(input: DisclosureClassifierInput): RuntimeDisclosureDecision;
}

const REASON_SENSITIVE_SIGNAL = 'SENSITIVE_CONTENT_DETECTED';
const LOCAL_ONLY_INSTRUCTION = /\b(?:local[- ]only|do not share|do not disclose|confidential|private data|internal only)\b/i;
const REASON_FLEET_ROUTE_ALLOWED = 'EXPLICIT_FLEET_ROUTE_NO_SENSITIVE_SIGNAL';
const REASON_DEFAULT_INTERNAL = 'DEFAULT_NATIVE_INTENT';
const REASON_UNTRUSTED_PROJECT = 'PROJECT_OVERLAY_UNTRUSTED';

/**
 * The default deterministic disclosure classifier (plan "Disclosure
 * classes"): a detected sensitive signal always forces `LOCAL_ONLY`
 * regardless of fleet intent (sensitivity takes precedence over an explicit
 * fleet route); an explicit fleet route with no sensitive signal allows
 * `EXTERNAL_ALLOWED`; every other native request remains
 * `INTERNAL_REDACTABLE`. No semantic model, provider competence, or
 * calibration is consulted — this is the only disclosure classifier this
 * increment defines.
 */
export function createDefaultRuntimeDisclosureClassifier(): RuntimeDisclosureClassifier {
  return {
    classify(input: DisclosureClassifierInput): RuntimeDisclosureDecision {
      // Scanned per line (mirrors scrub()/scanForSecrets() in
      // adapters/external-cli.ts and evaluator/engine.ts) so one
      // credential-bearing line inside an otherwise clean multi-line
      // request still trips LOCAL_ONLY. Only this boolean is ever kept —
      // the matched substring is discarded immediately.
      const credentialSignalDetected = input.request.split('\n').some((line) => SECRET_PATTERN.test(line));
      const localOnlyInstructionDetected = LOCAL_ONLY_INSTRUCTION.test(input.request);
      const sensitiveSignalDetected = credentialSignalDetected || localOnlyInstructionDetected;
      const projectTrustStatus = input.projectTrustStatus ?? 'ABSENT';
      let disclosureClass: DisclosureClass;
      let reasonCodes: readonly string[];
      if (sensitiveSignalDetected) {
        disclosureClass = 'LOCAL_ONLY';
        reasonCodes = [credentialSignalDetected ? REASON_SENSITIVE_SIGNAL : 'LOCAL_ONLY_INSTRUCTION'];
      } else if (projectTrustStatus === 'UNTRUSTED') {
        disclosureClass = 'LOCAL_ONLY';
        reasonCodes = [REASON_UNTRUSTED_PROJECT];
      } else if (input.explicitFleetRoute) {
        disclosureClass = 'EXTERNAL_ALLOWED';
        reasonCodes = [REASON_FLEET_ROUTE_ALLOWED];
      } else {
        disclosureClass = 'INTERNAL_REDACTABLE';
        reasonCodes = [REASON_DEFAULT_INTERNAL];
      }
      return {
        schemaVersion: '1.0',
        disclosureClass,
        predictionIdentity: input.predictionIdentity,
        sensitiveSignalDetected,
        explicitFleetRoute: input.explicitFleetRoute,
        projectTrustStatus,
        reasonCodes,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Decision trace
// ---------------------------------------------------------------------------

/** Named stage of the real compiler sequence (plan "Compiler sequence"),
 * enumerated in the fixed order the compiler executes them. A `DecisionTrace`
 * need not contain every stage (compilation may stop early), but any stages
 * it does contain must appear at most once and in this relative order. */
export type DecisionTraceStage =
  | 'CLASSIFICATION'
  | 'PROJECT_TRUST'
  | 'DISCLOSURE'
  | 'POLICY'
  | 'WORKFLOW_SELECTION'
  | 'CAPABILITY_SELECTION'
  | 'GRAPH_COMPILATION';

export const DECISION_TRACE_STAGES: readonly DecisionTraceStage[] = [
  'CLASSIFICATION',
  'PROJECT_TRUST',
  'DISCLOSURE',
  'POLICY',
  'WORKFLOW_SELECTION',
  'CAPABILITY_SELECTION',
  'GRAPH_COMPILATION',
];

export interface DecisionTraceEntry {
  readonly stage: DecisionTraceStage;
  readonly summary: string;
  readonly reasonCodes: readonly string[];
  readonly policyRefs?: readonly string[];
}

export interface DecisionTrace {
  readonly schemaVersion: '1.0';
  readonly entries: readonly DecisionTraceEntry[];
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const RUNTIME_DISCLOSURE_DECISION_KEYS = [
  'schemaVersion',
  'disclosureClass',
  'predictionIdentity',
  'sensitiveSignalDetected',
  'explicitFleetRoute',
  'projectTrustStatus',
  'reasonCodes',
] as const;

/** Strict validator for one `RuntimeDisclosureDecision`. Rejects unknown
 * properties, an empty `reasonCodes` array, an invalid `disclosureClass` or
 * `predictionIdentity`, a malformed `schemaVersion`, and the two
 * disclosure/fleet cross-field violations that would otherwise let a
 * sensitive request or an implicit (non-explicit-fleet) request resolve to
 * external eligibility. */
export function validateRuntimeDisclosureDecision(input: unknown): ValidationResult<RuntimeDisclosureDecision> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, RUNTIME_DISCLOSURE_DECISION_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  if (raw.schemaVersion !== '1.0') {
    pushErr(ctx, ['schemaVersion'], 'must be exactly "1.0"');
  }
  const disclosureClass = requireEnum(ctx, ['disclosureClass'], raw.disclosureClass, DISCLOSURE_CLASSES);
  const predictionIdentity = requireEnum(ctx, ['predictionIdentity'], raw.predictionIdentity, PREDICTION_IDENTITIES);
  const sensitiveSignalDetected = requireBoolean(ctx, ['sensitiveSignalDetected'], raw.sensitiveSignalDetected);
  const explicitFleetRoute = requireBoolean(ctx, ['explicitFleetRoute'], raw.explicitFleetRoute);
  const projectTrustStatus = requireEnum(ctx, ['projectTrustStatus'], raw.projectTrustStatus, ['ABSENT', 'TRUSTED', 'UNTRUSTED'] as const);
  const reasonCodes = requireStringArray(ctx, ['reasonCodes'], raw.reasonCodes, {
    minItems: 1,
    itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }),
  });

  if (
    raw.schemaVersion !== '1.0' ||
    disclosureClass === undefined ||
    predictionIdentity === undefined ||
    sensitiveSignalDetected === undefined ||
    explicitFleetRoute === undefined ||
    projectTrustStatus === undefined ||
    reasonCodes === undefined
  ) return finalize(ctx, out);

  // Cross-field: a detected sensitive signal must never resolve to
  // anything but LOCAL_ONLY, and EXTERNAL_ALLOWED requires both an
  // explicit fleet route and the absence of a sensitive signal.
  if (sensitiveSignalDetected && disclosureClass !== 'LOCAL_ONLY') {
    pushErr(ctx, ['disclosureClass'], 'must be "LOCAL_ONLY" when sensitiveSignalDetected is true');
  }
  if (disclosureClass === 'EXTERNAL_ALLOWED' && (sensitiveSignalDetected || !explicitFleetRoute)) {
    pushErr(ctx, ['disclosureClass'], 'must not be "EXTERNAL_ALLOWED" unless explicitFleetRoute is true and sensitiveSignalDetected is false');
  }
  if (disclosureClass === 'EXTERNAL_ALLOWED' && projectTrustStatus === 'UNTRUSTED') {
    pushErr(ctx, ['disclosureClass'], 'must not be "EXTERNAL_ALLOWED" for an untrusted project overlay');
  }
  if (ctx.errors.length > 0) return finalize(ctx, out);

  out.schemaVersion = '1.0';
  out.disclosureClass = disclosureClass;
  out.predictionIdentity = predictionIdentity;
  out.sensitiveSignalDetected = sensitiveSignalDetected;
  out.explicitFleetRoute = explicitFleetRoute;
  out.projectTrustStatus = projectTrustStatus;
  out.reasonCodes = reasonCodes;

  return finalize<RuntimeDisclosureDecision>(ctx, out);
}

const DECISION_TRACE_ENTRY_KEYS = ['stage', 'summary', 'reasonCodes', 'policyRefs'] as const;

function validateDecisionTraceEntry(ctx: Ctx, path: Path, value: unknown): DecisionTraceEntry | undefined {
  const raw = checkObjectShape(ctx, path, value, DECISION_TRACE_ENTRY_KEYS);
  if (!raw) return undefined;

  const stage = requireEnum(ctx, [...path, 'stage'], raw.stage, DECISION_TRACE_STAGES);
  const summary = requireHumanText(ctx, [...path, 'summary'], raw.summary, { maxLen: MAX_MEDIUM_TEXT });
  const reasonCodes = requireStringArray(ctx, [...path, 'reasonCodes'], raw.reasonCodes, {
    minItems: 1,
    itemValidator: (c, p, v) => requireExactString(c, p, v, { maxLen: MAX_SHORT_TEXT, pattern: REASON_CODE_PATTERN }),
  });
  let policyRefs: string[] | undefined;
  if (hasOwn(raw, 'policyRefs')) policyRefs = requirePolicyRefsArray(ctx, [...path, 'policyRefs'], raw.policyRefs);

  if (stage === undefined || summary === undefined || reasonCodes === undefined) return undefined;
  if (hasOwn(raw, 'policyRefs') && policyRefs === undefined) return undefined;

  // A stored trace entry must never carry a credential-bearing summary,
  // even though reasonCodes/policyRefs already reject that shape by
  // pattern alone.
  if (SECRET_PATTERN.test(summary)) {
    pushErr(ctx, [...path, 'summary'], 'must not contain a credential-bearing pattern');
    return undefined;
  }

  return policyRefs !== undefined ? { stage, summary, reasonCodes, policyRefs } : { stage, summary, reasonCodes };
}

const DECISION_TRACE_KEYS = ['schemaVersion', 'entries'] as const;

/** Strict validator for one `DecisionTrace`. Rejects unknown properties, an
 * empty `entries` array, any invalid entry (invalid `stage`, empty
 * `reasonCodes`, or a credential-bearing `summary`), a malformed
 * `schemaVersion`, and entries that repeat a stage or appear out of the
 * fixed `DECISION_TRACE_STAGES` compiler-sequence order. */
export function validateDecisionTrace(input: unknown): ValidationResult<DecisionTrace> {
  const ctx = newCtx();
  const raw = checkObjectShape(ctx, [], input, DECISION_TRACE_KEYS);
  const out: Record<string, unknown> = {};
  if (!raw) return finalize(ctx, out);

  if (raw.schemaVersion !== '1.0') {
    pushErr(ctx, ['schemaVersion'], 'must be exactly "1.0"');
  }

  let entries: DecisionTraceEntry[] | undefined;
  const rawEntries = requireArray(ctx, ['entries'], raw.entries, { minItems: 1 });
  if (rawEntries) {
    const items = rawEntries.map((v, i) => validateDecisionTraceEntry(ctx, ['entries', i], v));
    if (items.every((v): v is DecisionTraceEntry => v !== undefined)) entries = items;
  }

  if (raw.schemaVersion !== '1.0' || entries === undefined) return finalize(ctx, out);

  // Cross-field: each stage appears at most once, and present stages
  // appear in the fixed compiler-sequence order.
  const seenIndexes: number[] = [];
  for (const entry of entries) {
    const idx = DECISION_TRACE_STAGES.indexOf(entry.stage);
    if (seenIndexes.includes(idx)) {
      pushErr(ctx, ['entries'], `stage "${entry.stage}" must not repeat`);
      return finalize(ctx, out);
    }
    const last = seenIndexes[seenIndexes.length - 1];
    if (last !== undefined && idx < last) {
      pushErr(ctx, ['entries'], `stage "${entry.stage}" is out of the fixed compiler-sequence order`);
      return finalize(ctx, out);
    }
    seenIndexes.push(idx);
  }

  out.schemaVersion = '1.0';
  out.entries = entries;
  return finalize<DecisionTrace>(ctx, out);
}

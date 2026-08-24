/**
 * Agent Operator — Stage 2 `/operator` V1 command parser.
 *
 * Parses exactly the Stage 2 V1 command subset from the raw text following
 * `/operator `. Deterministic: the same input always parses to the same
 * output, and every missing/extra/ambiguous argument is rejected with a
 * `OperatorParseError` rather than silently falling back to a different
 * command shape.
 *
 * No I/O, no clock, no ids: pure string -> command mapping only.
 */

import type { TaskFamily } from './contracts.js';
import type { OperatorCommand } from './runtime-types.js';

/** Returned by `parseOperatorCommand` when `rawArgs` does not match the V1
 * command grammar. The caller (the runtime controller) is responsible for
 * mapping this to an `OperatorCommandOutcome` with `errorCode:
 * 'INVALID_COMMAND'`. */
export interface OperatorParseError {
  readonly kind: 'PARSE_ERROR';
  readonly message: string;
}

export type OperatorParseResult = OperatorCommand | OperatorParseError;

/** Bare keywords that take no further arguments. */
const RESERVED_BARE_COMMANDS: Record<string, true> = {
  explain: true,
  why: true,
  status: true,
  graph: true,
  continue: true,
  cancel: true,
};

/** Keywords that require exactly one further argument token. */
const RESERVED_ARG_COMMANDS: Record<string, true> = { approve: true, reject: true, resume: true };

/** Stage-10 evaluator namespace: `improve <subcommand> [args…]`. The
 * subcommand and args are passed through verbatim to the injected evaluator
 * handler; unknown subcommands fail closed inside the evaluator service. */
const RESERVED_EVALUATOR_COMMANDS: Record<string, true> = { improve: true };

/** Matches the `ID_PATTERN` enforced by the Stage 1 validators for gate ids
 * and operator session ids, so a malformed id is rejected at parse time
 * rather than surfacing a confusing downstream `GATE_NOT_FOUND` /
 * `SESSION_NOT_FOUND`. */
const ID_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type FamilyOverride = Exclude<TaskFamily, 'DIRECT'>;
const FAMILY_OVERRIDES: Readonly<Record<FamilyOverride, true>> = {
  RESEARCH: true,
  PLAN: true,
  IMPLEMENT: true,
  REVIEW: true,
  UI: true,
  QA: true,
  SECURITY: true,
  OPERATIONS: true,
};

function parseRequest(tokens: readonly string[], offset: number, usage: string): { readonly request: string; readonly familyOverride?: FamilyOverride } | OperatorParseError {
  let cursor = offset;
  let familyOverride: FamilyOverride | undefined;
  let fleetRoute = false;
  while (cursor < tokens.length) {
    if (tokens[cursor] === '--fleet') {
      if (fleetRoute) return { kind: 'PARSE_ERROR', message: '"--fleet" may be specified only once.' };
      fleetRoute = true;
      cursor += 1;
      continue;
    }
    if (tokens[cursor] === '--family') {
      if (familyOverride !== undefined) return { kind: 'PARSE_ERROR', message: '"--family" may be specified only once.' };
      const rawFamily = tokens[cursor + 1];
      if (rawFamily === undefined || FAMILY_OVERRIDES[rawFamily as FamilyOverride] !== true) {
        return { kind: 'PARSE_ERROR', message: `"--family" requires one of: ${Object.keys(FAMILY_OVERRIDES).join(', ')}.` };
      }
      familyOverride = rawFamily as FamilyOverride;
      cursor += 2;
      continue;
    }
    break;
  }
  const task = tokens.slice(cursor).join(' ').trim();
  if (task.length === 0) return { kind: 'PARSE_ERROR', message: `${usage} requires a non-empty request.` };
  const request = fleetRoute ? `--fleet ${task}` : task;
  return familyOverride === undefined ? { request } : { request, familyOverride };
}

export function parseOperatorCommand(rawArgs: string): OperatorParseResult {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'PARSE_ERROR',
      message:
        'missing command or request. Provide a request, simulate <request>, --dry-run <request>, --explain <request>, or an inspection/session command.',
    };
  }

  const tokens = trimmed.split(/\s+/);
  const first = tokens[0];
  if (first === undefined) {
    return {
      kind: 'PARSE_ERROR',
      message: [
        'Agent Operator — available commands:',
        '  <request>                      start a governed workflow session',
        '  simulate <request>             compile and preflight without state or dispatch',
        '  --dry-run <request>            alias for simulate',
        '  --explain <request>            routing explanation only',
        '  --family <FAMILY> <request>    start with an explicit task family',
        '  status | graph | why | explain show session / graph / routing detail',
        '  shadow on|off|status|evaluate  semantic comparison without route influence',
        '  competence status|show          inspect evidence-derived scorecards',
        '  policy test --proposed <path>  compare policy without applying it',
        '  canary run <provider> [model]  run bounded read-only qualification cases',
        '  continue | cancel              drive the active session',
        '  approve <gate-id> | reject <gate-id>',
        '  resume <operator-session-id>   reload a persisted session',
        '  improve status | harvest | corpus | evaluate | candidate verify | compare | generate',
        '',
        'Example: /operator plan the migration approach',
      ].join('\n'),
    };
  }

  if (first === '--explain') {
    const parsed = parseRequest(tokens, 1, '--explain');
    if ('kind' in parsed) return parsed;
    return { kind: 'START', mode: 'EXPLAIN', ...parsed };
  }

  if (first === '--dry-run' || first === 'simulate') {
    const parsed = parseRequest(tokens, 1, first);
    if ('kind' in parsed) return parsed;
    return { kind: 'SIMULATE', ...parsed };
  }

  if (first === 'shadow') {
    const subcommand = tokens[1];
    if (subcommand === 'on' || subcommand === 'off' || subcommand === 'status') {
      if (tokens.length !== 2) return { kind: 'PARSE_ERROR', message: `"shadow ${subcommand}" takes no additional arguments.` };
      return { kind: 'SHADOW', subcommand: subcommand.toUpperCase() as 'ON' | 'OFF' | 'STATUS' };
    }
    if (subcommand === 'evaluate') {
      const parsed = parseRequest(tokens, 2, 'shadow evaluate');
      if ('kind' in parsed) return parsed;
      return { kind: 'SHADOW', subcommand: 'EVALUATE', ...parsed };
    }
    return { kind: 'PARSE_ERROR', message: '"shadow" requires one of: on, off, status, evaluate <request>.' };
  }

  if (first === 'competence') {
    const subcommand = tokens[1];
    if (subcommand === 'status' && tokens.length === 2) return { kind: 'COMPETENCE', subcommand: 'STATUS' };
    if (subcommand === 'show' && tokens.length >= 3 && tokens.length <= 4) {
      const providerId = tokens[2];
      if (providerId === undefined) return { kind: 'PARSE_ERROR', message: 'competence show requires a provider id.' };
      return {
        kind: 'COMPETENCE',
        subcommand: 'SHOW',
        providerId,
        ...(tokens[3] === undefined ? {} : { modelId: tokens[3] }),
      };
    }
    return { kind: 'PARSE_ERROR', message: '"competence" requires status or show <provider> [model].' };
  }

  if (first === 'policy') {
    if (tokens[1] !== 'test' || tokens[2] !== '--proposed' || tokens[3] === undefined) {
      return { kind: 'PARSE_ERROR', message: '"policy test" requires --proposed <path> <request>.' };
    }
    const parsed = parseRequest(tokens, 4, 'policy test');
    if ('kind' in parsed) return parsed;
    return { kind: 'POLICY_TEST', proposedPath: tokens[3], ...parsed };
  }

  if (first === 'canary') {
    if (tokens[1] !== 'run' || tokens[2] === undefined || tokens.length > 4) return { kind: 'PARSE_ERROR', message: '"canary run" requires <provider> [model].' };
    return { kind: 'CANARY', providerId: tokens[2], ...(tokens[3] === undefined ? {} : { modelId: tokens[3] }) };
  }

  if (first === '--family' || first === '--fleet') {
    const parsed = parseRequest(tokens, 0, first);
    if ('kind' in parsed) return parsed;
    return { kind: 'START', mode: 'EXECUTE', ...parsed };
  }

  if (RESERVED_BARE_COMMANDS[first] === true) {
    if (tokens.length !== 1) {
      return { kind: 'PARSE_ERROR', message: `"${first}" takes no arguments (got ${tokens.length - 1} extra token(s)).` };
    }
    if (first === 'explain') return { kind: 'EXPLAIN' };
    if (first === 'why') return { kind: 'WHY' };
    if (first === 'status') return { kind: 'STATUS' };
    if (first === 'graph') return { kind: 'GRAPH' };
    if (first === 'continue') return { kind: 'CONTINUE' };
    return { kind: 'CANCEL' };
  }

  if (RESERVED_ARG_COMMANDS[first] === true) {
    if (tokens.length !== 2) {
      const argName = first === 'resume' ? 'operator-session-id' : 'gate-id';
      return { kind: 'PARSE_ERROR', message: `"${first}" requires exactly one argument: ${first} <${argName}> (got ${tokens.length - 1}).` };
    }
    const arg = tokens[1];
    if (arg === undefined || !ID_TOKEN_PATTERN.test(arg)) {
      return { kind: 'PARSE_ERROR', message: `"${first}" argument must be a valid id (letters, digits, ".", "_", ":", "-").` };
    }
    if (first === 'approve') return { kind: 'APPROVE', gateId: arg };
    if (first === 'reject') return { kind: 'REJECT', gateId: arg };
    return { kind: 'RESUME', operatorSessionId: arg };
  }

  if (RESERVED_EVALUATOR_COMMANDS[first] === true) {
    if (tokens.length < 2) {
      return { kind: 'PARSE_ERROR', message: `the "${first}" command requires a subcommand.` };
    }
    return { kind: 'IMPROVE', subcommand: tokens[1]!, args: tokens.slice(2) };
  }

  if (first === 'fleet') {
    if (tokens.length === 1) return { kind: 'FLEET', subcommand: 'list', args: [] };
    return { kind: 'FLEET', subcommand: tokens[1]!, args: tokens.slice(2) };
  }

  return { kind: 'START', request: trimmed, mode: 'EXECUTE' };
}

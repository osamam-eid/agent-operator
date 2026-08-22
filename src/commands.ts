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

export function parseOperatorCommand(rawArgs: string): OperatorParseResult {
  const trimmed = rawArgs.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'PARSE_ERROR',
      message:
        'missing command or request. Provide a request to start a session, or one of: --explain <request>, --dry-run <request>, explain, why, status, graph, approve <gate>, reject <gate>, continue, cancel, resume <id>.',
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
        '  --dry-run <request>            preflight without dispatching',
        '  --explain <request>            routing explanation only',
        '  status | graph | why | explain show session / graph / routing detail',
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
    const request = tokens.slice(1).join(' ').trim();
    if (request.length === 0) {
      return { kind: 'PARSE_ERROR', message: '"--explain" requires a request: --explain <request>.' };
    }
    return { kind: 'START', request, mode: 'EXPLAIN' };
  }

  if (first === '--dry-run') {
    const request = tokens.slice(1).join(' ').trim();
    if (request.length === 0) {
      return { kind: 'PARSE_ERROR', message: '"--dry-run" requires a request: --dry-run <request>.' };
    }
    return { kind: 'START', request, mode: 'DRY_RUN' };
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

  return { kind: 'START', request: trimmed, mode: 'EXECUTE' };
}

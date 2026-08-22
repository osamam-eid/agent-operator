---
name: agent-operator
description: Use when the user explicitly invokes `/operator` to classify a request, resolve global and trusted project policy, compile and inspect a validated read-only workflow graph, decide its exact human gates, dispatch its read-only planning/review/synthesis nodes, resume an interrupted session, preview compilation with `--dry-run`, or read its typed final result. Do not use for ordinary requests not routed through `/operator`; automatic interception remains unavailable and disabled. Do not use for mutating work (implementation, QA execution, UI implementation) - Stage 4 defines no production capability for any `MUTATING` role; those workflows compile-time block until a later stage.
---

# Agent Operator

Agent Operator is an interactive workflow controller entered only through
the explicit `/operator` command. It owns workflow topology and session
state; leaf work executes assigned nodes but never redesigns the workflow,
approves itself, or recursively delegates.

**Stage 4 status: read-only native dispatch over the `omp-task` adapter,
mutation still fully excluded.** The package resolves a portable global
profile, applies a project `.omp/operator.json` overlay only when its exact
hash is approved inside Git metadata, loads versioned policy packs,
enforces budgets and capability eligibility, instantiates an approved
workflow template, validates the compiled graph, and only then opens its
first human gate. Classification is a conservative deterministic sandbox
fixture, not a model judgment. `compiler.ts`'s default capability registry
is now the Stage 4 production registry (`registry.ts`'s
`createProductionCapabilityRegistry`): the three package-owned,
read-only roles (`agent-operator-native-planner`, `-reviewer`,
`-synthesis`) back every read-only planning/preflight/research/review/
scope-freeze/synthesis capability by default, each granted exactly
`operator_read`/`operator_grep`/`operator_glob` (or, for synthesis,
`operator_read` alone) — never `edit`, `write`, `bash`, `task`, or `hub`.
A mock capability record can never be selected through the production
registry, even if one is misconfigured or present alongside real records.
Stage 4 defines no `MUTATING` production capability at all: any workflow
whose mandatory nodes require implementation, QA execution, or UI
implementation (task families `IMPLEMENT`, `QA`, `UI`) fails to compile
with `CAPABILITY_UNAVAILABLE` rather than silently downgrading to a mock
or partial run. The deterministic mock registry and executor remain
available, but only for tests/fixtures — production wiring never selects
them. There is no external CLI provider, council, automatic routing,
provider fallback, or write-capable tool anywhere in this package.

## Invocation

Operator is entered only through the explicit command:

```text
/operator "<request>"
```

There is no undocumented always-listening interception of ordinary chat
messages. A request must be explicitly routed through `/operator` (or an
active Operator session's follow-up controls below) before Operator does
anything on its behalf.

## V1 `/operator` commands

The command handler parses `/operator`'s argument text into exactly one of
the following typed commands (`OperatorCommand` in `src/runtime-types.ts`);
anything else is rejected as `INVALID_COMMAND` rather than guessed at:

- **START** — begins a new session for `"<request>"`. Classifies the
  request conservatively, resolves trusted policy/configuration, selects a
  capability per node from the production `omp-task` registry by default
  (read-only roles resolve to a real package role; any node whose
  mandatory capability is `MUTATING` fails compilation instead), selects
  `plan.v1`, `implement.v1`, `qa.v1`, `security.v1`, `ui-change.v1`, or
  `research.v1`, and validates the compiled graph before any session is
  persisted. START has three modes:
  - **EXECUTE** — compiles the workflow and stops at its first exact
    graph-bound human gate. No node executes until that gate is approved and
    `CONTINUE` is issued.
  - **EXPLAIN** — performs the same classification, policy, capability, and
    graph checks for inspection only. Explain mode opens no actionable gate
    and can never dispatch a node.
  - **DRY_RUN** (`--dry-run "<request>"`) — performs the same compile-time
    checks as EXECUTE (classification, trusted policy/config resolution,
    capability selection, graph validation) and stops there: no gate is
    opened, no provider session is created, and no request is ever sent to
    a model. Truthful preflight only, never a partial dispatch.
- **EXPLAIN** — reports the current session's compiled pipeline, current
  node/gate states, and pending decision, without mutating anything.
- **WHY** — reports request/risk classification, workflow and graph revision,
  role/provider capability fit, rejected alternatives, required gates, budget
  effect, provider health/fallback decisions, exact policy references, and
  confidence/abstention without mutating anything.
- **STATUS** — reports the current session state, node states, and any
  open gate, without mutating anything.
- **GRAPH** — reports the compiled execution graph (nodes, edges, mutation
  metadata) for the current session.
- **APPROVE `<gateId>`** — approves the named gate. See "Human gate
  binding" below for exactly what this decision does and does not cover.
- **REJECT `<gateId>`** — rejects the named gate, producing a typed
  workflow effect on the session; it never silently retries or expands
  scope.
- **CONTINUE** — advances exactly one dependency-ready node after an
  approved gate. Multi-node graphs require repeated `CONTINUE` calls. When
  execution finishes, every remaining policy-required terminal gate
  must be decided before the session can report terminal success.
- **CANCEL** — cancels the active session.
- **RESUME `<operatorSessionId>`** — reloads a previously persisted
  session by id and reconciles it. See "Resume and `UNKNOWN` nodes" below.
  session by id and reconciles it. See "Resume and `UNKNOWN` nodes" below.

## Human gate binding

Every gate Operator opens (`HumanGate` in `src/contracts.ts`) carries its
own `operatorSessionId`, `gateId`, `graphRevision`, and `graphHash`. An
`APPROVE`/`REJECT` decision is checked against all of these together, not
just the gate id: it must name an `OPEN` gate that belongs to the exact
session currently active, and the session's compiled graph must still
hash to the exact value recorded on that gate at the time it was opened.
If the session's graph has since changed, the decision fails closed with
`GATE_MISMATCH` instead of being applied to a graph revision the human
never actually saw. Approving one gate never grants blanket approval for
a later graph revision, a different gate, or a different session.
## Resume and `UNKNOWN` nodes

`RESUME` never assumes a previously `RUNNING` mock node finished, failed,
or is still safely in flight. On resume, every node persisted in `RUNNING`
becomes the typed `UNKNOWN` state, a corresponding journal entry records the
reconciliation, and the session is blocked pending an explicit human
decision. Resume never retries a node automatically or guesses at its result.

## Policy, trust, and budgets

Policy precedence is hard safety invariants, explicit current instruction,
trusted project overlay, global profile, conservative classifier proposal,
then cost/latency optimization. Project policy is applied only when
`.omp/operator.json` is a regular contained file and its SHA-256 matches the
strict trust record under the repository's resolved Git metadata. Missing or
mismatched trust never silently changes routing; malformed, symlinked, or
path-escaping policy fails closed. Conflicting versioned policy packs fail
instead of selecting one implicitly. Budget profiles constrain eligible
capabilities but never override explicit intent, trusted governance, or hard
safety.

never guesses at an outcome on the affected node's behalf.

## Evidence-oriented output

Operator's final response is a decision-oriented `FinalOperatorResult`,
not a dump of raw transcripts. It separately reports execution status,
workflow status, requirement coverage, scope deviations, findings by
severity, remaining risk, and `actionsNotPerformed` (commit, push, merge,
deploy, publish, and similar actions that did not happen even when the
mock pipeline succeeded). Passing verification is never presented as
implying complete requirement coverage or an authorized mutation that did
not occur. Command failures report only a typed `errorCode` and a plain
message — never an internal stack trace or private reasoning.

## Session state

Sessions persist as one JSON file per `operatorSessionId` under
`OMP_AGENT_OPERATOR_STATE_DIR` when set, otherwise under the home-relative
default `~/.omp/state/agent-operator`. Writes are atomic and the state
directory and files are created with restrictive local permissions; no
session id can escape the configured root directory.

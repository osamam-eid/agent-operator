# WP12 — Decision Foundation, Disclosure, Simulation, and Explanation

## Objective

Deliver the first bounded intelligence increment without changing execution authority:

1. A schema-versioned runtime disclosure decision before external fleet eligibility.
2. A schema-versioned decision trace created by the real compiler.
3. A truly side-effect-free `/operator simulate`, with `--dry-run` retained as an alias.
4. `/operator why` rendering the stored compiler trace for new sessions.
5. `/operator --family <TASK_FAMILY> <request>` as an intent override only.

## Frozen invariants

- Stage 1–11 execution, policy, graph, gate, mutation, and promotion authority remain unchanged.
- Simulation performs no session/store/journal/gate/provider/tool/mutation writes and does not consume the runtime ID factory.
- Explicit family selection cannot select `DIRECT`, weaken disclosure/risk/policy, alter capabilities, or bypass gates.
- Disclosure is decided before fleet capability/provider selection.
- Existing sessions without WP12 fields remain loadable and explainable as legacy records.
- No semantic model classifier, provider competence, scorecard, calibration, shadow routing, dashboard, or online learning is introduced.

## Contracts

Add runtime intelligence contracts with `schemaVersion: "1.0"` and strict validators:

- `PredictionIdentity`
- `RuntimeDisclosureDecision`
- `DecisionTraceEntry`
- `DecisionTrace`
- `SimulationCapabilitySummary`
- `SimulationResultEnvelope`

Disclosure classes:

- `LOCAL_ONLY`
- `INTERNAL_REDACTABLE`
- `EXTERNAL_ALLOWED`

The default deterministic disclosure classifier uses the existing credential-bearing pattern. Local-only/confidential instructions and credential-bearing content force `LOCAL_ONLY`. Explicit fleet intent may produce `EXTERNAL_ALLOWED` only when no sensitive signal is present. Ordinary native requests remain `INTERNAL_REDACTABLE`. Unknown or classifier failure fails closed.

## Compiler sequence

1. Apply an explicit family override, if present, using deterministic family defaults; otherwise call the configured classifier.
2. Resolve config and project trust.
3. Compute the disclosure decision.
4. Block fleet compilation unless disclosure is `EXTERNAL_ALLOWED`.
5. Resolve policy.
6. Select the workflow and capabilities.
7. Compile and validate the graph and route.
8. Build one immutable `DecisionTrace` from the actual decisions.
9. Return disclosure, trace, and capability summaries in `CompiledWorkflow`.

No second compiler or explanation planner is allowed.

## CLI behavior

### `/operator simulate "<request>"`

- Canonical simulation command.
- `--dry-run <request>` is an exact compatibility alias.
- Supports `--family <TASK_FAMILY>`.
- Uses deterministic ephemeral compilation IDs derived from request/project/time; never calls the shared ID factory.
- Calls the existing non-dispatching preflight when configured.
- Returns `SimulationResultEnvelope` in `OperatorCommandOutcome.simulation`.
- Does not require or replace the active session.

### `/operator why [session-id]`

This increment keeps the existing active-session form. New sessions render:

- disclosure class and reason codes,
- classifier identity,
- classification,
- project trust,
- applied policy decisions,
- workflow selection,
- selected capabilities/providers/tools/mutation classes,
- graph compilation,
- existing route rejections, gates, budget, fallback, and policy refs.

Legacy sessions explicitly state that a WP12 trace is unavailable, while retaining the existing truthful route summary.

### `/operator --family PLAN <request>`

Accepted families: `RESEARCH`, `PLAN`, `IMPLEMENT`, `REVIEW`, `UI`, `QA`, `SECURITY`, `OPERATIONS`. The override selects intent only. `DIRECT` is rejected.

## Files

### New

- `src/intelligence.ts`
- `schemas/runtime-disclosure-decision.v1.json`
- `schemas/decision-trace.v1.json`
- `schemas/simulation-result.v1.json`
- `tests/intelligence.test.ts`

### Updated

- `src/classifier.ts`
- `src/stage3-types.ts`
- `src/compiler.ts`
- `src/runtime-types.ts`
- `src/commands.ts`
- `src/controller.ts`
- `src/state.ts`
- `src/runtime-validators.ts`
- `extension/index.ts`
- `tests/compiler.test.ts`
- `tests/runtime-flow.test.ts`
- schema validation tests where required
- `work-packages/intelligence/WORKSPACE.json`

## Verification

- Focused intelligence, compiler, runtime-flow, stage9, and schema tests.
- Full `bun test` after all slices integrate.
- `bun run typecheck`.
- Behavioral simulation smoke proving zero store saves, zero active-session change, zero ID-factory consumption, zero preflight dispatch, and a validated structured result.
- Disclosure smoke proving credential-bearing fleet requests fail before fleet selection.
- Existing execute-flow regression proving unchanged gate and dispatch behavior.

## Completion criteria

- Every new contract validates and has a JSON schema.
- Simulation is side-effect-free and uses the real compiler/preflight.
- New executed sessions persist the exact compiler trace and disclosure decision.
- Why uses stored structured evidence.
- External fleet eligibility is disclosure-gated.
- Explicit family override is bounded to intent.
- Full test suite and typecheck pass.

## Rollback

The new CLI variants and fields are additive. Reverting WP12 restores the previous parser/compiler/controller while old sessions remain unaffected. Disclosure must fail closed during rollback; it must not be replaced by unrestricted fleet eligibility.

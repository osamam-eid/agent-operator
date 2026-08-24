# WP13 — Semantic Classification, Shadow Routing, and No-Action

## Objective

Add real semantic intelligence without allowing it to control execution. WP13 runs the current OMP-selected model only behind WP12 disclosure, records structured shadow comparisons, and can recommend `DO_NOT_EXECUTE` without creating a task family or dispatching work.

## Scope

- Strict tool-free semantic classifier using the existing OMP child-session factory.
- Disclosure before every semantic model call.
- `/operator shadow on|off|status|evaluate <request>`.
- Primary route remains the deterministic incumbent; shadow output never changes it.
- Structured `EXECUTE | DO_NOT_EXECUTE | NEEDS_CLARIFICATION` disposition.
- Versioned local shadow observations containing request hashes, not raw requests.
- Evaluator-ready tests and schemas.

## Model boundary

- Current OMP-selected model only.
- Zero tools, custom tools, MCP, LSP, extension discovery, or fallback.
- Strict output schema and bounded evidence strings; no chain-of-thought.
- Exact provider/model identity recorded.
- Any fallback message, timeout, invalid output, or provider error fails closed and is recorded as a shadow failure.
- Child session is aborted on timeout and always disposed.

## Disclosure order

1. Compile the incumbent route using WP12.
2. Read the incumbent `RuntimeDisclosureDecision`.
3. If `LOCAL_ONLY`, do not call a model; record `BLOCKED_DISCLOSURE`.
4. Otherwise call the semantic classifier.
5. If disposition is `EXECUTE`, compile its proposal through a fresh real compiler instance.
6. Compare candidate and incumbent structures.
7. Persist the observation.
8. Return the incumbent unchanged.

This ordering avoids moving the model call into the compiler before disclosure.

## No-action

`DO_NOT_EXECUTE` is a semantic disposition, not `TaskFamily.NO_ACTION`. It is accepted only in shadow evidence during WP13. The observation records a typed reason and evidence. It never becomes a generic refusal or active execution bypass. Activation, if qualified, belongs to WP18 human promotion.

## Storage

- Local directory: `<operator-state>/shadow/`, mode `0700`.
- Observation files: mode `0600`, write-once id derived from request hash, model identity, and timestamp.
- No raw request, secret match, source file, or chain-of-thought.
- Store incumbent and candidate family/workflow/provider summaries, disposition, failure code, policy/catalog/compiler identity refs, and divergence fields.

## Commands

- `/operator shadow on`
- `/operator shadow off`
- `/operator shadow status`
- `/operator shadow evaluate <request>`

Shadow is default-off. `evaluate` performs one comparison without enabling passive observation. When enabled, new executed or explained requests record a shadow observation after incumbent compilation and before session persistence; a shadow failure cannot fail the incumbent request.

## Completion criteria

- Semantic classifier uses a real strict OMP session seam and disposes it.
- Disclosure blocks the model call for local-only input.
- Shadow candidate compilation uses the production compiler path.
- Primary route, graph, gate, and session are byte-identical with shadow on or off.
- No-action is structured, auditable, and non-dispatching.
- Observations contain no raw request or sensitive value.
- Full tests and typecheck pass.

## Non-goals

- No active semantic routing.
- No calibrated confidence.
- No provider competence influence.
- No autonomous learning or promotion.
- No dashboard.

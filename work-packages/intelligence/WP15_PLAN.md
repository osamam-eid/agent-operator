# WP15 — Provider Competence and Human-Feedback Evidence

## Objective

Collect and aggregate trustworthy provider/model evidence without changing routing.

## Scope

- Append-only evidence admission ledger with provenance and deduplication.
- Normalized human override records and metrics.
- Provider/model/role/task-family/capability competence snapshots.
- Canary observation record format and storage, collection-only.
- CLI inspection of scorecards.

## Evidence admission

Each observation binds provider/model, role, family, capability, policy/compiler identity, source session/evaluator/canary reference, outcome, latency/cost where known, timestamp, and integrity id. Incomplete, duplicate, unverified, unresolved-mutation, or human-preference-only records are excluded from positive competence evidence. Admission decisions are themselves stored.

## Human overrides

Capture provider/workflow/route overrides, gate rejection, reroute, retry, cancellation, finding disposition change, and promotion rejection as typed signals. A human decision is never automatically labeled correct.

## Competence

The key is `provider × model × role × task family × capability`. Snapshots report qualified sample count, successes, hard failures, success interval, quality, latency, cost per success, recency, and provenance refs. Catalog metadata is never competence evidence. WP15 scorecards have zero routing authority.

## Canary observations

Store fixed-case provider/model outcomes, quality, latency, tool reliability, and evaluator run identity. Execution and provider status influence remain deferred to WP18.

## Commands

- `/operator competence show <provider> [model]`
- `/operator competence status`

## Completion criteria

- Ledger is append-only, local, permission-restricted, deduplicated, and reconstructs snapshots deterministically.
- Human override analytics distinguish decision categories and outcomes.
- One success cannot produce high confidence.
- Catalog declarations cannot enter evidence.
- Scorecards cannot influence provider selection.
- Full tests and typecheck pass.

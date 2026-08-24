# WP18 — Calibration, Provider Canaries, Gym Integration, and Governed Activation

## Objective

Turn qualified intelligence evidence into immutable evaluated candidates, while keeping every behavior change human-promoted and digest-reversible.

## Scope

- Calibration reports for classification, workflow, provider, risk, and recommendation confidence.
- Explicit bounded provider canary execution against fixed cases.
- Intelligence candidate manifests bound to data/policy/model/scorer digests.
- Existing evaluator/Gym comparison integration.
- Human-only promotion pointer and explicit digest rollback.

## Calibration

Predictions and labels remain separate. Reports include sample count, Brier score, expected calibration error, reliability bins, and compatible prediction identity. Insufficient samples produce `INSUFFICIENT`; no probability is fabricated. Low confidence can recommend abstention but never trigger expensive execution.

## Canaries

`/operator canary run <provider> [model]` executes an injected fixed, read-only corpus under explicit case/token/cost/time bounds. One failure records an observation only. Provider status or routing cannot change without an evaluated candidate and promotion.

## Gym integration

An intelligence candidate binds classifier/calibrator/competence/context policy digests, evidence snapshot, policy/compiler/scorer versions, and base digest. Existing train/held-out isolation, secret gates, bundle verification, deterministic comparison, and adaptive-leakage limits remain authoritative.

## Activation and rollback

Promotion requires `PROMOTE_RECOMMENDED`, an exact candidate digest, a human approval reference, and `promotedBySystem: false`. The active pointer stores current and previous digests. Rollback requires a new explicit human approval and can only restore the recorded previous digest. Neither action commits, pushes, publishes, or deploys code.

## Completion criteria

- Calibration is version-partitioned and honest about insufficient evidence.
- Canaries are budgeted, fixed, and non-mutating.
- Candidate manifests are digest-complete and evaluator-compatible.
- Self-promotion and stale digest activation fail closed.
- Rollback is explicit, hash-bound, and auditable.
- Full tests and typecheck pass.

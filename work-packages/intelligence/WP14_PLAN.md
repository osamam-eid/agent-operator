# WP14 — Failure, Fallback, Recovery, Drift, and Approval Safety

## Objective

Make execution failures, fallback attempts, mutation recovery, scope drift, and approval risk reconstructable from structured evidence without weakening any existing gate or mutation boundary.

## Scope

- Normalized failure fingerprints with no raw sensitive content.
- Structured provider fallback attempt journals carried through validated outcomes into stored node results and session journals.
- Recovery packages prepared before governed mutation and finalized after success, cleanup, or unresolved cleanup failure.
- Material scope drift checks using frozen paths, baseline identity, graph identity, and optional authorized-operation hashes.
- Risk-aware summaries attached to existing gates; no new approval authority.

## Failure fingerprints

Fingerprint inputs are typed status/reason category, adapter, provider/model, capability, phase, mutation state, and policy/compiler identity. Raw prompts, credentials, full errors, stack traces, and file contents are excluded. One observation has no routing effect.

## Fallback journal

Every fleet attempt records provider/model, phase, typed outcome, reason code, disclosure compatibility, mutation safety, and cost delta when known. Automatic fallback remains bounded and stops on terminal/ambiguous mutation outcomes. The journal is persisted with the node result and rendered by `/operator why`.

## Recovery packages

Before a non-read-only governed mutation, record session/worktree/scope/baseline/graph identities and allowed paths. Update with changed paths and cleanup status. Rollback remains a separately governed mutation; package creation never performs rollback.

## Scope drift

Existing out-of-scope changed-path enforcement remains authoritative. WP14 adds operation-identity comparison when an authorized operation hash is supplied and records drift evidence. Harmless implementation detail inside frozen paths remains permitted.

## Approval UX

Existing `HumanGate` semantics remain. Add an optional structured risk summary: risk/disclosure/mutation class, exact node/path scope where available, providers/tools, verifier, actions not performed, and rollback/recovery reference. Gate and graph hashes remain binding.

## Completion criteria

- Equivalent normalized failures produce one stable fingerprint; distinct mutation/security contexts do not collide.
- Fallback history is typed and survives sanitize/store/reload/Why.
- Recovery evidence is written before mutation and cannot overwrite pre-existing changes.
- Path or authorized-operation drift blocks before promotion.
- Approval summaries are graph-bound and cannot authorize more than the existing gate.
- Full tests and typecheck pass.

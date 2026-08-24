# WP17 — Evidence Hierarchy, Adaptive Context, and Retention

## Objective

Create deterministic context/evidence candidates that reduce cost without deleting required context or authoritative raw evidence.

## Scope

- Requirement classes: `REQUIRED | RELEVANT | OPTIONAL | FORBIDDEN`.
- Representations: `FULL | SYMBOL_EXCERPT | SUMMARY | ARTIFACT_REFERENCE | EVIDENCE_ONLY`.
- Deterministic context packing plans and manifests.
- Raw → normalized → decision-brief evidence linkage.
- Explicit retention decisions and deduplication.
- Static projection remains the active default; adaptive plans are evaluator candidates until WP18 promotion.

## Packing invariants

Required items are never dropped. Forbidden items are never dispatched. Relevant/optional items are ranked deterministically within a pinned budget. Required overflow blocks. Every plan records excluded items and estimated token cost. Token reduction alone is not success; evaluator comparison includes correctness, security, extra tool calls, reruns, latency, and total cost.

## Evidence hierarchy

Raw evidence remains immutable by digest. Normalized evidence references raw records. Decision briefs reference normalized records. A summary never replaces or changes authoritative raw evidence.

## Retention

Default local policies: simulation memory-only; shadow/raw operational evidence 30 days; failure fingerprints 90 days; human signals 180 days; qualified intelligence 12 months; gates/promotion/publication digests retained while authoritative. Retention evaluation produces decisions only; deletion requires an explicit caller and cannot remove active references.

## Completion criteria

- Packing is deterministic and preserves required/security inputs.
- Forbidden context is excluded before dispatch.
- Required overflow fails closed.
- Evidence links and hashes remain verifiable through every level.
- Retention decisions respect active references and never silently delete evidence.
- Full tests and typecheck pass.

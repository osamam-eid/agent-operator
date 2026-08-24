# WP16 — Policy Diff, Execution Estimates, and Expensive-Work Preview

## Objective

Use the real compiler to compare proposed policy safely and show bounded cost/depth/risk information before execution.

## Scope

- `/operator policy test --proposed <path> <request>`.
- Current-versus-proposed compiler comparison with no policy application or session persistence.
- Deterministic graph call/depth estimates and explicit unknown financial estimates.
- Existing execution gate enriched when high-risk/expensive triggers apply.

## Policy test

The proposed file must validate as a project operator overlay. It is read only, never trusted or written. A simulated resolved config is created in memory, then both current and proposed configurations compile the same request under pinned project/catalog/compiler inputs. Report workflow, provider eligibility, gates, mutation, disclosure, budget profile, graph, and unchanged hard invariants.

## Estimates

Report expected node/provider calls, maximum graph depth, parallel width, external-provider use, mutation classes, budget profile, and estimate provenance. Financial cost remains `null/UNAVAILABLE` unless a trusted provider estimate exists; unknown is never treated as zero.

## Preview triggers

Reuse the existing graph-bound execution gate. Mark preview required for external providers, council, configured large graph, HIGH/CRITICAL risk, non-read-only mutation, or explicit policy. Display Run/Reject consequences through existing gate options; do not add approval authority.

## Completion criteria

- Policy simulation uses production compiler paths and writes no policy/session state.
- Hard fields cannot be weakened by a proposed overlay.
- Estimate graph calls/depth are exact for the compiled graph.
- Unknown cost is explicit.
- Stale gate/graph hashes remain invalid.
- Full tests and typecheck pass.

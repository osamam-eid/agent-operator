# Agent Operator 2.0.0 — Intelligence Roadmap (WP12–WP18)

## What's new

### Decision foundation and disclosure (WP12)
- Runtime disclosure classification (`LOCAL_ONLY` / `INTERNAL_REDACTABLE` / `EXTERNAL_ALLOWED`) is computed by the real compiler before any external fleet/provider eligibility, fail-closed on secrets, local-only instructions, and untrusted project overlays.
- Every compile now emits a schema-versioned `DecisionTrace`: classification, project trust, disclosure, policy, workflow selection, capability selection, and graph compilation.
- `/operator simulate "<request>"` compiles through the production compiler/preflight with zero session, journal, gate, provider, tool, mutation, or shared-id side effects; `--dry-run` remains as an exact alias.
- `/operator why` renders the persisted compiler trace, disclosure, capability summaries, runtime fallback journals, and failure fingerprints; legacy sessions are labeled explicitly.
- `/operator --family <FAMILY> <request>` selects intent only and never bypasses disclosure, risk, policy, or gates.

### Semantic routing and shadow mode (WP13)
- Strict tool-free semantic classifier over the current OMP-selected model with bounded structured output, timeout/abort/dispose handling, no keyword fallback, and disclosure gating before any model call.
- `/operator shadow on|off|status|evaluate <request>` compares the incumbent route with a semantic candidate without ever changing it; observations store request hashes plus structured decisions only.
- `DO_NOT_EXECUTE` / `NEEDS_CLARIFICATION` are auditable shadow dispositions, not task families and not execution bypasses.

### Execution safety evidence (WP14)
- Normalized, non-sensitive failure fingerprints on every non-success node outcome.
- Complete typed provider fallback journals (eligibility, binary verification, dispatch attempts, final outcome) persisted with results and rendered by `why`.
- Recovery packages are prepared before every governed mutation and updated through MUTATED → VERIFIED → CLEANED (or REQUIRES_HUMAN), with changed paths recorded.
- Scope drift enforcement: changed paths outside frozen scope and authorized-operation hash changes block before promotion.
- Risk-aware gate summaries carry risk/disclosure/mutation classes, providers, tools, scoped nodes, actions not performed, recovery requirements, expected calls, depth, cost confidence, and preview reasons inside existing graph-bound gates.

### Evidence intelligence (WP15)
- Append-only, deduplicated, provenance-bound evidence ledger with explicit admission decisions.
- Human gate decisions are captured as typed override signals that remain `UNREVIEWED` correctness labels.
- Evidence-derived competence scorecards keyed by provider × model × role × family × capability with Wilson confidence intervals and honest `INSUFFICIENT` states; they never influence routing in this release.
- `/operator competence status|show <provider> [model]`.

### Policy diff and cost previews (WP16)
- `/operator policy test --proposed <path> <request>` validates the proposed overlay, rejects unsafe broadening of hard-locked flags before any compilation, and reports verified hard-invariant status instead of hardcoded claims.
- Deterministic graph estimates: expected provider calls, maximum depth, parallel width, mutation classes, budget profile; unknown financial cost stays explicitly `UNAVAILABLE`.
- Expensive/high-risk preview reasons are surfaced inside the existing execution approval request text.

### Context and evidence intelligence (WP17)
- Requirement (`REQUIRED|RELEVANT|OPTIONAL|FORBIDDEN`) is separate from representation (`FULL|SYMBOL_EXCERPT|SUMMARY|ARTIFACT_REFERENCE|EVIDENCE_ONLY`); required context is never dropped, forbidden context is never dispatched, overflow blocks.
- Raw → normalized → decision-brief evidence hierarchy with digest linkage; raw evidence stays authoritative.
- Retention evaluation produces KEEP / ELIGIBLE_FOR_EXPLICIT_DELETION decisions only and always preserves authoritative or actively referenced records.

### Governed activation (WP18)
- Confidence calibration with Brier score, ECE, reliability bins, version identity partitioning, and honest `INSUFFICIENT` below 20 samples.
- `/operator canary run <provider> [model]` executes fixed read-only cases under hard case/token/cost/wall-clock budgets; observations are evidence only.
- Intelligence candidate manifests bind classifier/calibration/competence/context/evidence/policy/compiler/scorer digests and integrate with the existing evaluator/Gym comparison flow via `/operator improve intelligence …`.
- Promotion requires a clean trusted `PROMOTE_RECOMMENDED` comparison, an exact digest match, and a human approval reference; `promotedBySystem` is structurally false. Rollback requires its own human approval and restores only the recorded previous digest.

## Verification

- 625 tests passing across 38 files; TypeScript typecheck clean.
- Independent completeness and security reviews completed; all identified blockers fixed (policy-simulation unsafe-broadening gate + verified hard invariants, recovery port wired into the governed-mutation path, WP18 lifecycle reachable via `/operator improve intelligence`, documentation artifacts corrected).
- Stage 1–11 invariants unchanged: human gates, mutation ceilings, disclosure precedence, and promotion authority are untouched.

## Known limitations

- Adaptive context plans and calibration reports are offline candidate tooling; activation requires the documented promote/rollback flow and does not alter routing until promoted.
- Competence scorecards and canary results are collection-only evidence in 2.0.0; routing influence requires future evaluated candidates.
- Financial cost estimates remain unavailable unless a trusted provider estimate exists; unknown is never treated as zero.

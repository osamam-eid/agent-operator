/**
 * Agent Operator — Stage 3 deterministic mock capability registry, plus the
 * Stage 4 production `omp-task` capability records.
 *
 * Every mock record here is a local `omp-role` (no `binary`/probes, never
 * `external-cli`) with a hardcoded `mock` provider label. Selection never
 * dispatches anything: it is pure data lookup plus deterministic constraint
 * evaluation over `CapabilityRecord`/`ResolvedPolicy` fields already defined
 * by Stage 1/2/3 contracts. There is no code path in this module that can
 * construct, describe, or invoke a real provider.
 *
 * The Stage 4 production records below describe the three package-owned
 * read-only roles (`agent-operator-native-planner/-reviewer/-synthesis`,
 * loaded and hash-checked by `src/adapters/omp-task.ts`) dispatched through
 * the `omp-task` native OMP child-session adapter. `createProductionCapabilityRegistry`
 * hard-rejects every record whose `source` is not tagged `omp-task:` — a
 * mock record can never be selected through it, even if one is accidentally
 * included in its `records` array (defense in depth alongside the
 * `kind !== 'omp-role'` external-provider guard below).
 *
 * `select()` never silently degrades: on any unavailable/incompatible
 * requirement it throws `CapabilitySelectionError` rather than returning a
 * best-effort guess or a sentinel value. Fallbacks are only ever attempted
 * when the resolved `CapabilityPreference.fallbackPolicy` is
 * `'COMPATIBLE_ONLY'`; `'HUMAN_REQUIRED'` and `'DISABLED'` both fail closed
 * without inspecting the fallback list at all.
 */

import type { BudgetProfile, CapabilityRecord, HealthStatus, ModelTier } from './contracts.js';
import type { CapabilityPreference, CapabilityRegistry, CapabilityRequirement, CapabilitySelection, ResolvedPolicy } from './stage3-types.js';

// ---------------------------------------------------------------------------
// Typed selection error
// ---------------------------------------------------------------------------

/** Stable, enum-like reason codes for a rejected/unavailable selection. When
 * a preferred assignment is unavailable and its `fallbackPolicy` forbids
 * even trying the fallback list (`'HUMAN_REQUIRED'` / `'DISABLED'`), the
 * thrown error's `reasonCode` is the *specific* constraint that rejected the
 * preferred candidate (one of the non-wrapper codes below), not a generic
 * "fallback disabled" code — the `.message` states the fallback policy
 * separately. `NO_COMPATIBLE_FALLBACK` is used only when a
 * `'COMPATIBLE_ONLY'` walk of the fallback list was actually attempted and
 * every candidate (preferred included) failed for its own reason. */
export type CapabilitySelectionReasonCode =
  | 'NO_CAPABILITY_ASSIGNMENT'
  | 'UNKNOWN_CAPABILITY_ID'
  | 'EXTERNAL_PROVIDER_DISABLED'
  | 'PRODUCTION_MOCK_FORBIDDEN'
  | 'CAPABILITY_MISMATCH'
  | 'EXECUTION_SHAPE_UNSUPPORTED'
  | 'CAPABILITY_UNHEALTHY'
  | 'MUTATION_CLASS_INCOMPATIBLE'
  | 'BUDGET_MODEL_TIER_EXCEEDED'
  | 'BUDGET_COST_TIER_EXCEEDED'
  | 'INSUFFICIENT_CONCURRENCY'
  | 'INDEPENDENCE_VIOLATION'
  | 'NO_COMPATIBLE_FALLBACK';

/** Thrown by `select()` for any unavailable or incompatible requirement.
 * There is no other way for `select()` to fail: it never returns a
 * sentinel/null selection. */
export class CapabilitySelectionError extends Error {
  readonly requirement: CapabilityRequirement;
  readonly reasonCode: CapabilitySelectionReasonCode;

  constructor(message: string, requirement: CapabilityRequirement, reasonCode: CapabilitySelectionReasonCode) {
    super(message);
    this.name = 'CapabilitySelectionError';
    this.requirement = requirement;
    this.reasonCode = reasonCode;
  }
}

// ---------------------------------------------------------------------------
// Default mock capability records
// ---------------------------------------------------------------------------

/** All 19 Stage 3 mock roles. Every id here is a valid target for
 * `OperatorProfile.capabilityAssignments["<role>"].preferred/fallbacks`,
 * where `"<role>"` matches a `CapabilityRequirement.role` produced by
 * `workflow-templates.ts`. Kept intentionally exhaustive so config/policy
 * packs never need a role this registry cannot service. */
export const DEFAULT_MOCK_CAPABILITY_RECORDS: readonly CapabilityRecord[] = [
  {
    id: 'mock-planner-v1',
    kind: 'omp-role',
    capabilities: ['planning'],
    mutability: 'READ_ONLY',
    modelTiers: ['MEDIUM', 'HIGH'],
    tools: ['read', 'grep', 'glob'],
    spawns: false,
    supports: ['SINGLE', 'PIPELINE'],
    costClass: 'MEDIUM',
    latencyClass: 'MEDIUM',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#planner',
  },
  {
    id: 'mock-implementer-v1',
    kind: 'omp-role',
    capabilities: ['implementation'],
    mutability: 'MUTATING',
    modelTiers: ['MEDIUM', 'HIGH'],
    tools: ['read', 'edit', 'write', 'bash'],
    spawns: false,
    supports: ['SINGLE', 'PIPELINE'],
    costClass: 'HIGH',
    latencyClass: 'HIGH',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#implementer',
  },
  {
    id: 'mock-behavioral-verifier-v1',
    kind: 'omp-role',
    capabilities: ['behavioral-verification'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM'],
    tools: ['read', 'bash'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'LOW',
    latencyClass: 'MEDIUM',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#behavioral-verifier',
  },
  {
    id: 'mock-conformance-verifier-v1',
    kind: 'omp-role',
    capabilities: ['conformance-verification'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM'],
    tools: ['read', 'bash'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'LOW',
    latencyClass: 'MEDIUM',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#conformance-verifier',
  },
  {
    id: 'mock-independent-reviewer-v1',
    kind: 'omp-role',
    capabilities: ['independent-review'],
    mutability: 'READ_ONLY',
    modelTiers: ['MEDIUM', 'HIGH'],
    tools: ['read', 'grep'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'MEDIUM',
    latencyClass: 'MEDIUM',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#independent-reviewer',
  },
  {
    id: 'mock-adversarial-reviewer-v1',
    kind: 'omp-role',
    capabilities: ['adversarial-review'],
    mutability: 'READ_ONLY',
    modelTiers: ['HIGH'],
    tools: ['read', 'grep'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'HIGH',
    latencyClass: 'HIGH',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#adversarial-reviewer',
  },
  {
    id: 'mock-qa-executor-v1',
    kind: 'omp-role',
    capabilities: ['qa-execution'],
    mutability: 'MUTATING',
    modelTiers: ['LOW', 'MEDIUM'],
    tools: ['read', 'bash'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'LOW',
    latencyClass: 'MEDIUM',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#qa-executor',
  },
  {
    id: 'mock-qa-reviewer-v1',
    kind: 'omp-role',
    capabilities: ['qa-review'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'LOW',
    latencyClass: 'LOW',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#qa-reviewer',
  },
  {
    id: 'mock-security-reviewer-v1',
    kind: 'omp-role',
    capabilities: ['security-review'],
    mutability: 'READ_ONLY',
    modelTiers: ['MEDIUM', 'HIGH'],
    tools: ['read', 'grep'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'MEDIUM',
    latencyClass: 'MEDIUM',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#security-reviewer',
  },
  {
    id: 'mock-security-validator-v1',
    kind: 'omp-role',
    capabilities: ['security-validation'],
    mutability: 'READ_ONLY',
    modelTiers: ['MEDIUM', 'HIGH'],
    tools: ['read', 'bash'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'MEDIUM',
    latencyClass: 'MEDIUM',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#security-validator',
  },
  {
    id: 'mock-ui-designer-v1',
    kind: 'omp-role',
    capabilities: ['ui-design'],
    mutability: 'READ_ONLY',
    modelTiers: ['MEDIUM', 'HIGH'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE'],
    costClass: 'MEDIUM',
    latencyClass: 'MEDIUM',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#ui-designer',
  },
  {
    id: 'mock-ui-implementer-v1',
    kind: 'omp-role',
    capabilities: ['ui-implementation'],
    mutability: 'MUTATING',
    modelTiers: ['MEDIUM', 'HIGH'],
    tools: ['read', 'edit', 'write'],
    spawns: false,
    supports: ['SINGLE'],
    costClass: 'HIGH',
    latencyClass: 'HIGH',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#ui-implementer',
  },
  {
    id: 'mock-ui-design-reviewer-v1',
    kind: 'omp-role',
    capabilities: ['ui-design-review'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE', 'PARALLEL'],
    costClass: 'LOW',
    latencyClass: 'LOW',
    concurrency: 2,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#ui-design-reviewer',
  },
  {
    id: 'mock-ui-visual-verifier-v1',
    kind: 'omp-role',
    capabilities: ['ui-visual-verification'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE'],
    costClass: 'LOW',
    latencyClass: 'LOW',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#ui-visual-verifier',
  },
  {
    id: 'mock-researcher-v1',
    kind: 'omp-role',
    capabilities: ['research'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM', 'HIGH'],
    tools: ['read', 'grep', 'glob'],
    spawns: false,
    supports: ['SINGLE', 'PIPELINE'],
    costClass: 'MEDIUM',
    latencyClass: 'MEDIUM',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#researcher',
  },
  {
    id: 'mock-synthesizer-v1',
    kind: 'omp-role',
    capabilities: ['synthesis'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE', 'PIPELINE'],
    costClass: 'LOW',
    latencyClass: 'LOW',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#synthesizer',
  },
  {
    id: 'mock-preflight-checker-v1',
    kind: 'omp-role',
    capabilities: ['preflight'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE'],
    costClass: 'LOW',
    latencyClass: 'LOW',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#preflight-checker',
  },
  {
    id: 'mock-operator-synthesizer-v1',
    kind: 'omp-role',
    capabilities: ['operator-synthesis'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW', 'MEDIUM'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE'],
    costClass: 'LOW',
    latencyClass: 'LOW',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#operator-synthesizer',
  },
  {
    id: 'mock-scope-freeze-owner-v1',
    kind: 'omp-role',
    capabilities: ['scope-freeze'],
    mutability: 'READ_ONLY',
    modelTiers: ['LOW'],
    tools: ['read'],
    spawns: false,
    supports: ['SINGLE'],
    costClass: 'LOW',
    latencyClass: 'LOW',
    concurrency: 1,
    health: 'HEALTHY',
    source: 'mock:stage3/registry#scope-freeze-owner',
  },
];

// ---------------------------------------------------------------------------
// Stage 4 production `omp-task` capability records
// ---------------------------------------------------------------------------

/** Hard, adapter-wide ceiling on how many native OMP child sessions the
 * `omp-task` adapter may ever have active at once, independent of any
 * per-capability `concurrency` value or configured `OperatorProfile.maxConcurrency`.
 * `compiler.ts` enforces this at compile time as a non-dispatching preflight
 * check (plan §6.1's "adapter availability check", §4.4's "adapter
 * concurrency"): a compiled workflow that would ever need more than this
 * many concurrently dispatched nodes is rejected before any gate opens. */
export const PRODUCTION_MAX_CONCURRENT_NODES = 4;

/** Exact tool grant every Stage 4 read/search-capable package role receives.
 * These are the package-owned custom tools (`operator_read`/`operator_grep`/
 * `operator_glob`) the `omp-task` adapter registers via `defineTool` +
 * `allowRestrictedCustomTools: true`; never the host's ordinary
 * `read`/`grep`/`glob`, and never `edit`/`write`/`bash`/`task`/`hub`. */
const PLANNER_REVIEWER_TOOL_GRANT: readonly string[] = ['operator_read', 'operator_grep', 'operator_glob'];
/** The synthesis role only ever reads declared upstream summaries/artifacts;
 * it never searches, matching `agents/agent-operator-native-synthesis.md`'s
 * `tools: operator_read` frontmatter exactly. */
const SYNTHESIS_TOOL_GRANT: readonly string[] = ['operator_read'];

type ProductionRoleId = 'planner' | 'reviewer' | 'synthesis';

/** Package-relative path of each role definition `omp-task` loads directly
 * (never through the model-facing `task` tool's ambient discovery), and the
 * exact sha256 of its current pinned content — the same bytes
 * `src/adapters/roles.ts`'s `APPROVED_ROLE_MANIFEST` pins independently.
 * This hash is descriptive/traceability-only in this module (it flows into
 * `CapabilityRecord.source`, which has no dispatch-time meaning here); the
 * adapter's own manifest check is the actual security-enforcing gate. */
const PRODUCTION_ROLE_SOURCE: Readonly<Record<ProductionRoleId, { readonly relativePath: string; readonly contentHash: string }>> = {
  planner: {
    relativePath: 'agents/agent-operator-native-planner.md',
    contentHash: 'a8274f741b574a8b50be2cc8fdbf75906b00ed11ab17e91d0239c93ee9f95e38',
  },
  reviewer: {
    relativePath: 'agents/agent-operator-native-reviewer.md',
    contentHash: 'fc0f6aa574aefb4f12beb5500bff769f4307c24c9f7e2357c7f10c6abea009cc',
  },
  synthesis: {
    relativePath: 'agents/agent-operator-native-synthesis.md',
    contentHash: '2c3ef1fa1584bf4f3745706e17d928158aa3c0c6d745975b305a449855d51e41',
  },
};

function productionSource(role: ProductionRoleId): string {
  const { relativePath, contentHash } = PRODUCTION_ROLE_SOURCE[role];
  return `omp-task:${relativePath}#sha256:${contentHash}`;
}

/** Live, non-dispatching preflight evidence a caller (the extension wiring
 * the real `omp-task` adapter, or a test) may supply so each production
 * record's `health` reflects reality instead of an optimistic constant.
 * Defaults to "everything checked out" so `DEFAULT_PRODUCTION_CAPABILITY_RECORDS`
 * is usable out of the box; a real caller is expected to pass its actual
 * adapter-availability and role-hash-verification results here (plan §3.3,
 * §6.1) before wiring a registry into production. */
export interface ProductionCapabilityPreflight {
  /** False when the `omp-task` adapter itself is unavailable (host SDK
   * import failed, no active model resolved, etc.) — makes every record
   * `UNAVAILABLE` regardless of individual role-hash results. */
  readonly adapterAvailable: boolean;
  /** Per-role result of comparing the role file's current on-disk content
   * hash against the approved package manifest (`src/adapters/roles.ts`).
   * `false` makes only that one role's record `UNAVAILABLE`. */
  readonly roleHashVerified: Readonly<Record<ProductionRoleId, boolean>>;
}

const ALL_ROLE_HASHES_VERIFIED: ProductionCapabilityPreflight = {
  adapterAvailable: true,
  roleHashVerified: { planner: true, reviewer: true, synthesis: true },
};

function preflightHealth(role: ProductionRoleId, preflight: ProductionCapabilityPreflight): HealthStatus {
  if (!preflight.adapterAvailable) return 'UNAVAILABLE';
  return preflight.roleHashVerified[role] ? 'HEALTHY' : 'UNAVAILABLE';
}

/**
 * Builds the three Stage 4 production `omp-task` capability records from
 * live preflight evidence. Every record is `kind: 'omp-role'`,
 * `mutability: 'READ_ONLY'` — Stage 4 defines no `MUTATING` production
 * capability at all (plan Excluded scope; Stage 6 owns the first governed
 * mutation role) — and grants exactly the package role's declared
 * `operator_*` tools, never `read`/`grep`/`glob`/`edit`/`write`/`bash`.
 *
 * Capability grouping mirrors the three package roles: the planner record
 * covers every read-only planning/preflight/research/design-drafting node,
 * the reviewer record covers every independent/adversarial/QA/security/
 * conformance/behavioral/visual review and scope-freeze node, and the
 * synthesis record covers both group and final operator-synthesis nodes
 * (`concurrency: 2` so a `research.v1`-style grouped synthesis owner, whose
 * `CapabilityRequirement.executionShape` is `'PARALLEL'` because it shares
 * its group's `groupId`, remains selectable).
 */
export function buildProductionCapabilityRecords(preflight: ProductionCapabilityPreflight = ALL_ROLE_HASHES_VERIFIED): readonly CapabilityRecord[] {
  return [
    {
      id: 'omp-task-native-planner-v1',
      kind: 'omp-role',
      capabilities: ['planning', 'preflight', 'research', 'ui-design'],
      mutability: 'READ_ONLY',
      modelTiers: ['MEDIUM', 'HIGH'],
      tools: PLANNER_REVIEWER_TOOL_GRANT,
      spawns: false,
      supports: ['SINGLE', 'PARALLEL', 'PIPELINE'],
      costClass: 'MEDIUM',
      latencyClass: 'MEDIUM',
      concurrency: 3,
      health: preflightHealth('planner', preflight),
      source: productionSource('planner'),
    },
    {
      id: 'omp-task-native-reviewer-v1',
      kind: 'omp-role',
      capabilities: [
        'independent-review',
        'adversarial-review',
        'qa-review',
        'security-review',
        'conformance-verification',
        'behavioral-verification',
        'ui-visual-verification',
        'scope-freeze',
      ],
      mutability: 'READ_ONLY',
      modelTiers: ['MEDIUM', 'HIGH'],
      tools: PLANNER_REVIEWER_TOOL_GRANT,
      spawns: false,
      supports: ['SINGLE', 'PARALLEL', 'PIPELINE'],
      costClass: 'MEDIUM',
      latencyClass: 'MEDIUM',
      concurrency: 3,
      health: preflightHealth('reviewer', preflight),
      source: productionSource('reviewer'),
    },
    {
      id: 'omp-task-native-synthesis-v1',
      kind: 'omp-role',
      capabilities: ['synthesis', 'operator-synthesis'],
      mutability: 'READ_ONLY',
      modelTiers: ['LOW', 'MEDIUM'],
      tools: SYNTHESIS_TOOL_GRANT,
      spawns: false,
      supports: ['SINGLE', 'PARALLEL', 'PIPELINE'],
      costClass: 'LOW',
      latencyClass: 'LOW',
      concurrency: 2,
      health: preflightHealth('synthesis', preflight),
      source: productionSource('synthesis'),
    },
  ];
}

/** The three Stage 4 production records, all `HEALTHY` (out-of-the-box
 * default; a real wiring should call `buildProductionCapabilityRecords`
 * itself with live preflight evidence instead of relying on this constant). */
export const DEFAULT_PRODUCTION_CAPABILITY_RECORDS: readonly CapabilityRecord[] = buildProductionCapabilityRecords();

// ---------------------------------------------------------------------------
// Constraint evaluation
// ---------------------------------------------------------------------------

const TIER_RANK: Readonly<Record<ModelTier, number>> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Highest model/cost tier rank a given budget profile may spend. `CRITICAL`
 * and `QUALITY` both cap at `HIGH`, the top of the 3-level tier scale — a
 * budget profile can never authorize a tier that doesn't exist. */
const BUDGET_TIER_CAP: Readonly<Record<BudgetProfile, number>> = {
  CHEAP: TIER_RANK.LOW,
  BALANCED: TIER_RANK.MEDIUM,
  QUALITY: TIER_RANK.HIGH,
  CRITICAL: TIER_RANK.HIGH,
};

function minModelTierRank(modelTiers: readonly ModelTier[]): number {
  let min = TIER_RANK.HIGH;
  for (const tier of modelTiers) {
    const rank = TIER_RANK[tier];
    if (rank < min) min = rank;
  }
  return min;
}

interface ConstraintFailure {
  readonly ok: false;
  readonly reasonCode: CapabilitySelectionReasonCode;
  readonly detail: string;
}

interface ConstraintSuccess {
  readonly ok: true;
}

type ConstraintCheck = ConstraintFailure | ConstraintSuccess;

/** Evaluates every hard constraint for one candidate record against one
 * requirement. Order matters only for which single failure reason is
 * reported first; every check listed here is independently sufficient to
 * reject the candidate. */
export type RegistryMode = 'test' | 'production';

function evaluateCandidate(
  record: CapabilityRecord,
  requirement: CapabilityRequirement,
  budgetProfile: BudgetProfile,
  priorSelections: ReadonlyMap<string, CapabilityRecord>,
  mode: RegistryMode,
): ConstraintCheck {
  // Hardcoded safety invariant, independent of policy: this registry can
  // never select a real-provider-bearing record.
  if (record.kind !== 'omp-role') {
    return { ok: false, reasonCode: 'EXTERNAL_PROVIDER_DISABLED', detail: `capability "${record.id}" has kind "${record.kind}"; external providers are disabled` };
  }

  // Hardcoded safety invariant for the production registry only: no mock
  // (or any other non-`omp-task:`-sourced) record may ever dispatch through
  // it, even if one is present in its `records` array. `test`-mode
  // registries (Stage 1-3 behavior, unchanged) allow any `omp-role` record.
  if (mode === 'production' && !record.source.startsWith('omp-task:')) {
    return {
      ok: false,
      reasonCode: 'PRODUCTION_MOCK_FORBIDDEN',
      detail: `capability "${record.id}" source "${record.source}" is not an approved omp-task production record; mock and unapproved records cannot dispatch in production`,
    };
  }

  if (!record.capabilities.includes(requirement.capability)) {
    return {
      ok: false,
      reasonCode: 'CAPABILITY_MISMATCH',
      detail: `capability "${record.id}" does not declare required capability "${requirement.capability}"`,
    };
  }

  if (!record.supports.includes(requirement.executionShape)) {
    return {
      ok: false,
      reasonCode: 'EXECUTION_SHAPE_UNSUPPORTED',
      detail: `capability "${record.id}" does not support execution shape "${requirement.executionShape}"`,
    };
  }

  if (record.health !== 'HEALTHY') {
    return { ok: false, reasonCode: 'CAPABILITY_UNHEALTHY', detail: `capability "${record.id}" health is "${record.health}", not "HEALTHY"` };
  }

  const requiredMutability = requirement.mutationClass === 'READ_ONLY' ? 'READ_ONLY' : 'MUTATING';
  if (record.mutability !== requiredMutability) {
    return {
      ok: false,
      reasonCode: 'MUTATION_CLASS_INCOMPATIBLE',
      detail: `capability "${record.id}" mutability "${record.mutability}" is incompatible with requirement mutation class "${requirement.mutationClass}" (needs "${requiredMutability}")`,
    };
  }

  const tierCap = BUDGET_TIER_CAP[budgetProfile];
  if (minModelTierRank(record.modelTiers) > tierCap) {
    return {
      ok: false,
      reasonCode: 'BUDGET_MODEL_TIER_EXCEEDED',
      detail: `capability "${record.id}" cheapest model tier exceeds the cap for budget profile "${budgetProfile}"`,
    };
  }
  if (TIER_RANK[record.costClass] > tierCap) {
    return {
      ok: false,
      reasonCode: 'BUDGET_COST_TIER_EXCEEDED',
      detail: `capability "${record.id}" cost class "${record.costClass}" exceeds the cap for budget profile "${budgetProfile}"`,
    };
  }

  if (requirement.executionShape === 'PARALLEL' && record.concurrency < 2) {
    return {
      ok: false,
      reasonCode: 'INSUFFICIENT_CONCURRENCY',
      detail: `capability "${record.id}" concurrency ${record.concurrency} cannot service a PARALLEL requirement (needs >= 2)`,
    };
  }

  for (const otherRole of requirement.independentFromRoles) {
    const otherSelection = priorSelections.get(otherRole);
    if (otherSelection !== undefined && otherSelection.id === record.id) {
      return {
        ok: false,
        reasonCode: 'INDEPENDENCE_VIOLATION',
        detail: `capability "${record.id}" was already assigned to role "${otherRole}"; requirement demands independence from it`,
      };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

class CapabilityRegistryImpl implements CapabilityRegistry {
  readonly records: readonly CapabilityRecord[];
  readonly #byId: ReadonlyMap<string, CapabilityRecord>;
  readonly #selectionsByRole = new Map<string, CapabilityRecord>();
  readonly #mode: RegistryMode;

  constructor(records: readonly CapabilityRecord[], mode: RegistryMode) {
    this.records = records;
    this.#mode = mode;
    const byId = new Map<string, CapabilityRecord>();
    for (const record of records) byId.set(record.id, record);
    this.#byId = byId;
  }

  select(requirement: CapabilityRequirement, policy: ResolvedPolicy): CapabilitySelection {
    const assignment: CapabilityPreference | undefined = policy.config.profile.capabilityAssignments[requirement.role];
    if (assignment === undefined) {
      throw new CapabilitySelectionError(
        `no capability assignment configured for role "${requirement.role}"`,
        requirement,
        'NO_CAPABILITY_ASSIGNMENT',
      );
    }

    const preferredRecord = this.#byId.get(assignment.preferred);
    if (preferredRecord === undefined) {
      throw new CapabilitySelectionError(
        `preferred capability id "${assignment.preferred}" for role "${requirement.role}" is not registered`,
        requirement,
        'UNKNOWN_CAPABILITY_ID',
      );
    }

    const preferredCheck = evaluateCandidate(preferredRecord, requirement, policy.budgetProfile, this.#selectionsByRole, this.#mode);
    if (preferredCheck.ok) {
      return this.#commit(requirement, preferredRecord, 'PREFERRED_ASSIGNMENT_MATCH', undefined);
    }

    if (assignment.fallbackPolicy !== 'COMPATIBLE_ONLY') {
      const policyNote = assignment.fallbackPolicy === 'DISABLED' ? 'fallbackPolicy is "DISABLED"' : 'fallbackPolicy is "HUMAN_REQUIRED"';
      throw new CapabilitySelectionError(
        `preferred capability "${assignment.preferred}" for role "${requirement.role}" is unavailable (${preferredCheck.detail}) and ${policyNote}, so no fallback may be attempted`,
        requirement,
        preferredCheck.reasonCode,
      );
    }

    // assignment.fallbackPolicy === 'COMPATIBLE_ONLY': only now may we walk
    // the declared fallback list, and only records that pass every hard
    // constraint may be selected.
    for (const fallbackId of assignment.fallbacks) {
      const fallbackRecord = this.#byId.get(fallbackId);
      if (fallbackRecord === undefined) continue;
      const fallbackCheck = evaluateCandidate(fallbackRecord, requirement, policy.budgetProfile, this.#selectionsByRole, this.#mode);
      if (fallbackCheck.ok) {
        return this.#commit(requirement, fallbackRecord, 'COMPATIBLE_FALLBACK_MATCH', assignment.preferred);
      }
    }

    throw new CapabilitySelectionError(
      `no compatible capability for role "${requirement.role}": preferred "${assignment.preferred}" failed (${preferredCheck.detail}) and no declared fallback among [${assignment.fallbacks.join(', ')}] satisfied every constraint`,
      requirement,
      'NO_COMPATIBLE_FALLBACK',
    );
  }

  #commit(
    requirement: CapabilityRequirement,
    record: CapabilityRecord,
    reasonCode: 'PREFERRED_ASSIGNMENT_MATCH' | 'COMPATIBLE_FALLBACK_MATCH',
    fallbackFrom: string | undefined,
  ): CapabilitySelection {
    this.#selectionsByRole.set(requirement.role, record);
    // Provider is derived from the record's own `source` prefix
    // (`"mock:..."` -> `"mock"`, `"omp-task:..."` -> `"omp-task"`) rather
    // than hardcoded, so the same class serves both the Stage 1-3 mock
    // registry and the Stage 4 production registry with an honest
    // `RouteDecision.selectedRolesProviders` provider label either way.
    const provider = record.source.split(':', 1)[0] ?? record.source;
    return {
      requirement,
      selected: record,
      provider,
      ...(fallbackFrom !== undefined ? { fallbackFrom } : {}),
      reasonCode,
    };
  }
}

/** Creates a fresh, stateful mock `CapabilityRegistry`. Defaults to
 * `DEFAULT_MOCK_CAPABILITY_RECORDS` when `records` is omitted. Independence
 * tracking (`CapabilityRequirement.independentFromRoles`) is scoped to this
 * single instance across its ordered `select()` calls: callers MUST create a
 * new registry per workflow compilation rather than reusing one across
 * requests, or stale role→record state will leak between compiles. */
export function createMockCapabilityRegistry(records: readonly CapabilityRecord[] = DEFAULT_MOCK_CAPABILITY_RECORDS): CapabilityRegistry {
  return new CapabilityRegistryImpl(records, 'test');
}

/** Creates a fresh, stateful production `CapabilityRegistry`. Defaults to
 * `DEFAULT_PRODUCTION_CAPABILITY_RECORDS` (the three Stage 4 `omp-task`
 * roles, all `HEALTHY`) when `records` is omitted. Unlike
 * `createMockCapabilityRegistry`, every `select()` call on the returned
 * registry additionally rejects any candidate record — preferred or
 * fallback, even one accidentally present in `records` — whose `source` is
 * not tagged `omp-task:` (`PRODUCTION_MOCK_FORBIDDEN`), so a mock record can
 * never dispatch through it. Same per-instance independence-tracking
 * caveat as `createMockCapabilityRegistry` applies. */
export function createProductionCapabilityRegistry(records: readonly CapabilityRecord[] = DEFAULT_PRODUCTION_CAPABILITY_RECORDS): CapabilityRegistry {
  return new CapabilityRegistryImpl(records, 'production');
}

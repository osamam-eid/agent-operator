/**
 * Agent Operator — Stage 4 extension registration.
 *
 * Registers exactly one command, `operator`, wired to the `/operator`
 * runtime (`OperatorRuntime`), plus a `session_shutdown` handler that
 * aborts every active execution batch through `ExecutionCoordinator`.
 *
 * This is the *only* module in the package that imports a real
 * `@oh-my-pi/pi-coding-agent` symbol (type-only for the activation/context
 * shapes, value imports for the five SDK primitives the plan authorizes:
 * `createAgentSession`, `SessionManager`, `Settings`, `AgentRegistry`,
 * `discoverAuthStorage`/`ModelRegistry`, plus the four safe-tool factories
 * `createReadToolDefinition`/`createGrepToolDefinition`/
 * `createFindToolDefinition`/`defineTool`). Every downstream module
 * (`controller.ts`, `execution-coordinator.ts`, `adapters/omp-task.ts`,
 * `context-projection.ts`, `safe-tools.ts`) stays SDK-independent and is
 * exercised by its own tests through structural fakes; this file is where
 * those structural seams (`OmpHostSdk`, `OperatorToolFactories`,
 * `NodeContextProjector`) meet the genuine host.
 *
 * Dependency wiring (per `OperatorRuntimeDependencies`):
 *  - store:               `FileOperatorSessionStore`, rooted at
 *                          `OMP_AGENT_OPERATOR_STATE_DIR` when set,
 *                          otherwise `~/.omp/state/agent-operator`.
 *  - clock / ids:         real system clock / `node:crypto` `randomUUID`.
 *  - nodeExecutionAdapterResolver: the exact tuple resolver whose frozen
 *    path returns the existing `omp-task` object and whose Stage-7 path is
 *    empty in 7A, so v2 dispatch fails closed until 7B/7C.
 *  - contextProjector:    `materializeProjection` wrapped to build a
 *                          `NodeExecutionRequest` from a node's declared
 *                          `consumes`/artifacts/evidence.
 *  - nodeTimeoutMs:        a fixed, finite per-budget-profile ceiling.
 *  - compiler:             `createStage3WorkflowCompiler()`.
 *  - registerActiveBatch:  `ExecutionCoordinator.registerActiveBatch`,
 *                          bound to the runtime's own `getActiveBatch` /
 *                          `completeBatch` / `timeoutBatch` /
 *                          `shutdownActive`.
 *
 * All dependencies are constructed once, at extension activation, and
 * reused across every `/operator` invocation for this process.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';

import {
  AgentRegistry,
  createAgentSession,
  SessionManager,
  Settings,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from '@oh-my-pi/pi-coding-agent';
// The four legacy tool-definition factories the plan authorizes
// (`createReadToolDefinition`/`createGrepToolDefinition`/
// `createFindToolDefinition`/`defineTool`) live only under the package's
// legacy compatibility shim, not the root barrel (verified against the
// published `@oh-my-pi/pi-coding-agent@17.3.5` `dist/types` output).
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createReadToolDefinition,
  defineTool,
} from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim';
import { FileOperatorSessionStore } from '../src/store.js';

import { createOmpSdkSessionFactory, createOmpTaskAdapter, type OmpCustomToolDefinition, type OmpHostSdk, type OmpToolFactories } from '../src/adapters/omp-task.js';
import { createStage3WorkflowCompiler, type Stage3WorkflowCompilerOptions } from '../src/compiler.js';
import type { CapabilityRequirement, CapabilitySelection, ClassificationProposal } from '../src/stage3-types.js';
import { loadResolvedOperatorConfig, resolveProviderCatalogPath } from '../src/config.js';
import { loadCatalogFile as loadFleetCatalog } from '../src/fleet-catalog.js';
import { createExternalCliAdapter } from '../src/adapters/external-cli.js';
import { createEvaluatorHandler } from '../src/evaluator/service.js';
import { normalizeProviderCatalog, normalizedProviderToCapabilityRecord, selectProviderRecord, type ProviderCatalog, type ProviderPreferencePolicy } from '../src/provider-fleet.js';
import { createSemanticOperatorClassifier } from '../src/semantic-classifier.js';
import { createShadowRoutingService, FileShadowObservationStore } from '../src/shadow-routing.js';
import { createProviderIntelligenceService, FileProviderIntelligenceStore } from '../src/provider-intelligence.js';
import { createPolicySimulationService } from '../src/policy-simulation.js';
import { createSemanticCanaryCommand } from '../src/intelligence-activation.js';
import { FileIntelligenceActivationStore, createIntelligenceActivationService } from '../src/intelligence-activation.js';
import { createIntelligenceLifecycleHandler } from '../src/intelligence-lifecycle.js';
import { createRecoveryPackagePort, FileRecoveryPackageStore } from '../src/execution-safety.js';
import type { ArtifactManifest, Evidence, ExecutionGraphNode } from '../src/contracts.js';
import { createOperatorRuntime, type OperatorRuntime } from '../src/controller.js';
import { collectSharedProjectSources, materializeProjection } from '../src/context-projection.js';
import {
  adaptHostTimerScheduler,
  assertProductionAdapter,
  ExecutionCoordinator,
  type SupervisedFailure,
} from '../src/execution-coordinator.js';
import type {
  NodeContextProjection,
  NodeExecutionAttemptAllocation,
  NodeExecutionRequest,
  OperatorClock,
  OperatorIdFactory,
  StoredOperatorSession,
} from '../src/runtime-types.js';
import { createOperatorSafeTools, OPERATOR_SAFE_TOOL_NAMES, type AgentToolDefinition, type OperatorToolFactories } from '../src/safe-tools.js';
import { createNodeExecutionAdapterResolver, readTrustedStage7StartupFeatureSet, STAGE7_BINDINGS } from '../src/stage7/index.js';

class SystemClock implements OperatorClock {
  now(): string {
    return new Date().toISOString();
  }
}

class RandomIdFactory implements OperatorIdFactory {
  next(prefix: 'session' | 'graph' | 'gate' | 'result' | 'batch' | 'providerSession'): string {
    return `${prefix}-${randomUUID()}`;
  }
}

/** Per-`(operatorSessionId, nodeId)` attempt count, bounding how many
 * distinct projection directories this process will ever materialize —
 * Stage 4 permits exactly one attempt per node, so this only ever reaches
 * 1, but the counter keeps directory names unique under a crash/resume
 * that re-registers the same node. */
function projectionDirName(allocation: NodeExecutionAttemptAllocation): string {
  return `${allocation.operatorSessionId}-${allocation.nodeId}-${allocation.attemptId}`;
}

/** `NodeContextProjector`: translates one node's declared inputs into a
 * materialized, read-only projection via `materializeProjection`, then
 * builds the minimized `NodeExecutionRequest` the adapter prompts with.
 * Never passes the full `OperatorSession`. */
function createOperatorContextProjector(deps: { readonly projectRoot: string; readonly projectionsRoot: string }) {
  return {
    async project(params: {
      readonly record: StoredOperatorSession;
      readonly node: ExecutionGraphNode;
      readonly allocation: NodeExecutionAttemptAllocation;
    }): Promise<NodeExecutionRequest> {
      const { record, node, allocation } = params;
      const artifactsById = new Map<string, ArtifactManifest>(record.session.artifacts.map((a) => [a.artifactId, a]));
      const evidenceById = new Map<string, Evidence>(record.session.evidence.map((e) => [e.evidenceId, e]));
      const consumedArtifacts = node.consumes.map((ref) => artifactsById.get(ref)).filter((a): a is ArtifactManifest => a !== undefined);
      const consumedEvidence = node.consumes.map((ref) => evidenceById.get(ref)).filter((e): e is Evidence => e !== undefined);
      const dependencyResultSummaries = node.dependsOn.map((nodeId) => {
        const dependencyResult = record.nodeResultRefs[nodeId];
        if (dependencyResult === undefined) {
          throw new Error(`Dependency "${nodeId}" has no validated terminal result available for node "${node.nodeId}".`);
        }
        return { nodeId, status: dependencyResult.status, summary: dependencyResult.summary };
      });

      // `Evidence` (contracts.ts) carries no file path of its own — only an
      // optional `artifact` back-reference to the `ArtifactManifest` that
      // backs it (when the evidence is grounded in a stored artifact).
      // Evidence without a backing artifact (e.g. `HUMAN_STATEMENT`,
      // `EXTERNAL_SOURCE`) has nothing to materialize as a file; its claim
      // is still inlined into the child's prompt via `consumedEvidence`
      // (see `buildTaskPrompt`/`renderEvidence` in `adapters/omp-task.ts`).
      const evidenceArtifactSources = consumedEvidence
        .map((e) => (e.artifact !== undefined ? artifactsById.get(e.artifact) : undefined))
        .filter((a): a is ArtifactManifest => a !== undefined)
        .map((a) => ({ label: `evidence-artifact:${a.artifactId}`, absolutePath: a.location }));

      const limits = { maxFiles: 200, maxTotalBytes: 25_000_000, maxFileBytes: 5_000_000 } as const;
      const sharedProjectSources = node.contextPolicy === 'shared' ? await collectSharedProjectSources(deps.projectRoot, limits.maxFiles) : [];
      const sources = [
        ...sharedProjectSources,
        ...consumedArtifacts.map((a) => ({ label: `artifact:${a.artifactId}`, absolutePath: a.location })),
        ...evidenceArtifactSources,
      ];

      const materialized = await materializeProjection({
        destinationRoot: join(deps.projectionsRoot, projectionDirName(allocation)),
        allowedRoots: [deps.projectRoot],
        sources,
        limits,

      });

      const projection: NodeContextProjection = {
        projectionRoot: materialized.projectionRoot,
        allowedPaths: [materialized.projectionRoot],
        manifestHash: materialized.manifest.manifestDigest,
        sourceLabels: materialized.manifest.entries.map((e) => e.label),
      };

      return {
        allocation,
        node,
        requestOrSummary: record.session.originalRequest,
        consumedArtifacts,
        consumedEvidence,
        dependencyResultSummaries,
        projection,
        policyRefs: [],
        instructions: `Execute node "${node.nodeId}" (role "${node.role}") for operator session "${record.session.operatorSessionId}".`,
        acceptanceCriteria: [],
        toolGrant: [...OPERATOR_SAFE_TOOL_NAMES],
        mutationClass: node.mutation?.mutationClass ?? 'READ_ONLY',
        outputSchemaId: 'agent-result.v1',
      };
    },
  };
}

/** `omp-task.ts`'s `OmpToolFactories` boundary is deliberately SDK-
 * independent: its factories return the narrow structural
 * `OmpCustomToolDefinition` (`{ name, [key: string]: unknown }`) so that
 * module never needs the real SDK installed. `safe-tools.ts`'s
 * `OperatorToolFactories` boundary needs the genuine `execute` method
 * (`AgentToolDefinition`) to wrap it safely. Both boundaries are always
 * satisfied by the exact same production values — the real
 * `@oh-my-pi/pi-coding-agent` legacy tool factories imported above — so
 * this only re-narrows the *type* at the seam with a runtime-verified
 * assertion, never `any`/`ts-ignore`. */
function asAgentToolDefinition(definition: OmpCustomToolDefinition): AgentToolDefinition {
  if (typeof definition['execute'] !== 'function') {
    throw new TypeError(`SDK tool definition "${definition.name}" has no callable "execute"`);
  }
  return definition as OmpCustomToolDefinition & AgentToolDefinition;
}

function adaptToOperatorToolFactories(factories: OmpToolFactories): OperatorToolFactories {
  return {
    createReadToolDefinition: (cwd, options) => asAgentToolDefinition(factories.createReadToolDefinition(cwd, options)),
    createGrepToolDefinition: (cwd, options) => asAgentToolDefinition(factories.createGrepToolDefinition(cwd, options)),
    createFindToolDefinition: (cwd, options) => asAgentToolDefinition(factories.createFindToolDefinition(cwd, options)),
    defineTool: (definition) => asAgentToolDefinition(factories.defineTool(definition)),
  };
}

/** The real `@oh-my-pi/pi-coding-agent` legacy tool factories, narrowed to
 * `OmpToolFactories`'s deliberately SDK-independent shape. Two seams need
 * bridging here, both via a targeted `as`/`as unknown as` (never `any`/
 * `ts-ignore`): the real factories accept concretely-typed `options`
 * (`ReadToolOptions`, ...) where `OmpToolFactories` declares `unknown` —
 * safe because every call site (`safe-tools.ts`) only ever forwards a
 * plain options object or `undefined`; and the real return type
 * (`ToolDefinition`) has no index signature, which `OmpCustomToolDefinition`
 * requires structurally even though every property is index-compatible. */
const PRODUCTION_TOOL_FACTORIES: OmpToolFactories = {
  createReadToolDefinition: (cwd, options) => createReadToolDefinition(cwd, options as Parameters<typeof createReadToolDefinition>[1]) as unknown as OmpCustomToolDefinition,
  createGrepToolDefinition: (cwd, options) => createGrepToolDefinition(cwd, options as Parameters<typeof createGrepToolDefinition>[1]) as unknown as OmpCustomToolDefinition,
  createFindToolDefinition: (cwd, options) => createFindToolDefinition(cwd, options as Parameters<typeof createFindToolDefinition>[1]) as unknown as OmpCustomToolDefinition,
  defineTool: (definition) => defineTool(definition as unknown as Parameters<typeof defineTool>[0]) as unknown as OmpCustomToolDefinition,
};

/** Real `OmpHostSdk`: the five SDK primitives `createOmpSdkSessionFactory`
 * needs, each constructed exactly as plan §3.1/§3.2 (as corrected by the
 * locally verified OMP 17.3.5 API inspection) requires — no `mcpServers` override, no `spawns`
 * option, `allowRestrictedCustomTools: true` handled by the adapter's own
 * `createAgentSession` call, this object only supplies the four factory
 * methods that call is built from. */
function createProductionHostSdk(deps: { readonly providerSessionRoot: string }): OmpHostSdk {
  return {
    createAgentSession: (options) => createAgentSession(options as Parameters<typeof createAgentSession>[0]),
    createAgentRegistry: () => new AgentRegistry(),
    createSessionManager: (cwd: string, _providerSessionId: string) => SessionManager.create(cwd, deps.providerSessionRoot),
    createIsolatedSettings: () =>
      Settings.isolated({
        'async.enabled': false,
        'bash.autoBackground.enabled': false,
        'retry.enabled': false,
        'compaction.enabled': false,
        'memory.backend': 'off',
        'autolearn.enabled': false,
        'advisor.enabled': false,
        'skills.enabled': false,
      }),
  };
}

const COMMAND_DESCRIPTION = 'Governed workflow controller v1.0.0 — classified, gate-checked workflows. Bare `/operator` lists all subcommands.';

/** OMP command-picker suggestions while the first argument is being typed
 * (same interaction as /coach): arrow-navigable labels with descriptions. */
const OPERATOR_SUBCOMMANDS: ReadonlyArray<{ label: string; description: string; hint?: string }> = [
  { label: 'status', description: 'Show current session and node states' },
  { label: 'graph', description: 'Render the active session graph' },
  { label: 'why', description: 'Explain routing and provider decisions' },
  { label: 'explain', description: 'Routing explanation for a request', hint: '<request>' },
  { label: 'continue', description: 'Drive the paused session forward' },
  { label: 'cancel', description: 'Cancel the active session' },
  { label: 'approve', description: 'Approve one pending human gate', hint: '<gate-id>' },
  { label: 'reject', description: 'Reject one pending human gate', hint: '<gate-id>' },
  { label: 'resume', description: 'Reload a persisted session after restart', hint: '<operator-session-id>' },
  { label: 'simulate', description: 'Compile and preflight without state or dispatch', hint: '<request>' },
  { label: '--dry-run', description: 'Alias for side-effect-free simulation', hint: '<request>' },
  { label: 'shadow', description: 'Semantic shadow routing: on / off / status / evaluate', hint: '<subcommand>' },
  { label: '--family', description: 'Select the task family explicitly', hint: '<FAMILY> <request>' },
  { label: '--explain', description: 'Explain routing without executing', hint: '<request>' },
  { label: 'competence', description: 'Inspect evidence-derived provider scorecards', hint: 'status | show <provider> [model]' },
  { label: 'policy', description: 'Compare a proposed policy without applying it', hint: 'test --proposed <path> <request>' },
  { label: 'canary', description: 'Run bounded fixed provider qualification cases', hint: 'run <provider> [model]' },
  { label: 'improve', description: 'Evaluator: harvest, corpus, evaluate, compare, generate', hint: '<subcommand>' },
  { label: 'fleet', description: 'Manage provider fleet catalog (bootstrap / list / remove)' },
];

const FLEET_SUBCOMMANDS: ReadonlyArray<{ label: string; description: string; hint?: string }> = [
  { label: 'list', description: 'Show curated fleet providers' },
  { label: 'bootstrap', description: 'Project your OMP providers into the catalog', hint: '[--models <path>]' },
  { label: 'remove', description: 'Remove one provider from the catalog', hint: '<provider-id>' },
  { label: 'combo', description: 'Define a provider combo (e.g. your council roster)', hint: '<name> <provider1> [provider2 ...]' },
];

function __logCompletion(prefix: string): void {
  try {
    appendFileSync('/tmp/op-completions.log', `${JSON.stringify(prefix)}\n`);
  } catch { /* diagnostics must never break the UI */ }
}

export function completeOperatorSubcommand(argumentPrefix: string): Array<{ value: string; label: string; description: string; hint?: string }> | null {
  __logCompletion(argumentPrefix);
  const tokens = argumentPrefix.trim().split(/\s+/).filter((token) => token.length > 0);
  const endsWithSpace = /\s$/.test(argumentPrefix);
  const partial = endsWithSpace ? '' : (tokens[tokens.length - 1] ?? '').toLowerCase();

  // Top level: `/operator`, `/operator s…` — the original working menu.
  if (tokens[0]?.toLowerCase() !== 'fleet') {
    if (tokens.length > 1) return null;
    const matches = OPERATOR_SUBCOMMANDS.filter((item) => item.label.startsWith(partial));
    return matches.map((item) => ({ ...item, value: item.label }));
  }

  // `/operator fleet` or `/operator fleet <partial>` — fleet submenu.
  if (tokens.length === 1) {
    return FLEET_SUBCOMMANDS.map((item) => ({ ...item, value: `fleet ${item.label}` }));
  }
  if (tokens.length === 2 && !endsWithSpace) {
    const typed = (tokens[1] ?? '').toLowerCase();
    const matches = FLEET_SUBCOMMANDS.filter((item) => item.label.startsWith(typed));
    return matches.map((item) => ({ ...item, value: `fleet ${item.label}` }));
  }

  // `fleet combo` stages.
  if ((tokens[1] ?? '').toLowerCase() === 'combo') {
    try {
      if (tokens.length === 2) {
        return [{ value: 'fleet combo council', label: 'council', description: 'Roster used by council.v1 debates', hint: '<provider1> [provider2 ...]' }];
      }
      if (tokens.length === 3 && !endsWithSpace) {
        const combosPath = join(dirname(resolveProviderCatalogPath()), 'combos.json');
        const names: Array<{ label: string; description: string }> = [{ label: 'council', description: 'Roster used by council.v1 debates' }];
        if (existsSync(combosPath)) {
          const saved = JSON.parse(readFileSync(combosPath, 'utf8')) as Record<string, string[]>;
          for (const [name, providers] of Object.entries(saved)) names.push({ label: name, description: `extend roster (${providers.join(', ')})` });
        }
        const typed = (tokens[2] ?? '').toLowerCase();
        return names.filter((item) => item.label.startsWith(typed)).map((item) => ({ value: `fleet combo ${item.label}`, label: item.label, description: item.description }));
      }
      const providerStage = tokens.length >= 4 || (endsWithSpace && tokens.length >= 3);
      if (providerStage) {
        const loaded = loadFleetCatalog(resolveProviderCatalogPath());
        const catalog = loaded ?? { providers: [] };
        if (catalog.providers.length === 0) return null;
        const comboName = String(tokens[2]);
        // The last token is the INCOMPLETE provider being typed — it is not
        // part of the roster yet, so it must not leak into chosen/persisted.
        const settled = endsWithSpace ? tokens.slice(3) : tokens.slice(3, -1);
        const chosen = new Set(settled.map((token) => token.toLowerCase()));
        return catalog.providers
          .map((entry) => String(entry['providerId']))
          .filter((id) => !chosen.has(id.toLowerCase()) && id.toLowerCase().startsWith(partial))
          .map((id) => ({ value: `fleet combo ${comboName} ${[...chosen, id].join(' ')}`, label: id, description: `add to ${comboName}, Enter saves` }));
      }
      return null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Builds the Stage 4 runtime once, from real (non-mock) dependencies, and
 * returns a bound command handler plus the `ExecutionCoordinator` a
 * `session_shutdown` hook must drain. `assertProductionAdapter` fails
 * activation outright if this path is ever reached with a `'mock'`
 * adapter — a violated invariant, not a runtime condition to recover from.
 */
function buildOperatorRuntime(): { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>; coordinator: ExecutionCoordinator } {
  const clock = new SystemClock();
  const ids = new RandomIdFactory();

  const configuredStateDir = process.env['OMP_AGENT_OPERATOR_STATE_DIR'];
  const rootDir = configuredStateDir && configuredStateDir.length > 0 ? configuredStateDir : join(homedir(), '.omp', 'state', 'agent-operator');

  const configuredProjectRoot = process.env['OMP_AGENT_OPERATOR_PROJECT_ROOT'];
  const projectRoot = configuredProjectRoot && configuredProjectRoot.length > 0 ? configuredProjectRoot : process.cwd();

  const providerSessionRoot = join(rootDir, 'provider-sessions');
  const projectionsRoot = join(rootDir, 'projections');
  // Both projection materialization and the SDK's file-backed
  // SessionManager require their parent directories to exist. Create the
  // package-owned roots once at activation; per-attempt directories remain
  // fresh and are still rejected if they already exist.
  mkdirSync(providerSessionRoot, { recursive: true, mode: 0o700 });
  mkdirSync(projectionsRoot, { recursive: true, mode: 0o700 });


  const startupFeatureSet = readTrustedStage7StartupFeatureSet();
  let fleetCatalog: ProviderCatalog | undefined;
  const fleetSafeToolNames: readonly string[] = [...OPERATOR_SAFE_TOOL_NAMES];
  if (startupFeatureSet.stage9ExternalProvidersEnabled) {
    // Fail activation closed when Stage 9 is enabled but the operator-owned
    // catalog is absent or invalid; fleet dispatch must never silently no-op.
    const catalogPath = resolveProviderCatalogPath();
    fleetCatalog = normalizeProviderCatalog(JSON.parse(readFileSync(catalogPath, 'utf8')) as unknown, new Date().toISOString());
  }
  const providerIntelligence = createProviderIntelligenceService(new FileProviderIntelligenceStore(join(rootDir, 'intelligence')));
  const store = new FileOperatorSessionStore({ rootDir });
  const fleetCapabilitySelect = fleetCatalog === undefined
    ? undefined
    : (requirement: CapabilityRequirement): CapabilitySelection => {
        const catalogNow = fleetCatalog as NonNullable<typeof fleetCatalog>;
        const eligible = catalogNow.records
          .filter((candidate) => candidate.kind === 'external-cli' && candidate.health === 'HEALTHY' && candidate.auth === 'AUTHENTICATED' && candidate.mutability === 'READ_ONLY' && candidate.capabilities.includes(requirement.capability))
          .sort((first, second) => first.providerId.localeCompare(second.providerId));
        const primary = eligible[0];
        if (primary === undefined) throw new Error(`Fleet catalog has no eligible external-cli provider for capability "${requirement.capability}".`);
        const preference: ProviderPreferencePolicy = {
          preferredProvider: primary.providerId,
          fallbackProviders: eligible.slice(1).map((candidate) => candidate.providerId),
          allowExternalProviders: true,
          allowUndisclosedModels: false,
          fallbackPolicy: 'COMPATIBLE_ONLY',
        };
        const { selection, record, model } = selectProviderRecord(catalogNow, {
          role: requirement.role,
          capability: requirement.capability,
          executionShape: 'SINGLE',
          mutationClass: requirement.mutationClass,
          toolCeiling: [...OPERATOR_SAFE_TOOL_NAMES],
          preference,
        });
        return {
          requirement,
          selected: normalizedProviderToCapabilityRecord(record, model, requirement.capability),
          provider: selection.providerId,
          reasonCode: selection.reasonCode,
          ...(selection.fallbackFrom !== undefined ? { fallbackFrom: selection.fallbackFrom } : {}),
        };
      };
  const compilerOptions: Stage3WorkflowCompilerOptions = {
    stage7FeatureSet: startupFeatureSet,
    ...(fleetCapabilitySelect === undefined ? {} : { fleetCapabilitySelect }),
  };
  const compiler = createStage3WorkflowCompiler(compilerOptions);
  const policySimulation = createPolicySimulationService({
    loadCurrentConfig: (root) => loadResolvedOperatorConfig({ projectRoot: root }),
    readProposed: async (proposedPath) => {
      const candidate = resolve(projectRoot, proposedPath);
      const rel = relative(projectRoot, candidate);
      if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error('Proposed policy path must stay inside the project root.');
      const stats = lstatSync(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Proposed policy must be a regular non-symlink file.');
      return readFileSync(candidate, 'utf8');
    },
    compileWithConfig: (request, context, config) =>
      createStage3WorkflowCompiler({ ...compilerOptions, loadConfig: async () => config }).compile(request, context),
  });
  const contextProjector = createOperatorContextProjector({ projectRoot, projectionsRoot });

  const hostSdk = createProductionHostSdk({ providerSessionRoot });
  const sessionFactory = createOmpSdkSessionFactory(hostSdk, providerSessionRoot);
  let selectedModel: { provider: string; id: string; sdkModel: unknown } | undefined;
  const semanticClassifier = createSemanticOperatorClassifier({
    sessionFactory,
    resolveModel: () => {
      if (selectedModel === undefined) throw new Error('No active OMP model is available for semantic classification.');
      return selectedModel;
    },
  });
  const shadowRouting = createShadowRoutingService({
    classifier: semanticClassifier,
    store: new FileShadowObservationStore(join(rootDir, 'shadow')),
    compileCandidate: (proposal: ClassificationProposal, context) =>
      createStage3WorkflowCompiler({
        ...compilerOptions,
        classifier: { classify: () => proposal },
      }).compile(context.familyOverride === undefined ? 'semantic shadow request' : `semantic shadow ${context.familyOverride}`, context),
  });
  const intelligenceActivation = createIntelligenceActivationService(new FileIntelligenceActivationStore(join(rootDir, 'intelligence-active')));
  const recoveryPort = createRecoveryPackagePort(new FileRecoveryPackageStore(join(rootDir, 'recovery')));
  const providerCanary = createSemanticCanaryCommand({
    classifier: semanticClassifier,
    intelligence: providerIntelligence,
    resolveModel: () => {
      if (selectedModel === undefined) throw new Error('No active OMP model is available for provider canaries.');
      return selectedModel;
    },
    projectRoot,
    now: () => new Date().toISOString(),
  });

  const nodeExecutionAdapter = createOmpTaskAdapter({
    sessionFactory,
    resolveModel: () => {
      if (selectedModel === undefined) throw new Error('No active OMP model is available for Agent Operator dispatch.');
      return selectedModel;
    },
    toolFactories: PRODUCTION_TOOL_FACTORIES,
    createSafeTools: (projectionRoot, factories) => createOperatorSafeTools({ projectionRoot, factories: adaptToOperatorToolFactories(factories) }),
    safeToolNames: [...OPERATOR_SAFE_TOOL_NAMES],
  });
  assertProductionAdapter(nodeExecutionAdapter);
  const nodeExecutionAdapterResolver = createNodeExecutionAdapterResolver({
    frozenAdapter: nodeExecutionAdapter,
    featureSet: startupFeatureSet,
    bindings: STAGE7_BINDINGS,
    implementations: new Map(),
    ...(fleetCatalog === undefined ? {} : {
      fleetAdapter: createExternalCliAdapter({
        resolveChain: (request) => {
          const catalogNow = fleetCatalog as NonNullable<typeof fleetCatalog>;
          const requiredCapability = request.node.requiredCapability;
          if (requiredCapability === undefined) return { policy: 'COMPATIBLE_ONLY', candidates: [] };
          const matching = catalogNow.records
            .filter((candidate) => candidate.kind === 'external-cli' && candidate.health === 'HEALTHY' && candidate.auth === 'AUTHENTICATED' && candidate.mutability === 'READ_ONLY' && candidate.capabilities.includes(requiredCapability) && candidate.tools.every((tool) => fleetSafeToolNames.includes(tool)))
            .sort((first, second) => first.providerId.localeCompare(second.providerId));
          const selected = matching.find((candidate) => `${candidate.providerId}:${requiredCapability}` === request.node.capabilityId);
          return { policy: 'COMPATIBLE_ONLY', candidates: selected === undefined ? [] : [selected, ...matching.filter((candidate) => candidate !== selected)] };
        },
      }),
    }),
  });

  const onUnhandledFailure = (failure: SupervisedFailure): void => {
    // Bounded, user-facing diagnostic: never a stack trace or reasoning
    // trace, and never allowed to throw back into the coordinator.
    const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
    process.stderr.write(`[agent-operator] ${failure.stage}: ${message}\n`);
  };

  // Forward reference: `coordinator` needs to call back into `runtime`
  // (`getActiveBatch`/`completeBatch`/`timeoutBatch`/`shutdownActive`),
  // while `runtime` needs `coordinator.registerActiveBatch` at
  // construction. Each closure below only runs after both are assigned —
  // `registerActiveBatch` is invoked no earlier than `#handleContinue`,
  // long after this function returns.
  let runtime: OperatorRuntime;
  const coordinator = new ExecutionCoordinator({
    runtime: {
      getActiveBatch: (operatorSessionId) => runtime.getActiveBatch(operatorSessionId),
      completeBatch: (operatorSessionId, batchId, outcomes) => runtime.completeBatch(operatorSessionId, batchId, outcomes),
      timeoutBatch: (operatorSessionId, batchId) => runtime.timeoutBatch(operatorSessionId, batchId),
      shutdownActive: () => runtime.shutdownActive(),
    },
    onUnhandledFailure,
  });

  runtime = createOperatorRuntime({
    store,
    clock,
    ids,
    nodeExecutionAdapterResolver,
    contextProjector,
    stage7FeatureSet: startupFeatureSet,
    nodeTimeoutMs: () => 900_000,
    compiler,
    projectRoot,
    shadowRouting,
    registerActiveBatch: coordinator.registerActiveBatch.bind(coordinator),
    providerIntelligence,
    policySimulation,
    providerCanary,
    ...(startupFeatureSet.stage10EvaluatorEnabled === true
      ? {
          evaluatorHandler: createEvaluatorHandler({
            store,
            evaluatorDir: join(rootDir, 'evaluator'),
            featureSet: startupFeatureSet,
            baselineDigest: 'fc62ffa61b5f1b69400eb7b24008546846821d8e809f26657018d794680920db',
            intelligenceHandler: createIntelligenceLifecycleHandler({
              evaluatorDir: join(rootDir, 'evaluator'),
              projectRoot,
              activation: intelligenceActivation,
              intelligence: providerIntelligence,
              baseDigest: 'fc62ffa61b5f1b69400eb7b24008546846821d8e809f26657018d794680920db',
              policyDigest: 'wp18-default-policy',
              compilerVersion: 'intelligence-roadmap',
              scorerVersion: 'deterministic-structural-v1',
            }),
          }),
        }
      : {}),
  });

  const HELP_MENU = [
    'Agent Operator — available commands:',
    '  <request>                      start a governed workflow session',
    '  simulate <request>             compile and preflight without state or dispatch',
    '  --dry-run <request>            alias for simulate',
    '  --family <FAMILY> <request>    start with an explicit task family',
    '  --explain <request>            routing explanation only',
    '  status | graph | why | explain show session / graph / routing detail',
    '  shadow on|off|status|evaluate  compare semantic routing without influence',
    '  continue | cancel              drive the active session',
    '  approve <gate-id> | reject <gate-id>',
    '  competence status|show         inspect evidence-derived provider scorecards',
    '  policy test --proposed <path>  compare policy without applying it',
    '  canary run <provider> [model]  run bounded read-only qualification cases',
    '  resume <operator-session-id>   reload a persisted session',
    '  improve status | harvest | corpus | evaluate | candidate verify | compare | generate',
    '',
    'Example: /operator plan the migration approach',
  ].join('\n');
  const handler = async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    if (args.trim() === '') {
      ctx.ui.notify(HELP_MENU, 'info');
      return;
    }
    const currentModel = ctx.models.current();
    if (currentModel === undefined) {
      ctx.ui.notify('/operator cannot dispatch because the host has no active model.', 'error');
      return;
    }
    selectedModel = { provider: currentModel.provider, id: currentModel.id, sdkModel: currentModel };
    coordinator.setScheduler(adaptHostTimerScheduler(ctx));
    try {
      const outcome = await runtime.handle(args);
      ctx.ui.notify(outcome.text, outcome.ok ? 'info' : 'error');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`/operator failed unexpectedly: ${message}`, 'error');
    }
  };

  return { handler, coordinator };
}

/**
 * Extension activation entrypoint. Registers the `operator` command and a
 * `session_shutdown` handler that aborts every active batch through the
 * coordinator before the process tears the session down.
 */
export default function agentOperatorExtension(api: ExtensionAPI): void {
  const { handler, coordinator } = buildOperatorRuntime();

  api.registerCommand('operator', {
    description: COMMAND_DESCRIPTION,
    getArgumentCompletions: completeOperatorSubcommand,
    handler,
  });

  api.on('session_shutdown', async () => {
    await coordinator.shutdown();
  });
}

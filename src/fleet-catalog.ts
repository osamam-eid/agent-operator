/** Fleet catalog bootstrap + management. Projects the host OMP model
 * config (already authenticated) into the operator-owned fleet catalog,
 * and provides list/remove edits. No key material is ever copied: OMP
 * resolves credentials itself; omp-native records carry no auth data. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { normalizeProviderCatalog } from './provider-fleet.js';
import { resolveProviderCatalogPath } from './config.js';

export interface FleetBootstrapEntry {
  readonly id: string;
  readonly hasKeyRef: boolean;
}

export interface FleetCatalogFile {
  readonly providers: Readonly<Record<string, unknown>>[];
}

/** Minimal purpose-built reader for OMP's models.yml provider blocks:
 * top-level `providers:` then two-space-indented `id:` entry heads. All
 * nested detail (baseUrl/api/models/…) is intentionally ignored — the
 * catalog projects identity only, never credentials. */
export function parseOmpModelsYaml(yaml: string): readonly FleetBootstrapEntry[] {
  const lines = yaml.split(/\r?\n/);
  const entries: FleetBootstrapEntry[] = [];
  let inProviders = false;
  let currentId: string | undefined;
  for (const line of lines) {
    if (/^providers:\s*$/.test(line)) { inProviders = true; continue; }
    if (inProviders && /^[^ #\s]/.test(line)) break;
    if (!inProviders) continue;
    const head = /^  ([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (head && head[1] !== undefined) {
      currentId = head[1];
      entries.push({ id: head[1], hasKeyRef: /apikey/i.test(head[2] ?? '') });
      continue;
    }
    if (currentId !== undefined && /apikey|auth\s*:/i.test(line)) {
      const last = entries[entries.length - 1];
      if (last !== undefined && last.id === currentId && /apikey/i.test(line)) {
        entries[entries.length - 1] = { ...last, hasKeyRef: true };
      }
    }
  }
  return entries;
}

const DEFAULT_CAPABILITIES: readonly string[] = ['research', 'planning', 'implementation', 'code-review', 'ui-design', 'security-review', 'qa', 'operations'];

/** Conservative omp-native record per provider. OMP owns authentication;
 * records start READ_ONLY with read-tier tool grants until an operator
 * widens them deliberately. Output validates against
 * normalizeProviderCatalog — the frozen oracle. */
export function bootstrapCatalog(entries: readonly FleetBootstrapEntry[]): FleetCatalogFile {
  const seen = new Set<string>();
  const providers = entries.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).map((entry) => ({
    providerId: entry.id,
    kind: 'omp-native',
    displayName: entry.id,
    source: `omp-models-yaml:${entry.id}`,
    health: 'HEALTHY',
    auth: 'AUTHENTICATED',
    capabilities: [...DEFAULT_CAPABILITIES],
    models: [{ id: 'default', tier: 'MEDIUM', disclosed: true, capabilities: [...DEFAULT_CAPABILITIES], costClass: 'LOW', latencyClass: 'LOW' }],
    supports: ['SINGLE'],
    mutability: 'READ_ONLY',
    tools: ['read', 'grep', 'glob'],
    concurrency: 1,
  }));
  return { providers } as FleetCatalogFile;
}

/** Merge-by-addition: existing operator records always win; bootstrap only
 * fills ids that are not present yet. */
export function mergeCatalog(existing: FleetCatalogFile | undefined, bootstrapped: FleetCatalogFile): FleetCatalogFile & { added: readonly string[] } {
  const have = new Set((existing?.providers ?? []).map((entry) => entry['providerId']));
  const additions = bootstrapped.providers.filter((entry) => !have.has(entry['providerId']));
  return { providers: [...(existing?.providers ?? []), ...additions], added: additions.map((entry) => String(entry['providerId'])) };
}

export function loadCatalogFile(catalogPath: string): FleetCatalogFile | undefined {
  if (!existsSync(catalogPath)) return undefined;
  return JSON.parse(readFileSync(catalogPath, 'utf8')) as FleetCatalogFile;
}

export function saveCatalogFile(catalogPath: string, catalog: FleetCatalogFile): void {
  normalizeProviderCatalog(catalog, new Date().toISOString());
  mkdirSync(dirname(catalogPath), { recursive: true, mode: 0o700 });
  writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), { mode: 0o600 });
}

export function defaultModelsYamlPath(): string {
  return join(homedir(), '.omp', 'agent', 'models.yml');
}

export function fleetCatalogPath(): string {
  return resolveProviderCatalogPath();
}

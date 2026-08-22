import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  bootstrapCatalog, defaultModelsYamlPath, fleetCatalogPath, loadCatalogFile,
  mergeCatalog, parseOmpModelsYaml, saveCatalogFile,
} from '../src/fleet-catalog.js';
import { normalizeProviderCatalog } from '../src/provider-fleet.js';
import { parseOperatorCommand } from '../src/commands.js';
import { OperatorRuntime } from '../src/controller.js';
import { MemoryOperatorSessionStore } from '../src/store.js';

const MODELS_YAML = `providers:
  kiro:
    baseUrl: http://127.0.0.1:8000/v1
    api: openai-completions
    apiKey: KIRO_GATEWAY_API_KEY # resolved from ~/.omp/agent/.env
    discovery:
      type: proxy
  lightning:
    baseUrl: http://127.0.0.1:11434/v1
    auth: none
    models:
      - id: qwen-27b:latest
other:
  key: value
`;

describe('fleet catalog', () => {
  test('parser projects provider identities only, tolerating nested noise', () => {
    const entries = parseOmpModelsYaml(MODELS_YAML);
    expect(entries.map((entry) => entry.id)).toEqual(['kiro', 'lightning']);
    expect(entries[0]?.hasKeyRef).toBe(true);
    expect(entries[1]?.hasKeyRef).toBe(false);
  });

  test('bootstrapped records pass the frozen catalog validator', () => {
    const catalog = bootstrapCatalog(parseOmpModelsYaml(MODELS_YAML));
    const normalized = normalizeProviderCatalog(catalog, '2026-08-22T00:00:00.000Z');
    expect(normalized.records.map((record) => record.providerId).sort()).toEqual(['kiro', 'lightning']);
    for (const record of normalized.records) {
      expect(record.kind).toBe('omp-native');
      expect(record.auth).toBe('AUTHENTICATED');
      expect(record.mutability).toBe('READ_ONLY');
      expect(record.binary).toBeUndefined();
    }
  });

  test('merge adds missing ids and never overwrites operator records', () => {
    const existing = { providers: [{ providerId: 'kiro', kind: 'omp-native', displayName: 'My Kiro', source: 'hand', health: 'HEALTHY', auth: 'AUTHENTICATED', capabilities: ['research'], models: [{ id: 'm', tier: 'HIGH', disclosed: true, capabilities: ['research'], costClass: 'LOW', latencyClass: 'LOW' }], supports: ['SINGLE'], mutability: 'READ_ONLY', tools: ['read'], concurrency: 1 }] };
    const merged = mergeCatalog(existing, bootstrapCatalog(parseOmpModelsYaml(MODELS_YAML)));
    expect(merged.providers).toHaveLength(2);
    expect(merged.added).toEqual(['lightning']);
    expect((merged.providers[0] as { displayName: string }).displayName).toBe('My Kiro');
  });

  test('controller fleet lifecycle: bootstrap → list → remove (isolated XDG dir)', async () => {
    const tmp = mkdtempSync(join('/tmp', 'fleet-xdg-'));
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = tmp;
    try {
      const runtime = new OperatorRuntime({
        store: new MemoryOperatorSessionStore(),
        featureSet: createTrusted(),
        compiler: undefined,
        evaluatorHandler: undefined,
      } as never);
      const modelsFixture = join(tmp, 'models.yml');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(modelsFixture, MODELS_YAML);
      const boot = await runtime.handle(`fleet bootstrap --models ${modelsFixture}`);
      expect(boot.ok).toBe(true);
      expect(boot.text).toContain('added 2 provider(s)');
      const catalogPath = fleetCatalogPath();
      const written = JSON.parse(readFileSync(catalogPath, 'utf8')) as { providers: { providerId: string }[] };
      expect(written.providers.map((entry) => entry.providerId).sort()).toEqual(['kiro', 'lightning']);
      const list = await runtime.handle('fleet');
      expect(list.ok).toBe(true);
      expect(list.text).toContain('kiro (omp-native, HEALTHY, READ_ONLY)');
      const remove = await runtime.handle('fleet remove kiro');
      expect(remove.ok).toBe(true);
      const after = loadCatalogFile(catalogPath);
      expect(after?.providers.map((entry) => entry.providerId)).toEqual(['lightning']);
      const dup = await runtime.handle('fleet remove kiro');
      expect(dup.ok).toBe(false);
      void catalogPath; void defaultModelsYamlPath; void writeFileSync;
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('parse surface', () => {
    expect(parseOperatorCommand('fleet')).toMatchObject({ kind: 'FLEET', subcommand: 'list' });
    expect(parseOperatorCommand('fleet bootstrap')).toMatchObject({ kind: 'FLEET', subcommand: 'bootstrap' });
    expect(parseOperatorCommand('fleet remove x')).toMatchObject({ kind: 'FLEET', subcommand: 'remove' });
  });
});

function createTrusted() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createStage7FeatureSet } = require('../src/stage7/feature-config.js') as typeof import('../src/stage7/feature-config.js');
  return createStage7FeatureSet(true, true, false, false);
}

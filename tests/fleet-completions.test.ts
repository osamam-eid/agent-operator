import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { completeOperatorSubcommand } from '../extension/index.js';

/** Fixture catalog mirrors the live one (5 providers) so provider-stage
 * suggestions are deterministic. XDG_CONFIG_HOME is redirected per-test. */
const PROVIDERS = ['agentrouter', 'gemini-gateway', 'kiro', 'lightning', 'tokenrouter'];

function withXdg(run: () => void): void {
  const dir = mkdtempSync(join('/tmp', 'compl-xdg-'));
  const agentDir = join(dir, 'agent-operator');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, 'providers.json'), JSON.stringify({
    providers: PROVIDERS.map((providerId) => ({
      providerId, kind: 'omp-native', displayName: providerId, source: `test:${providerId}`,
      health: 'HEALTHY', auth: 'AUTHENTICATED',
      capabilities: ['research'], models: [{ id: 'default', tier: 'MEDIUM', disclosed: true, capabilities: ['research'], costClass: 'LOW', latencyClass: 'LOW' }],
      supports: ['SINGLE'], mutability: 'READ_ONLY', tools: ['read'], concurrency: 1,
    })),
  }));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
  }
}

const ids = (prefix: string): string[] | null => {
  const items = completeOperatorSubcommand(prefix);
  return items === null ? null : items.map((item) => item.value);
};

describe('completeOperatorSubcommand — probe-log regression table', () => {
  test('"" → full top-level menu (12 entries)', () => {
    withXdg(() => {
      const values = ids('');
      expect(values).not.toBeNull();
      expect(values!.length).toBeGreaterThanOrEqual(12);
    });
  });

  test('"f" → fleet only', () => {
    withXdg(() => {
      expect(ids('f')).toEqual(['fleet']);
    });
  });

  test('"fleet" and "fleet " → the four subcommands, fully-qualified values', () => {
    withXdg(() => {
      for (const prefix of ['fleet', 'fleet ']) {
        const values = ids(prefix);
        expect([...values!].sort()).toEqual([
          'fleet bootstrap', 'fleet combo', 'fleet list', 'fleet remove',
        ].sort());
      }
    });
  });

  test('"fleet b" → bootstrap; "fleet c" → combo only', () => {
    withXdg(() => {
      expect(ids('fleet b')).toEqual(['fleet bootstrap']);
      expect(ids('fleet c')).toEqual(['fleet combo']);
    });
  });

  test('"fleet combo" / "fleet combo c" → council roster suggestion', () => {
    withXdg(() => {
      expect(ids('fleet combo')).toEqual(['fleet combo']); // complete subcommand token
      expect(ids('fleet combo c')).toEqual(['fleet combo council']);
    });
  });

  test('"fleet combo council " → all five providers as + adds', () => {
    withXdg(() => {
      const values = ids('fleet combo council ');
      expect(values).toHaveLength(5);
      for (const value of values!) expect(value.startsWith('fleet combo council ')).toBe(true);
    });
  });

  test('"fleet combo council t" → tokenrouter only (mid-token filtering)', () => {
    withXdg(() => {
      expect(ids('fleet combo council t')).toEqual(['fleet combo council tokenrouter']);
    });
  });

  test('"fleet combo council tokenrouter " → excludes picked, offers remaining four', () => {
    withXdg(() => {
      const values = ids('fleet combo council tokenrouter ');
      expect(values).toHaveLength(4);
      expect(values ?? []).toHaveLength(4);
    });
  });
});

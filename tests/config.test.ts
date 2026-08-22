import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  hashProjectPolicyBytes,
  loadResolvedOperatorConfig,
  OperatorConfigError,
  resolveGlobalConfigPath,
  validateOperatorProfile,
  validateProjectOperatorOverlay,
} from '../src/config.js';

let rootDir: string;
let projectRoot: string;
let missingGlobalConfigPath: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-operator-config-test-'));
  projectRoot = path.join(rootDir, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  missingGlobalConfigPath = path.join(rootDir, 'no-such-global.json');
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

async function initGit(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, '.git'), { recursive: true });
}

async function writeOverlay(dir: string, overlay: Record<string, unknown>): Promise<Buffer> {
  const omDir = path.join(dir, '.omp');
  await fs.mkdir(omDir, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(overlay), 'utf8');
  await fs.writeFile(path.join(omDir, 'operator.json'), bytes);
  return bytes;
}

async function writeTrust(gitDir: string, policyBytes: Buffer, overrides: Record<string, unknown> = {}): Promise<void> {
  const trustDir = path.join(gitDir, 'agent-operator');
  await fs.mkdir(trustDir, { recursive: true });
  const record = {
    schemaVersion: '1.0',
    policyPath: '.omp/operator.json',
    expectedHash: hashProjectPolicyBytes(policyBytes),
    trustedAt: '2026-08-14T00:00:00Z',
    ...overrides,
  };
  await fs.writeFile(path.join(trustDir, 'trust.json'), JSON.stringify(record));
}

describe('hashProjectPolicyBytes', () => {
  test('is a deterministic sha256 hex digest of the exact bytes', () => {
    const hash = hashProjectPolicyBytes(Buffer.from('hello', 'utf8'));
    expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(hash).toHaveLength(64);
    expect(hashProjectPolicyBytes('hello')).toBe(hash);
  });
});

describe('validateOperatorProfile', () => {
  test('accepts the bundled defaults.json content unmodified', async () => {
    const raw = JSON.parse(await fs.readFile(path.join(import.meta.dir, '..', 'config', 'defaults.json'), 'utf8'));
    const result = validateOperatorProfile(raw);
    expect(result.ok).toBe(true);
  });

  test('rejects unknown top-level properties', () => {
    const result = validateOperatorProfile({
      schemaVersion: '1.0',
      workflow: 'mock.v1',
      defaultPolicyPacks: [],
      budgetProfile: 'BALANCED',
      maxConcurrency: 1,
      features: { automaticRouting: false, externalProviders: false, councilMode: false, autoFallback: false, persistentState: true, costTracking: false },
      rules: {
        humanIsFinalApprover: true,
        implementerSelfApproval: false,
        automaticCommit: false,
        automaticPush: false,
        automaticMerge: false,
        independentVerification: true,
        adversarialReviewForHighRisk: true,
        scopeFreezeRequired: true,
        maxReviewRounds: 2,
      },
      capabilityAssignments: {},
      unknownField: 'nope',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('unknownField'))).toBe(true);
  });
});

describe('validateProjectOperatorOverlay', () => {
  test('rejects unknown properties in a nested features object', () => {
    const result = validateProjectOperatorOverlay({ schemaVersion: '1.0', features: { automaticRouting: false, madeUp: true } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.includes('madeUp'))).toBe(true);
  });
});

describe('loadResolvedOperatorConfig — absent project overlay', () => {
  test('resolves the bundled defaults with ABSENT status when no .git exists', async () => {
    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });
    expect(config.projectOverlay.status).toBe('ABSENT');
    expect(config.profile.rules.humanIsFinalApprover).toBe(true);
    expect(config.profile.features.automaticRouting).toBe(false);
    expect(config.policyRefs).toEqual(['agent-operator@1:config.defaults']);
  });

  test('resolves ABSENT when a .git exists but .omp does not', async () => {
    await initGit(projectRoot);
    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });
    expect(config.projectOverlay.status).toBe('ABSENT');
  });
});

describe('loadResolvedOperatorConfig — trusted project overlay', () => {
  test('applies an overlay whose hash matches its trust record', async () => {
    await initGit(projectRoot);
    const policyBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 4, rules: { scopeFreezeRequired: false } });
    await writeTrust(path.join(projectRoot, '.git'), policyBytes);

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('TRUSTED');
    expect(config.profile.maxConcurrency).toBe(4);
    expect(config.profile.rules.scopeFreezeRequired).toBe(false);
    // Untouched fields fall through from defaults.
    expect(config.profile.rules.humanIsFinalApprover).toBe(true);
    expect(config.policyRefs).toEqual(['agent-operator@1:config.defaults', 'agent-operator@1:config.project.trusted']);
  });

  test('rejects a trusted overlay that attempts unsafe broadening as INVALID, never applying it', async () => {
    await initGit(projectRoot);
    const policyBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', features: { automaticRouting: true } });
    await writeTrust(path.join(projectRoot, '.git'), policyBytes);

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.overlay).toBeUndefined();
    expect(config.profile.features.automaticRouting).toBe(false);
  });
});

describe('loadResolvedOperatorConfig — untrusted / hash mismatch', () => {
  test('reports UNTRUSTED and never applies the overlay when bytes changed after trust was recorded', async () => {
    await initGit(projectRoot);
    const originalBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 4 });
    await writeTrust(path.join(projectRoot, '.git'), originalBytes);
    // Policy edited after trust was recorded — hash no longer matches.
    await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 8 });

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('UNTRUSTED');
    expect(config.projectOverlay.overlay).toBeUndefined();
    expect(config.profile.maxConcurrency).toBe(3);

  });

  test('reports UNTRUSTED when no trust record exists at all', async () => {
    await initGit(projectRoot);
    await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 4 });

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('UNTRUSTED');
  });
});

describe('loadResolvedOperatorConfig — symlink and path-escape rejection', () => {
  test('rejects a symlinked .omp directory as INVALID', async () => {
    await initGit(projectRoot);
    const outsideDir = path.join(rootDir, 'outside-omp');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.symlink(outsideDir, path.join(projectRoot, '.omp'), 'dir');

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.reason).toContain('symlinked .omp');
  });

  test('rejects a symlinked project policy file as INVALID', async () => {
    await initGit(projectRoot);
    await fs.mkdir(path.join(projectRoot, '.omp'), { recursive: true });
    const outsideFile = path.join(rootDir, 'outside-policy.json');
    await fs.writeFile(outsideFile, JSON.stringify({ schemaVersion: '1.0' }));
    await fs.symlink(outsideFile, path.join(projectRoot, '.omp', 'operator.json'));

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.reason).toContain('symlinked project policy file');
  });

  test('rejects a symlinked trust record as INVALID', async () => {
    await initGit(projectRoot);
    const policyBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 4 });
    const gitDir = path.join(projectRoot, '.git');
    await writeTrust(gitDir, policyBytes);
    const trustPath = path.join(gitDir, 'agent-operator', 'trust.json');
    const outsideTrustPath = path.join(rootDir, 'outside-trust.json');
    await fs.rename(trustPath, outsideTrustPath);
    await fs.symlink(outsideTrustPath, trustPath);

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.reason).toContain('symlinked trust record');
  });

  test('rejects a symlinked .git entry as INVALID rather than discovering an ancestor repository', async () => {
    await initGit(rootDir);
    await fs.symlink(path.join(rootDir, '.git'), path.join(projectRoot, '.git'), 'dir');

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.reason).toContain('symlinked .git');
  });

  test('rejects a trust record whose declared policyPath escapes to a different file', async () => {
    await initGit(projectRoot);
    const policyBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 4 });
    await writeTrust(path.join(projectRoot, '.git'), policyBytes, { policyPath: '.omp/some-other-file.json' });

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.reason).toContain('targets');
  });

  test('rejects a trust record whose declared policyPath contains a ".." segment', async () => {
    await initGit(projectRoot);
    const policyBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 4 });
    await writeTrust(path.join(projectRoot, '.git'), policyBytes, { policyPath: '../secrets/operator.json' });

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.reason).toContain('invalid trust record');
  });

  test('resolves a linked worktree via a gitdir: pointer file', async () => {
    const realGitDir = path.join(rootDir, 'real.git');
    await fs.mkdir(realGitDir, { recursive: true });
    await fs.writeFile(path.join(projectRoot, '.git'), `gitdir: ${realGitDir}\n`);
    const policyBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 4 });
    await writeTrust(realGitDir, policyBytes);

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('TRUSTED');
    expect(config.profile.maxConcurrency).toBe(4);
  });
});

describe('loadResolvedOperatorConfig — malformed and unknown-field project policy', () => {
  test('reports INVALID for malformed JSON even when its hash matches the trust record', async () => {
    await initGit(projectRoot);
    const omDir = path.join(projectRoot, '.omp');
    await fs.mkdir(omDir, { recursive: true });
    const malformed = Buffer.from('{ not valid json', 'utf8');
    await fs.writeFile(path.join(omDir, 'operator.json'), malformed);
    await writeTrust(path.join(projectRoot, '.git'), malformed);

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.reason).toContain('malformed');
  });

  test('reports INVALID for a well-formed but unknown-field overlay', async () => {
    await initGit(projectRoot);
    const policyBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', notARealField: true });
    await writeTrust(path.join(projectRoot, '.git'), policyBytes);

    const config = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath: missingGlobalConfigPath });

    expect(config.projectOverlay.status).toBe('INVALID');
    expect(config.projectOverlay.reason).toContain('unknown property');
  });
});

describe('loadResolvedOperatorConfig — global override precedence', () => {
  test('a valid global overlay narrows defaults and is itself narrowed further by a trusted project overlay', async () => {
    const globalConfigPath = path.join(rootDir, 'global-operator.json');
    await fs.writeFile(globalConfigPath, JSON.stringify({ schemaVersion: '1.0', maxConcurrency: 8, budgetProfile: 'QUALITY' }));

    const globalOnly = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath });
    expect(globalOnly.profile.maxConcurrency).toBe(8);
    expect(globalOnly.profile.budgetProfile).toBe('QUALITY');
    expect(globalOnly.policyRefs).toEqual(['agent-operator@1:config.defaults', 'agent-operator@1:config.global']);

    await initGit(projectRoot);
    const policyBytes = await writeOverlay(projectRoot, { schemaVersion: '1.0', maxConcurrency: 2 });
    await writeTrust(path.join(projectRoot, '.git'), policyBytes);

    const withProject = await loadResolvedOperatorConfig({ projectRoot, globalConfigPath });
    // Project overlay narrows the global-overridden value further; global's
    // budgetProfile choice survives since the project overlay never mentions it.
    expect(withProject.profile.maxConcurrency).toBe(2);
    expect(withProject.profile.budgetProfile).toBe('QUALITY');
    expect(withProject.policyRefs).toEqual(['agent-operator@1:config.defaults', 'agent-operator@1:config.global', 'agent-operator@1:config.project.trusted']);
  });

  test('a malformed global config throws OperatorConfigError and never silently falls back to defaults', async () => {
    const globalConfigPath = path.join(rootDir, 'broken-global.json');
    await fs.writeFile(globalConfigPath, '{ not json');

    await expect(loadResolvedOperatorConfig({ projectRoot, globalConfigPath })).rejects.toBeInstanceOf(OperatorConfigError);
  });

  test('a global config attempting unsafe broadening throws OperatorConfigError', async () => {
    const globalConfigPath = path.join(rootDir, 'unsafe-global.json');
    await fs.writeFile(globalConfigPath, JSON.stringify({ schemaVersion: '1.0', rules: { implementerSelfApproval: true } }));

    let caught: unknown;
    try {
      await loadResolvedOperatorConfig({ projectRoot, globalConfigPath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OperatorConfigError);
    expect((caught as OperatorConfigError).code).toBe('GLOBAL_CONFIG_INVALID');
  });
});

describe('resolveGlobalConfigPath', () => {
  test('prefers an explicit option over any environment resolution', () => {
    expect(resolveGlobalConfigPath({ globalConfigPath: '/tmp/explicit/operator.json' })).toBe(path.resolve('/tmp/explicit/operator.json'));
  });

  test('falls back to $XDG_CONFIG_HOME/agent-operator/operator.json when set', () => {
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    try {
      expect(resolveGlobalConfigPath({})).toBe(path.join('/tmp/xdg-config', 'agent-operator', 'operator.json'));
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    }
  });

  test('falls back to ~/.config/agent-operator/operator.json when XDG_CONFIG_HOME is unset', () => {
    const previous = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    try {
      expect(resolveGlobalConfigPath({})).toBe(path.join(os.homedir(), '.config', 'agent-operator', 'operator.json'));
    } finally {
      if (previous !== undefined) process.env.XDG_CONFIG_HOME = previous;
    }
  });
});

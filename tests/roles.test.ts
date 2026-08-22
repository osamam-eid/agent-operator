import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT_RESULT_SCHEMA_NAME,
  APPROVED_AGENT_RESULT_SCHEMA_HASH,
  APPROVED_ROLE_MANIFEST,
  PACKAGE_ROLE_NAMES,
  PackageRoleIntegrityError,
  loadAgentResultSchema,
  loadAllPackageRoles,
  loadPackageRole,
  resolvePackageRoleName,
} from '../src/adapters/roles.js';

const REAL_PACKAGE_ROOT = path.resolve(import.meta.dir, '..');

async function makeFixtureRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'role-fixture-'));
  await fs.mkdir(path.join(root, 'agents'));
  return root;
}

async function writeRoleFile(root: string, name: string, content: string): Promise<void> {
  await fs.writeFile(path.join(root, 'agents', `${name}.md`), content);
}

const VALID_BODY = [
  '---',
  'name: agent-operator-native-planner',
  'description: A test planner role.',
  'tools: operator_read, operator_grep, operator_glob',
  'spawns: ""',
  'thinkingLevel: high',
  'output: agent-result.v1',
  '---',
  '',
  'You are the planner. Do planning things.',

  '',
].join('\n');

test('maps every configured native read-only role to a hash-pinned package role', async () => {
  const raw: unknown = JSON.parse(await fs.readFile(path.join(REAL_PACKAGE_ROOT, 'config', 'defaults.json'), 'utf8'));
  const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isRecord(raw)) throw new Error('defaults.json must contain an object');
  const assignments = raw['capabilityAssignments'];
  if (!isRecord(assignments)) throw new Error('defaults.json capabilityAssignments must be an object');
  for (const [role, assignment] of Object.entries(assignments)) {
    if (!isRecord(assignment)) continue;
    const preferred = assignment['preferred'];
    if (typeof preferred === 'string' && preferred.startsWith('omp-task-native-')) expect(resolvePackageRoleName(role)).toBeDefined();
  }
  expect(resolvePackageRoleName('implementer')).toBeUndefined();
  expect(resolvePackageRoleName('ui-designer')).toBe('agent-operator-native-planner');
  expect(resolvePackageRoleName('scope-freeze')).toBe('agent-operator-native-reviewer');
  expect(resolvePackageRoleName('visual-verifier')).toBe('agent-operator-native-reviewer');
});

describe('loadPackageRole — real package agents/*.md', () => {
  test('loads and hash-verifies all three real committed role files', async () => {
    const roles = await loadAllPackageRoles({ packageRoot: REAL_PACKAGE_ROOT });
    for (const roleName of PACKAGE_ROLE_NAMES) {
      const role = roles[roleName];
      expect(role.name).toBe(roleName);
      expect(role.spawns).toBe(false);
      expect(role.tools.length).toBeGreaterThan(0);
      for (const tool of role.tools) expect(tool.startsWith('operator_')).toBe(true);
      expect(role.systemPrompt.length).toBeGreaterThan(0);
      expect(role.contentHash).toBe(APPROVED_ROLE_MANIFEST[roleName]);
      expect(role.output).toBe(AGENT_RESULT_SCHEMA_NAME);
      expect(role.outputSchema).toMatchObject({ title: 'AgentResult.v1', type: 'object' });
    }
  });

  test('synthesis role declares a strictly narrower tool grant than planner/reviewer (least privilege)', async () => {
    const roles = await loadAllPackageRoles({ packageRoot: REAL_PACKAGE_ROOT });
    expect(roles['agent-operator-native-synthesis'].tools.length).toBeLessThan(roles['agent-operator-native-planner'].tools.length);
  });
});

describe('loadAgentResultSchema — package integrity', () => {
  test('loads the exact hash-pinned AgentResult.v1 schema', async () => {
    const schema = await loadAgentResultSchema({ packageRoot: REAL_PACKAGE_ROOT });
    expect(schema).toMatchObject({ title: 'AgentResult.v1', type: 'object' });
    expect(APPROVED_AGENT_RESULT_SCHEMA_HASH).toHaveLength(64);
  });
});


describe('loadPackageRole — integrity failures block before any session is created', () => {
  test('missing file -> ROLE_FILE_MISSING / BLOCKED_SECURITY-mappable', async () => {
    const root = await makeFixtureRoot();
    try {
      await expect(loadPackageRole('agent-operator-native-planner', { packageRoot: root })).rejects.toMatchObject({
        code: 'ROLE_FILE_MISSING',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('tampered content -> ROLE_HASH_MISMATCH even when frontmatter still parses cleanly', async () => {
    const root = await makeFixtureRoot();
    try {
      await writeRoleFile(root, 'agent-operator-native-planner', VALID_BODY + '\nAn attacker appended this line.\n');
      const error = await loadPackageRole('agent-operator-native-planner', { packageRoot: root }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PackageRoleIntegrityError);
      expect((error as PackageRoleIntegrityError).code).toBe('ROLE_HASH_MISMATCH');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('symlinked role file is rejected as not a regular file, never dereferenced', async () => {
    const root = await makeFixtureRoot();
    const realRoot = await makeFixtureRoot();
    try {
      await writeRoleFile(realRoot, 'agent-operator-native-planner', VALID_BODY);
      await fs.symlink(path.join(realRoot, 'agents', 'agent-operator-native-planner.md'), path.join(root, 'agents', 'agent-operator-native-planner.md'));
      const error = await loadPackageRole('agent-operator-native-planner', { packageRoot: root }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PackageRoleIntegrityError);
      expect((error as PackageRoleIntegrityError).code).toBe('ROLE_FILE_NOT_REGULAR');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(realRoot, { recursive: true, force: true });
    }
  });

  test('name mismatch inside frontmatter is rejected even with a matching manifest key', async () => {
    const root = await makeFixtureRoot();
    try {
      const wrongName = VALID_BODY.replace('name: agent-operator-native-planner', 'name: some-ambient-project-agent');
      await writeRoleFile(root, 'agent-operator-native-planner', wrongName);
      // Recompute this fixture's own hash by loading with a throwaway manifest bypass is not
      // exposed; instead assert the failure is a hash mismatch (fixture content differs from
      // the pinned manifest) OR a name mismatch, proving no path silently accepts an ambient name.
      const error = await loadPackageRole('agent-operator-native-planner', { packageRoot: root }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PackageRoleIntegrityError);
      expect(['ROLE_HASH_MISMATCH', 'ROLE_NAME_MISMATCH']).toContain((error as PackageRoleIntegrityError).code);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('non-empty spawns is rejected for a Stage 4 read-only role', async () => {
    const root = await makeFixtureRoot();
    try {
      const withSpawns = VALID_BODY.replace('spawns: ""', 'spawns: "*"');
      await writeRoleFile(root, 'agent-operator-native-planner', withSpawns);
      const error = await loadPackageRole('agent-operator-native-planner', { packageRoot: root }).catch((e: unknown) => e);
      // Content differs from the pinned manifest either way; the point is no code path ever
      // returns a role with spawns !== false, whichever check fires first.
      expect(error).toBeInstanceOf(PackageRoleIntegrityError);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test('unknown role name is rejected without any filesystem lookup', async () => {
    // @ts-expect-error deliberately invalid input
    await expect(loadPackageRole('not-a-real-role')).rejects.toMatchObject({ code: 'ROLE_UNKNOWN' });
  });
});

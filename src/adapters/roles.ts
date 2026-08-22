import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export type PackageRoleName =
  | 'agent-operator-native-planner'
  | 'agent-operator-native-reviewer'
  | 'agent-operator-native-synthesis';

export const ROLE_TO_PACKAGE_ROLE: Readonly<Record<string, PackageRoleName>> = Object.freeze({
  'context-preflight': 'agent-operator-native-planner',
  planner: 'agent-operator-native-planner',
  researcher: 'agent-operator-native-planner',
  'plan-context-loader': 'agent-operator-native-planner',
  'qa-preflight': 'agent-operator-native-planner',
  'ui-designer': 'agent-operator-native-planner',
  'independent-reviewer': 'agent-operator-native-reviewer',
  'scope-freeze': 'agent-operator-native-reviewer',
  'visual-verifier': 'agent-operator-native-reviewer',
  'adversarial-reviewer': 'agent-operator-native-reviewer',
  'behavioral-verifier': 'agent-operator-native-reviewer',
  'conformance-verifier': 'agent-operator-native-reviewer',
  'security-reviewer': 'agent-operator-native-reviewer',
  'evidence-collector': 'agent-operator-native-reviewer',
  'operator-synthesis': 'agent-operator-native-synthesis',
  'research-synthesizer': 'agent-operator-native-synthesis',
  report: 'agent-operator-native-synthesis',
});

export function resolvePackageRoleName(nodeRole: string): PackageRoleName | undefined {
  return ROLE_TO_PACKAGE_ROLE[nodeRole];
}

export const PACKAGE_ROLE_NAMES: readonly PackageRoleName[] = [
  'agent-operator-native-planner',
  'agent-operator-native-reviewer',
  'agent-operator-native-synthesis',
];

export const APPROVED_ROLE_MANIFEST: Readonly<Record<PackageRoleName, string>> = Object.freeze({
  'agent-operator-native-planner': 'a8274f741b574a8b50be2cc8fdbf75906b00ed11ab17e91d0239c93ee9f95e38',
  'agent-operator-native-reviewer': 'fc0f6aa574aefb4f12beb5500bff769f4307c24c9f7e2357c7f10c6abea009cc',
  'agent-operator-native-synthesis': '2c3ef1fa1584bf4f3745706e17d928158aa3c0c6d745975b305a449855d51e41',
});

export const APPROVED_AGENT_RESULT_SCHEMA_HASH = 'a7ed51e9a5b5b0220887dacacdd8f629d6d823e3bfe5c67355d203588d0b7137';
export const AGENT_RESULT_SCHEMA_NAME = 'agent-result.v1' as const;

export type PackageRoleErrorCode =
  | 'ROLE_UNKNOWN'
  | 'ROLE_FILE_MISSING'
  | 'ROLE_FILE_NOT_REGULAR'
  | 'ROLE_HASH_MISMATCH'
  | 'ROLE_NAME_MISMATCH'
  | 'ROLE_FRONTMATTER_INVALID'
  | 'ROLE_SPAWNS_NOT_EMPTY'
  | 'OUTPUT_SCHEMA_FILE_MISSING'
  | 'OUTPUT_SCHEMA_FILE_NOT_REGULAR'
  | 'OUTPUT_SCHEMA_HASH_MISMATCH'
  | 'OUTPUT_SCHEMA_INVALID';

export class PackageRoleIntegrityError extends Error {
  readonly code: PackageRoleErrorCode;
  readonly roleName: string;
  readonly filePath: string | undefined;

  constructor(code: PackageRoleErrorCode, roleName: string, message: string, filePath?: string) {
    super(message);
    this.name = 'PackageRoleIntegrityError';
    this.code = code;
    this.roleName = roleName;
    this.filePath = filePath;
  }
}

export interface LoadedPackageRole {
  readonly name: PackageRoleName;
  readonly description: string;
  readonly tools: readonly string[];
  readonly spawns: false;
  readonly thinkingLevel?: string;
  readonly output: typeof AGENT_RESULT_SCHEMA_NAME;
  readonly systemPrompt: string;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly contentHash: string;
  readonly filePath: string;
}

export function resolvePackageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

interface ParsedFrontmatter {
  readonly fields: ReadonlyMap<string, string>;
  readonly body: string;
}

function parseFrontmatter(raw: string, roleName: string, filePath: string): ParsedFrontmatter {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new PackageRoleIntegrityError('ROLE_FRONTMATTER_INVALID', roleName, `Role file must begin with frontmatter: ${filePath}`, filePath);
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) {
    throw new PackageRoleIntegrityError('ROLE_FRONTMATTER_INVALID', roleName, `Role frontmatter is not closed: ${filePath}`, filePath);
  }
  const fields = new Map<string, string>();
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const separator = line.indexOf(':');
    if (separator <= 0) {
      throw new PackageRoleIntegrityError('ROLE_FRONTMATTER_INVALID', roleName, `Invalid frontmatter line ${index + 1}: ${filePath}`, filePath);
    }
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (fields.has(key)) {
      throw new PackageRoleIntegrityError('ROLE_FRONTMATTER_INVALID', roleName, `Duplicate frontmatter key "${key}": ${filePath}`, filePath);
    }
    fields.set(key, value);
  }
  return { fields, body: lines.slice(closing + 1).join('\n').replace(/^\n+/, '') };
}

async function regularFile(filePath: string, roleName: string, missing: PackageRoleErrorCode, notRegular: PackageRoleErrorCode): Promise<Stats> {
  let stat: Stats;
  try {
    stat = await fs.lstat(filePath);
  } catch {
    throw new PackageRoleIntegrityError(missing, roleName, `Required package file is missing: ${filePath}`, filePath);
  }
  if (!stat.isFile()) throw new PackageRoleIntegrityError(notRegular, roleName, `Required package path is not a regular file: ${filePath}`, filePath);
  return stat;
}

export async function loadAgentResultSchema(options: { readonly packageRoot?: string } = {}): Promise<Readonly<Record<string, unknown>>> {
  const root = options.packageRoot ?? resolvePackageRoot();
  const schemaPath = path.join(root, 'schemas', `${AGENT_RESULT_SCHEMA_NAME}.json`);
  await regularFile(schemaPath, AGENT_RESULT_SCHEMA_NAME, 'OUTPUT_SCHEMA_FILE_MISSING', 'OUTPUT_SCHEMA_FILE_NOT_REGULAR');
  const raw = await fs.readFile(schemaPath);
  const actual = sha256Hex(raw);
  if (actual !== APPROVED_AGENT_RESULT_SCHEMA_HASH) {
    throw new PackageRoleIntegrityError('OUTPUT_SCHEMA_HASH_MISMATCH', AGENT_RESULT_SCHEMA_NAME, `Output schema hash mismatch for ${schemaPath}`, schemaPath);
  }
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('schema root must be an object');
    return Object.freeze(parsed as Record<string, unknown>);
  } catch (error) {
    throw new PackageRoleIntegrityError('OUTPUT_SCHEMA_INVALID', AGENT_RESULT_SCHEMA_NAME, `Invalid output schema: ${error instanceof Error ? error.message : String(error)}`, schemaPath);
  }
}

export async function loadPackageRole(roleName: PackageRoleName, options: { readonly packageRoot?: string } = {}): Promise<LoadedPackageRole> {
  if (!PACKAGE_ROLE_NAMES.includes(roleName)) throw new PackageRoleIntegrityError('ROLE_UNKNOWN', roleName, `Unknown package role "${roleName}"`);
  const root = options.packageRoot ?? resolvePackageRoot();
  const filePath = path.join(root, 'agents', `${roleName}.md`);
  await regularFile(filePath, roleName, 'ROLE_FILE_MISSING', 'ROLE_FILE_NOT_REGULAR');
  const raw = await fs.readFile(filePath);
  const contentHash = sha256Hex(raw);
  if (contentHash !== APPROVED_ROLE_MANIFEST[roleName]) {
    throw new PackageRoleIntegrityError('ROLE_HASH_MISMATCH', roleName, `Role content hash mismatch: ${filePath}`, filePath);
  }
  const { fields, body } = parseFrontmatter(raw.toString('utf8'), roleName, filePath);
  if (fields.get('name') !== roleName) throw new PackageRoleIntegrityError('ROLE_NAME_MISMATCH', roleName, `Role name does not match ${roleName}: ${filePath}`, filePath);
  const description = fields.get('description');
  const toolsValue = fields.get('tools');
  const spawns = fields.get('spawns');
  const output = fields.get('output');
  if (description === undefined || toolsValue === undefined || output === undefined || body.trim() === '') {
    throw new PackageRoleIntegrityError('ROLE_FRONTMATTER_INVALID', roleName, `Role frontmatter or body is incomplete: ${filePath}`, filePath);
  }
  if (spawns !== '') throw new PackageRoleIntegrityError('ROLE_SPAWNS_NOT_EMPTY', roleName, `Role spawns must be empty: ${filePath}`, filePath);
  if (output !== AGENT_RESULT_SCHEMA_NAME) throw new PackageRoleIntegrityError('ROLE_FRONTMATTER_INVALID', roleName, `Role output must be ${AGENT_RESULT_SCHEMA_NAME}: ${filePath}`, filePath);
  const tools = toolsValue.split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0);
  if (tools.length === 0) throw new PackageRoleIntegrityError('ROLE_FRONTMATTER_INVALID', roleName, `Role has no tools: ${filePath}`, filePath);
  const thinkingLevel = fields.get('thinkingLevel');
  return {
    name: roleName,
    description,
    tools,
    spawns: false,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    output: AGENT_RESULT_SCHEMA_NAME,
    systemPrompt: body.trim(),
    outputSchema: await loadAgentResultSchema({ packageRoot: root }),
    contentHash,
    filePath,
  };
}

export async function loadAllPackageRoles(options: { readonly packageRoot?: string } = {}): Promise<Readonly<Record<PackageRoleName, LoadedPackageRole>>> {
  const entries = await Promise.all(PACKAGE_ROLE_NAMES.map(async (role) => [role, await loadPackageRole(role, options)] as const));
  return Object.fromEntries(entries) as Record<PackageRoleName, LoadedPackageRole>;
}

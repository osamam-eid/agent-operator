import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import type { QaNativeBinding } from './types.js';
import { validateQaBinding } from './bindings.js';

export interface LoadedQaAgent {
  readonly agentName: QaNativeBinding['agentName'];
  readonly description: string;
  readonly tools: readonly string[];
  readonly model: string;
  readonly systemPrompt: string;
  readonly contentSha256: string;
  readonly filePath: string;
}

export class QaAgentIntegrityError extends Error {
  readonly code: 'MISSING' | 'NOT_REGULAR' | 'HASH_MISMATCH' | 'FRONTMATTER' | 'IDENTITY_MISMATCH' | 'TOOL_MISMATCH';
  constructor(code: QaAgentIntegrityError['code'], message: string) { super(message); this.name = 'QaAgentIntegrityError'; this.code = code; }
}

function parseFrontmatter(raw: string): { readonly fields: ReadonlyMap<string, string>; readonly body: string } {
  const lines = raw.split('\n');
  if (lines[0]?.trim() !== '---') throw new QaAgentIntegrityError('FRONTMATTER', 'QA agent definition frontmatter is invalid.');
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (closing < 0) throw new QaAgentIntegrityError('FRONTMATTER', 'QA agent definition frontmatter is not closed.');
  const fields = new Map<string, string>();
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;
    const separator = line.indexOf(':');
    if (separator <= 0) throw new QaAgentIntegrityError('FRONTMATTER', 'QA agent definition contains invalid frontmatter.');
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (fields.has(key)) throw new QaAgentIntegrityError('FRONTMATTER', 'QA agent definition contains duplicate frontmatter.');
    fields.set(key, value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);
  }
  const body = lines.slice(closing + 1).join('\n').replace(/^\n+/, '').trim();
  if (body.length === 0) throw new QaAgentIntegrityError('FRONTMATTER', 'QA agent definition has no system prompt.');
  return { fields, body };
}

function parseTools(value: string | undefined): readonly string[] {
  if (value === undefined) throw new QaAgentIntegrityError('FRONTMATTER', 'QA agent definition has no tools declaration.');
  const tools = value.split(',').map((tool) => tool.trim()).filter((tool) => tool.length > 0);
  if (tools.length === 0 || new Set(tools).size !== tools.length) throw new QaAgentIntegrityError('FRONTMATTER', 'QA agent tools declaration is invalid.');
  return tools;
}

export async function loadVerifiedQaAgent(binding: QaNativeBinding, roleRoot: string): Promise<LoadedQaAgent> {
  validateQaBinding(binding);
  const filePath = path.join(path.resolve(roleRoot), `${binding.agentName}.md`);
  let raw: Buffer;
  try { raw = await fs.readFile(filePath); } catch { throw new QaAgentIntegrityError('MISSING', 'The configured authoritative QA agent definition is unavailable.'); }
  let stat;
  try { stat = await fs.stat(filePath); } catch { throw new QaAgentIntegrityError('MISSING', 'The configured authoritative QA agent definition is unavailable.'); }
  if (!stat.isFile()) throw new QaAgentIntegrityError('NOT_REGULAR', 'The configured authoritative QA agent definition is not a regular file.');
  const contentSha256 = createHash('sha256').update(raw).digest('hex');
  if (contentSha256 !== binding.roleContentSha256) throw new QaAgentIntegrityError('HASH_MISMATCH', 'The authoritative QA agent definition hash does not match the pinned binding.');
  const parsed = parseFrontmatter(raw.toString('utf8'));
  const name = parsed.fields.get('name');
  const description = parsed.fields.get('description');
  const model = parsed.fields.get('model');
  const spawns = parsed.fields.get('spawns');
  const tools = parseTools(parsed.fields.get('tools'));
  const output = parsed.fields.get('output');
  if (name !== binding.agentName || description === undefined || model !== `${binding.provider}/${binding.modelId}:high` || spawns !== '' || (output !== undefined && output !== binding.outputSchemaId)) throw new QaAgentIntegrityError('IDENTITY_MISMATCH', 'The authoritative QA agent identity, fixed model, or output schema does not match the binding.');
  if (tools.length !== binding.requiredRoleTools.length || tools.some((tool, index) => tool !== binding.requiredRoleTools[index])) throw new QaAgentIntegrityError('TOOL_MISMATCH', 'The authoritative QA agent tools do not match the pinned binding.');
  return { agentName: binding.agentName, description, tools, model, systemPrompt: parsed.body, contentSha256, filePath };
}

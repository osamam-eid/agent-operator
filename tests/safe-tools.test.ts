import { describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  type AgentToolDefinition,
  createOperatorSafeTools,
  OPERATOR_SAFE_TOOL_NAMES,
  type OperatorToolFactories,
  SafeToolViolation,
} from '../src/safe-tools.js';

/** Deterministic fake mirroring the grounded SDK contract: each factory is
 * bound to `(cwd, options)` and returns a base tool whose `execute` just
 * records the call and returns a sentinel — standing in for the real
 * `createReadToolDefinition`/`createGrepToolDefinition`/
 * `createFindToolDefinition`/`defineTool` this module wraps. */
function fakeFactories(recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }>): OperatorToolFactories {
  function baseTool(name: string, cwd: string): AgentToolDefinition {
    return {
      name,
      description: `${name} tool bound to ${cwd}`,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
      label: name.toUpperCase(),
      approval: 'read',
      execute: (callId, args) => {
        recorded.push({ tool: name, callId, args });
        return { ok: true, tool: name };
      },
    };
  }
  return {
    createReadToolDefinition: (cwd) => baseTool('read', cwd),
    createGrepToolDefinition: (cwd) => baseTool('grep', cwd),
    createFindToolDefinition: (cwd) => baseTool('find', cwd),
    defineTool: (definition) => definition,
  };
}

async function withProjectionRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-tools-test-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const fakeSignal = new AbortController().signal;

describe('createOperatorSafeTools — shape', () => {
  test('returns exactly operator_read, operator_grep, operator_glob, bound to the given cwd', async () => {
    await withProjectionRoot(async (root) => {
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const factories = fakeFactories(recorded);
      const tools = createOperatorSafeTools({ projectionRoot: root, factories });
      expect(tools.map((t) => t.name)).toEqual([...OPERATOR_SAFE_TOOL_NAMES]);
      expect(tools[0]?.description).toContain(root);
      expect(tools[0]?.label).toBe('READ'); // passthrough field from the underlying definition
      expect(tools[0]?.approval).toBe('read');
    });
  });

  test('rejects a non-absolute projectionRoot before calling any factory', async () => {
    const calls: string[] = [];
    const factories: OperatorToolFactories = {
      createReadToolDefinition: (cwd) => {
        calls.push('read');
        return { name: 'read', execute: () => undefined };
      },
      createGrepToolDefinition: (cwd) => {
        calls.push('grep');
        return { name: 'grep', execute: () => undefined };
      },
      createFindToolDefinition: (cwd) => {
        calls.push('find');
        return { name: 'find', execute: () => undefined };
      },
      defineTool: (definition) => definition,
    };
    expect(() => createOperatorSafeTools({ projectionRoot: 'relative/path', factories })).toThrow(SafeToolViolation);
    expect(calls).toEqual([]);
  });
});

describe('operator_read — path enforcement', () => {
  test('delegates to the underlying read tool for a path inside the projection root', async () => {
    await withProjectionRoot(async (root) => {
      await fs.writeFile(path.join(root, 'inside.txt'), 'ok');
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [readTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      const result = await readTool!.execute('call-1', { path: path.join(root, 'inside.txt') }, fakeSignal);
      expect(result).toEqual({ ok: true, tool: 'read' });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ tool: 'read', callId: 'call-1' });
    });
  });

  test('allows a read-selector suffix (file.ts:50-200 style) whose base path is in bounds', async () => {
    await withProjectionRoot(async (root) => {
      await fs.writeFile(path.join(root, 'file.ts'), 'content\n'.repeat(20));
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [readTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      const result = await readTool!.execute('call-2', { path: `${path.join(root, 'file.ts')}:1-5` }, fakeSignal);
      expect(result).toEqual({ ok: true, tool: 'read' });
      expect(recorded).toHaveLength(1);
    });
  });

  test('rejects an absolute path outside the projection root (proves forbidden paths never reach delegated execution)', async () => {
    await withProjectionRoot(async (root) => {
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [readTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      await expect(readTool!.execute('call-3', { path: '/etc/hosts' }, fakeSignal)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
      expect(recorded).toHaveLength(0);
    });
  });

  test('rejects a relative path that escapes the projection root via ../', async () => {
    await withProjectionRoot(async (root) => {
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [readTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      await expect(readTool!.execute('call-4', { path: '../../../etc/passwd' }, fakeSignal)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
      expect(recorded).toHaveLength(0);
    });
  });

  test('rejects a URL/internal-URI path before delegating', async () => {
    await withProjectionRoot(async (root) => {
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [readTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      for (const uri of ['memory://bank/entry', 'ssh://host/etc/passwd', 'https://example.com/x', 'agent://abc/output', 'artifact://xyz']) {
        await expect(readTool!.execute('call-5', { path: uri }, fakeSignal)).rejects.toMatchObject({ code: 'NON_LOCAL_PATH' });
      }
      expect(recorded).toHaveLength(0);
    });
  });

  test('rejects malformed args before delegating', async () => {
    await withProjectionRoot(async (root) => {
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [readTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      await expect(readTool!.execute('call-6', {}, fakeSignal)).rejects.toMatchObject({ code: 'MALFORMED_TOOL_INPUT' });
      await expect(readTool!.execute('call-7', { path: 42 }, fakeSignal)).rejects.toMatchObject({ code: 'MALFORMED_TOOL_INPUT' });
      await expect(readTool!.execute('call-8', null as unknown as Record<string, unknown>, fakeSignal)).rejects.toMatchObject({ code: 'MALFORMED_TOOL_INPUT' });
      await expect(readTool!.execute('call-9', [] as unknown as Record<string, unknown>, fakeSignal)).rejects.toMatchObject({ code: 'MALFORMED_TOOL_INPUT' });
      expect(recorded).toHaveLength(0);
    });
  });
});

describe('operator_grep / operator_glob — semicolon lists and omission', () => {
  test('allows an omitted path (defaults to the already-bounded cwd)', async () => {
    await withProjectionRoot(async (root) => {
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [, grepTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      const result = await grepTool!.execute('call-10', { pattern: 'foo' }, fakeSignal);
      expect(result).toEqual({ ok: true, tool: 'grep' });
      expect(recorded).toHaveLength(1);
    });
  });

  test('allows a semicolon-delimited list where every segment is in bounds', async () => {
    await withProjectionRoot(async (root) => {
      await fs.writeFile(path.join(root, 'a.ts'), 'a');
      await fs.writeFile(path.join(root, 'b.ts'), 'b');
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [, , globTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      const rawPath = `${path.join(root, 'a.ts')}; ${path.join(root, 'b.ts')}`;
      const result = await globTool!.execute('call-11', { path: rawPath }, fakeSignal);
      expect(result).toEqual({ ok: true, tool: 'find' });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.args['path']).toBe(rawPath); // args pass through unmodified once validated
    });
  });

  test('rejects the whole call when any segment of a semicolon list escapes — none of it reaches execute', async () => {
    await withProjectionRoot(async (root) => {
      await fs.writeFile(path.join(root, 'a.ts'), 'a');
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [, grepTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      const rawPath = `${path.join(root, 'a.ts')};/etc/hosts`;
      await expect(grepTool!.execute('call-12', { pattern: 'x', path: rawPath }, fakeSignal)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
      expect(recorded).toHaveLength(0);
    });
  });

  test('rejects a non-string path', async () => {
    await withProjectionRoot(async (root) => {
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [, , globTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      await expect(globTool!.execute('call-13', { path: 42 }, fakeSignal)).rejects.toMatchObject({ code: 'MALFORMED_TOOL_INPUT' });
      expect(recorded).toHaveLength(0);
    });
  });

  test('rejects a blank/empty-only semicolon list', async () => {
    await withProjectionRoot(async (root) => {
      const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
      const [, grepTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
      await expect(grepTool!.execute('call-14', { pattern: 'x', path: '  ; ; ' }, fakeSignal)).rejects.toMatchObject({ code: 'MALFORMED_TOOL_INPUT' });
      expect(recorded).toHaveLength(0);
    });
  });
});

describe('operator_* — symlink escape via realpath', () => {
  test('rejects a path that resolves inside the root textually but whose target is a symlink pointing outside', async () => {
    await withProjectionRoot(async (root) => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'safe-tools-outside-'));
      try {
        const outsideSecret = path.join(outside, 'secret.txt');
        await fs.writeFile(outsideSecret, 'secret');
        const linkInRoot = path.join(root, 'looks-local.txt');
        await fs.symlink(outsideSecret, linkInRoot);

        const recorded: Array<{ tool: string; callId: string; args: Record<string, unknown> }> = [];
        const [readTool] = createOperatorSafeTools({ projectionRoot: root, factories: fakeFactories(recorded) });
        await expect(readTool!.execute('call-15', { path: linkInRoot }, fakeSignal)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
        expect(recorded).toHaveLength(0);
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });
});

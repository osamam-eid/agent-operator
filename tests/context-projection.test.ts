import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  collectSharedProjectSources,
  materializeProjection,
  PROJECTION_MANIFEST_ALGORITHM,
  ProjectionError,
  type ProjectionSource,
} from '../src/context-projection.js';

let rootDir: string;
let projectRoot: string;
let destinationCounter: number;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'context-projection-test-'));
  projectRoot = path.join(rootDir, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  destinationCounter = 0;
});

afterEach(async () => {
  await restoreWritePermissions(rootDir);
  await fs.rm(rootDir, { recursive: true, force: true });
});

/** `materializeProjection` locks its output directory to 0500 and every
 * file within it to 0400 (asserted in the "POSIX permission lockdown"
 * describe block below) — correct production behavior for a read-only
 * projection handed to a child session. `fs.rm` needs write permission on
 * every directory it descends into to unlink entries, so cleanup must
 * restore write bits first; this never touches the assertions made while
 * a test is still running against the locked-down tree. */
async function restoreWritePermissions(target: string): Promise<void> {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    await fs.chmod(target, 0o700);
    const entries = await fs.readdir(target);
    await Promise.all(entries.map((entry) => restoreWritePermissions(path.join(target, entry))));
  } else if (stat.isFile()) {
    await fs.chmod(target, 0o600);
  }
}

function nextDestination(): string {
  destinationCounter += 1;
  return path.join(rootDir, `dest-${destinationCounter}`);
}

async function writeSourceFile(relativePath: string, content: string): Promise<string> {
  const absolutePath = path.join(projectRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, content, 'utf8');
  return absolutePath;
}

const GENEROUS_LIMITS = { maxFiles: 100, maxTotalBytes: 1_000_000, maxFileBytes: 100_000 };

describe('collectSharedProjectSources', () => {
  test('collects the configured shared root recursively in stable byte order', async () => {
    const z = await writeSourceFile('z.txt', 'z');
    const nested = await writeSourceFile('nested/a.txt', 'a');

    const sources = await collectSharedProjectSources(projectRoot, 10);

    expect(sources).toEqual([
      { label: 'project:nested/a.txt', absolutePath: nested },
      { label: 'project:z.txt', absolutePath: z },
    ]);
  });

  test('fails closed instead of truncating a shared root above the file cap', async () => {
    await writeSourceFile('a.txt', 'a');
    await writeSourceFile('b.txt', 'b');

    await expect(collectSharedProjectSources(projectRoot, 1)).rejects.toMatchObject({ code: 'FILE_COUNT_EXCEEDED' });
  });
});


describe('materializeProjection — deterministic manifests', () => {
  test('same declared sources produce the same manifest entries and digest across independent runs', async () => {
    const planPath = await writeSourceFile('plan.md', '# implementation plan\n');
    const evidencePath = await writeSourceFile('evidence.json', '{"claim":"x"}');
    const sources: ProjectionSource[] = [
      { label: 'artifact:plan', absolutePath: planPath },
      { label: 'evidence:e1', absolutePath: evidencePath },
    ];

    const first = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources,
      limits: GENEROUS_LIMITS,
    });
    const second = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources,
      limits: GENEROUS_LIMITS,
    });

    expect(first.manifest.algorithm).toBe(PROJECTION_MANIFEST_ALGORITHM);
    expect(first.manifest.manifestDigest).toBe(second.manifest.manifestDigest);
    expect(first.manifest.entries.map((e) => ({ label: e.label, relativePath: e.relativePath, sizeBytes: e.sizeBytes, sha256: e.sha256 }))).toEqual(
      second.manifest.entries.map((e) => ({ label: e.label, relativePath: e.relativePath, sizeBytes: e.sizeBytes, sha256: e.sha256 })),
    );
    expect(first.manifest.fileCount).toBe(2);
    expect(first.manifest.totalBytes).toBe(second.manifest.totalBytes);
  });

  test('manifest entries are sorted by relativePath regardless of declaration order', async () => {
    const a = await writeSourceFile('a.txt', 'aaa');
    const b = await writeSourceFile('b.txt', 'bbb');

    const forward = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources: [
        { label: 'first', absolutePath: a },
        { label: 'second', absolutePath: b },
      ],
      limits: GENEROUS_LIMITS,
    });
    const reversed = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources: [
        { label: 'second', absolutePath: b },
        { label: 'first', absolutePath: a },
      ],
      limits: GENEROUS_LIMITS,
    });

    // Declaration order changes the index-prefixed relativePath assigned to
    // each label, but the manifest is always emitted sorted by
    // relativePath, so entries.map(label) still reflects each run's own
    // (self-consistent) declaration order rather than being scrambled.
    expect(forward.manifest.entries.map((e) => e.relativePath)).toEqual([...forward.manifest.entries.map((e) => e.relativePath)].sort());
    expect(reversed.manifest.entries.map((e) => e.relativePath)).toEqual([...reversed.manifest.entries.map((e) => e.relativePath)].sort());
  });
});

describe('materializeProjection — caps', () => {
  test('rejects when declared source count exceeds maxFiles', async () => {
    const a = await writeSourceFile('a.txt', 'a');
    const b = await writeSourceFile('b.txt', 'b');
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [
          { label: 'a', absolutePath: a },
          { label: 'b', absolutePath: b },
        ],
        limits: { maxFiles: 1, maxTotalBytes: 1_000, maxFileBytes: 1_000 },
      }),
    ).rejects.toMatchObject({ code: 'FILE_COUNT_EXCEEDED' });
  });

  test('rejects a single source larger than maxFileBytes', async () => {
    const big = await writeSourceFile('big.txt', 'x'.repeat(1000));
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [{ label: 'big', absolutePath: big }],
        limits: { maxFiles: 10, maxTotalBytes: 1_000_000, maxFileBytes: 100 },
      }),
    ).rejects.toMatchObject({ code: 'FILE_BYTES_EXCEEDED' });
  });

  test('rejects when combined source bytes exceed maxTotalBytes', async () => {
    const a = await writeSourceFile('a.txt', 'x'.repeat(60));
    const b = await writeSourceFile('b.txt', 'x'.repeat(60));
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [
          { label: 'a', absolutePath: a },
          { label: 'b', absolutePath: b },
        ],
        limits: { maxFiles: 10, maxTotalBytes: 100, maxFileBytes: 1_000 },
      }),
    ).rejects.toMatchObject({ code: 'TOTAL_BYTES_EXCEEDED' });
  });

  test('a rejected request never leaves a partial destination directory on disk', async () => {
    const big = await writeSourceFile('big.txt', 'x'.repeat(1000));
    const destinationRoot = nextDestination();
    await expect(
      materializeProjection({
        destinationRoot,
        allowedRoots: [projectRoot],
        sources: [{ label: 'big', absolutePath: big }],
        limits: { maxFiles: 10, maxTotalBytes: 1_000_000, maxFileBytes: 100 },
      }),
    ).rejects.toThrow(ProjectionError);
    await expect(fs.stat(destinationRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('materializeProjection — symlink, special-file, path, and URI rejection', () => {
  test('rejects a symlinked source', async () => {
    const real = await writeSourceFile('real.txt', 'content');
    const linkPath = path.join(projectRoot, 'link.txt');
    await fs.symlink(real, linkPath);
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [{ label: 'link', absolutePath: linkPath }],
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'SYMLINK_REJECTED' });
  });

  test('rejects a directory declared as a source (special/non-regular file)', async () => {
    const dirPath = path.join(projectRoot, 'a-directory');
    await fs.mkdir(dirPath);
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [{ label: 'dir', absolutePath: dirPath }],
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'SPECIAL_FILE_REJECTED' });
  });

  test('rejects a relative source path', async () => {
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [{ label: 'rel', absolutePath: 'relative/path.txt' }],
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  });

  test('rejects a URL/internal-URI source', async () => {
    for (const uri of ['https://example.com/secret', 'memory://bank/entry', 'ssh://host/etc/passwd', 'agent://abc/output']) {
      await expect(
        materializeProjection({
          destinationRoot: nextDestination(),
          allowedRoots: [projectRoot],
          sources: [{ label: 'uri', absolutePath: uri }],
          limits: GENEROUS_LIMITS,
        }),
      ).rejects.toMatchObject({ code: 'NON_LOCAL_SOURCE' });
    }
  });

  test('rejects a source outside every declared allowed root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'context-projection-outside-'));
    try {
      const outsideFile = path.join(outside, 'secret.txt');
      await fs.writeFile(outsideFile, 'secret');
      await expect(
        materializeProjection({
          destinationRoot: nextDestination(),
          allowedRoots: [projectRoot],
          sources: [{ label: 'outside', absolutePath: outsideFile }],
          limits: GENEROUS_LIMITS,
        }),
      ).rejects.toMatchObject({ code: 'UNDECLARED_ROOT' });
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('rejects a source that does not exist', async () => {
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [{ label: 'missing', absolutePath: path.join(projectRoot, 'does-not-exist.txt') }],
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_NOT_FOUND' });
  });
});

describe('materializeProjection — malformed requests', () => {
  test('rejects a non-absolute destinationRoot', async () => {
    await expect(
      materializeProjection({
        destinationRoot: 'relative/dest',
        allowedRoots: [projectRoot],
        sources: [],
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  test('rejects an existing destinationRoot', async () => {
    const destinationRoot = nextDestination();
    await fs.mkdir(destinationRoot);
    await expect(
      materializeProjection({
        destinationRoot,
        allowedRoots: [projectRoot],
        sources: [],
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' });
  });

  test('rejects duplicate source labels', async () => {
    const a = await writeSourceFile('a.txt', 'a');
    const b = await writeSourceFile('b.txt', 'b');
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [
          { label: 'same', absolutePath: a },
          { label: 'same', absolutePath: b },
        ],
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_LABEL' });
  });

  test('rejects a non-object source entry instead of crashing', async () => {
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [null as unknown as ProjectionSource],
        limits: GENEROUS_LIMITS,
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });

  test('rejects malformed limits', async () => {
    await expect(
      materializeProjection({
        destinationRoot: nextDestination(),
        allowedRoots: [projectRoot],
        sources: [],
        limits: { maxFiles: -1, maxTotalBytes: 100, maxFileBytes: 100 },
      }),
    ).rejects.toMatchObject({ code: 'MALFORMED_REQUEST' });
  });
});

describe('materializeProjection — canary-secret omission and context-policy shapes', () => {
  test('a canary secret in an undeclared file under an allowed root is never materialized', async () => {
    const declared = await writeSourceFile('declared.txt', 'declared content');
    await writeSourceFile('undeclared-canary.txt', 'CANARY-SECRET-VALUE-1');

    const result = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources: [{ label: 'declared', absolutePath: declared }],
      limits: GENEROUS_LIMITS,
    });

    expect(result.manifest.fileCount).toBe(1);
    const entries = await fs.readdir(result.projectionRoot);
    expect(entries).toHaveLength(1);
    for (const entry of entries) {
      const content = await fs.readFile(path.join(result.projectionRoot, entry), 'utf8');
      expect(content).not.toContain('CANARY-SECRET-VALUE-1');
    }
  });

  test('isolated policy: only the declared input is materialized, no sibling artifact leaks in', async () => {
    const implementerInput = await writeSourceFile('isolated/task.md', 'task instructions');
    await writeSourceFile('isolated/sibling-result.json', '{"private":"sibling reasoning"}');

    const result = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources: [{ label: 'consumes:task', absolutePath: implementerInput }],
      limits: GENEROUS_LIMITS,
    });

    expect(result.manifest.entries).toHaveLength(1);
    expect(result.manifest.entries[0]?.label).toBe('consumes:task');
  });

  test('summary-only policy: a validated summary artifact is materialized, raw transcript content is never declared or present', async () => {
    const summary = await writeSourceFile('summary/finding-summary.md', 'concise validated summary');
    const rawTranscriptPath = await writeSourceFile('summary/raw-transcript.jsonl', '{"hiddenReasoning":"..."}');
    void rawTranscriptPath; // exists on disk but is never declared as a source

    const result = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources: [{ label: 'summary:finding', absolutePath: summary }],
      limits: GENEROUS_LIMITS,
    });

    expect(result.manifest.entries).toHaveLength(1);
    const entries = await fs.readdir(result.projectionRoot);
    expect(entries).toHaveLength(1);
    const content = await fs.readFile(path.join(result.projectionRoot, entries[0]!), 'utf8');
    expect(content).toBe('concise validated summary');
  });

  test('shared policy: the full explicitly approved shared input set is materialized, nothing beyond it', async () => {
    const shared1 = await writeSourceFile('shared/project-file-1.md', 'shared 1');
    const shared2 = await writeSourceFile('shared/project-file-2.md', 'shared 2');
    await writeSourceFile('shared/not-approved.md', 'not approved for sharing');

    const result = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources: [
        { label: 'shared:file-1', absolutePath: shared1 },
        { label: 'shared:file-2', absolutePath: shared2 },
      ],
      limits: GENEROUS_LIMITS,
    });

    expect(result.manifest.entries).toHaveLength(2);
    const entries = await fs.readdir(result.projectionRoot);
    expect(entries).toHaveLength(2);
    const contents = await Promise.all(entries.map((entry) => fs.readFile(path.join(result.projectionRoot, entry), 'utf8')));
    expect(contents.sort()).toEqual(['shared 1', 'shared 2']);
    expect(contents.join('\n')).not.toContain('not approved');
  });
});

describe('materializeProjection — POSIX permission lockdown', () => {
  test('locks the projection directory to 0500 and every file to 0400', async () => {
    if (process.platform === 'win32') return;
    const a = await writeSourceFile('a.txt', 'a');
    const result = await materializeProjection({
      destinationRoot: nextDestination(),
      allowedRoots: [projectRoot],
      sources: [{ label: 'a', absolutePath: a }],
      limits: GENEROUS_LIMITS,
    });

    const dirStat = await fs.stat(result.projectionRoot);
    expect(dirStat.mode & 0o777).toBe(0o500);
    const entries = await fs.readdir(result.projectionRoot);
    for (const entry of entries) {
      const fileStat = await fs.stat(path.join(result.projectionRoot, entry));
      expect(fileStat.mode & 0o777).toBe(0o400);
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  collectBundleFiles,
  HASH_BUNDLE_ALGORITHM,
  HashBundleEntryError,
  HashBundleTargetError,
  hashBundle,
} from '../scripts/hash-bundle.js';

// The exact canonical Stage 4 base values pinned by the approved plan. If
// this environment does not have the immutable Stage 3 base checked out at
// this fixed path, the dedicated test below skips instead of failing.
const STAGE3_BASE = '/tmp/agent-operator-candidate';
const STAGE3_FILE_COUNT = 52;
const STAGE3_TOTAL_BYTES = 778858;
const STAGE3_DIGEST = '7d725b5e89b844e50d564a295294c66b3db19a2ae8dd6f6b0678faea63c3e32d';

let rootDir: string;

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-bundle-test-'));
});

afterEach(async () => {
  await fs.rm(rootDir, { recursive: true, force: true });
});

describe('hashBundle — algorithm and byte/file totals', () => {
  test('reports exact file count and total content bytes', async () => {
    await fs.writeFile(path.join(rootDir, 'a.txt'), 'hello'); // 5 bytes
    await fs.mkdir(path.join(rootDir, 'nested'));
    await fs.writeFile(path.join(rootDir, 'nested', 'b.txt'), 'world!!'); // 7 bytes

    const result = await hashBundle(rootDir);

    expect(result.fileCount).toBe(2);
    expect(result.totalBytes).toBe(12);
    expect(result.algorithm).toBe(HASH_BUNDLE_ALGORITHM);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('changed file content changes the digest', async () => {
    await fs.writeFile(path.join(rootDir, 'a.txt'), 'hello');
    const before = await hashBundle(rootDir);

    await fs.writeFile(path.join(rootDir, 'a.txt'), 'hellp');
    const after = await hashBundle(rootDir);

    expect(after.digest).not.toBe(before.digest);
    expect(after.fileCount).toBe(before.fileCount);
    expect(after.totalBytes).toBe(before.totalBytes);
  });

  test('is deterministic across repeated runs on the same input', async () => {
    await fs.writeFile(path.join(rootDir, 'a.txt'), 'stable content');
    await fs.mkdir(path.join(rootDir, 'dir'));
    await fs.writeFile(path.join(rootDir, 'dir', 'b.txt'), 'more content');

    const first = await hashBundle(rootDir);
    const second = await hashBundle(rootDir);

    expect(second).toEqual(first);
  });
});

describe('hashBundle — ordering', () => {
  test('sorts by unsigned UTF-8 byte order of the relative path, independent of creation order', async () => {
    // Create the same three files in a deliberately scrambled order in one
    // directory, and in ascending order in another. The digest must match
    // because sorting happens after the walk, not during it.
    await fs.writeFile(path.join(rootDir, 'zebra.txt'), '1');
    await fs.writeFile(path.join(rootDir, 'apple.txt'), '2');
    await fs.writeFile(path.join(rootDir, 'mango.txt'), '3');

    const scrambledResult = await hashBundle(rootDir);

    const orderedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-bundle-test-ordered-'));
    try {
      await fs.writeFile(path.join(orderedDir, 'apple.txt'), '2');
      await fs.writeFile(path.join(orderedDir, 'mango.txt'), '3');
      await fs.writeFile(path.join(orderedDir, 'zebra.txt'), '1');

      const orderedResult = await hashBundle(orderedDir);

      expect(orderedResult.digest).toBe(scrambledResult.digest);
    } finally {
      await fs.rm(orderedDir, { recursive: true, force: true });
    }
  });

  test('collectBundleFiles returns paths pre-sorted by unsigned UTF-8 byte order', async () => {
    await fs.writeFile(path.join(rootDir, 'b.txt'), '');
    await fs.mkdir(path.join(rootDir, 'a-dir'));
    await fs.writeFile(path.join(rootDir, 'a-dir', 'z.txt'), '');
    await fs.writeFile(path.join(rootDir, 'a.txt'), '');

    const files = await collectBundleFiles(rootDir);
    const paths = files.map((f) => f.relativePath);

    // Ascending unsigned UTF-8 byte order: '.' (0x2e) sorts before any
    // letter, so "a-dir/z.txt" and "a.txt" order by comparing 'a' (tie),
    // then '-' (0x2d) vs '.' (0x2e) — '-' is smaller, so the directory
    // entry sorts first.
    expect(paths).toEqual(['a-dir/z.txt', 'a.txt', 'b.txt']);
  });

  test('swapping two file names changes the digest (order-sensitive content binding)', async () => {
    await fs.writeFile(path.join(rootDir, 'first.txt'), 'AAA');
    await fs.writeFile(path.join(rootDir, 'second.txt'), 'BBB');
    const original = await hashBundle(rootDir);

    await fs.writeFile(path.join(rootDir, 'first.txt'), 'BBB');
    await fs.writeFile(path.join(rootDir, 'second.txt'), 'AAA');
    const swapped = await hashBundle(rootDir);

    expect(swapped.digest).not.toBe(original.digest);
  });
});

describe('hashBundle — length-prefix boundaries', () => {
  test('a path/content byte split cannot be forged by an equal-length concatenation', async () => {
    // Without length prefixes, a single file named "ab" with content "cd"
    // and a single file named "a" with content "bcd" would concatenate to
    // the same bytes ("abcd"). The u64be length prefixes must make these
    // distinguishable.
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-bundle-test-boundary-a-'));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-bundle-test-boundary-b-'));
    try {
      await fs.writeFile(path.join(dirA, 'ab'), 'cd');
      await fs.writeFile(path.join(dirB, 'a'), 'bcd');

      const resultA = await hashBundle(dirA);
      const resultB = await hashBundle(dirB);

      expect(resultA.digest).not.toBe(resultB.digest);
    } finally {
      await fs.rm(dirA, { recursive: true, force: true });
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });

  test('two files whose names concatenate to a third single file name stay distinguishable', async () => {
    // "foo" + "bar" (as two files) must not collide with a single file
    // named "foobar" holding the concatenated content, even though naive
    // unframed concatenation of (name, content) pairs would collide.
    const dirTwoFiles = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-bundle-test-split-'));
    const dirOneFile = await fs.mkdtemp(path.join(os.tmpdir(), 'hash-bundle-test-joined-'));
    try {
      await fs.writeFile(path.join(dirTwoFiles, 'foo'), '');
      await fs.writeFile(path.join(dirTwoFiles, 'bar'), '');
      await fs.writeFile(path.join(dirOneFile, 'foobar'), '');

      const twoFilesResult = await hashBundle(dirTwoFiles);
      const oneFileResult = await hashBundle(dirOneFile);

      expect(twoFilesResult.digest).not.toBe(oneFileResult.digest);
    } finally {
      await fs.rm(dirTwoFiles, { recursive: true, force: true });
      await fs.rm(dirOneFile, { recursive: true, force: true });
    }
  });

  test('a file with an exact 8-byte name and content still hashes correctly across the u64be boundary', async () => {
    const eightByteName = 'abcdefgh';
    await fs.writeFile(path.join(rootDir, eightByteName), '12345678');

    const result = await hashBundle(rootDir);

    expect(result.fileCount).toBe(1);
    expect(result.totalBytes).toBe(8);
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('hashBundle — exclusions', () => {
  test('excludes .git and node_modules directories (any depth) and .DS_Store files from the digest', async () => {
    await fs.writeFile(path.join(rootDir, 'kept.txt'), 'content');
    const bare = await hashBundle(rootDir);

    await fs.mkdir(path.join(rootDir, '.git'));
    await fs.writeFile(path.join(rootDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    await fs.mkdir(path.join(rootDir, 'node_modules', 'some-pkg'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = {};');
    await fs.mkdir(path.join(rootDir, 'nested', '.git'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'nested', '.git', 'config'), '[core]');
    await fs.writeFile(path.join(rootDir, '.DS_Store'), 'binary-ish junk');
    await fs.mkdir(path.join(rootDir, 'nested'), { recursive: true });
    await fs.writeFile(path.join(rootDir, 'nested', '.DS_Store'), 'more junk');

    const withExcluded = await hashBundle(rootDir);

    expect(withExcluded.fileCount).toBe(bare.fileCount);
    expect(withExcluded.totalBytes).toBe(bare.totalBytes);
    expect(withExcluded.digest).toBe(bare.digest);
  });

  test('does not descend into an excluded directory even when it contains further excluded files', async () => {
    await fs.mkdir(path.join(rootDir, '.git', 'refs', 'heads'), { recursive: true });
    await fs.writeFile(path.join(rootDir, '.git', 'refs', 'heads', 'main'), 'abc123');
    await fs.writeFile(path.join(rootDir, 'kept.txt'), 'x');

    const files = await collectBundleFiles(rootDir);

    expect(files.map((f) => f.relativePath)).toEqual(['kept.txt']);
  });
});

describe('hashBundle — target rejection', () => {
  test('rejects a missing target directory', async () => {
    const missing = path.join(rootDir, 'does-not-exist');

    await expect(hashBundle(missing)).rejects.toBeInstanceOf(HashBundleTargetError);
    await expect(hashBundle(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('rejects a target path that is a regular file, not a directory', async () => {
    const filePath = path.join(rootDir, 'not-a-dir.txt');
    await fs.writeFile(filePath, 'content');

    await expect(hashBundle(filePath)).rejects.toBeInstanceOf(HashBundleTargetError);
    await expect(hashBundle(filePath)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  test('rejects a target path that is a symlink to a directory rather than following it', async () => {
    const realDir = path.join(rootDir, 'real');
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, 'a.txt'), 'x');
    const linkPath = path.join(rootDir, 'link-to-real');
    await fs.symlink(realDir, linkPath, 'dir');

    await expect(hashBundle(linkPath)).rejects.toBeInstanceOf(HashBundleTargetError);
    await expect(hashBundle(linkPath)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('hashBundle — entry rejection', () => {
  test('rejects a symlinked file inside the tree instead of following it', async () => {
    await fs.writeFile(path.join(rootDir, 'real.txt'), 'content');
    await fs.symlink(path.join(rootDir, 'real.txt'), path.join(rootDir, 'link.txt'));

    await expect(hashBundle(rootDir)).rejects.toBeInstanceOf(HashBundleEntryError);
    await expect(hashBundle(rootDir)).rejects.toMatchObject({ code: 'ESYMLINK' });
  });

  test('rejects a symlinked directory inside the tree instead of descending into it', async () => {
    const realDir = path.join(rootDir, 'real-dir');
    await fs.mkdir(realDir);
    await fs.writeFile(path.join(realDir, 'a.txt'), 'x');
    await fs.symlink(realDir, path.join(rootDir, 'link-dir'), 'dir');

    await expect(hashBundle(rootDir)).rejects.toBeInstanceOf(HashBundleEntryError);
    await expect(hashBundle(rootDir)).rejects.toMatchObject({ code: 'ESYMLINK' });
  });

  test('rejects an unsupported special file (a FIFO) rather than reading or skipping it', async () => {
    const fifoPath = path.join(rootDir, 'a-fifo');
    try {
      execFileSync('mkfifo', [fifoPath]);
    } catch {
      // mkfifo unavailable on this platform/PATH — nothing meaningful to
      // assert; skip rather than fail the whole suite for an environment gap.
      return;
    }

    await expect(hashBundle(rootDir)).rejects.toBeInstanceOf(HashBundleEntryError);
    await expect(hashBundle(rootDir)).rejects.toMatchObject({ code: 'EUNSUPPORTED_TYPE' });
  });
});

describe('hashBundle — CLI', () => {
  test('emits a stable compact JSON object by default', async () => {
    await fs.writeFile(path.join(rootDir, 'a.txt'), 'hello');

    const raw = execFileSync('bun', [path.join(import.meta.dir, '..', 'scripts', 'hash-bundle.ts'), rootDir], {
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);

    expect(Object.keys(parsed).sort()).toEqual(['algorithm', 'digest', 'fileCount', 'root', 'totalBytes']);
    expect(parsed.algorithm).toBe(HASH_BUNDLE_ALGORITHM);
    expect(parsed.fileCount).toBe(1);
    expect(parsed.totalBytes).toBe(5);
    expect(parsed.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('--manifest includes a machine-readable per-file list matching the library result', async () => {
    await fs.writeFile(path.join(rootDir, 'a.txt'), 'hello');
    await fs.mkdir(path.join(rootDir, 'nested'));
    await fs.writeFile(path.join(rootDir, 'nested', 'b.txt'), 'world!!');

    const libraryResult = await hashBundle(rootDir);
    const raw = execFileSync(
      'bun',
      [path.join(import.meta.dir, '..', 'scripts', 'hash-bundle.ts'), rootDir, '--manifest'],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(raw);

    expect(parsed.digest).toBe(libraryResult.digest);
    expect(parsed.files).toEqual([
      { path: 'a.txt', bytes: 5 },
      { path: 'nested/b.txt', bytes: 7 },
    ]);
  });

  test('exits non-zero with a diagnostic on stderr for a missing target', () => {
    const missing = path.join(rootDir, 'does-not-exist');
    let threw = false;
    try {
      execFileSync('bun', [path.join(import.meta.dir, '..', 'scripts', 'hash-bundle.ts'), missing], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      threw = true;
      const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
      expect(stderr).toContain('does not exist');
    }
    expect(threw).toBe(true);
  });
});

describe('hashBundle — immutable Stage 3 base (canonical gate value)', () => {
  test('matches the exact pinned Stage 4 provenance digest, file count, and byte count', async () => {
    if (!existsSync(STAGE3_BASE)) {
      // Not every environment running this suite has the fixed Stage 3
      // scratch path checked out; skip rather than fail spuriously.
      return;
    }

    const result = await hashBundle(STAGE3_BASE);

    expect(result.fileCount).toBe(STAGE3_FILE_COUNT);
    expect(result.totalBytes).toBe(STAGE3_TOTAL_BYTES);
    expect(result.digest).toBe(STAGE3_DIGEST);
  });
});

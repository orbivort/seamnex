import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import {
  HOST_SEPARATOR,
  assertFileSegment,
  ensureDir,
  exists,
  isFile,
  readTextFile,
  safeJoin,
  sha256,
  writeFileAtomic,
} from '../../../../src/common/fs/files';

/**
 * These run against a real directory rather than a mocked `node:fs`: atomicity and containment are
 * properties of the filesystem call, and a mock would only prove the mock.
 */
const ROOT = resolve(process.cwd(), 'temp', 'vitest-files');

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  ensureDir(ROOT);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('directory and content helpers', () => {
  it('creates a nested directory idempotently', () => {
    const nested = join(ROOT, 'a', 'b', 'c');
    ensureDir(nested);
    ensureDir(nested);
    expect(statSync(nested).isDirectory()).toBe(true);
  });

  it('hashes strings and buffers identically', () => {
    expect(sha256('abc')).toBe(sha256(Buffer.from('abc')));
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('reads text back with utf8 decoding', () => {
    const file = join(ROOT, 'read-me.txt');
    writeFileAtomic(file, 'héllo');
    expect(readTextFile(file)).toBe('héllo');
  });

  it('reports existence and file-ness without throwing on a missing path', () => {
    const file = join(ROOT, 'present.txt');
    writeFileAtomic(file, 'x');
    expect(exists(file)).toBe(true);
    expect(exists(join(ROOT, 'absent.txt'))).toBe(false);
    expect(isFile(file)).toBe(true);
    expect(isFile(join(ROOT, 'absent.txt'))).toBe(false);
    expect(isFile(ROOT)).toBe(false);
  });
});

describe('safeJoin', () => {
  it('resolves a normal relative path under the root', () => {
    expect(safeJoin(ROOT, 'nested/file.yml')).toBe(join(ROOT, 'nested', 'file.yml'));
    expect(safeJoin(ROOT, 'a/../b.yml')).toBe(join(ROOT, 'b.yml'));
  });

  it('refuses an absolute path or an empty one', () => {
    expect(() => safeJoin(ROOT, '/etc/passwd')).toThrow(/relative and non-empty/);
    expect(() => safeJoin(ROOT, '')).toThrow(/relative and non-empty/);
  });

  it('refuses a traversal, and a traversal that only escapes after resolution', () => {
    expect(() => safeJoin(ROOT, '../outside.yml')).toThrow(/escapes its root/);
    expect(() => safeJoin(ROOT, 'a/../../outside.yml')).toThrow(/escapes its root/);
    expect(() => safeJoin(ROOT, 'a/b/../../../outside.yml')).toThrow(/escapes its root/);
  });

  it('refuses the root itself, which is not a file path', () => {
    expect(() => safeJoin(ROOT, '.')).toThrow(/escapes its root/);
  });
});

describe('writeFileAtomic', () => {
  it('writes content and leaves no temporary file behind', () => {
    const file = join(ROOT, 'atomic.txt');
    writeFileAtomic(file, 'first');
    writeFileAtomic(file, 'second');
    expect(readFileSync(file, 'utf8')).toBe('second');
    const leftovers = statSync(ROOT).isDirectory()
      ? readDirNames(ROOT).filter((name) => name.startsWith('atomic.txt.') && name.endsWith('.tmp'))
      : [];
    expect(leftovers).toEqual([]);
  });

  it('applies an explicit mode when one is given', () => {
    const file = join(ROOT, 'mode.txt');
    writeFileAtomic(file, 'x', 0o600);
    expect(existsSync(file)).toBe(true);
  });

  it('creates nothing when the directory does not exist, rather than a partial file', () => {
    const file = join(ROOT, 'missing-dir', 'file.txt');
    expect(() => writeFileAtomic(file, 'x')).toThrow();
    expect(existsSync(file)).toBe(false);
  });
});

describe('assertFileSegment', () => {
  it('accepts a slug and returns it', () => {
    expect(assertFileSegment('my-app-01')).toBe('my-app-01');
    expect(assertFileSegment('a')).toBe('a');
  });

  it('accepts the 63-character boundary', () => {
    const segment = `a${'b'.repeat(62)}`;
    expect(assertFileSegment(segment)).toBe(segment);
  });

  it.each([
    '',
    '-leading',
    'Upper',
    'has_underscore',
    'has space',
    `a${'b'.repeat(63)}`,
    '../escape',
  ])('refuses %j', (value) => {
    expect(() => assertFileSegment(value)).toThrow(/not a valid file segment/);
  });

  it('names the label in the refusal', () => {
    expect(() => assertFileSegment('Bad', 'slug')).toThrow(/slug is not a valid file segment/);
  });
});

describe('HOST_SEPARATOR', () => {
  it('exposes the platform separator', () => {
    expect(HOST_SEPARATOR).toBe(sep);
  });
});

function readDirNames(path: string): string[] {
  return readdirSync(path);
}

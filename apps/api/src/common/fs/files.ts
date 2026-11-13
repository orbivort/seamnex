import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Filesystem primitives shared by the Phase 4 writers (ADR-BE-12 D5).
 *
 * Two properties matter more than convenience:
 *   - **atomicity**: a reader (Traefik's file provider, a restore) never sees a half-written file.
 *     Every write goes to a temporary name in the *same* directory and is `rename`d into place,
 *     which is atomic within a filesystem.
 *   - **containment**: a slug, a draft id or a compose path arrives from outside. `safeJoin` refuses
 *     anything that resolves outside the root, so `../../etc/passwd` is a rejected request rather
 *     than a read.
 */

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

export function exists(path: string): boolean {
  return existsSync(path);
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolves `relativePath` under `root`, refusing traversal, absolute input and symlink-free
 * escapes. The check is on the resolved path, not on the string, so `a/../../b` is caught too.
 */
export function safeJoin(root: string, relativePath: string): string {
  if (isAbsolute(relativePath) || relativePath.length === 0) {
    throw new Error(`path must be relative and non-empty: ${relativePath}`);
  }
  const rootResolved = resolve(root);
  const target = resolve(join(rootResolved, relativePath));
  const within = relative(rootResolved, target);
  if (within.startsWith('..') || within === '' || isAbsolute(within)) {
    throw new Error(`path escapes its root: ${relativePath}`);
  }
  return target;
}

/** Writes through a temporary file in the same directory, then renames. */
export function writeFileAtomic(path: string, content: string | Buffer, mode?: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, mode === undefined ? undefined : { mode });
  renameSync(temporary, path);
}

/** The slug/route segment any generated file name may use. */
export function assertFileSegment(value: string, label = 'segment'): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new Error(`${label} is not a valid file segment: ${value}`);
  }
  return value;
}

/** Path separator of the host, exposed so a manifest can record platform-independent paths. */
export const HOST_SEPARATOR = sep;

import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * The digest of a file's *bytes*, streamed in 64 KB chunks.
 *
 * The backup manifest records this per artefact, and a digest is only evidence if it covers the
 * content: the previous `sha256(key:bytes)` shorthand proved the object's name and size, not that
 * the downloaded bytes were the ones captured. Streaming keeps a multi-gigabyte dump out of the
 * API process's memory.
 */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Deletes a scratch file whose absence is the expected state; any other failure is ignored too. */
export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A file that is already gone needs no cleanup, and a scratch directory is not worth failing a
    // completed capture over.
  }
}

/**
 * Removes a scratch directory and everything under it.
 *
 * Used when a capture fails: the directory holds database dumps and an unencrypted realm export,
 * which carry product data and client secrets. A failed set is retried by capturing again, so
 * nothing here is worth keeping.
 */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // A directory that cannot be removed is a disk-space problem surfaced by the next capture, not a
    // reason to fail the settlement of the current one.
  }
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

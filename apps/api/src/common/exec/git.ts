import { run, runOrThrow } from './exec';

/**
 * Source resolution helpers for M02 (4A.2).
 *
 * The resolver fetches a customer-supplied repository, which makes it an SSRF boundary as well as a
 * supply-chain one. Two guards live here rather than in the service:
 *   - the URL must be `https` (or `git+https`) on an allow-listed host, with no embedded
 *     credentials, and must not resolve to a literal private address;
 *   - every git call is an argv array with `--depth 1`, so a branch name cannot smuggle options.
 *
 * A host allow-list is weaker than DNS pinning. It is chosen deliberately: pinning behind a proxy
 * breaks legitimate mirrors, while the allow-list is reviewable and the resolver never follows
 * HTTP redirects of its own.
 */

export type CloneOptions = {
  readonly url: string;
  readonly targetDir: string;
  readonly revision?: string;
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number;
};

export type CloneResult = {
  /** The commit actually checked out; recorded in `source_resolution`. */
  readonly commit: string;
  /** The revision that was requested, or `HEAD` when the caller named none. */
  readonly revision: string;
};

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
];

/**
 * Validates a source URL. Throws with a message a support engineer can act on: the caller turns it
 * into `SOURCE_URL_REJECTED` rather than a generic 500.
 */
export function assertAllowedSourceUrl(rawUrl: string, allowedHosts: readonly string[]): URL {
  const withoutPrefix = rawUrl.startsWith('git+') ? rawUrl.slice(4) : rawUrl;

  let url: URL;
  try {
    url = new URL(withoutPrefix);
  } catch {
    throw new Error(`source URL is not a URL: ${rawUrl}`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`source URL must use https (got ${url.protocol.replace(':', '')})`);
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('source URL must not embed credentials; use a secret reference instead');
  }

  const host = url.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    throw new Error(`source host ${host} is a private address`);
  }
  const allowed = allowedHosts.map((entry) => entry.toLowerCase());
  if (!allowed.includes(host)) {
    throw new Error(
      `source host ${host} is not allow-listed (allowed: ${allowed.join(', ') || 'none'})`,
    );
  }
  return url;
}

export function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
    return true;
  if (host === '::1' || host === '[::1]' || host.startsWith('fc') || host.startsWith('fd'))
    return true;
  if (host.startsWith('fe80')) return true;
  return PRIVATE_V4.some((pattern) => pattern.test(host));
}

/**
 * Clones at a revision. A shallow clone of a default branch is one call; a named revision needs a
 * second (`fetch --depth 1 origin <rev>`), because `--branch` only accepts branch and tag names.
 */
export async function cloneAtRevision(options: CloneOptions): Promise<CloneResult> {
  const url = assertAllowedSourceUrl(options.url, options.allowedHosts);
  const revision = options.revision?.trim() ?? '';
  const timeoutMs = options.timeoutMs ?? 300_000;

  if (revision.length === 0) {
    await runOrThrow(
      'git',
      ['clone', '--depth', '1', '--no-tags', '--single-branch', url.toString(), options.targetDir],
      { timeoutMs },
    );
    return { commit: await commitOf(options.targetDir), revision: 'HEAD' };
  }

  // `--` terminates option parsing, so a revision that begins with a dash is a revision, not a flag.
  await runOrThrow('git', ['init', '--quiet', options.targetDir], { timeoutMs });
  await runOrThrow('git', ['remote', 'add', 'origin', url.toString()], {
    cwd: options.targetDir,
    timeoutMs,
  });
  await runOrThrow('git', ['fetch', '--depth', '1', '--no-tags', 'origin', '--', revision], {
    cwd: options.targetDir,
    timeoutMs,
  });
  await runOrThrow('git', ['checkout', '--quiet', 'FETCH_HEAD'], {
    cwd: options.targetDir,
    timeoutMs,
  });
  return { commit: await commitOf(options.targetDir), revision };
}

/**
 * What a ref that a caller named actually is.
 *
 * `cloneAtRevision` alone cannot tell `catalog-2026.11.0` from `main`: both fetch, both check out a
 * commit, and the difference only shows as "the catalogue changed under a running installation" the
 * next time someone syncs. ADR-BE-42 §10.2 rule 5 makes the ref a tag or a commit, so the check
 * happens before the clone and names all four outcomes instead of guessing from a message.
 */
export type RefKind = 'tag' | 'commit' | 'branch' | 'missing';

// eslint-disable-next-line security/detect-unsafe-regex -- both alternatives are fixed-length ({40} and {24}), so matching is linear in the input.
const COMMIT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

export async function resolveRefKind(options: {
  readonly url: string;
  readonly ref: string;
  readonly allowedHosts: readonly string[];
  readonly timeoutMs?: number;
}): Promise<RefKind> {
  const url = assertAllowedSourceUrl(options.url, options.allowedHosts);
  if (COMMIT_PATTERN.test(options.ref)) return 'commit';

  const timeoutMs = options.timeoutMs ?? 30_000;
  const tag = await listRef(url.toString(), ['--tags'], `refs/tags/${options.ref}`, timeoutMs);
  if (tag.length > 0) return 'tag';

  // Only reached when the tag lookup found nothing, so the happy path is one round trip.
  const head = await listRef(url.toString(), ['--heads'], `refs/heads/${options.ref}`, timeoutMs);
  return head.length > 0 ? 'branch' : 'missing';
}

async function listRef(
  url: string,
  kind: readonly string[],
  ref: string,
  timeoutMs: number,
): Promise<string> {
  const result = await runOrThrow('git', ['ls-remote', '--refs', ...kind, url, ref], { timeoutMs });
  return result.stdout.trim();
}

/** The commit the working tree is on; the resolver records it, the renderer hashes files. */
export async function commitOf(directory: string): Promise<string> {
  const result = await runOrThrow('git', ['rev-parse', 'HEAD'], {
    cwd: directory,
    timeoutMs: 30_000,
  });
  return result.stdout.trim();
}

/** A bare mirror of the catalogue repository for the platform-tier backup (4C.3). */
export async function cloneBare(
  url: string,
  targetDir: string,
  timeoutMs = 300_000,
): Promise<void> {
  await runOrThrow('git', ['clone', '--bare', url, targetDir], { timeoutMs });
}

/** Best-effort remote URL of a working tree, for a manifest that must be reproducible. */
export async function remoteUrlOf(directory: string): Promise<string | null> {
  const result = await run('git', ['remote', 'get-url', 'origin'], {
    cwd: directory,
    timeoutMs: 15_000,
  });
  return result.code === 0 ? result.stdout.trim() : null;
}

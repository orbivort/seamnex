import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The resolver fetches a customer-supplied repository, which makes this file an SSRF and
 * supply-chain boundary. Every refusal it can produce is a case here, because the service turns the
 * message into `SOURCE_URL_REJECTED` and a wrong message sends support to the wrong cause.
 */
const state = vi.hoisted(() => ({ run: vi.fn(), runOrThrow: vi.fn() }));

vi.mock('../../../../src/common/exec/exec', () => ({
  run: state.run,
  runOrThrow: state.runOrThrow,
}));

const {
  assertAllowedSourceUrl,
  cloneAtRevision,
  cloneBare,
  commitOf,
  isPrivateHost,
  remoteUrlOf,
  resolveRefKind,
} = await import('../../../../src/common/exec/git');

const HOSTS = ['github.com', 'GitLab.example.test'];

beforeEach(() => {
  state.run
    .mockReset()
    .mockResolvedValue({ code: 0, stdout: '  abc123  \n', stderr: '', truncated: false });
  state.runOrThrow
    .mockReset()
    .mockResolvedValue({ code: 0, stdout: 'abc123\n', stderr: '', truncated: false });
});

describe('assertAllowedSourceUrl', () => {
  it('accepts an allow-listed https URL and strips a git+ prefix', () => {
    expect(assertAllowedSourceUrl('https://github.com/acme/app.git', HOSTS).hostname).toBe(
      'github.com',
    );
    expect(assertAllowedSourceUrl('git+https://github.com/acme/app', HOSTS).protocol).toBe(
      'https:',
    );
  });

  it('matches the allow-list case-insensitively', () => {
    expect(assertAllowedSourceUrl('https://gitlab.example.test/x', HOSTS).hostname).toBe(
      'gitlab.example.test',
    );
  });

  it('refuses a value that is not a URL', () => {
    expect(() => assertAllowedSourceUrl('not a url', HOSTS)).toThrow(/is not a URL/);
  });

  it('refuses a non-https scheme', () => {
    expect(() => assertAllowedSourceUrl('http://github.com/x', HOSTS)).toThrow(/must use https/);
    expect(() => assertAllowedSourceUrl('ssh://github.com/x', HOSTS)).toThrow(/must use https/);
  });

  it('refuses embedded credentials', () => {
    expect(() => assertAllowedSourceUrl('https://user:pw@github.com/x', HOSTS)).toThrow(
      /must not embed credentials/,
    );
  });

  it('refuses a literal private address before consulting the allow-list', () => {
    expect(() => assertAllowedSourceUrl('https://127.0.0.1/x', ['127.0.0.1'])).toThrow(
      /is a private address/,
    );
  });

  it('refuses a host that is not allow-listed, naming the list', () => {
    expect(() => assertAllowedSourceUrl('https://evil.test/x', HOSTS)).toThrow(
      /not allow-listed \(allowed: github.com, gitlab.example.test\)/,
    );
    expect(() => assertAllowedSourceUrl('https://evil.test/x', [])).toThrow(/allowed: none/);
  });
});

describe('isPrivateHost', () => {
  it.each([
    'localhost',
    'shop.localhost',
    'db.internal',
    '::1',
    '[::1]',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    '10.0.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '0.0.0.0',
  ])('treats %s as private', (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(['github.com', '172.32.0.1', '8.8.8.8', 'example.test'])(
    'treats %s as public',
    (host) => {
      expect(isPrivateHost(host)).toBe(false);
    },
  );
});

describe('cloneAtRevision', () => {
  it('shallow-clones the default branch and records HEAD', async () => {
    const result = await cloneAtRevision({
      url: 'https://github.com/acme/app.git',
      targetDir: '/work/app',
      allowedHosts: HOSTS,
    });

    expect(result).toEqual({ commit: 'abc123', revision: 'HEAD' });
    expect(state.runOrThrow).toHaveBeenCalledWith(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--no-tags',
        '--single-branch',
        'https://github.com/acme/app.git',
        '/work/app',
      ],
      { timeoutMs: 300_000 },
    );
    expect(state.runOrThrow).toHaveBeenLastCalledWith('git', ['rev-parse', 'HEAD'], {
      cwd: '/work/app',
      timeoutMs: 30_000,
    });
  });

  it('fetches a named revision with `--` so a dash cannot become a flag', async () => {
    const result = await cloneAtRevision({
      url: 'https://github.com/acme/app.git',
      targetDir: '/work/app',
      revision: '  v1.2.3  ',
      allowedHosts: HOSTS,
      timeoutMs: 1_000,
    });

    expect(result).toEqual({ commit: 'abc123', revision: 'v1.2.3' });
    expect(state.runOrThrow.mock.calls[2]?.[1]).toEqual([
      'fetch',
      '--depth',
      '1',
      '--no-tags',
      'origin',
      '--',
      'v1.2.3',
    ]);
    expect(state.runOrThrow).toHaveBeenCalledWith('git', ['init', '--quiet', '/work/app'], {
      timeoutMs: 1_000,
    });
    expect(state.runOrThrow).toHaveBeenCalledWith('git', ['checkout', '--quiet', 'FETCH_HEAD'], {
      cwd: '/work/app',
      timeoutMs: 1_000,
    });
  });

  it('treats a whitespace-only revision as HEAD', async () => {
    await cloneAtRevision({
      url: 'https://github.com/acme/app.git',
      targetDir: '/work/app',
      revision: '   ',
      allowedHosts: HOSTS,
    });
    // One clone plus one rev-parse, no repo init.
    expect(state.runOrThrow).toHaveBeenCalledTimes(2);
  });

  it('refuses before running git when the URL is not allowed', async () => {
    await expect(
      cloneAtRevision({ url: 'https://evil.test/x', targetDir: '/work', allowedHosts: HOSTS }),
    ).rejects.toThrow(/not allow-listed/);
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });
});

describe('commitOf / cloneBare / remoteUrlOf', () => {
  it('trims the commit hash', async () => {
    expect(await commitOf('/work/app')).toBe('abc123');
  });

  it('mirrors the catalogue repository for a platform backup', async () => {
    await cloneBare('https://github.com/acme/catalog.git', '/backup/catalog.git');
    expect(state.runOrThrow).toHaveBeenCalledWith(
      'git',
      ['clone', '--bare', 'https://github.com/acme/catalog.git', '/backup/catalog.git'],
      { timeoutMs: 300_000 },
    );
  });

  it('accepts an explicit timeout for the bare clone', async () => {
    await cloneBare('https://x.test/c.git', '/b', 1_000);
    expect(state.runOrThrow).toHaveBeenCalledWith(
      'git',
      ['clone', '--bare', 'https://x.test/c.git', '/b'],
      { timeoutMs: 1_000 },
    );
  });

  it('returns the trimmed remote URL when the tree has one', async () => {
    expect(await remoteUrlOf('/work/app')).toBe('abc123');
  });

  it('returns null when the working tree has no origin', async () => {
    state.run.mockResolvedValue({
      code: 2,
      stdout: '',
      stderr: 'no such remote',
      truncated: false,
    });
    expect(await remoteUrlOf('/work/app')).toBeNull();
  });
});

/*
 * ADR-BE-42 §10.2 rule 5 — a ref is a tag or a commit, never a branch.
 *
 * `cloneAtRevision` alone cannot tell them apart: `catalog-2026.11.0` and `main` both fetch, both
 * check out a commit. Rejecting a branch is what keeps "the catalogue" from being whatever a branch
 * happened to point at on the day someone synced.
 */
describe('resolveRefKind', () => {
  const URL = 'https://github.com/orbivort/seamnex-catalog';

  it('accepts a full commit SHA without asking the remote', async () => {
    // A SHA names one revision; a lookup would only be able to confirm it by already having it.
    expect(await resolveRefKind({ url: URL, ref: 'a'.repeat(40), allowedHosts: HOSTS })).toBe(
      'commit',
    );
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('accepts the 64-hex form git uses internally', async () => {
    expect(await resolveRefKind({ url: URL, ref: 'b'.repeat(64), allowedHosts: HOSTS })).toBe(
      'commit',
    );
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('reports a tag, with one round trip in the happy path', async () => {
    expect(await resolveRefKind({ url: URL, ref: 'catalog-2026.11.0', allowedHosts: HOSTS })).toBe(
      'tag',
    );
    expect(state.runOrThrow).toHaveBeenCalledOnce();
    expect(state.runOrThrow.mock.calls[0]?.[1]).toEqual([
      'ls-remote',
      '--refs',
      '--tags',
      URL,
      'refs/tags/catalog-2026.11.0',
    ]);
  });

  it('names a branch as a branch only after the tag lookup found nothing', async () => {
    state.runOrThrow
      .mockResolvedValueOnce({ code: 0, stdout: '', stderr: '', truncated: false })
      .mockResolvedValueOnce({
        code: 0,
        stdout: 'abc123\trefs/heads/main\n',
        stderr: '',
        truncated: false,
      });

    expect(await resolveRefKind({ url: URL, ref: 'main', allowedHosts: HOSTS })).toBe('branch');
    expect(state.runOrThrow).toHaveBeenCalledTimes(2);
    expect(state.runOrThrow.mock.calls[1]?.[1]).toContain('refs/heads/main');
  });

  it('reports a ref that exists as neither', async () => {
    state.runOrThrow.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });

    expect(await resolveRefKind({ url: URL, ref: 'nope', allowedHosts: HOSTS })).toBe('missing');
  });

  it('applies the URL allow-list before the first lookup', async () => {
    await expect(
      resolveRefKind({ url: 'https://evil.example.test/x', ref: 'v1', allowedHosts: HOSTS }),
    ).rejects.toThrow(/evil\.example\.test/);
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });
});

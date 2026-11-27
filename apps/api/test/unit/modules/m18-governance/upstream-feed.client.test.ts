import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse, textResponse } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { UpstreamFeedClient } from '../../../../src/modules/m18-governance/upstream-feed.client';

/**
 * FR-2.12 / NFR-4.7 — the two feeds, and the three ways they are bounded.
 *
 * This client runs unattended, so every failure mode has to be an outcome rather than an exception:
 * a host outside the allow-list, a timeout, a non-200, a body that is not JSON. The distinction the
 * register depends on is `skipped` (nothing to ask) versus `failed` (asked, not answered) — a product
 * without releases must not read as a broken feed, and an unreachable feed must not read as "nothing
 * open".
 */
function config(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    upstreamAllowedHosts: ['api.github.com', 'api.osv.dev'],
    SEAMNEX_UPSTREAM_TIMEOUT_MS: 10_000,
    ...overrides,
  } as unknown as AppConfig;
}

function client(overrides: Record<string, unknown> = {}): UpstreamFeedClient {
  return new UpstreamFeedClient(config(overrides));
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sentUrl(call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

function sentInit(call = 0): RequestInit {
  return (fetchMock.mock.calls[call]?.[1] ?? {}) as RequestInit;
}

describe('repositoryOf', () => {
  it('maps the three repository spellings the catalogue uses', () => {
    expect(UpstreamFeedClient.repositoryOf('https://github.com/espocrm/espocrm')).toBe(
      'espocrm/espocrm',
    );
    expect(UpstreamFeedClient.repositoryOf('https://github.com/espocrm/espocrm.git')).toBe(
      'espocrm/espocrm',
    );
    expect(UpstreamFeedClient.repositoryOf('git@github.com:mautic/mautic.git')).toBe(
      'mautic/mautic',
    );
  });

  it('returns null for a missing or non-GitHub repository', () => {
    expect(UpstreamFeedClient.repositoryOf(null)).toBeNull();
    expect(UpstreamFeedClient.repositoryOf('https://gitlab.com/team/app')).toBeNull();
    expect(UpstreamFeedClient.repositoryOf('')).toBeNull();
  });
});

describe('release', () => {
  it('asks GitHub for the release list and normalises the tag', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        {
          tag_name: 'v5.4.2',
          html_url: 'https://github.com/mautic/mautic/releases/tag/5.4.2',
          published_at: '2026-10-01T00:00:00.000Z',
        },
      ]),
    );

    const outcome = await client().release('https://github.com/mautic/mautic');

    expect(sentUrl()).toBe('https://api.github.com/repos/mautic/mautic/releases?per_page=30');
    expect(sentInit().redirect).toBe('error');
    expect(outcome).toEqual({
      kind: 'ok',
      value: {
        version: '5.4.2',
        url: 'https://github.com/mautic/mautic/releases/tag/5.4.2',
        publishedAt: '2026-10-01T00:00:00.000Z',
      },
    });
  });

  /**
   * Measured on `opf/openproject` on 2026-11-19: `/releases/latest` answered `v17.8.3` (published
   * 12:07Z) because a maintenance release on the 17.8 branch landed 78 minutes after `v17.9.8`
   * (10:49Z). The register then offered a version older than the 17.9.6 the host was running.
   */
  it('keeps the highest version, so a branch backport published later cannot displace it', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { tag_name: 'v17.8.3', published_at: '2026-11-19T12:07:25Z' },
        { tag_name: 'v17.9.8', published_at: '2026-11-19T10:49:02Z' },
        { tag_name: 'v17.9.7', published_at: '2026-11-09T08:19:46Z' },
        { tag_name: 'v17.9.6', published_at: '2026-10-30T13:32:00Z' },
      ]),
    );

    const outcome = await client().release('https://github.com/opf/openproject');

    expect(outcome).toEqual({
      kind: 'ok',
      value: { version: '17.9.8', url: null, publishedAt: '2026-11-19T10:49:02Z' },
    });
  });

  it('orders numerically, not lexically, when it picks the highest', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([{ tag_name: 'v16.9.0' }, { tag_name: 'v16.10.0' }, { tag_name: 'v16.9.4' }]),
    );

    const outcome = await client().release('https://github.com/mautic/mautic');

    expect(outcome.kind === 'ok' ? outcome.value?.version : null).toBe('16.10.0');
  });

  it('skips an entry that declares no GitHub repository, without calling anything', async () => {
    const outcome = await client().release(null);

    expect(outcome).toEqual({ kind: 'skipped', reason: expect.stringContaining('no GitHub') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a 404 as a repository GitHub cannot answer for, not as "nothing to upgrade"', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Not Found' }, { status: 404 }));

    // `[]` with 200 is the answer of an existing repository with no releases; a 404 is a missing or
    // private one, and reading it as "no release" would leave the row current forever.
    expect(await client().release('https://github.com/mautic/mautic')).toEqual({
      kind: 'failed',
      reason: 'GitHub has no repository mautic/mautic',
    });
  });

  it('reports a non-200 as failed, naming the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 403 }));

    expect(await client().release('https://github.com/mautic/mautic')).toEqual({
      kind: 'failed',
      reason: 'GitHub answered 403',
    });
  });

  it('reports a published release without a tag as failed rather than as an empty version', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ tag_name: '' }]));

    expect(await client().release('https://github.com/mautic/mautic')).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('no tag'),
    });
  });

  it('never announces a draft or pre-release, and picks the stable release beneath them', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { tag_name: 'v6.0.0-rc1', prerelease: true },
        { tag_name: 'v6.0.0', draft: true },
        { tag_name: 'v5.4.2' },
      ]),
    );

    expect(await client().release('https://github.com/mautic/mautic')).toEqual({
      kind: 'ok',
      value: { version: '5.4.2', url: null, publishedAt: null },
    });
  });

  it('answers "no stable release" when the page holds only pre-releases', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse([
        { tag_name: 'v6.0.0-rc2', prerelease: true },
        { tag_name: 'v6.0.0-rc1', prerelease: true },
      ]),
    );

    // A real answer — the project has shipped nothing stable — and not a "skipped: no feed", which
    // would be counted as an entry the pass never reached.
    expect(await client().release('https://github.com/mautic/mautic')).toEqual({
      kind: 'ok',
      value: null,
    });
  });

  it('answers an empty release list with no release', async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));

    expect(await client().release('https://github.com/mautic/mautic')).toEqual({
      kind: 'ok',
      value: null,
    });
  });

  it('answers a release that carries no page or date with nulls rather than invented values', async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ tag_name: 'v2.0.0' }]));

    // A tag is enough to say "a release exists"; the register shows an absent page as absent.
    expect(await client().release('https://github.com/mautic/mautic')).toEqual({
      kind: 'ok',
      value: { version: '2.0.0', url: null, publishedAt: null },
    });
  });

  it('refuses a host outside the allow-list before opening a socket', async () => {
    const outcome = await client({ upstreamAllowedHosts: ['api.osv.dev'] }).release(
      'https://github.com/mautic/mautic',
    );

    expect(outcome).toEqual({
      kind: 'failed',
      reason: 'api.github.com is not in SEAMNEX_UPSTREAM_ALLOWED_HOSTS',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a transport failure as an outcome, keeping the previous observation intact', async () => {
    fetchMock.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'));

    const outcome = await client().release('https://github.com/mautic/mautic');

    expect(outcome.kind).toBe('failed');
    expect(outcome).toHaveProperty('reason', expect.stringContaining('ENOTFOUND'));
  });

  it('survives a body that is not JSON', async () => {
    fetchMock.mockResolvedValue(textResponse('not json at all'));

    expect(await client().release('https://github.com/mautic/mautic')).toEqual({
      kind: 'failed',
      reason: expect.stringContaining('release list'),
    });
  });
});

describe('advisories', () => {
  it('queries OSV by source package, not by image', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ vulns: [] }));

    await client().advisories('https://github.com/mautic/mautic');

    expect(sentUrl()).toBe('https://api.osv.dev/v1/query');
    expect(JSON.parse(String(sentInit().body))).toEqual({
      // A `pkg:docker/...` query answers "no records" for every image, which reads as "nothing open".
      package: { purl: 'pkg:github/mautic/mautic' },
    });
  });

  it('maps an advisory with the project rating and the first fixed version', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        vulns: [
          {
            id: 'GHSA-aaaa-bbbb-cccc',
            summary: 'Path traversal in the upload endpoint',
            published: '2026-09-01T00:00:00.000Z',
            database_specific: { severity: 'HIGH' },
            affected: [{ ranges: [{ events: [{ introduced: '0' }, { fixed: '5.4.3' }] }] }],
          },
        ],
      }),
    );

    const outcome = await client().advisories('https://github.com/mautic/mautic');

    expect(outcome).toEqual({
      kind: 'ok',
      value: [
        {
          id: 'GHSA-aaaa-bbbb-cccc',
          severity: 'high',
          summary: 'Path traversal in the upload endpoint',
          url: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
          fixedVersion: '5.4.3',
          publishedAt: '2026-09-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('falls back to a CVSS score, then to unknown, and keeps a record with no summary', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        vulns: [
          { id: 'OSV-1', severity: [{ score: 9.1 }] },
          { id: 'OSV-2', severity: [{ score: 7.5 }] },
          { id: 'OSV-3', severity: [{ score: 5 }] },
          { id: 'OSV-4', severity: [{ score: 1 }] },
          { id: 'OSV-5', severity: [{ score: 0 }] },
          { id: 'OSV-6' },
          { summary: 'no id, so not an advisory' },
          'not an object',
        ],
      }),
    );

    const outcome = await client().advisories('https://github.com/mautic/mautic');
    const advisories = outcome.kind === 'ok' ? outcome.value : [];

    expect(advisories.map((entry) => [entry.id, entry.severity])).toEqual([
      ['OSV-1', 'critical'],
      ['OSV-2', 'high'],
      ['OSV-3', 'medium'],
      ['OSV-4', 'low'],
      ['OSV-5', 'unknown'],
      ['OSV-6', 'unknown'],
    ]);
    expect(advisories[5]?.summary).toContain('OSV-6 affects this product upstream');
    expect(advisories[0]?.fixedVersion).toBeNull();
  });

  it('answers an empty body and a non-array vulns field with no advisories', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));

    expect(await client().advisories('https://github.com/mautic/mautic')).toEqual({
      kind: 'ok',
      value: [],
    });
  });

  it('reports a non-200 as failed, naming the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, { status: 502 }));

    expect(await client().advisories('https://github.com/mautic/mautic')).toEqual({
      kind: 'failed',
      reason: 'OSV answered 502',
    });
  });

  it('reports a request that never reached the feed, including a rejection that is not an Error', async () => {
    // A socket can reject with a bare string; the outcome still has to carry a reason the row shows.
    fetchMock.mockRejectedValue('socket hang up');

    expect(await client().advisories('https://github.com/mautic/mautic')).toEqual({
      kind: 'failed',
      reason: 'socket hang up',
    });
  });

  it('survives a severity block and an affected tree in shapes OSV does not promise', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        vulns: [
          // A numeric project rating is not a word; the CVSS fallback is empty, so it is unknown.
          { id: 'OSV-A', database_specific: { severity: 5 } },
          // A word outside the map is unknown too, not a crash on an undefined band.
          { id: 'OSV-B', database_specific: { severity: 'bogus' } },
          // The CVSS array holds things that are not entries, and an entry without a numeric score.
          { id: 'OSV-C', severity: ['not an object', { score: 'high' }, {}] },
          // The affected tree is malformed at every level, so there is no fixed version to name.
          {
            id: 'OSV-D',
            affected: [
              'not an object',
              {},
              {
                ranges: [
                  'not an object',
                  {},
                  { events: ['not an object', {}, { introduced: '0' }] },
                ],
              },
            ],
          },
        ],
      }),
    );

    const outcome = await client().advisories('https://github.com/mautic/mautic');
    const advisories = outcome.kind === 'ok' ? outcome.value : [];

    expect(advisories.map((entry) => [entry.id, entry.severity, entry.fixedVersion])).toEqual([
      ['OSV-A', 'unknown', null],
      ['OSV-B', 'unknown', null],
      ['OSV-C', 'unknown', null],
      // No `fixed` event anywhere: upstream has not published a fix, which is `null`, not ''.
      ['OSV-D', 'unknown', null],
    ]);
  });

  it('asks nothing when the entry has no repository', async () => {
    expect(await client().advisories(null)).toEqual({
      kind: 'skipped',
      reason: expect.stringContaining('no GitHub'),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caps the list at the batch size the register can show', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ vulns: Array.from({ length: 40 }, (_, index) => ({ id: `OSV-${index}` })) }),
    );

    const outcome = await client().advisories('https://github.com/mautic/mautic');

    expect(outcome.kind === 'ok' ? outcome.value.length : 0).toBe(25);
  });
});

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ScanSeverity } from '@seamnex/domain';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';

/**
 * FR-2.12 / NFR-4.7 — the two feeds the patch register is advanced from.
 *
 * Both calls are bounded three ways, because this process calls them unattended: a host allow-list
 * (`SEAMNEX_UPSTREAM_ALLOWED_HOSTS`), a timeout (`SEAMNEX_UPSTREAM_TIMEOUT_MS`) and a per-pass batch
 * cap held by the caller. A feed that answers slowly or not at all is an expected outcome, not a
 * crash: every method returns an outcome instead of throwing, so one unreachable upstream cannot
 * abort the pass and cannot erase the previous observation.
 *
 * **Which key is queried, and why not the image.** Releases are asked for by the entry's repository
 * (`repoUrl`), which is the identifier GitHub's API takes. Advisories are asked for by the same
 * repository as an OSV purl (`pkg:github/owner/repo`), not by `imageRef`: OSV indexes source
 * packages, and a `pkg:docker/...` query answers "no records" for every image ever published, which
 * is precisely the empty answer that must not be mistaken for "nothing open".
 */

export type UpstreamRelease = {
  /** Release tag with a leading `v` removed; what the register's `latestVersion` shows. */
  readonly version: string;
  readonly url: string | null;
  readonly publishedAt: string | null;
};

export type UpstreamAdvisory = {
  readonly id: string;
  readonly severity: ScanSeverity;
  readonly summary: string;
  readonly url: string | null;
  readonly fixedVersion: string | null;
  readonly publishedAt: string | null;
};

/**
 * Three outcomes rather than two. `skipped` means "there was nothing to ask" (no GitHub repository,
 * no published release) and is *not* a failure: counting it as one would turn a product without
 * releases into a permanent red row. `failed` means the question was asked and not answered, and the
 * previous observation is kept.
 */
export type FeedOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

const GITHUB_HOST = 'api.github.com';
const OSV_HOST = 'api.osv.dev';
const USER_AGENT = 'seamnex-upstream-tracker';
/** OSV answers with every advisory ever published; the register shows the open, actionable ones. */
const MAX_ADVISORIES = 25;

const OSV_SEVERITY: Readonly<Record<string, ScanSeverity>> = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MODERATE: 'medium',
  MEDIUM: 'medium',
  LOW: 'low',
};

@Injectable()
export class UpstreamFeedClient {
  private readonly logger = new Logger('m18-upstream-feed');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** `https://github.com/owner/repo(.git)` → `owner/repo`; anything else is unmappable. */
  static repositoryOf(repoUrl: string | null): string | null {
    if (repoUrl === null) return null;
    const trimmed = repoUrl.trim();

    const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
    if (ssh !== null) {
      const [, owner, repo] = ssh;
      return owner === undefined || repo === undefined ? null : `${owner}/${repo}`;
    }

    const https = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/.exec(trimmed);
    if (https === null) return null;
    const [, owner, repo] = https;
    if (owner === undefined || repo === undefined) return null;
    return `${owner}/${repo.replace(/\.git$/, '')}`;
  }

  async release(repoUrl: string | null): Promise<FeedOutcome<UpstreamRelease | null>> {
    const repository = UpstreamFeedClient.repositoryOf(repoUrl);
    if (repository === null) {
      return { kind: 'skipped', reason: 'no GitHub repository is declared for this entry' };
    }

    const url = `https://${GITHUB_HOST}/repos/${repository}/releases/latest`;
    const response = await this.get(url, {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
    });
    if (response.kind !== 'ok') return response;
    // 404 means the repository exists and has published no release — a real answer, not an error.
    if (response.status === 404) {
      return { kind: 'ok', value: null };
    }
    if (response.status !== 200) {
      return { kind: 'failed', reason: `GitHub answered ${response.status}` };
    }

    const body = response.body as {
      tag_name?: unknown;
      html_url?: unknown;
      published_at?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    };
    if (typeof body.tag_name !== 'string' || body.tag_name.length === 0) {
      return { kind: 'failed', reason: 'the GitHub release carried no tag' };
    }
    /*
     * A draft or pre-release is not "available" for a production patch register: announcing it would
     * tell an operator to upgrade to a version the project has not shipped.
     */
    if (body.draft === true || body.prerelease === true) {
      return { kind: 'skipped', reason: 'the newest GitHub release is a draft or pre-release' };
    }

    return {
      kind: 'ok',
      value: {
        version: normaliseVersion(body.tag_name),
        url: typeof body.html_url === 'string' ? body.html_url : null,
        publishedAt: typeof body.published_at === 'string' ? body.published_at : null,
      },
    };
  }

  async advisories(repoUrl: string | null): Promise<FeedOutcome<readonly UpstreamAdvisory[]>> {
    const repository = UpstreamFeedClient.repositoryOf(repoUrl);
    if (repository === null) {
      return { kind: 'skipped', reason: 'no GitHub repository is declared for this entry' };
    }

    const response = await this.post(`https://${OSV_HOST}/v1/query`, {
      package: { purl: `pkg:github/${repository.toLowerCase()}` },
    });
    if (response.kind !== 'ok') return response;
    if (response.status !== 200) {
      return { kind: 'failed', reason: `OSV answered ${response.status}` };
    }

    const vulns = (response.body as { vulns?: unknown }).vulns;
    if (!Array.isArray(vulns)) return { kind: 'ok', value: [] };

    const advisories: UpstreamAdvisory[] = [];
    for (const entry of vulns.slice(0, MAX_ADVISORIES)) {
      const advisory = toAdvisory(entry);
      if (advisory !== null) advisories.push(advisory);
    }
    return { kind: 'ok', value: advisories };
  }

  private async get(url: string, headers: Record<string, string>): Promise<FeedResponse> {
    return this.request(url, { method: 'GET', headers });
  }

  private async post(url: string, body: unknown): Promise<FeedResponse> {
    return this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  private async request(url: string, init: RequestInit): Promise<FeedResponse> {
    const host = hostOf(url);
    /*
     * The allow-list is checked before the socket is opened. It is not a proxy for the timeout: a
     * URL built from catalogue data is still data, and a redirected or edited entry must not be able
     * to make the API call an arbitrary host from inside the cluster.
     */
    if (host === null || !this.config.upstreamAllowedHosts.includes(host)) {
      return {
        kind: 'failed',
        reason: `${host ?? 'unparseable'} is not in SEAMNEX_UPSTREAM_ALLOWED_HOSTS`,
      };
    }

    try {
      const response = await fetch(url, {
        ...init,
        redirect: 'error',
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(this.config.SEAMNEX_UPSTREAM_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => ({}));
      return { kind: 'ok', status: response.status, body };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.warn(`upstream request to ${url} failed: ${reason}`);
      return { kind: 'failed', reason };
    }
  }
}

type FeedOk = { readonly kind: 'ok'; readonly status: number; readonly body: unknown };
type FeedFailure = { readonly kind: 'failed'; readonly reason: string };
type FeedResponse = FeedOk | FeedFailure;

/** `v1.2.3` and `1.2.3` are the same release; the register compares versions, not tag spellings. */
function normaliseVersion(tag: string): string {
  return tag.trim().replace(/^v(?=\d)/i, '');
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function toAdvisory(value: unknown): UpstreamAdvisory | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as {
    id?: unknown;
    summary?: unknown;
    details?: unknown;
    aliases?: unknown;
    published?: unknown;
    severity?: unknown;
    database_specific?: unknown;
    affected?: unknown;
  };
  if (typeof record.id !== 'string' || record.id.length === 0) return null;

  const summary =
    typeof record.summary === 'string' && record.summary.length > 0
      ? record.summary
      : `${record.id} affects this product upstream.`;

  return {
    id: record.id,
    severity: severityOf(record),
    summary,
    url: `https://osv.dev/vulnerability/${encodeURIComponent(record.id)}`,
    fixedVersion: fixedVersionOf(record.affected),
    publishedAt: typeof record.published === 'string' ? record.published : null,
  };
}

/**
 * `database_specific.severity` is the project's own rating and is preferred; a CVSS vector is only
 * used to confirm it. A record with neither is `unknown`, which still blocks nothing on its own but
 * is shown rather than dropped.
 */
function severityOf(record: { severity?: unknown; database_specific?: unknown }): ScanSeverity {
  const specific = record.database_specific;
  if (typeof specific === 'object' && specific !== null) {
    const value = (specific as { severity?: unknown }).severity;
    if (typeof value === 'string') {
      const mapped = OSV_SEVERITY[value.trim().toUpperCase()];
      if (mapped !== undefined) return mapped;
    }
  }

  if (Array.isArray(record.severity)) {
    for (const entry of record.severity) {
      if (typeof entry !== 'object' || entry === null) continue;
      const score = (entry as { score?: unknown }).score;
      if (typeof score === 'number' && Number.isFinite(score)) return bandOf(score);
    }
  }
  return 'unknown';
}

function bandOf(score: number): ScanSeverity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0) return 'low';
  return 'unknown';
}

/** The first `fixed` event OSV reports; `null` means upstream has not published a fix yet. */
function fixedVersionOf(affected: unknown): string | null {
  if (!Array.isArray(affected)) return null;
  for (const item of affected) {
    if (typeof item !== 'object' || item === null) continue;
    const ranges = (item as { ranges?: unknown }).ranges;
    if (!Array.isArray(ranges)) continue;
    for (const range of ranges) {
      if (typeof range !== 'object' || range === null) continue;
      const events = (range as { events?: unknown }).events;
      if (!Array.isArray(events)) continue;
      for (const event of events) {
        if (typeof event !== 'object' || event === null) continue;
        const fixed = (event as { fixed?: unknown }).fixed;
        if (typeof fixed === 'string' && fixed.length > 0) return fixed;
      }
    }
  }
  return null;
}

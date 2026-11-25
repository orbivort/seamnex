import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CatalogRepositoryView } from '@seamnex/domain';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import {
  assertAllowedSourceUrl,
  cloneAtRevision,
  commitOf,
  resolveRefKind,
} from '../../common/exec/git';
import { ExecError } from '../../common/exec/exec';
import { CATALOG_REPOSITORY, type CatalogRepositoryService } from './catalog-repo.contract';
import type { CatalogSyncOutcome, CatalogSyncService } from './catalog-sync.contract';
import { clearSyncMarker, readSyncMarker, writeSyncMarker } from './catalog-sync.marker';
import { REAL_SWAP_IO, applySwap, planSwap } from './catalog-swap';

/**
 * ADR-BE-42 §10.2 — the one writer of `SEAMNEX_CATALOG_REPO_PATH`.
 *
 * The loader already reads `catalog/`, `catalog/env/` and a `git rev-parse HEAD` from whatever the
 * root is, so acquisition is the whole change: fetch the mirror at a tag into a staging directory
 * inside the root, prove it carries a catalogue, then rename its children into place. The root is a
 * bind mount, which is why nothing here renames the root itself.
 *
 * Three decisions are worth stating because each one is a refusal to paper something over:
 *
 *   - **The source is configuration.** The request carries a ref and never a URL, so there is no
 *     user-supplied host to validate and no path by which the console becomes an SSRF proxy.
 *   - **The swap is not atomic.** Four renames plus the documents are sequentially consistent, not
 *     one transaction, and `applySwap` records what it had not done. A mixed tree is reported by the
 *     read model, never claimed as a success.
 *   - **`catalog/env` is not a child of its own.** Declarations live under `catalog/`, so renaming
 *     `catalog` carries them; the marker names three directories and the documents, which is what
 *     the filesystem actually has.
 */
const CLONE_TIMEOUT_MS = 300_000;
const REF_LOOKUP_TIMEOUT_MS = 30_000;

/**
 * Distinct from `MIGRATION_LOCK_KEY` (918_273_647): a held migration must not be able to make a
 * catalogue sync look contended, or the other way round.
 */
const CATALOG_SYNC_LOCK_KEY = 918_273_649;

/**
 * `catalog_commit.kind` admits `scaffold`, `params` and `metadata` only, and widening it is a schema
 * change this change deliberately does not make (AC-14). Sync rows therefore use `metadata` and are
 * identified by this message prefix — one place, so the writer and the read model cannot disagree.
 */
const SYNC_KIND = 'metadata';
const SYNC_COMMIT_PREFIX = 'catalog sync ';

/** A ref the clone can name: no whitespace, no option-looking prefix, no explicit branch. */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

@Injectable()
export class CatalogSyncServiceImpl implements CatalogSyncService {
  private readonly logger = new Logger('catalog-sync');
  /** Per-actor cooldown, in-process on purpose: the advisory lock is the cross-replica control. */
  private readonly lastStartedAt = new Map<string, number>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CATALOG_REPOSITORY) private readonly repository: CatalogRepositoryService,
  ) {}

  async read(): Promise<CatalogRepositoryView> {
    const configured = this.config.SEAMNEX_CATALOG_SOURCE_URL.trim();
    const marker = readSyncMarker(this.config.SEAMNEX_CATALOG_REPO_PATH);
    return {
      revision: await this.repository.revision(),
      source: {
        configured: configured.length > 0,
        host: sanitisedHost(configured),
        ref: this.config.SEAMNEX_CATALOG_SOURCE_REF.trim() || null,
      },
      commit: await this.lastSyncedCommit(),
      staged: marker === null ? null : { pending: [...marker.pending] },
    };
  }

  async sync(input: {
    readonly ref?: string;
    readonly actorId: string;
  }): Promise<CatalogSyncOutcome> {
    const configured = this.config.SEAMNEX_CATALOG_SOURCE_URL.trim();
    if (configured.length === 0) {
      throw new AppError({
        code: 'SOURCE_NOT_CONFIGURED',
        detail:
          'No catalogue source is configured, so there is nothing to fetch. The working tree is the authority and a reload reads it.',
        remediation:
          'Set SEAMNEX_CATALOG_SOURCE_URL, or place a catalogue tag in SEAMNEX_CATALOG_REPO_PATH by hand and reload.',
      });
    }

    const ref = (input.ref ?? this.config.SEAMNEX_CATALOG_SOURCE_REF).trim();
    if (ref.length === 0) {
      throw new AppError({
        code: 'SOURCE_REF_REQUIRED',
        detail:
          'No ref was supplied and SEAMNEX_CATALOG_SOURCE_REF is unset, so the sync would have to guess a revision.',
        remediation: 'Name the tag to fetch, e.g. `catalog-2026.11.0`.',
      });
    }
    if (!REF_PATTERN.test(ref) || ref.startsWith('refs/heads/')) {
      throw new AppError({
        code: 'SOURCE_REF_REJECTED',
        detail: `"${ref}" is not a tag or commit name.`,
        remediation:
          'Name an annotated tag (catalog-YYYY.MM.<patch>) or a full commit SHA; a branch would change the catalogue under a running installation.',
      });
    }

    let url: URL;
    try {
      url = assertAllowedSourceUrl(configured, this.config.sourceAllowedHosts);
    } catch (error) {
      throw new AppError({
        code: 'SOURCE_URL_REJECTED',
        detail: `The configured catalogue source was refused: ${messageOf(error)}`,
        remediation: `Use an https URL on an allow-listed host (${this.config.sourceAllowedHosts.join(', ')}), without embedded credentials.`,
        cause: error,
      });
    }

    const root = this.config.SEAMNEX_CATALOG_REPO_PATH;
    this.assertWritable(root);
    this.assertCooledDown(input.actorId);

    const client = await this.pool.connect();
    let locked = false;
    try {
      // `pg_try_advisory_lock` rather than the blocking helper: a contended call is refused with a
      // named code instead of holding the request open for another operator's 300-second clone.
      const acquired = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [CATALOG_SYNC_LOCK_KEY],
      );
      locked = acquired.rows[0]?.locked === true;
      if (!locked) {
        throw new AppError({
          code: 'SOURCE_SYNC_IN_PROGRESS',
          status: 409,
          detail: 'Another catalogue sync is running; two of them would interleave in one root.',
          remediation: 'Wait for the running sync to finish, then run this one again.',
        });
      }

      this.lastStartedAt.set(input.actorId, Date.now());
      return await this.fetchAndSwap({
        root,
        url: url.toString(),
        // Derived from the URL the allow-list already accepted, not re-parsed from the raw setting:
        // one parse, one answer.
        sanitised: `${url.host}${url.pathname.replace(/\/+$/, '').replace(/\.git$/, '')}`,
        ref,
        actorId: input.actorId,
      });
    } finally {
      if (locked) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [CATALOG_SYNC_LOCK_KEY]);
        } catch (error) {
          // The lock is session-scoped and the connection is released below, which drops it anyway.
          this.logger.warn({ msg: 'advisory unlock failed', err: messageOf(error) });
        }
      }
      client.release();
    }
  }

  private async fetchAndSwap(input: {
    readonly root: string;
    readonly url: string;
    readonly sanitised: string;
    readonly ref: string;
    readonly actorId: string;
  }): Promise<CatalogSyncOutcome> {
    const kind = await resolveRefKind({
      url: input.url,
      ref: input.ref,
      allowedHosts: this.config.sourceAllowedHosts,
      timeoutMs: REF_LOOKUP_TIMEOUT_MS,
    }).catch((error: unknown) => {
      throw new AppError({
        code: 'SOURCE_CLONE_FAILED',
        detail: `The catalogue source could not be reached to resolve "${input.ref}": ${messageOf(error)}`,
        remediation: 'Check that the host can reach the source and that the tag exists.',
        cause: error,
      });
    });

    if (kind === 'branch') {
      throw new AppError({
        code: 'SOURCE_REF_IS_BRANCH',
        detail: `"${input.ref}" is a branch, not a tag or commit.`,
        remediation:
          'Tag the release (catalog-YYYY.MM.<patch>) and sync that tag; a branch would change the catalogue under a running installation.',
      });
    }
    if (kind === 'missing') {
      throw new AppError({
        code: 'SOURCE_REF_NOT_FOUND',
        detail: `The source has no tag "${input.ref}".`,
        remediation: 'Check the tag name; tags look like catalog-YYYY.MM.<patch>.',
      });
    }

    const stage = join(input.root, `.sync-${Date.now()}`);
    try {
      let commit: string;
      try {
        const clone = await cloneAtRevision({
          url: input.url,
          targetDir: stage,
          revision: input.ref,
          allowedHosts: this.config.sourceAllowedHosts,
          timeoutMs: CLONE_TIMEOUT_MS,
        });
        commit = clone.commit;
      } catch (error) {
        throw new AppError({
          code: 'SOURCE_CLONE_FAILED',
          detail: `The catalogue source could not be fetched: ${stderrTail(error) ?? messageOf(error)}`,
          remediation:
            'Check the host network and the tag, then retry. Nothing in the working tree was changed.',
          cause: error,
        });
      }

      this.assertCarriesCatalogue(stage, input.ref);

      const marker = readSyncMarker(input.root);
      const current = await this.headOf(input.root);
      /*
       * A re-sync at the commit already checked out changes nothing (AC-20). It is skipped only when
       * no marker exists: after an interrupted swap the git head may describe the *new* content while
       * a child still holds the old, and short-circuiting there would strand the mixed tree for ever.
       */
      if (marker === null && current === commit) {
        await this.recordCommit(input, commit);
        return { url: input.sanitised, ref: input.ref, commit, staged: null };
      }

      const pending = this.swap({
        root: input.root,
        stage,
        ref: input.ref,
        commit,
        actorId: input.actorId,
      });
      await this.recordCommit(input, commit);
      return {
        url: input.sanitised,
        ref: input.ref,
        commit,
        staged: pending.length === 0 ? null : { pending },
      };
    } finally {
      // Scratch state must not accumulate: a crashed or failed sync leaves no second tree behind.
      rmSync(stage, { recursive: true, force: true });
    }
  }

  private swap(input: {
    readonly root: string;
    readonly stage: string;
    readonly ref: string;
    readonly commit: string;
    readonly actorId: string;
  }): readonly string[] {
    const steps = planSwap({ root: input.root, stage: input.stage });
    const base = {
      ref: input.ref,
      commit: input.commit,
      actor: input.actorId,
      startedAt: new Date().toISOString(),
    };

    try {
      return applySwap(steps, {
        ...REAL_SWAP_IO,
        recordPending: (pending) => {
          if (pending.length === 0) {
            clearSyncMarker(input.root);
            return;
          }
          writeSyncMarker(input.root, { ...base, pending });
        },
      });
    } catch (error) {
      const remaining = readSyncMarker(input.root)?.pending ?? steps.map((step) => step.name);
      this.logger.error({
        msg: 'catalogue swap interrupted; the tree is mixed',
        pending: remaining,
        err: messageOf(error),
      });
      throw new AppError({
        code: 'SOURCE_SWAP_INCOMPLETE',
        status: 500,
        detail: `The catalogue tree is mixed: ${remaining.join(', ')} still hold their previous content.`,
        remediation:
          'Re-run the sync at the same ref. GET /catalog/repository reports the same pending order.',
        cause: error,
      });
    }
  }

  /**
   * A tag that declares no catalogue is the failure `removeMissing` turns into a wiped projection:
   * the reload would reconcile against an empty tree and delete every entry no instance holds.
   */
  private assertCarriesCatalogue(stage: string, ref: string): void {
    const catalogDir = join(stage, 'catalog');
    const documents = existsSync(catalogDir)
      ? readdirSync(catalogDir).filter((name) => name.endsWith('.json'))
      : [];
    if (documents.length === 0) {
      throw new AppError({
        code: 'SOURCE_EMPTY_TREE',
        detail: `The clone at "${ref}" carries no catalog/*.json document, so swapping it in would delete the catalogue.`,
        remediation:
          'Check the tag: a catalogue root is catalog/<KEY>.json, catalog/env/<KEY>.json and upstream/<KEY>/.',
      });
    }
  }

  private async recordCommit(
    input: { readonly ref: string; readonly actorId: string },
    commit: string,
  ): Promise<void> {
    await this.repository.recordCommit({
      sha: commit,
      kind: SYNC_KIND,
      actor: input.actorId,
      message: `${SYNC_COMMIT_PREFIX}${input.ref} at ${commit}`,
    });
  }

  private async lastSyncedCommit(): Promise<CatalogRepositoryView['commit']> {
    const result = await this.pool.query<{
      sha: string;
      actor: string;
      message: string;
      created_at: Date | string;
    }>(
      `SELECT sha, actor, message, created_at FROM catalog_commit
        WHERE message LIKE $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [`${SYNC_COMMIT_PREFIX}%`],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      sha: row.sha,
      actor: row.actor,
      message: row.message,
      recordedAt: new Date(row.created_at).toISOString(),
    };
  }

  private async headOf(root: string): Promise<string | null> {
    if (!existsSync(join(root, '.git'))) return null;
    try {
      return await commitOf(root);
    } catch {
      return null;
    }
  }

  /**
   * AC-24: the API runs as `node`, and a mount the host owns as root fails at the first rename.
   * Probing now turns that into a named refusal instead of a raw `EACCES` from `git`.
   */
  private assertWritable(root: string): void {
    try {
      mkdirSync(root, { recursive: true });
      const probe = join(root, `.sync-probe-${String(process.pid)}`);
      writeFileSync(probe, 'probe', 'utf8');
      rmSync(probe, { force: true });
    } catch (error) {
      throw new AppError({
        code: 'SOURCE_ROOT_NOT_WRITABLE',
        detail: `The catalogue root ${root} is not writable by the API user, so nothing can be fetched into it.`,
        remediation:
          'Make the host directory writable by the API container uid/gid and let git accept it (safe.directory when the host uid differs); ADR-BE-42 §10.7.',
        cause: error,
      });
    }
  }

  private assertCooledDown(actorId: string): void {
    const cooldown = this.config.SEAMNEX_CATALOG_SYNC_COOLDOWN_MS;
    if (cooldown <= 0) return;
    const last = this.lastStartedAt.get(actorId);
    if (last === undefined) return;
    const elapsed = Date.now() - last;
    if (elapsed >= cooldown) return;
    const retryAfter = Math.ceil((cooldown - elapsed) / 1_000);
    throw new AppError({
      code: 'SOURCE_SYNC_COOLDOWN',
      status: 429,
      detail: `The previous sync started ${String(Math.floor(elapsed / 1_000))}s ago; the cooldown is ${String(Math.floor(cooldown / 1_000))}s.`,
      remediation: 'Wait for the cooldown, then retry.',
      headers: { 'retry-after': String(retryAfter) },
    });
  }
}

/** `host/path`, never a scheme or a credential: safe to show, log and audit. */
function sanitisedHost(rawUrl: string): string | null {
  if (rawUrl.length === 0) return null;
  try {
    const parsed = new URL(rawUrl.startsWith('git+') ? rawUrl.slice(4) : rawUrl);
    const path = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    return `${parsed.host}${path}`;
  } catch {
    return null;
  }
}

/** The tail of a failed command's stderr, which is where git puts the reason. */
function stderrTail(error: unknown): string | null {
  if (!(error instanceof ExecError)) return null;
  const tail = error.stderr.trim().split(/\r?\n/).slice(-3).join(' ').trim();
  return tail.length === 0 ? null : tail;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

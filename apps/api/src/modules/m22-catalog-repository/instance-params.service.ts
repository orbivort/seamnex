import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { withAuditedMutation } from '@seamnex/db';
import type { Pool } from 'pg';
import { stringify } from 'yaml';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { ensureDir, safeJoin, sha256, writeFileAtomic } from '../../common/fs/files';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';

type InstanceRow = {
  id: string;
  entry_key: string;
  slug: string;
  domain_route: string;
  profile_key: string | null;
  state: string;
  payload: Record<string, unknown>;
  deleted_at: Date | null;
};

/**
 * 4A.8 — `instances/<slug>/instance.yaml`.
 *
 * The instance definition is **version-controlled and non-secret**: slug, entry, profile, resources,
 * route and the *names* of environment variables. A secret never reaches this file, which is what
 * makes it safe to commit and to reproduce from.
 *
 * `content_hash` is verified at boot. A mismatch is recorded as drift and blocks `start`, because a
 * host whose definition disagrees with the repository is a host nobody can reason about (inv. 13).
 */
@Injectable()
export class InstanceParamsService implements OnModuleInit {
  private readonly logger = new Logger('m22-instance-params');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
  ) {}

  /** Verification runs after migrations and before the first request, in the `api` role. */
  async onModuleInit(): Promise<void> {
    await this.verifyAll().catch((error: unknown) => {
      this.logger.error(`instance parameter verification failed: ${String(error)}`);
    });
  }

  /** `<SEAMNEX_CATALOG_REPO_PATH>/instances` — the only directory a deployment writes into. */
  get instancesRoot(): string {
    return join(this.config.SEAMNEX_CATALOG_REPO_PATH, 'instances');
  }

  /**
   * Refuses a deployment *before* anything is created when the working tree cannot take the write.
   *
   * The commit of `instances/<slug>/instance.yaml` happens after the instance row, the secrets and the
   * job exist (4A.8). When the directory was missing or mounted read-only — the dev stack mounts the
   * repository from the host, where the API user owns neither the mount root nor a directory that was
   * never created — the deployment failed with an `EACCES`, the operator was told "nothing was
   * applied", and a `requested` row kept the slug reserved for 30 days. A probe that costs one
   * `access(2)` turns that into a refusal that is both true and actionable.
   */
  assertWritable(): void {
    const root = this.instancesRoot;
    try {
      ensureDir(root);
      accessSync(root, constants.W_OK);
    } catch (error) {
      throw new AppError({
        code: 'REPOSITORY_UNAVAILABLE',
        detail: `The catalog repository is not writable at ${root}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        remediation:
          'Create the directory and make it writable by the API user (the dev stack prepares it from `temp/catalog-repo/instances`), then retry. Nothing was created.',
        cause: error,
      });
    }
  }

  async write(instanceId: string, actorId: string): Promise<{ path: string; contentHash: string }> {
    const instance = await this.instance(instanceId);
    const content = stringify(
      {
        apiVersion: 'seamnex/v1',
        kind: 'Instance',
        metadata: { slug: instance.slug, entryKey: instance.entry_key },
        spec: {
          profile: instance.profile_key ?? 'default',
          domainRoute: instance.domain_route,
          resources: instance.payload.resources ?? null,
          route: instance.payload.route ?? null,
          httpPort: instance.payload.httpPort ?? 80,
          // Names only. A value here would make the file a secret store, which it must never be.
          env: await this.envNames(instanceId),
        },
      },
      { lineWidth: 0 },
    );
    const contentHash = sha256(content);
    const root = join(this.config.SEAMNEX_CATALOG_REPO_PATH, 'instances');
    const relative = `${instance.slug}/instance.yaml`;
    ensureDir(join(root, instance.slug));
    writeFileAtomic(safeJoin(root, relative), content);

    const gitSha = await this.headSha();
    /*
     * Three writes, one commit — with the audit row first, which is the order AD-20 depends on: a
     * trigger that rejects the projection still leaves evidence of the attempt, and a failing audit
     * append stops the projection from being written at all.
     *
     * These were three autocommit statements. A failure between them left the file on disk, the
     * projection without its `catalog_commit` anchor, and no audit row saying a commit was attempted
     * — with no way to tell which of the three had succeeded. `withAuditedMutation` is the helper
     * that owns this order; hand-rolling it is how the three drifted apart in the first place.
     */
    await withAuditedMutation(
      this.pool,
      async (tx) => {
        await this.audit.append(
          {
            action: 'instance.params.committed',
            actorType: 'user',
            actorId,
            targetType: 'instance',
            targetId: instanceId,
            outcome: 'success',
            detail: { path: `instances/${relative}`, contentHash },
          },
          tx,
        );
      },
      async (tx) => {
        await tx.query(
          `INSERT INTO instance_param (instance_id, git_sha, content_hash, params, read_at)
           VALUES ($1, $2, $3, $4::jsonb, now())
           ON CONFLICT (instance_id) DO UPDATE
              SET git_sha = EXCLUDED.git_sha, content_hash = EXCLUDED.content_hash,
                  params = EXCLUDED.params, read_at = now()`,
          [instanceId, gitSha, contentHash, JSON.stringify(instance.payload)],
        );
        await tx.query(
          `INSERT INTO catalog_commit (sha, kind, actor, message)
           VALUES ($1, 'params', $2, $3) ON CONFLICT (sha) DO NOTHING`,
          [contentHash, actorId, `instance.yaml for ${instance.slug}`],
        );
      },
    );
    return { path: `instances/${relative}`, contentHash };
  }

  /**
   * Boot verification. A row whose file is missing or hashed differently marks the instance as
   * drifted; the pipeline refuses `start` until the definition is reconciled, so an operator cannot
   * "fix" a host by restarting it.
   *
   * Two properties this needs to be usable:
   *   - **the read is retried.** A bind mount (Docker Desktop, a network share) can serve a file the
   *     writing process has already closed but the host has not propagated yet. One early read used
   *     to mark a definition drifted seconds after it was committed, and the pipeline then refused to
   *     deploy an instance whose definition was on disk and correct.
   *   - **a match clears the flag.** Drift was sticky: once set, a reconciled file never cleared it,
   *     so the only way out was deleting the instance. Verification that cannot heal is a trap.
   */
  async verifyAll(): Promise<{ checked: number; drifted: number }> {
    const rows = await this.pool.query<{ instance_id: string; content_hash: string; slug: string }>(
      `SELECT p.instance_id, p.content_hash, i.slug
         FROM instance_param p JOIN instance i ON i.id = p.instance_id
        WHERE i.deleted_at IS NULL`,
    );
    let drifted = 0;

    for (const row of rows.rows) {
      const path = join(
        this.config.SEAMNEX_CATALOG_REPO_PATH,
        'instances',
        row.slug,
        'instance.yaml',
      );
      let observed = 'missing';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          observed = sha256(readFileSync(path, 'utf8'));
        } catch {
          observed = 'missing';
        }
        if (observed === row.content_hash) break;
        await sleep(250);
      }

      if (observed === row.content_hash) {
        await this.pool.query(
          `UPDATE instance SET payload = payload - 'instanceParamDrift', updated_at = now()
            WHERE id = $1 AND payload ? 'instanceParamDrift'`,
          [row.instance_id],
        );
        continue;
      }

      drifted += 1;
      await this.pool.query(
        `INSERT INTO drift_record (scope, instance_id, expected_hash, observed_hash, direction, detail)
         VALUES ('instance_param', $1, $2, $3, 'unknown', $4::jsonb)`,
        [row.instance_id, row.content_hash, observed, JSON.stringify({ path, kind: 'mismatch' })],
      );
      await this.pool.query(
        `UPDATE instance SET payload = payload || '{"instanceParamDrift":true}'::jsonb, updated_at = now()
          WHERE id = $1`,
        [row.instance_id],
      );
      this.logger.warn(
        { instanceId: row.instance_id, path },
        'instance.yaml does not match its recorded hash',
      );
    }

    return { checked: rows.rowCount ?? 0, drifted };
  }

  /** Used by the pipeline through `instance_param` reads; kept here so the rule has one owner. */
  async isDrifted(instanceId: string): Promise<boolean> {
    const result = await this.pool.query<{ drifted: boolean }>(
      `SELECT COALESCE((payload->>'instanceParamDrift')::boolean, false) AS drifted
         FROM instance WHERE id = $1`,
      [instanceId],
    );
    return result.rows[0]?.drifted === true;
  }

  private async envNames(instanceId: string): Promise<string[]> {
    const result = await this.pool.query<{ var_name: string }>(
      `SELECT var_name FROM instance_env_value WHERE instance_id = $1 ORDER BY var_name`,
      [instanceId],
    );
    return result.rows.map((row) => row.var_name);
  }

  private async instance(instanceId: string): Promise<InstanceRow> {
    const result = await this.pool.query<InstanceRow>(
      `SELECT id, entry_key, slug, domain_route, profile_key, state, payload, deleted_at
         FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No instance ${instanceId}.`,
        remediation: 'Refresh the instance list.',
      });
    }
    return row;
  }

  private async headSha(): Promise<string> {
    const result = await this.pool.query<{ sha: string }>(
      `SELECT sha FROM catalog_commit ORDER BY created_at DESC LIMIT 1`,
    );
    return result.rows[0]?.sha ?? 'worktree';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CatalogEntrySchema,
  isComposedEntryKey,
  isCredentialGranularity,
  isWriteEligible,
  type CatalogEntry,
  type CatalogReloadResult,
  type CredentialGranularity,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { withTransaction } from '@seamnex/db';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { AppError } from '../../common/problem/app-error';
import { OUTBOX_SERVICE, type Outbox } from '../m17-audit/audit.contract';
import {
  CATALOG_REPOSITORY,
  type CatalogRepositoryService,
  type CatalogWorkingTree,
} from '../m22-catalog-repository/catalog-repo.contract';
import type { CatalogService, IntegrationMetadataPatch } from './catalog.contract';
import { preserveVerifiedFacts, sameProjection, type StoredProjection } from './projection-compare';

type EntryRow = {
  key: string;
  domain: string;
  product: string;
  cluster: string | null;
  packaging: CatalogEntry['packaging'];
  guarantee_class: CatalogEntry['guaranteeClass'];
  payload: Record<string, unknown>;
};

/** FR-2.14 review cadence: 13 weeks, the window every seeded entry uses. */
const REVIEW_WINDOW_DAYS = 91;

/**
 * The projection is the relational row overlaid on the stored document (ADR-BE-09 D10): the
 * columns that are filtered, joined or ordered on always win over a stale document field.
 *
 * `cluster` is the one column that may be NULL while the document is not; falling back to the
 * document keeps a row that was written before the column was populated readable.
 */
function project(row: EntryRow): Record<string, unknown> {
  const document = (row.payload ?? {}) as Record<string, unknown>;
  return {
    ...document,
    key: row.key,
    domain: row.domain,
    product: row.product,
    cluster: row.cluster ?? document.cluster,
    packaging: row.packaging,
    guaranteeClass: row.guarantee_class,
  };
}

@Injectable()
export class PostgresCatalogService implements CatalogService {
  private readonly logger = new Logger('catalog');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(CATALOG_REPOSITORY) private readonly repository: CatalogRepositoryService,
    @Inject(OUTBOX_SERVICE) private readonly outbox: Outbox,
  ) {}

  async list(filter: {
    q?: string;
    cluster?: string;
    packaging?: string;
  }): Promise<CatalogEntry[]> {
    const q = (filter.q ?? '').toLowerCase();
    const result = await this.pool.query<EntryRow>(
      `SELECT key, domain, product, cluster, packaging, guarantee_class, payload
         FROM catalog_entry
        WHERE ($1 = '' OR lower(product) LIKE '%' || $1 || '%' OR lower(domain) LIKE '%' || $1 || '%' OR lower(key) LIKE '%' || $1 || '%')
          AND ($2 = '' OR cluster = $2)
          AND ($3 = '' OR packaging = $3)
        ORDER BY
          -- ADR-BE-20 phase 1 transitional ordering: a tree that still holds a legacy key cannot
          -- sort on the key text alone. 'D' + '3' sorts after 'D' + '0', so every legacy key would
          -- be pushed past every composed one and the catalogue list would silently reorder. Domain
          -- ordinal first, product ordinal second (a legacy key is product 1 by definition), then
          -- the key as the tie-break. Deleted in phase 3, when plain text ordering is correct again.
          CASE WHEN position('-' in key) > 0 THEN substr(key, 2, 2)::int ELSE substr(key, 2)::int END,
          CASE WHEN position('-' in key) > 0 THEN substr(key, 5, 2)::int ELSE 1 END,
          key`,
      [q, filter.cluster ?? '', filter.packaging ?? ''],
    );

    // One incomplete projection must not take down the whole catalogue: the row is reported and
    // omitted, so the screen still renders the entries whose document satisfies the contract.
    const entries: CatalogEntry[] = [];
    for (const row of result.rows) {
      const entry = this.projection(row);
      if (entry !== null) entries.push(entry);
    }
    return entries;
  }

  async entry(key: string): Promise<CatalogEntry> {
    const row = await this.find(key);
    if (row === undefined) throw notFound(key);
    return this.requireProjection(row);
  }

  async reload(input: {
    actorId: string;
    tree?: CatalogWorkingTree;
  }): Promise<CatalogReloadResult> {
    const tree = input.tree ?? (await this.repository.load());
    const actorId = input.actorId;
    const previous = await this.currentProjections();
    const reconciled: CatalogReloadResult['reconciled'] = [];
    let added = 0;
    let changed = 0;

    for (const document of tree.documents) {
      const contentHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
      const before = previous.get(document.key);
      /**
       * FR-2.14: "verified values supersede catalog assumptions". A reload re-projects the repository
       * document, and the repository cannot know what an operator verified against the running
       * product — so the verified block is carried forward over the incoming document. Without this,
       * committing any unrelated change to an entry silently re-opened its review, reset its staleness
       * clock and reverted a corrected credential granularity, which is a verification that lasts
       * until the next reload.
       */
      const projected = preserveVerifiedFacts(document, before?.document ?? {});
      /**
       * A matching revision hash is not proof that the projection is current.
       *
       * `catalog_entry` can be rewritten without touching `catalog_entry_revision` — `pnpm db:seed`
       * does exactly that, and so does a restore or a hand repair. Comparing only the hash then
       * reports "unchanged" forever and serves the seeded document (wrong domain, wrong image digest,
       * wrong review dates) to the catalog, the deploy wizard and pre-flight. So the stored row is
       * compared as well: the document *and* the columns it is overlaid with.
       */
      const revisionMatches = before !== undefined && before.contentHash === contentHash;
      const projectionMatches = before !== undefined && sameProjection(before, projected);
      const change: 'unchanged' | 'added' | 'updated' =
        before === undefined
          ? 'added'
          : revisionMatches && projectionMatches
            ? 'unchanged'
            : 'updated';

      if (change !== 'unchanged') {
        await withTransaction(this.pool, async (tx) => {
          // Lock order: audit chain first, business rows second (AD-20).
          await this.audit.lockChain(tx);
          await tx.query(
            `INSERT INTO catalog_entry (key, domain, product, cluster, packaging, guarantee_class, repo_url, license_id, payload)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
             ON CONFLICT (key) DO UPDATE
                SET domain = EXCLUDED.domain,
                    product = EXCLUDED.product,
                    cluster = EXCLUDED.cluster,
                    packaging = EXCLUDED.packaging,
                    guarantee_class = EXCLUDED.guarantee_class,
                    repo_url = EXCLUDED.repo_url,
                    license_id = EXCLUDED.license_id,
                    payload = EXCLUDED.payload,
                    updated_at = now()`,
            [
              projected.key,
              projected.domain,
              projected.product,
              projected.cluster,
              projected.packaging,
              projected.guaranteeClass,
              projected.repoUrl,
              projected.licenseId,
              JSON.stringify(projected),
            ],
          );
          await tx.query(
            `INSERT INTO catalog_entry_revision (entry_key, git_sha, content_hash, payload)
             VALUES ($1, $2, $3, $4::jsonb)
             ON CONFLICT (entry_key, git_sha) DO NOTHING`,
            // The revision records what the repository said, not what the platform verified.
            [document.key, tree.revision, contentHash, JSON.stringify(document)],
          );
          await this.audit.append(
            {
              action: 'catalog.reloaded',
              actorType: 'user',
              actorId,
              targetType: 'catalog_entry',
              targetId: document.key,
              outcome: 'success',
              detail: {
                change,
                revision: tree.revision,
                // The repository did not move; the row had drifted from it. Recorded so the repair is
                // distinguishable from a normal reload in the audit trail.
                repaired: revisionMatches && !projectionMatches,
              },
            },
            tx,
          );
        });

        if (change === 'added') added += 1;
        else changed += 1;
        if (change === 'updated' && before !== undefined && before.contentHash !== contentHash) {
          await this.repository.recordDrift(document.key, before.contentHash, contentHash);
        }
      }

      reconciled.push({
        key: document.key,
        change,
        detail:
          change === 'unchanged'
            ? `Matches revision ${tree.revision}.`
            : revisionMatches && !projectionMatches
              ? `Projection repaired from revision ${tree.revision}; the stored row did not match the repository.`
              : `Projected from revision ${tree.revision}; content hash ${contentHash.slice(0, 12)}.`,
      });
    }

    // A file that exists but failed validation is **not** a deleted file. Protecting its key is what
    // stops a trailing comma from quietly removing a product from the projection; the reason is
    // returned instead, so the operator sees "rejected" rather than "gone".
    const rejected = new Set(
      tree.invalid.flatMap((artefact) =>
        artefact.scope === 'entry' && artefact.key !== null ? [artefact.key] : [],
      ),
    );
    const removed = await this.removeMissing(
      new Set(tree.documents.map((document) => document.key)),
      rejected,
      actorId,
    );
    for (const key of removed) {
      reconciled.push({ key, change: 'removed', detail: 'No longer present in the working tree.' });
    }

    /*
     * ADR-BE-20 phase 1: a legacy key is reported, not refused. The receipt is the only place an
     * operator learns the tree is still mid-migration — and it is what phase 2's "reload and read the
     * receipt" step asserts is empty once the rename is complete.
     */
    const deprecated = tree.documents
      .map((document) => document.key)
      .filter((key) => !isComposedEntryKey(key));

    return {
      reloadedAt: new Date().toISOString(),
      revision: tree.revision,
      entries: tree.documents.length,
      added,
      changed,
      removed: removed.length,
      reconciled,
      invalid: [...tree.invalid],
      deprecated,
    };
  }

  /**
   * FR-2.14 — record a verified review, including the credential granularity that C-11 turns into a
   * write-eligibility verdict.
   *
   * Two rows are written, deliberately:
   *
   *   * `catalog_entry.payload` is the reviewed entry-level record — the only place a verification
   *     can live for an entry that has not been deployed yet, and what every catalog screen reads;
   *   * `integration_metadata` is the per-instance record that the database invariant, the credential
   *     broker, the registry feed and the governance review queue all read. Writing one without the
   *     other is what made the feature inert: the console wrote the document only, so a granularity
   *     of `none` never reached invariant 4 and never stopped a write scope.
   *
   * The upsert is `entry_key`-scoped because the operator verifies a *product*, not an instance, and
   * a per-instance divergence would otherwise be invisible on the screen that caused it.
   */
  async patchIntegrationMetadata(
    key: string,
    patch: IntegrationMetadataPatch,
    actorId: string,
  ): Promise<CatalogEntry> {
    const row = await this.find(key);
    if (row === undefined) throw notFound(key);
    // Writing back a partial document would persist the defect this method is meant to repair.
    const entry = this.requireProjection(row);
    // The route schema already rejects an unknown value; repeating it here is what keeps the
    // invariant true for a caller that reaches the service without the route (a job, a test).
    if (
      !isCredentialGranularity(patch.credentialGranularity) &&
      patch.credentialGranularity !== undefined
    ) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `"${String(patch.credentialGranularity)}" is not a credential granularity.`,
        fieldErrors: [
          {
            field: 'credentialGranularity',
            code: 'enum',
            message: 'One of scoped, account, none.',
          },
        ],
        remediation: 'Send scoped, account or none.',
      });
    }

    const previousGranularity: CredentialGranularity = entry.integration.credentialGranularity;
    const nextGranularity: CredentialGranularity =
      patch.credentialGranularity ?? previousGranularity;
    // A verification that leaves `nextReviewAt` and `stale` untouched is not a verification: the
    // contract, the button label and the audit detail all claim the clock restarts, so it does.
    const verifiedAt = new Date();
    const nextReviewAt = new Date(verifiedAt.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const integration = {
      ...entry.integration,
      credentialGranularity: nextGranularity,
      ...(patch.sessionMaxMinutes === undefined
        ? {}
        : { sessionMaxMinutes: patch.sessionMaxMinutes }),
      verifiedBy: actorId,
      verifiedAt: verifiedAt.toISOString(),
      nextReviewAt: nextReviewAt.toISOString(),
      stale: false,
    };
    const next: CatalogEntry = { ...entry, integration };
    // The downgrade is the audited fact: it is the one that can invalidate credentials that already
    // exist, and the trigger in 0017 revokes them in this same transaction.
    const revokesLiveWriteScopes =
      isWriteEligible(previousGranularity) && !isWriteEligible(nextGranularity);

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(
        `UPDATE catalog_entry SET payload = $2::jsonb, updated_at = now() WHERE key = $1`,
        [key, JSON.stringify(next)],
      );
      // The per-instance record the enforcement points read. `verified_by/at` and `next_review_at`
      // travel with it, because the registry's staleness flag and the governance review queue are
      // queries over these columns, not over the catalog document.
      await tx.query(
        `INSERT INTO integration_metadata
           (instance_id, entry_key, credential_granularity, session_max_minutes, verified_by, verified_at, next_review_at)
         SELECT i.id, i.entry_key, $2, $3, $4, $5, $6
           FROM instance i
          WHERE i.entry_key = $1 AND i.deleted_at IS NULL
         ON CONFLICT (instance_id) DO UPDATE
            SET credential_granularity = EXCLUDED.credential_granularity,
                session_max_minutes = EXCLUDED.session_max_minutes,
                verified_by = EXCLUDED.verified_by,
                verified_at = EXCLUDED.verified_at,
                next_review_at = EXCLUDED.next_review_at`,
        [key, nextGranularity, integration.sessionMaxMinutes, actorId, verifiedAt, nextReviewAt],
      );
      await this.audit.append(
        {
          action: 'catalog.integration_metadata.updated',
          actorType: 'user',
          actorId,
          targetType: 'catalog_entry',
          targetId: key,
          outcome: 'success',
          detail: {
            credentialGranularity: nextGranularity,
            previousGranularity,
            // FR-2.14: the verdict the platform derives, recorded with the fact it derives from.
            writeEligible: isWriteEligible(nextGranularity),
            revokesLiveWriteScopes,
            sessionMaxMinutes: integration.sessionMaxMinutes,
            nextReviewAt: integration.nextReviewAt,
          },
        },
        tx,
      );
      // FR-2.15/AC-41: the registry and posture screens serve a projection, so the change is only
      // visible once it is rebuilt. Emitted in the transaction (AD-18) so a restart cannot lose it.
      await this.outbox.emit(tx, {
        aggregateType: 'catalog_entry',
        aggregateId: key,
        eventType: 'registry.rebuild',
        payload: { reason: 'integration_metadata.updated', entryKey: key },
      });
    });

    return next;
  }

  private async find(key: string): Promise<EntryRow | undefined> {
    const result = await this.pool.query<EntryRow>(
      `SELECT key, domain, product, cluster, packaging, guarantee_class, payload
         FROM catalog_entry WHERE key = $1`,
      [key],
    );
    return result.rows[0];
  }

  /**
   * The contract is enforced here, not only in the route table: a row whose stored document is
   * stale or partial must never reach the response parser, where it would surface as a 500.
   */
  private projection(row: EntryRow): CatalogEntry | null {
    const parsed = CatalogEntrySchema.safeParse(project(row));
    if (parsed.success) return parsed.data;

    this.logger.error({
      msg: 'catalog projection does not match the entry contract',
      key: row.key,
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'document'}: ${issue.message}`)
        .join('; '),
    });
    return null;
  }

  private requireProjection(row: EntryRow): CatalogEntry {
    const entry = this.projection(row);
    if (entry === null) throw incompleteProjection(row.key);
    return entry;
  }

  /**
   * Everything the reload needs to decide whether a row still represents the repository: the hash of
   * the last revision it was projected from, the document that was stored, and the columns the
   * document is overlaid with. A hash alone cannot see a row that was rewritten behind its back.
   */
  private async currentProjections(): Promise<Map<string, StoredProjection>> {
    const result = await this.pool.query<{
      key: string;
      domain: string;
      product: string;
      cluster: string | null;
      packaging: CatalogEntry['packaging'];
      guarantee_class: CatalogEntry['guaranteeClass'];
      repo_url: string | null;
      license_id: string | null;
      payload: Record<string, unknown>;
      content_hash: string | null;
    }>(
      `SELECT e.key, e.domain, e.product, e.cluster, e.packaging, e.guarantee_class,
              e.repo_url, e.license_id, e.payload,
              (SELECT r.content_hash FROM catalog_entry_revision r
                WHERE r.entry_key = e.key ORDER BY r.loaded_at DESC, r.id DESC LIMIT 1) AS content_hash
         FROM catalog_entry e`,
    );
    return new Map(
      result.rows.map((row) => [
        row.key,
        {
          contentHash: row.content_hash ?? '',
          document: row.payload ?? {},
          columns: {
            domain: row.domain,
            product: row.product,
            cluster: row.cluster,
            packaging: row.packaging,
            guaranteeClass: row.guarantee_class,
            repoUrl: row.repo_url,
            licenseId: row.license_id,
          },
        },
      ]),
    );
  }

  private async removeMissing(
    present: ReadonlySet<string>,
    /** Keys whose file was rejected this run: present on disk, so they must survive. */
    rejected: ReadonlySet<string>,
    actorId: string,
  ): Promise<string[]> {
    const result = await this.pool.query<{ key: string }>(
      `SELECT e.key FROM catalog_entry e
        WHERE NOT (e.key = ANY($1::text[]))
          AND NOT (e.key = ANY($2::text[]))
          AND NOT EXISTS (SELECT 1 FROM instance i WHERE i.entry_key = e.key)`,
      [[...present], [...rejected]],
    );
    const removed: string[] = [];
    for (const row of result.rows) {
      await withTransaction(this.pool, async (tx) => {
        await this.audit.lockChain(tx);
        await tx.query(`DELETE FROM catalog_entry WHERE key = $1`, [row.key]);
        await this.audit.append(
          {
            action: 'catalog.entry.removed',
            actorType: 'user',
            actorId,
            targetType: 'catalog_entry',
            targetId: row.key,
            outcome: 'success',
            detail: { reason: 'absent from the working tree' },
          },
          tx,
        );
      });
      removed.push(row.key);
    }
    return removed;
  }
}

function notFound(key: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No catalog entry ${key}.`,
    remediation: 'Reload the catalog repository or check the entry key.',
  });
}

/**
 * A row exists but its document is not a complete entry. Naming the key and the repair keeps the
 * failure actionable instead of the generic "response violates the contract" it used to produce.
 */
function incompleteProjection(key: string): AppError {
  return new AppError({
    code: 'INTERNAL_ERROR',
    detail: `Catalog entry ${key} is projected without the fields its contract requires.`,
    remediation:
      'Run POST /catalog/reload to re-read the catalog repository, or reseed the development database.',
  });
}

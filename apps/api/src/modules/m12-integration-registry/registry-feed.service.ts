import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import {
  canonicalVersion,
  isCredentialGranularity,
  isWorkflowEligible,
  isWriteEligible,
  type CredentialGranularity,
  type OperationsResponse,
  type RegistryEntry,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { AppError } from '../../common/problem/app-error';
import { OUTBOX_SERVICE, type Outbox } from '../m17-audit/audit.contract';

/**
 * 4D.6 - the registry feed (CL-07).
 *
 * `registry_snapshot` stores one projection per instance in `payload`; operations and event modes
 * ride inside it rather than in their own columns, because the snapshot is a cache of an entry, not
 * a second schema. Staleness is a fact with a date: a snapshot whose metadata was never verified, or
 * whose verification is older than `SEAMNEX_REGISTRY_STALE_DAYS`, is marked stale and `/posture` counts it.
 */
@Injectable()
export class RegistryFeedService implements OnApplicationBootstrap, OnModuleInit {
  private readonly logger = new Logger('m12-registry-feed');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(OUTBOX_SERVICE) private readonly outbox: Outbox,
  ) {}

  onModuleInit(): void {
    // The event is durable and idempotent, so a metadata change made while the API restarts is not
    // lost the way a direct call would be.
    this.outbox.on('registry.rebuild', async () => {
      await this.rebuild().catch((error: unknown) => {
        this.logger.error(`registry rebuild failed: ${String(error)}`);
      });
    });
  }

  /**
   * Backfills a projection that was never built.
   *
   * A registry with deployed instances and no snapshot rows is not an empty platform — it is the
   * signature of an outbox event that no role ever dispatched. The dev stack shipped without a
   * `scheduler` for a while, so three `registry.rebuild` rows reached `attempts = 0` and never ran;
   * `/registry` reported "No registry entry matches" next to six ready products, and the workflow
   * builder could not resolve a single target. Waiting for the next metadata edit leaves all of that
   * broken indefinitely, so the projection repairs itself once at boot.
   *
   * This is a backfill, not a rebuild: a projection that already covers every live instance is left
   * alone, so a restart does not churn `built_at` or hide an unfresh snapshot behind a fresh one.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      if (!(await this.isIncomplete())) return;
      const rebuilt = await this.rebuild();
      this.logger.log(`registry backfilled on boot: ${rebuilt} instance(s) had no snapshot`);
    } catch (error) {
      // A projection that cannot be built must not keep the API from serving: the endpoint answers
      // with what it has, and the failure is in the log rather than in a boot loop.
      this.logger.error(`registry backfill failed: ${String(error)}`);
    }
  }

  /** True when at least one live instance has no snapshot row. */
  private async isIncomplete(): Promise<boolean> {
    const result = await this.pool.query<{ incomplete: boolean }>(
      `SELECT EXISTS (
                SELECT 1 FROM instance i
                 WHERE i.deleted_at IS NULL
                   AND NOT EXISTS (SELECT 1 FROM registry_snapshot s WHERE s.instance_id = i.id)
              ) AS incomplete`,
    );
    return result.rows[0]?.incomplete === true;
  }

  /** Operations discovered for one product; the canvas must never ask an author to type a URL. */
  async operations(target: string): Promise<OperationsResponse> {
    const result = await this.pool.query<{
      entry_key: string;
      payload: RegistryEntry & { operations?: unknown; eventModes?: unknown };
    }>(
      `SELECT payload->>'entryKey' AS entry_key, payload FROM registry_snapshot
        WHERE payload->>'slug' = $1 OR instance_id::text = $1 OR payload->>'entryKey' = $1
        LIMIT 1`,
      [target],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No registry entry for "${target}".`,
        remediation:
          'Rebuild the registry and pick the product from the list; an unknown target is not a guessable URL.',
      });
    }
    return {
      target: row.entry_key,
      operations: (row.payload.operations ?? []) as OperationsResponse['operations'],
      eventModes: (row.payload.eventModes ?? []) as OperationsResponse['eventModes'],
    };
  }

  /**
   * Rebuilds every snapshot row from the instances and their verified metadata.
   *
   * The projection used to select `m.payload`, a JSONB column `integration_metadata` does not have
   * (its columns are `credential_granularity`, `operation_inventory`, `event_modes`,
   * `session_max_minutes`, `verified_at`, `next_review_at`). The query failed, so no snapshot was
   * ever rebuilt and `/registry` served whatever the seed had written — including a `writeEligible`
   * that disagreed with the catalog the operator had just edited.
   *
   * The guarantee class and the auth method follow the same precedence as the timestamps: the
   * verified fact first, then the entry document. They used to be read from `i.payload`, which the
   * deploy writer fills with `route.authMode` and no top-level `guaranteeClass`/`authMethod` — so
   * every snapshot defaulted to `native`/`oidc` and the registry advertised single sign-on for the
   * proxy-gated products (D07-01, D09-01) whose own entry screen says "Sign-in required". That is
   * the claim ADR-BE-15 exists to forbid, published by the inventory the workflow builder reads.
   */
  async rebuild(): Promise<number> {
    const rows = await this.pool.query<{
      instance_id: string;
      entry_key: string;
      slug: string;
      host: string | null;
      payload: Record<string, unknown>;
      guarantee_class: RegistryEntry['guaranteeClass'] | null;
      auth_method: string | null;
      credential_granularity: string;
      operation_inventory: unknown;
      event_modes: unknown;
      document_operations: unknown;
      document_event_modes: unknown;
      verified_at: Date | null;
      next_review_at: Date | null;
      product: string | null;
      version: string | null;
      owner: string | null;
    }>(
      // `seamnex_effective_granularity` is the same resolver invariant 4 uses (migration 0017), so the
      // registry cannot advertise write eligibility the database would refuse.
      `SELECT i.id AS instance_id, i.entry_key, i.slug, r.host, i.payload,
              seamnex_effective_granularity(i.id) AS credential_granularity,
              coalesce(m.guarantee_class_verified, c.guarantee_class) AS guarantee_class,
              coalesce(m.auth_method, c.payload->>'authMethod') AS auth_method,
              m.operation_inventory,
              m.event_modes,
              c.payload #> '{integration,operationInventory}' AS document_operations,
              c.payload #> '{integration,eventModes}' AS document_event_modes,
              coalesce(m.verified_at, CASE WHEN c.payload #>> '{integration,verifiedAt}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                                           THEN (c.payload #>> '{integration,verifiedAt}')::timestamptz END) AS verified_at,
              coalesce(m.next_review_at, CASE WHEN c.payload #>> '{integration,nextReviewAt}' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
                                              THEN (c.payload #>> '{integration,nextReviewAt}')::timestamptz END) AS next_review_at,
              c.payload->>'product' AS product,
              -- The document has no top-level version key; it carries upstream.currentVersion, so
              -- reading only payload ->> 'version' left every row on the "unpinned" placeholder
              -- although the image was pinned (FR-1.5). The running tag is a different question —
              -- it belongs to the instance and patch screens, and instance_service is outside the
              -- tables this module may read (module-boundaries).
              c.payload->'upstream'->>'currentVersion' AS version,
              c.payload->>'owner' AS owner
         FROM instance i
         LEFT JOIN instance_route r ON r.instance_id = i.id AND r.published AND NOT r.gated
         LEFT JOIN integration_metadata m ON m.instance_id = i.id
         LEFT JOIN catalog_entry c ON c.key = i.entry_key
        WHERE i.deleted_at IS NULL`,
    );

    for (const row of rows.rows) {
      const granularity = asGranularity(row.credential_granularity);
      const declaredVersion =
        row.version ?? (typeof row.payload.version === 'string' ? row.payload.version : null);
      const verifiedAt = row.verified_at;
      const stale =
        verifiedAt === null ||
        Date.now() - verifiedAt.getTime() > this.config.SEAMNEX_REGISTRY_STALE_DAYS * 86_400_000;
      const projected: RegistryEntry & { operations: unknown; eventModes: unknown } = {
        instanceId: row.instance_id,
        entryKey: row.entry_key,
        product: row.product ?? row.entry_key,
        slug: row.slug,
        route: row.host ?? '',
        version: canonicalVersion(declaredVersion) ?? 'unpinned',
        apiBaseUrl: row.host === null ? '' : `https://${row.host}`,
        authMethod: row.auth_method ?? 'oidc',
        guaranteeClass: row.guarantee_class ?? 'native',
        // The verified inventory, falling back to the entry document: the canvas discovers operations
        // here (FR-5.2), and an empty list made every product look like it had none.
        operations: (row.operation_inventory ??
          row.document_operations ??
          []) as RegistryEntry['operations'],
        eventModes: (row.event_modes ??
          row.document_event_modes ??
          []) as RegistryEntry['eventModes'],
        credentialGranularity: granularity,
        writeEligible: isWriteEligible(granularity),
        workflowEligible: isWorkflowEligible(granularity),
        owner: row.owner ?? 'platform',
        verifiedAt: (verifiedAt ?? new Date(0)).toISOString(),
        nextReviewAt: (
          row.next_review_at ??
          new Date(
            (verifiedAt ?? new Date(0)).getTime() +
              this.config.SEAMNEX_REGISTRY_STALE_DAYS * 86_400_000,
          )
        ).toISOString(),
        stale,
      };
      await this.pool.query(
        `INSERT INTO registry_snapshot (instance_id, payload, stale)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (instance_id) DO UPDATE
            SET payload = EXCLUDED.payload, stale = EXCLUDED.stale, built_at = now()`,
        [row.instance_id, JSON.stringify(projected), stale],
      );
    }

    // A delete is a soft delete (`deleted_at`), so `ON DELETE CASCADE` never fires and a removed
    // product kept its snapshot row: the registry went on offering an instance that no longer exists
    // as a workflow target. The projection is the live instances and only those.
    await this.pool.query(
      `DELETE FROM registry_snapshot s
        WHERE NOT EXISTS (
          SELECT 1 FROM instance i WHERE i.id = s.instance_id AND i.deleted_at IS NULL
        )`,
    );

    return rows.rowCount ?? 0;
  }
}

/** A stored value that is not one of the three members is a declarable-granularity failure. */
function asGranularity(value: string): CredentialGranularity {
  return isCredentialGranularity(value) ? value : 'none';
}

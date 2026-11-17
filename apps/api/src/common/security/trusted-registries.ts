import { Inject, Injectable, Logger } from '@nestjs/common';
import { loadShippedTrustedRegistries } from '@seamnex/db';
import type { Pool } from 'pg';
import {
  isTrustedImageReference,
  tryParseImageReference,
  untrustedRegistryMessage,
} from '@seamnex/domain';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../problem/app-error';

/**
 * NFR-4.16 — the allow-list, read once per process and enforced wherever an image is fetched.
 *
 * The reader lives in `common/` rather than in M02 because the pull/build guard has to run inside
 * `DockerEngineClient`, and a client that imported a module service would invert the dependency the
 * boundary manifest exists to protect. M02 remains the writer (revisions + audit); this class is the
 * read-only, cached view. It names one table, which the manifest declares under `common.reads`.
 *
 * **The cache is the point.** Every deploy pulls several images and checks each one; a query per
 * check would put the allow-list on the hot path of a deployment. Thirty seconds is short enough
 * that an operator's added namespace takes effect within one retry, and the write path invalidates
 * the cache outright, so the common case is immediate.
 */
export const IMAGE_TRUST_GUARD = Symbol('seamnex.image.trust.guard');

export type ImageTrustOperation = 'pull' | 'build' | 'start';

export type ImageTrustGuard = {
  /** Refuses a reference outside the allow-list with an actionable `AppError`. */
  assertTrusted(reference: string, operation: ImageTrustOperation): Promise<void>;
};

export type TrustedRegistrySnapshot = {
  readonly version: number;
  readonly contentHash: string;
  readonly entries: readonly string[];
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  /** Where the list in force came from, so the console can say "shipped default" honestly. */
  readonly origin: 'database' | 'configuration' | 'shipped';
};

const CACHE_TTL_MS = 30_000;

type RevisionRow = {
  version: number;
  content_hash: string;
  entries: unknown;
  note: string | null;
  created_by: string;
  created_at: Date;
};

@Injectable()
export class TrustedRegistriesReader implements ImageTrustGuard {
  private readonly logger = new Logger('trusted-registries');
  private cache: { snapshot: TrustedRegistrySnapshot; expiresAt: number } | null = null;
  private shipped: readonly string[] | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async snapshot(): Promise<TrustedRegistrySnapshot> {
    const now = Date.now();
    if (this.cache !== null && now < this.cache.expiresAt) return this.cache.snapshot;

    let snapshot: TrustedRegistrySnapshot;
    try {
      const result = await this.pool.query<RevisionRow>(
        `SELECT version, content_hash, entries, note, created_by, created_at
           FROM trusted_registry_revision
          ORDER BY version DESC
          LIMIT 1`,
      );
      const row = result.rows[0];
      snapshot =
        row === undefined
          ? this.shippedSnapshot('no revision has been written yet')
          : {
              version: row.version,
              contentHash: row.content_hash,
              entries: normaliseRowEntries(row.entries),
              note: row.note,
              createdBy: row.created_by,
              createdAt: row.created_at.toISOString(),
              origin: 'database',
            };
    } catch (error) {
      /*
       * The database being unreachable must not silently disable the control. Falling back to the
       * shipped list keeps a booting stack usable, and the log line is what makes the downgrade
       * visible — a guard that skipped its check would be the defect NFR-4.16 names.
       */
      this.logger.warn(
        `trusted-registry allow-list could not be read, using the shipped default: ${(error as Error).message}`,
      );
      snapshot = this.shippedSnapshot('the revision table is unreachable');
    }

    this.cache = { snapshot, expiresAt: now + CACHE_TTL_MS };
    return snapshot;
  }

  async entries(): Promise<readonly string[]> {
    return (await this.snapshot()).entries;
  }

  /** Called by the writer after a revision is committed: the next check must see it. */
  invalidate(): void {
    this.cache = null;
  }

  async assertTrusted(reference: string, operation: ImageTrustOperation): Promise<void> {
    const entries = await this.entries();
    // An unparseable reference is not trusted by definition: the parser is the only thing that can
    // say where an image comes from, and "we could not tell" is not a pass.
    if (
      tryParseImageReference(reference) === null ||
      !isTrustedImageReference(reference, entries)
    ) {
      throw new AppError({
        code: 'COMPOSE_POLICY_BLOCKED',
        // The refused step is part of the message: "pull" and "start" fail with the same rule, and
        // an operator reading a job log needs to know which fetch was stopped.
        detail: `${untrustedRegistryMessage(reference)} The ${operation} was refused.`,
        remediation:
          'Add the registry namespace to the trusted-registry allow-list (Security posture, R1) and retry the deployment.',
      });
    }
  }

  private shippedSnapshot(reason: string): TrustedRegistrySnapshot {
    const entries = this.shippedEntries();
    return {
      version: 0,
      contentHash: '',
      entries,
      note: `Shipped default (${reason}).`,
      createdBy: 'platform',
      // No revision exists, so there is no timestamp to invent; the epoch says "never revised".
      createdAt: new Date(0).toISOString(),
      origin: this.config.trustedRegistries.length > 0 ? 'configuration' : 'shipped',
    };
  }

  private shippedEntries(): readonly string[] {
    if (this.config.trustedRegistries.length > 0) return this.config.trustedRegistries;
    if (this.shipped !== null) return this.shipped;
    try {
      this.shipped = loadShippedTrustedRegistries().entries;
      return this.shipped;
    } catch (error) {
      // A missing document is a packaging error, not a reason to refuse every deployment silently —
      // and an empty list would do exactly that, so it is reported as a configuration failure.
      throw new AppError({
        code: 'UNAVAILABLE',
        detail: `the shipped trusted-registry allow-list could not be loaded: ${(error as Error).message}`,
        remediation:
          'Restore packages/db/src/seed/trusted-registries.json, or set SEAMNEX_TRUSTED_REGISTRIES explicitly.',
      });
    }
  }
}

/** The row is `jsonb`; a non-string member is dropped rather than trusted as an object key. */
function normaliseRowEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries.filter((entry): entry is string => typeof entry === 'string');
}

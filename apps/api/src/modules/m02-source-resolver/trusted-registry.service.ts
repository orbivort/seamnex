import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { trustedRegistryContentHash, withTransaction } from '@seamnex/db';
import type { Pool } from 'pg';
import {
  normaliseRegistryEntry,
  type TrustedRegistryState,
  type TrustedRegistryUpdate,
} from '@seamnex/domain';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  TrustedRegistriesReader,
  type TrustedRegistrySnapshot,
} from '../../common/security/trusted-registries';

/**
 * NFR-4.16 — the allow-list's write side.
 *
 * M02 owns `trusted_registry_revision` because the allow-list *is* source policy: the same module
 * that says which compose constructs may run says which registries may fill them. The read side
 * lives in `common/security` so the pull/build guard can hold one cached view without importing a
 * module service.
 *
 * Every change is a new revision plus an audit row inside one transaction: "adding an entry is an
 * audited change" is the requirement's sentence, and an UPDATE of the current list could not express
 * *what* changed or *when* it stopped being safe.
 */
@Injectable()
export class PostgresTrustedRegistryService implements OnModuleInit {
  private readonly logger = new Logger('m02-trusted-registries');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    // Explicit token: `tsx` emits no `design:paramtypes`, so an undecorated class parameter would
    // resolve to `undefined` at runtime.
    @Inject(TrustedRegistriesReader) private readonly reader: TrustedRegistriesReader,
  ) {}

  /**
   * Revision 1 is the shipped default, written once per database.
   *
   * Appending it at boot rather than lazily on the first change means the *first* state an operator
   * sees is a real revision with a real hash and a recorded author (`system`), instead of a
   * synthesised version 0 the API would have to explain.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.ensureBaseline();
    } catch (error) {
      // A database that is not migrated yet is reported here and retried on the next read; failing
      // the process would make an API unable to boot over one reference table.
      this.logger.warn(`trusted-registry baseline not written: ${(error as Error).message}`);
    }
  }

  async state(): Promise<TrustedRegistryState> {
    await this.ensureBaseline();
    const result = await this.pool.query<{
      version: number;
      content_hash: string;
      entries: unknown;
      note: string | null;
      created_by: string;
      created_at: Date;
    }>(
      `SELECT version, content_hash, entries, note, created_by, created_at
         FROM trusted_registry_revision
        ORDER BY version DESC
        LIMIT 20`,
    );

    const rows = result.rows;
    const current = rows[0];
    if (current === undefined) {
      throw new AppError({
        code: 'UNAVAILABLE',
        detail: 'the trusted-registry allow-list has no revision and could not be initialised.',
        remediation: 'Run `pnpm db:migrate` (0039) and retry.',
      });
    }

    return {
      current: {
        version: current.version,
        contentHash: current.content_hash,
        entries: stringEntries(current.entries),
        note: current.note,
        createdBy: current.created_by,
        createdAt: current.created_at.toISOString(),
      },
      history: rows.map((row) => ({
        version: row.version,
        createdAt: row.created_at.toISOString(),
        createdBy: row.created_by,
        note: row.note,
        entryCount: stringEntries(row.entries).length,
      })),
    };
  }

  async update(input: {
    actorId: string;
    update: TrustedRegistryUpdate;
  }): Promise<TrustedRegistryState> {
    const base = (await this.state()).current;
    const entries = new Set(base.entries);

    const removed: string[] = [];
    for (const entry of input.update.remove) {
      const normalised = normaliseRegistryEntry(entry);
      if (normalised === null) continue;
      if (entries.delete(normalised)) removed.push(normalised);
    }
    const added: string[] = [];
    for (const entry of input.update.add) {
      const normalised = normaliseRegistryEntry(entry);
      if (normalised === null) continue;
      if (!entries.has(normalised)) added.push(normalised);
      entries.add(normalised);
    }

    if (added.length === 0 && removed.length === 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        detail: `the allow-list already matches that change (version ${base.version}).`,
        remediation: 'Remove an entry that is present, or add one that is not.',
      });
    }
    /*
     * An empty list refuses every image, including the scanner's own. That is not a policy choice an
     * operator can mean, so it is refused while the previous revision is still intact.
     */
    if (entries.size === 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        detail:
          'the change would leave the trusted-registry allow-list empty, which refuses every image on the platform.',
        remediation:
          'Add the replacement namespace in the same change, or keep the current revision and add first.',
      });
    }

    const canonical = [...entries].sort();
    const version = base.version + 1;
    const contentHash = trustedRegistryContentHash(canonical);

    await withTransaction(this.pool, async (tx) => {
      // Lock order: audit chain first, business rows second (AD-20).
      await this.audit.lockChain(tx);
      await tx.query(
        `INSERT INTO trusted_registry_revision (version, content_hash, entries, note, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5)`,
        [version, contentHash, JSON.stringify(canonical), input.update.note, input.actorId],
      );
      await this.audit.append(
        {
          action: 'security.trusted_registry.updated',
          actorType: 'user',
          actorId: input.actorId,
          targetType: 'trusted_registry_revision',
          targetId: String(version),
          outcome: 'success',
          detail: {
            version,
            added,
            removed,
            entryCount: canonical.length,
            note: input.update.note,
          },
        },
        tx,
      );
    });

    // The guard must see the revision before the response leaves this process: an operator who
    // added a namespace and retried immediately should not hit a stale cache.
    this.reader.invalidate();
    return this.state();
  }

  /** The list in force, for callers that only need the entries (catalogue validation). */
  async entries(): Promise<readonly string[]> {
    return (await this.state()).current.entries;
  }

  private async ensureBaseline(): Promise<void> {
    const existing = await this.pool.query<{ total: number }>(
      'SELECT count(*)::int AS total FROM trusted_registry_revision',
    );
    if ((existing.rows[0]?.total ?? 0) > 0) return;

    const snapshot: TrustedRegistrySnapshot = await this.reader.snapshot();
    if (snapshot.entries.length === 0) return;
    const entries = [...snapshot.entries].sort();
    await this.pool.query(
      `INSERT INTO trusted_registry_revision (version, content_hash, entries, note, created_by)
       VALUES (1, $1, $2::jsonb, $3, 'system')
       ON CONFLICT (version) DO NOTHING`,
      [
        trustedRegistryContentHash(entries),
        JSON.stringify(entries),
        snapshot.origin === 'configuration'
          ? 'Shipped default, taken from SEAMNEX_TRUSTED_REGISTRIES at first boot (NFR-4.16).'
          : 'Shipped default from packages/db/src/seed/trusted-registries.json (NFR-4.16).',
      ],
    );
    this.reader.invalidate();
  }
}

function stringEntries(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

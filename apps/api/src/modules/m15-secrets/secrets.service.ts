import { Inject, Injectable } from '@nestjs/common';
import { withTransaction, type Queryable, type SecretVersionRow } from '@seamnex/db';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { METRICS } from '../../common/metrics/metrics';
import type { Metrics } from '../../common/metrics/metrics';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import type { SecretMetadata, SecretOwner, SecretScope, SecretsService } from './secrets.contract';
import { aadFor, loadRootKey, open as openSealed, seal, type RootKey } from './envelope';
import { MASK } from '../../common/logging/masking';

/**
 * Mask by default (exit criterion 7). Three properties make that credible:
 *   1. no method returns a value except `open`, and `open` writes `secret.read` first;
 *   2. the value never enters an error message — failures are coded, not descriptive;
 *   3. the root key is loaded lazily, so a role that never touches a secret does not need the file.
 */
@Injectable()
export class EnvelopeSecretsService implements SecretsService {
  private cachedRootKey: RootKey | undefined;

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  private rootKey(): RootKey {
    this.cachedRootKey ??= loadRootKey(this.config.SEAMNEX_ROOT_KEY_FILE, {
      strictMode: this.config.SEAMNEX_ROOT_KEY_STRICT_MODE,
    });
    return this.cachedRootKey;
  }

  async put(
    scope: SecretScope,
    ownerId: string,
    name: string,
    value: string,
    caller?: Queryable,
  ): Promise<SecretMetadata> {
    const plaintext = Buffer.from(value, 'utf8');
    try {
      const write = async (tx: Queryable): Promise<SecretMetadata> => {
        // Only the transaction that owns the chain lock takes it. A caller that already holds it
        // passes its handle and the write joins it; taking it twice on a second connection would
        // wait for a lock this very request is holding.
        if (caller === undefined) await this.audit.lockChain(tx);

        const secret = await tx.query<{ id: string }>(
          `INSERT INTO secret (scope, owner_id, name)
           VALUES ($1, $2, $3)
           ON CONFLICT (scope, owner_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [scope, ownerId, name],
        );
        const secretId = secret.rows[0]?.id;
        if (secretId === undefined) throw new Error('secret upsert returned no row');

        const version = await this.nextVersion(tx, secretId);
        const sealed = seal(plaintext, this.rootKey(), aadFor(secretId, version));

        await tx.query(
          `INSERT INTO secret_version (secret_id, version, dek_id, dek_wrapped, ciphertext, aad, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            secretId,
            version,
            sealed.dekId,
            sealed.dekWrapped,
            sealed.ciphertext,
            sealed.aad,
            this.config.SEAMNEX_ROLE,
          ],
        );

        // The write is audited in the same transaction: an unaudited secret store is not allowed.
        await this.audit.append(
          {
            action: 'secret.write',
            actorType: 'service',
            actorId: this.config.SEAMNEX_ROLE,
            targetType: 'secret',
            targetId: secretId,
            outcome: 'success',
            detail: { scope, ownerId, name, version },
          },
          tx,
        );

        return { id: secretId, scope, ownerId, name, version, masked: MASK };
      };

      return caller === undefined ? await withTransaction(this.pool, write) : await write(caller);
    } finally {
      plaintext.fill(0);
    }
  }

  async rotate(
    secretId: string,
    value: string,
    expected?: SecretOwner,
    caller?: Queryable,
  ): Promise<SecretMetadata> {
    const plaintext = Buffer.from(value, 'utf8');
    try {
      const write = async (tx: Queryable): Promise<SecretMetadata> => {
        // Same rule as `put`: the caller that already holds the chain lock supplies its handle.
        if (caller === undefined) await this.audit.lockChain(tx);

        // `FOR UPDATE` serialises two rotations of the same secret, so `MAX(version) + 1` cannot
        // collide on the (secret_id, version) key and surface as a raw driver error.
        const secret = await tx.query<{ scope: SecretScope; owner_id: string; name: string }>(
          'SELECT scope, owner_id, name FROM secret WHERE id = $1 FOR UPDATE',
          [secretId],
        );
        const row = secret.rows[0];
        if (row === undefined)
          throw new AppError({ code: 'SECRET_NOT_FOUND', detail: 'No such secret.', status: 404 });

        await this.refuseUnlessOwned(secretId, 'secret.rotate', row, expected);

        const version = await this.nextVersion(tx, secretId);
        const sealed = seal(plaintext, this.rootKey(), aadFor(secretId, version));
        await tx.query(
          `INSERT INTO secret_version (secret_id, version, dek_id, dek_wrapped, ciphertext, aad, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            secretId,
            version,
            sealed.dekId,
            sealed.dekWrapped,
            sealed.ciphertext,
            sealed.aad,
            this.config.SEAMNEX_ROLE,
          ],
        );

        await this.audit.append(
          {
            action: 'secret.rotate',
            actorType: 'service',
            actorId: this.config.SEAMNEX_ROLE,
            targetType: 'secret',
            targetId: secretId,
            outcome: 'success',
            detail: { scope: row.scope, name: row.name, version },
          },
          tx,
        );

        return {
          id: secretId,
          scope: row.scope,
          ownerId: row.owner_id,
          name: row.name,
          version,
          masked: MASK,
        };
      };

      return caller === undefined ? await withTransaction(this.pool, write) : await write(caller);
    } finally {
      plaintext.fill(0);
    }
  }

  async open(secretId: string, reason: string, expected?: SecretOwner): Promise<string> {
    return withTransaction(this.pool, async (tx) => {
      // One statement: the version plus the owner it must be checked against. Two queries would be
      // a second round trip on every read of a per-user product password, and the owner is on the
      // row the version already points at.
      const result = await tx.query<SecretVersionRow & { scope: SecretScope; owner_id: string }>(
        `SELECT v.id, v.secret_id, v.version, v.dek_id, v.dek_wrapped, v.ciphertext, v.aad,
                v.rotated_at, v.created_by, s.scope, s.owner_id
           FROM secret_version v
           JOIN secret s ON s.id = v.secret_id
          WHERE v.secret_id = $1
          ORDER BY v.version DESC
          LIMIT 1`,
        [secretId],
      );
      const row = result.rows[0];
      if (row === undefined)
        throw new AppError({ code: 'SECRET_NOT_FOUND', detail: 'No such secret.', status: 404 });

      /*
       * Refuse before decrypting, and record the refusal on its own connection: the throw below
       * rolls this transaction back, so a row appended inside it would never be committed. This is
       * the same shape the decrypt-failure path uses, and for the same reason.
       *
       * 404 rather than 403: the caller learns that it cannot open *this id*, not that the id
       * exists under another owner.
       */
      if (
        expected !== undefined &&
        (row.scope !== expected.scope || row.owner_id !== expected.ownerId)
      ) {
        await this.audit
          .append({
            action: 'secret.read',
            actorType: 'service',
            actorId: this.config.SEAMNEX_ROLE,
            targetType: 'secret',
            targetId: secretId,
            outcome: 'failure',
            detail: { reason, error: 'SCOPE_MISMATCH' },
          })
          .catch(() => undefined);
        throw new AppError({ code: 'SECRET_NOT_FOUND', detail: 'No such secret.', status: 404 });
      }

      let plaintext: Buffer;
      try {
        plaintext = openSealed(
          {
            dekId: row.dek_id,
            dekWrapped: row.dek_wrapped,
            ciphertext: row.ciphertext,
            // The AAD is *recomputed* from the row identity, never read from `row.aad`: reading it
            // back would let a writer move ciphertext, AAD and wrapped DEK together and still pass
            // the GCM tag, which is exactly what the AAD binding exists to prevent.
            aad: aadFor(row.secret_id, row.version),
          },
          this.rootKey(),
        );
      } catch (error) {
        // A failed decrypt must leave a trace. It cannot use this transaction — the failure rolls
        // it back — so the denial is appended on its own.
        await this.audit
          .append({
            action: 'secret.read',
            actorType: 'service',
            actorId: this.config.SEAMNEX_ROLE,
            targetType: 'secret',
            targetId: secretId,
            outcome: 'failure',
            detail: { reason, version: row.version, error: 'SECRET_UNAVAILABLE' },
          })
          .catch(() => undefined);
        throw error;
      }

      // Only a successful open is chained inside the caller's transaction, so the read is audited
      // before the plaintext can escape: if this append fails, the whole open is refused.
      await this.audit.append(
        {
          action: 'secret.read',
          actorType: 'service',
          actorId: this.config.SEAMNEX_ROLE,
          targetType: 'secret',
          targetId: secretId,
          outcome: 'success',
          detail: { reason, version: row.version },
        },
        tx,
      );

      this.metrics.secretsDecrypted.labels('managed').inc();
      try {
        return plaintext.toString('utf8');
      } finally {
        plaintext.fill(0);
      }
    });
  }

  async remove(secretId: string, reason: string, expected?: SecretOwner): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      /*
       * The row is read before it is deleted, because the assertion has to happen before the write:
       * a drifted `secret_ref` must not delete another scope's secret even once, and a refusal has
       * nothing to roll back. `FOR UPDATE` keeps a concurrent rotation from slipping in between.
       */
      const found = await tx.query<{ scope: SecretScope; owner_id: string; name: string }>(
        'SELECT scope, owner_id, name FROM secret WHERE id = $1 FOR UPDATE',
        [secretId],
      );
      const foundRow = found.rows[0];
      // Deleting a secret twice is not an error: offboarding is retried by design, and the second
      // run has nothing left to do.
      if (foundRow === undefined) return;
      await this.refuseUnlessOwned(secretId, 'secret.delete', foundRow, expected);

      const deleted = await tx.query<{ scope: SecretScope; owner_id: string; name: string }>(
        `DELETE FROM secret WHERE id = $1 RETURNING scope, owner_id, name`,
        [secretId],
      );
      const row = deleted.rows[0] ?? foundRow;
      await this.audit.append(
        {
          action: 'secret.delete',
          actorType: 'service',
          actorId: this.config.SEAMNEX_ROLE,
          targetType: 'secret',
          targetId: secretId,
          outcome: 'success',
          // The value is gone with the row; only what was deleted is recorded, never what it held.
          detail: { reason, scope: row.scope, name: row.name },
        },
        tx,
      );
    });
  }

  async describe(secretId: string): Promise<SecretMetadata> {
    const result = await this.pool.query<{
      id: string;
      scope: SecretScope;
      owner_id: string;
      name: string;
      version: number | null;
    }>(
      `SELECT s.id, s.scope, s.owner_id, s.name, MAX(v.version) AS version
         FROM secret s
         LEFT JOIN secret_version v ON v.secret_id = s.id
        WHERE s.id = $1
        GROUP BY s.id, s.scope, s.owner_id, s.name`,
      [secretId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new AppError({ code: 'SECRET_NOT_FOUND', detail: 'No such secret.', status: 404 });

    return {
      id: row.id,
      scope: row.scope,
      ownerId: row.owner_id,
      name: row.name,
      version: row.version ?? 0,
      masked: MASK,
    };
  }

  async find(scope: SecretScope, ownerId: string, name: string): Promise<SecretMetadata | null> {
    const result = await this.pool.query<{
      id: string;
      scope: SecretScope;
      owner_id: string;
      name: string;
      version: number | null;
    }>(
      `SELECT s.id, s.scope, s.owner_id, s.name, MAX(v.version) AS version
         FROM secret s
         LEFT JOIN secret_version v ON v.secret_id = s.id
        WHERE s.scope = $1 AND s.owner_id = $2 AND s.name = $3
        GROUP BY s.id, s.scope, s.owner_id, s.name`,
      [scope, ownerId, name],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    return {
      id: row.id,
      scope: row.scope,
      ownerId: row.owner_id,
      name: row.name,
      version: row.version ?? 0,
      masked: MASK,
    };
  }

  /**
   * Refuses a write aimed at a secret the caller does not own, and records the refusal.
   *
   * The three verbs that touch an existing secret — `open`, `rotate`, `remove` — take the same
   * assertion for the same reason: a scope is a namespace, not an authorization boundary, so an id
   * alone would address any scope's value (ADR-BE-22). `rotate` and `remove` are the destructive
   * pair; `open` refuses before decrypting, this refuses before writing.
   *
   * The refusal is appended on its own connection because the throw rolls the caller's transaction
   * back — a row appended inside it would never be committed. 404 rather than 403: the caller learns
   * that it cannot write *this id*, not that the id exists under another owner.
   */
  private async refuseUnlessOwned(
    secretId: string,
    action: 'secret.rotate' | 'secret.delete',
    row: { readonly scope: SecretScope; readonly owner_id: string },
    expected: SecretOwner | undefined,
  ): Promise<void> {
    if (expected === undefined) return;
    if (row.scope === expected.scope && row.owner_id === expected.ownerId) return;

    await this.audit
      .append({
        action,
        actorType: 'service',
        actorId: this.config.SEAMNEX_ROLE,
        targetType: 'secret',
        targetId: secretId,
        outcome: 'failure',
        detail: { error: 'SCOPE_MISMATCH', expectedScope: expected.scope },
      })
      .catch(() => undefined);
    throw new AppError({ code: 'SECRET_NOT_FOUND', detail: 'No such secret.', status: 404 });
  }

  private async nextVersion(tx: { query: Pool['query'] }, secretId: string): Promise<number> {
    const result = await tx.query<{ next: number }>(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM secret_version WHERE secret_id = $1',
      [secretId],
    );
    return result.rows[0]?.next ?? 1;
  }
}

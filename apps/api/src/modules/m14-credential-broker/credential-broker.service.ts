import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  workflowIneligibilityReason,
  writeIneligibilityReason,
  type CredentialGranularity,
  type CredentialScope,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import type { CredentialBrokerService, VerifiedScope } from './credential-broker.contract';

const NINETY_DAYS = 90 * 24 * 60 * 60;

/**
 * 4E.3 - the credential broker.
 *
 * Three rules the table cannot express alone:
 *   - a scope is bounded by the **workflow version** that requested it; republishing a workflow does
 *     not silently extend an old token's meaning;
 *   - a scope is bounded by the **declared credential granularity** (FR-2.14, C-11). `write` requires
 *     `scoped`; `none` permits nothing at all, because the product exposes no API credential to
 *     broker. The refusal is stated here *and* enforced by invariant 4, which is what makes it true
 *     for a writer that does not come through this interface;
 *   - the token is stored in M15 and only `secret_ref` reaches `credential_scope`, so a database copy
 *     yields no usable credential.
 */
@Injectable()
export class BrokeredCredentialService implements CredentialBrokerService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
  ) {}

  async mint(input: {
    instanceId: string;
    workflowId: string;
    operations: readonly string[];
    mode: 'read' | 'write';
    ttlSeconds: number;
    idempotencyKey?: string;
  }): Promise<{
    scopeId: string;
    secretRef: string;
    token: string;
    expiresAt: string;
    mode: 'read' | 'write';
    operations: string[];
  }> {
    /*
     * Re-activation of an unchanged version must not mint a second live token: the caller keys the
     * request by version and entry, and the token already handed to n8n stays valid. The plaintext is
     * therefore *opened* from the secret store on that path — the same value, audited as a read —
     * rather than generated again and left as an orphaned credential in n8n.
     */
    const existing = await this.existingScope(input);
    if (existing !== null) {
      const token = await this.secrets.open(
        existing.secret_ref,
        'workflow egress token reused on re-activation',
        {
          scope: 'workflow',
          ownerId: input.workflowId,
        },
      );
      /*
       * Reuse is conditional on the row still owning the value behind its own `secret_ref`. A row
       * whose digest was minted from a token its secret no longer holds is how a shared secret row
       * hands one product another product's credential — the read scope that would have received the
       * write token. Falling through mints a token and repoints the row instead.
       */
      if (tokenDigest(token) === existing.token_hash) {
        return {
          scopeId: existing.id,
          secretRef: existing.secret_ref,
          token,
          expiresAt: existing.expires_at.toISOString(),
          mode: existing.mode as 'read' | 'write',
          operations: [...existing.operations],
        };
      }
    }

    const granularity = await this.granularity(input.instanceId);
    // FR-5.3: "where a product cannot issue scoped credentials, the workflow shall be limited to
    // read operations". `account` is refused for writes for the same reason `none` is — an
    // account-wide credential cannot be bounded to the operation the node claims to perform.
    const refusal =
      input.mode === 'write'
        ? writeIneligibilityReason(granularity)
        : workflowIneligibilityReason(granularity);
    if (refusal !== null) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: refusal,
        // FR-2.14 — the brokered-mode remediation used to end with "(FR-2.14)". Remediation text
        // is rendered to operators, so the id stays here.
        remediation:
          input.mode === 'write' && granularity === 'account'
            ? 'Use a read-only operation, or ask the product owner to expose per-operation credentials.'
            : 'Target a product that exposes an API credential, or record a verified granularity for this one.',
      });
    }
    const ttl = Math.min(Math.max(input.ttlSeconds, 60), NINETY_DAYS);
    const versionId = await this.currentVersionId(input.workflowId);
    const secret = `seamnex_${cryptoRandom()}`;
    const secretDigest = tokenDigest(secret);
    const stored = await this.secrets.put(
      'workflow',
      input.workflowId,
      `scope_${stored_key(input.idempotencyKey)}`,
      secret,
    );

    const scopeId = await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO credential_scope
           (instance_id, workflow_id, version_id, operations, mode, secret_ref, token_hash, expires_at, idempotency_key)
         VALUES ($1, $2, $3, $4::text[], $5, $6, $7, now() + ($8 || ' seconds')::interval, $9)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          input.instanceId,
          input.workflowId,
          versionId,
          [...input.operations],
          input.mode,
          stored.id,
          secretDigest,
          String(ttl),
          input.idempotencyKey ?? null,
        ],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        const existing = await tx.query<{ id: string }>(
          `SELECT id FROM credential_scope WHERE idempotency_key = $1 AND workflow_id = $2`,
          [input.idempotencyKey ?? null, input.workflowId],
        );
        const found = existing.rows[0]?.id;
        if (found === undefined)
          throw new AppError({
            code: 'INTERNAL_ERROR',
            detail: 'The credential scope was not created.',
          });
        return found;
      }
      await this.audit.append(
        {
          action: 'credential.scope.minted',
          actorType: 'service',
          actorId: 'broker-proxy',
          targetType: 'credential_scope',
          targetId: id,
          outcome: 'success',
          detail: {
            instanceId: input.instanceId,
            workflowId: input.workflowId,
            mode: input.mode,
            operations: input.operations,
            ttl,
          },
        },
        tx,
      );
      return id;
    });

    const row = await this.pool.query<{
      secret_ref: string;
      token_hash: string | null;
      expires_at: Date;
    }>(`SELECT secret_ref, token_hash, expires_at FROM credential_scope WHERE id = $1`, [scopeId]);
    const settled = row.rows[0];
    /*
     * The token returned here is the one n8n will carry, so it has to be the one the row honours. Two
     * things can make that untrue after the transaction commits: a concurrent activation won the
     * insert, or the row's `secret_ref` holds a value its `token_hash` was not minted from. The first
     * is the reason the winner's token is opened rather than invented — a freshly generated value
     * would write a credential no scope recognises. The second is the shared-secret state, and there
     * the row is repointed at this mint's token instead.
     */
    let token = secret;
    let secretRef = stored.id;
    if (settled !== undefined && settled.token_hash !== secretDigest) {
      const held = await this.secrets.open(
        settled.secret_ref,
        'workflow egress token reused on re-activation',
        {
          scope: 'workflow',
          ownerId: input.workflowId,
        },
      );
      if (tokenDigest(held) === settled.token_hash) {
        token = held;
        secretRef = settled.secret_ref;
      } else {
        await this.repoint(scopeId, stored.id, secretDigest);
      }
    }
    return {
      scopeId,
      secretRef,
      token,
      expiresAt: (settled?.expires_at ?? new Date(Date.now() + ttl * 1_000)).toISOString(),
      mode: input.mode,
      operations: [...input.operations],
    };
  }

  /**
   * Points an existing scope at a secret this call minted, and says so in the audit log.
   *
   * Its own transaction, deliberately: the caller decides by opening the current secret, and
   * `SecretsService.open` takes the audit chain lock on another connection. Doing the same inside the
   * mint transaction would wait for a lock the caller already holds — the self-deadlock `put()`
   * documents — and only end when `statement_timeout` fires.
   */
  private async repoint(scopeId: string, secretRef: string, tokenHash: string): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await tx.query(`UPDATE credential_scope SET secret_ref = $2, token_hash = $3 WHERE id = $1`, [
        scopeId,
        secretRef,
        tokenHash,
      ]);
      await this.audit.append(
        {
          action: 'credential.scope.rotated',
          actorType: 'service',
          actorId: 'broker-proxy',
          targetType: 'credential_scope',
          targetId: scopeId,
          outcome: 'success',
          detail: { secretRef, storedTokenMismatchedDigest: true },
        },
        tx,
      );
    });
  }

  /**
   * The scope this version already minted for this entry, if any — the token it holds stays the one
   * n8n carries, so a re-activation is a repoint and not a second live credential. `token_hash` comes
   * along because reuse is only safe when the secret still holds the value it was minted from.
   */
  private async existingScope(input: {
    instanceId: string;
    workflowId: string;
    idempotencyKey?: string;
  }): Promise<{
    id: string;
    secret_ref: string;
    token_hash: string | null;
    expires_at: Date;
    mode: string;
    operations: string[];
  } | null> {
    if (input.idempotencyKey === undefined) return null;
    const result = await this.pool.query<{
      id: string;
      secret_ref: string;
      token_hash: string | null;
      expires_at: Date;
      mode: string;
      operations: string[];
    }>(
      `SELECT id, secret_ref, token_hash, expires_at, mode, operations
         FROM credential_scope
        WHERE idempotency_key = $1 AND workflow_id = $2 AND instance_id = $3
          AND revoked_at IS NULL AND expires_at > now()`,
      [input.idempotencyKey, input.workflowId, input.instanceId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The scope behind a token the broker was handed.
   *
   * The digest is the index (migration 0027) and the version join is the bound: a token outlives its
   * version only until the next activation, whatever its `expires_at` says.
   */
  async verifyToken(token: string): Promise<VerifiedScope | null> {
    if (!token.startsWith('seamnex_')) return null;
    const result = await this.pool.query<{
      id: string;
      instance_id: string;
      workflow_id: string;
      version_id: string | null;
      operations: string[];
      mode: string;
      expires_at: Date;
    }>(
      `SELECT s.id, s.instance_id, s.workflow_id, s.version_id, s.operations, s.mode, s.expires_at
         FROM credential_scope s
         JOIN workflow w ON w.id = s.workflow_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND (s.version_id IS NULL OR s.version_id = w.current_version_id)`,
      [tokenDigest(token)],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      scopeId: row.id,
      instanceId: row.instance_id,
      workflowId: row.workflow_id,
      versionId: row.version_id,
      operations: row.operations,
      mode: row.mode === 'write' ? 'write' : 'read',
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /** Revocation is immediate and audited; the secret itself is left to M15's retention rules. */
  async revoke(scopeId: string, actorId = 'platform'): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      const result = await tx.query(
        `UPDATE credential_scope SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
        [scopeId],
      );
      if (result.rowCount === 0) {
        throw new AppError({
          code: 'NOT_FOUND',
          detail: `No live credential scope ${scopeId}.`,
          remediation: 'Refresh the scope list.',
        });
      }
      await this.audit.append(
        {
          action: 'credential.scope.revoked',
          actorType: 'user',
          actorId,
          targetType: 'credential_scope',
          targetId: scopeId,
          outcome: 'success',
        },
        tx,
      );
    });
  }

  async list(instanceId: string): Promise<CredentialScope[]> {
    const result = await this.pool.query<{
      id: string;
      instance_id: string;
      operations: string[];
      mode: string;
      issued_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, instance_id, operations, mode, issued_at, expires_at, revoked_at
         FROM credential_scope WHERE instance_id = $1 ORDER BY issued_at DESC`,
      [instanceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      instanceId: row.instance_id,
      product: instanceId,
      operations: row.operations,
      mode: row.mode as CredentialScope['mode'],
      issuedAt: row.issued_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      revokedAt: row.revoked_at?.toISOString() ?? null,
      brokered: true,
    }));
  }

  /**
   * The declared fact, resolved by the database's own resolver (migration 0017).
   *
   * `integration_metadata` is a per-instance table whose columns are snake_case — the previous query
   * read `m.payload->>'credentialGranularity'`, a JSONB column that `integration_metadata` never had,
   * so it failed outright and the gate above never saw a value. Calling `seamnex_effective_granularity`
   * instead of re-implementing the join means the application and invariant 4 cannot disagree about
   * which of the two records (per-instance verification, entry-level catalog document) wins.
   */
  private async granularity(instanceId: string): Promise<CredentialGranularity> {
    const result = await this.pool.query<{ granularity: string | null }>(
      `SELECT seamnex_effective_granularity($1) AS granularity`,
      [instanceId],
    );
    const value = result.rows[0]?.granularity;
    return value === 'scoped' || value === 'account' || value === 'none' ? value : 'none';
  }

  private async currentVersionId(workflowId: string): Promise<string | null> {
    const result = await this.pool.query<{ current_version_id: string | null }>(
      `SELECT current_version_id FROM workflow WHERE id = $1`,
      [workflowId],
    );
    return result.rows[0]?.current_version_id ?? null;
  }
}

/** SHA-256 of a broker token: the only form `credential_scope.token_hash` ever holds. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function cryptoRandom(): string {
  return Array.from({ length: 24 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
}

/**
 * The M15 secret name for one idempotency key.
 *
 * A digest of the whole key, not its first 32 characters. The key is
 * `<workflow id>:<entry key>:<mode>`, and a workflow id is a 36-character UUID, so a prefix kept
 * nothing but the workflow — every product a workflow touches was filed under one name. `put` upserts
 * `secret` on `(scope, owner_id, name)`, so the second product's mint wrote a new *version of the
 * first product's secret* and destroyed the token n8n was already carrying for it. Each product now
 * gets its own row, while a retried activation still derives the same name it derived last time.
 */
function stored_key(key: string | undefined): string {
  return key === undefined
    ? 'default'
    : createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 32);
}

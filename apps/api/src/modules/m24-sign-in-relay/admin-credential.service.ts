import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { withTransaction } from '@seamnex/db';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { ProductApiAdapters } from './provisioning-adapters';
import type {
  AdminCredentialActor,
  AdminCredentialService,
  AdminCredentialView,
} from './relay.contract';

/**
 * ADR-BE-22 §Credentials — the operator's half of the provisioning credential.
 *
 * Why this exists at all: the sweep can read a `password` product's administrator login from the
 * instance's own variables, but OpenProject's `/api/v3` accepts only a personal access token, and a
 * token can be minted only inside an authenticated session. So the token has to come from somewhere,
 * and there are exactly two sources: the operator pastes one, or the sweep derives one from the seed
 * administrator the deploy itself created (see `openproject-admin-token.ts`). Both paths end here,
 * because this is the only writer of the secret the sweep reads.
 *
 * The distinction is recorded, not flattened: the audit row carries the actor type, so an operator
 * paste and a derived token are two different facts in the chain.
 *
 * Three rules are load-bearing:
 *
 *   * **The value is write-only.** No method returns it, no log line carries it, and the audit row
 *     records the version, not the token. `status` answers configured/version only.
 *   * **One name, one entry shape.** The secret is the configured `SEAMNEX_RELAY_ADMIN_SECRET_NAME`
 *     in the `instance` scope, and only an entry whose provisioning adapter takes a bearer token may
 *     write it. This is not a general secret-writing API: a route that accepted any name would let a
 *     caller overwrite the instance's database password or an IdP client secret.
 *   * **The write is fail-closed.** The secret version and the operator's audit row share one
 *     transaction and one chain lock, so a successful response means both landed.
 */
@Injectable()
export class PostgresAdminCredentialService implements AdminCredentialService {
  private readonly logger = new Logger('m24-admin-credential');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(ProductApiAdapters) private readonly adapters: ProductApiAdapters,
  ) {}

  async status(instanceId: string): Promise<AdminCredentialView> {
    const entryKey = await this.entryKeyOf(instanceId);
    const kind = this.kindFor(entryKey);
    const name = this.config.SEAMNEX_RELAY_ADMIN_SECRET_NAME;
    if (kind !== 'bearer') {
      // No lookup for the other two shapes: a token stored under this name would not be read by the
      // sweep, and reporting it as the credential would describe a product that does not use one.
      return { kind, required: false, configured: false, name, version: null };
    }
    const stored = await this.secrets.find('instance', instanceId, name);
    return {
      kind,
      required: true,
      configured: stored !== null,
      name,
      version: stored?.version ?? null,
    };
  }

  async store(
    instanceId: string,
    token: string,
    actor: AdminCredentialActor,
  ): Promise<AdminCredentialView> {
    const entryKey = await this.entryKeyOf(instanceId);
    const kind = this.kindFor(entryKey);
    const name = this.config.SEAMNEX_RELAY_ADMIN_SECRET_NAME;

    if (kind === 'none') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `${entryKey} registers no provisioning adapter, so there is nothing to authenticate.`,
        remediation:
          'Create this product’s relay accounts by hand; a token would not be read by anything.',
      });
    }
    if (kind === 'password') {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `${entryKey} provisions with its administrator login, not an API token.`,
        remediation:
          'Change the administrator variables the entry declares; no token is stored for this product.',
      });
    }

    const value = token.trim();
    if (value.length === 0) {
      // The request schema refuses an empty value; this is the service's own guarantee, because the
      // store would otherwise accept a blank version and every product call would answer 401.
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'The token is empty.',
        remediation: 'Paste the token the product issued, without surrounding whitespace.',
      });
    }

    let version = 0;
    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      // `put` upserts on (scope, owner, name) and appends a version, so a replacement keeps the
      // history rather than overwriting it. `tx` joins this transaction, which already holds the
      // chain lock.
      const stored = await this.secrets.put('instance', instanceId, name, value, tx);
      version = stored.version;
      await this.audit.append(
        {
          action: 'instance.admin_credential.updated',
          actorType: actor.type,
          actorId: actor.id,
          targetType: 'instance',
          targetId: instanceId,
          outcome: 'success',
          // The token is not named, quoted or fingerprinted here. The version is what an operator
          // needs to correlate the row with the store.
          detail: { entryKey, name, version },
        },
        tx,
      );
    });

    this.logger.log(
      { instanceId, entryKey, name, version, actorType: actor.type, actorId: actor.id },
      'product administrator token stored for relay provisioning',
    );

    return {
      kind,
      required: true,
      configured: true,
      name,
      version,
    };
  }

  /** The entry key of a live instance, or a 404 that names what was asked for. */
  private async entryKeyOf(instanceId: string): Promise<string> {
    const result = await this.pool.query<{ entry_key: string }>(
      `SELECT entry_key FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        status: 404,
        detail: 'No such instance.',
        remediation: 'Check the identifier; a deleted instance is not readable.',
      });
    }
    return row.entry_key;
  }

  /** How this entry provisions, via the same registry the sweep uses. */
  private kindFor(entryKey: string): AdminCredentialView['kind'] {
    return this.adapters.for(entryKey)?.credentialKind ?? 'none';
  }
}

import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SERVICE_SCOPES, isServiceScope, type Capability } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import type { MachineClientAuthenticator, MachinePrincipal } from './access-control.contract';

type CachedPrincipal = { principal: MachinePrincipal | null; at: number };

/** A token is looked up at most this often per process; revocation therefore takes ≤ 60 s. */
const CACHE_TTL_MS = 60_000;
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Machine clients are rows, not environment tokens (deliverable 3.4).
 *
 * `machine_client` stores only a SHA-256 hash of the bearer token, so a database read cannot
 * impersonate a client. The scope column names a closed set (`registry.read`, `audit.read`);
 * the PDP turns that into capabilities and never consults a human role.
 */
@Injectable()
export class MachineClientService implements MachineClientAuthenticator {
  private readonly logger = new Logger('machine-client');
  private readonly cache = new Map<string, CachedPrincipal>();
  private readonly lastUsedWrites = new Map<string, number>();

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async authenticate(token: string): Promise<MachinePrincipal | null> {
    if (token.length < 32 || token.length > 512) return null;
    const hash = hashToken(token);

    const cached = this.cache.get(hash);
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.principal;

    const result = await this.pool.query<{
      id: string;
      name: string;
      scope: string;
      enabled: boolean;
      last_used_at: Date | null;
    }>(`SELECT id, name, scope, enabled, last_used_at FROM machine_client WHERE token_hash = $1`, [
      hash,
    ]);
    const row = result.rows[0];
    const principal: MachinePrincipal | null =
      row === undefined || !row.enabled
        ? null
        : {
            id: row.id,
            name: row.name,
            scopes: isServiceScope(row.scope)
              ? (SERVICE_SCOPES[row.scope] as readonly Capability[])
              : [],
          };

    this.cache.set(hash, { principal, at: Date.now() });
    if (principal !== null) this.markUsed(principal.id, row?.last_used_at ?? null);
    return principal;
  }

  private markUsed(id: string, lastUsedAt: Date | null): void {
    const last = this.lastUsedWrites.get(id) ?? lastUsedAt?.getTime() ?? 0;
    if (Date.now() - last < LAST_USED_THROTTLE_MS) return;
    this.lastUsedWrites.set(id, Date.now());
    void this.pool
      .query(`UPDATE machine_client SET last_used_at = now() WHERE id = $1`, [id])
      .catch((error: unknown) => {
        this.logger.warn(`machine client last_used_at not written (${String(error)})`);
      });
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

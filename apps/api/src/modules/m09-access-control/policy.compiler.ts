import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { CAPABILITY_MATRIX, POLICY_KEYS, SERVICE_SCOPES } from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';

export type CompiledPolicy = {
  readonly version: number;
  readonly sourceHash: string;
};

/**
 * ADR-BE-05: compile the capability matrix at boot, version it, and never transcribe it.
 *
 * The source hash covers the matrix, the route→capability table and the machine scopes. An unchanged
 * source reuses the stored version, so a redeploy does not mint a row and a decision stays
 * attributable to the policy that produced it. A malformed matrix fails the boot: the alternative
 * is failing open at the first request.
 */
@Injectable()
export class PolicyCompiler implements OnApplicationBootstrap {
  private readonly logger = new Logger('policy');
  private active: CompiledPolicy | undefined;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.compile();
  }

  /** The active version. A caller before boot is a programming error, not a user condition. */
  get activeVersion(): number {
    if (this.active === undefined) throw new Error('policy has not been compiled');
    return this.active.version;
  }

  get sourceHash(): string {
    if (this.active === undefined) throw new Error('policy has not been compiled');
    return this.active.sourceHash;
  }

  async compile(): Promise<CompiledPolicy> {
    const sourceHash = compileHash();
    const snapshot = {
      capabilityMatrix: CAPABILITY_MATRIX,
      policyKeys: POLICY_KEYS,
      serviceScopes: SERVICE_SCOPES,
      sourceHash,
    };

    const compiled = await withTransaction(this.pool, async (tx) => {
      // Serialise concurrent boots (every process role compiles); the advisory lock is released
      // with the transaction, so a crash cannot leave policy pinned.
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('seamnex.policy_version'))`);

      const existing = await tx.query<{ version: number }>(
        `SELECT version FROM policy_version WHERE source_hash = $1`,
        [sourceHash],
      );
      const found = existing.rows[0];

      if (found !== undefined) {
        const active = await tx.query<{ is_active: boolean }>(
          `SELECT is_active FROM policy_version WHERE version = $1`,
          [found.version],
        );
        if (active.rows[0]?.is_active !== true) await activate(tx, found.version);
        return { version: found.version, sourceHash };
      }

      await tx.query(`UPDATE policy_version SET is_active = false WHERE is_active`);
      const inserted = await tx.query<{ version: number }>(
        `INSERT INTO policy_version (version, matrix, is_active, source_hash)
         VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM policy_version), $1::jsonb, true, $2)
         RETURNING version`,
        [JSON.stringify(snapshot), sourceHash],
      );
      const version = inserted.rows[0]?.version;
      if (version === undefined) throw new Error('policy_version insert returned no row');
      return { version, sourceHash };
    });

    this.active = compiled;
    this.logger.log({
      msg: 'policy compiled',
      version: compiled.version,
      sourceHash: compiled.sourceHash.slice(0, 16),
      capabilities: Object.keys(CAPABILITY_MATRIX).length,
      operations: Object.keys(POLICY_KEYS).length,
    });
    return compiled;
  }
}

async function activate(
  tx: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  version: number,
): Promise<void> {
  await tx.query(`UPDATE policy_version SET is_active = false WHERE is_active`);
  await tx.query(`UPDATE policy_version SET is_active = true WHERE version = $1`, [version]);
}

/** Deterministic serialisation: the matrix is data, so the hash is stable across processes. */
export function compileHash(): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        capabilityMatrix: CAPABILITY_MATRIX,
        policyKeys: POLICY_KEYS,
        serviceScopes: SERVICE_SCOPES,
      }),
    )
    .digest('hex');
}

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createTestDatabase, skipUnlessDatabase, type TestDatabase } from '../helpers';

/**
 * Design §7.3 — every invariant the design says belongs to the database, proven by a write that
 * must fail. A test that only reads the DDL proves nothing: this suite performs the illegal write.
 */
let database: TestDatabase | undefined;
let pool: Pool;

beforeAll(async () => {
  if (!skipUnlessDatabase()) {
    database = await createTestDatabase();
    pool = database.pool;
  }
});

afterAll(async () => {
  await database?.drop();
});

/** Each suite runs in a fresh database, so a counter is enough to keep D-keys unique. */
let keyCounter = 100;
function nextKey(): string {
  keyCounter += 1;
  return `D${keyCounter}`;
}

async function instanceId(
  options: { state?: string; sourcePath?: string | null; slug?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const key = nextKey();
  await pool.query(
    `INSERT INTO catalog_entry (key, domain, product, guarantee_class, packaging)
     VALUES ($1, 'Core Operations', 'Test', 'native', 'compose')`,
    [key],
  );
  await pool.query(
    `INSERT INTO instance (id, entry_key, slug, domain_route, state, source_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      key,
      options.slug ?? `inst-${id.slice(0, 8)}`,
      `host-${id.slice(0, 8)}.test`,
      options.state ?? 'ready',
      options.sourcePath ?? 'compose',
    ],
  );
  return id;
}

describe.skipIf(skipUnlessDatabase() !== false)('design §7.3 invariants', () => {
  it('invariant 5: guarantee_class is NOT NULL at the database', async () => {
    await expect(
      pool.query(
        `INSERT INTO catalog_entry (key, domain, product, packaging) VALUES ('D999', 'x', 'y', 'compose')`,
      ),
    ).rejects.toThrow(/null value in column "guarantee_class"/);
  });

  it('invariant 3: two catalog entries may share one primary instance (D05-01/D06-01)', async () => {
    // Design §7.3.3: "D5 and D6 point at the same instance, which is how 13 entries become 12
    // deployments". The first version put a UNIQUE index on primary_instance_id, which made the
    // documented pair unwritable — the invariant was implemented backwards and the test asserted
    // the blow-up. This asserts the design.
    const shared = await instanceId();
    const [first, second] = [nextKey(), nextKey()];
    await pool.query(
      `INSERT INTO catalog_entry (key, domain, product, guarantee_class, packaging, primary_instance_id)
       VALUES ($1, 'x', 'y', 'native', 'compose', $3), ($2, 'x', 'y', 'native', 'compose', $3)`,
      [first, second, shared],
    );

    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM catalog_entry WHERE primary_instance_id = $1',
      [shared],
    );
    expect(result.rows[0]?.count).toBe('2');
  });

  it('invariant 2: a render set is immutable once applied', async () => {
    const id = await instanceId();
    const render = await pool.query<{ id: string }>(
      `INSERT INTO render_set (instance_id, content_hash) VALUES ($1, $2) RETURNING id`,
      [id, 'a'.repeat(64)],
    );
    const renderSetId = render.rows[0]?.id;

    await pool.query('UPDATE render_set SET applied_at = now() WHERE id = $1', [renderSetId]);
    await expect(
      pool.query(`UPDATE render_set SET content_hash = $1 WHERE id = $2`, [
        'b'.repeat(64),
        renderSetId,
      ]),
    ).rejects.toThrow(/immutable after applied_at/);
    await expect(pool.query('DELETE FROM render_set WHERE id = $1', [renderSetId])).rejects.toThrow(
      /immutable after applied_at/,
    );
  });

  it('invariant 8: break-glass mode is immutable and a grant cannot be extended', async () => {
    const id = await instanceId();
    const session = await pool.query<{ id: string }>(
      `INSERT INTO break_glass_session (requester, instance_id, access_mode, state, justification, approver, expires_at)
       VALUES ('requester', $1, 'read_only', 'approved', 'incident', 'approver', now() + interval '30 minutes')
       RETURNING id`,
      [id],
    );
    const sessionId = session.rows[0]?.id;

    await expect(
      pool.query(`UPDATE break_glass_session SET access_mode = 'read_write' WHERE id = $1`, [
        sessionId,
      ]),
    ).rejects.toThrow(/access_mode is immutable/);
    await expect(
      pool.query(
        `UPDATE break_glass_session SET expires_at = now() + interval '5 hours' WHERE id = $1`,
        [sessionId],
      ),
    ).rejects.toThrow(/cannot be extended/);
  });

  it('invariant 1: a deleted slug stays reserved for 30 days', async () => {
    const slug = `reserved-${randomUUID().slice(0, 8)}`;
    const id = await instanceId({ slug });
    await pool.query('UPDATE instance SET deleted_at = now() WHERE id = $1', [id]);

    const key = nextKey();
    await pool.query(
      `INSERT INTO catalog_entry (key, domain, product, guarantee_class, packaging)
       VALUES ($1, 'x', 'y', 'native', 'compose')`,
      [key],
    );
    await expect(
      pool.query(
        `INSERT INTO instance (id, entry_key, slug, domain_route, state)
         VALUES ($1, $2, $3, $4, 'requested')`,
        [randomUUID(), key, slug, `new-${slug}.test`],
      ),
    ).rejects.toThrow(/reserved for 30 days/);
  });

  it('invariant 4: a write credential scope is rejected when granularity is none', async () => {
    const id = await instanceId();
    await pool.query(
      `INSERT INTO integration_metadata (instance_id, entry_key, credential_granularity)
       SELECT $1, entry_key, 'none' FROM instance WHERE id = $1`,
      [id],
    );

    await expect(
      pool.query(
        `INSERT INTO credential_scope (instance_id, operations, mode, secret_ref, expires_at)
         VALUES ($1, ARRAY['write'], 'write', 'secret://x', now() + interval '90 days')`,
        [id],
      ),
    ).rejects.toThrow(/requires credential_granularity = 'scoped'/);
  });

  /**
   * FR-5.3 / C-11: only a *scoped* credential can bound a write to an operation. An account-wide
   * credential cannot, so `account` is write-ineligible — the rule used to allow it, which is the
   * single most consequential disagreement between the requirement and the schema.
   */
  it('invariant 4: a write scope is rejected when granularity is account-level', async () => {
    const id = await instanceId();
    await pool.query(
      `INSERT INTO integration_metadata (instance_id, entry_key, credential_granularity)
       SELECT $1, entry_key, 'account' FROM instance WHERE id = $1`,
      [id],
    );

    await expect(
      pool.query(
        `INSERT INTO credential_scope (instance_id, operations, mode, secret_ref, expires_at)
         VALUES ($1, ARRAY['write'], 'write', 'secret://x', now() + interval '90 days')`,
        [id],
      ),
    ).rejects.toThrow(/requires credential_granularity = 'scoped'/);

    // A read scope is still legitimate: the failure above is about the *width* of the credential.
    await expect(
      pool.query(
        `INSERT INTO credential_scope (instance_id, operations, mode, secret_ref, expires_at)
         VALUES ($1, ARRAY['read'], 'read', 'secret://y', now() + interval '90 days')`,
        [id],
      ),
    ).resolves.toBeDefined();
  });

  /**
   * The invariant has to hold after the fact, not only at insert time: recording a lower
   * granularity is exactly when a live write scope stops being defensible.
   */
  it('invariant 4: lowering the granularity revokes the live write scopes it invalidates', async () => {
    const id = await instanceId();
    await pool.query(
      `INSERT INTO integration_metadata (instance_id, entry_key, credential_granularity)
       SELECT $1, entry_key, 'scoped' FROM instance WHERE id = $1`,
      [id],
    );
    const scope = await pool.query<{ id: string }>(
      `INSERT INTO credential_scope (instance_id, operations, mode, secret_ref, expires_at)
       VALUES ($1, ARRAY['write'], 'write', 'secret://z', now() + interval '90 days')
       RETURNING id`,
      [id],
    );

    await pool.query(
      `UPDATE integration_metadata SET credential_granularity = 'none' WHERE instance_id = $1`,
      [id],
    );

    const after = await pool.query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM credential_scope WHERE id = $1`,
      [scope.rows[0]?.id],
    );
    expect(after.rows[0]?.revoked_at).not.toBeNull();
  });

  it('invariant 11: a Dockerfile instance cannot be backed up without its image artefact', async () => {
    const id = await instanceId({ sourcePath: 'dockerfile' });
    await expect(
      pool.query(`INSERT INTO backup (kind, instance_id) VALUES ('instance', $1)`, [id]),
    ).rejects.toThrow(/image_artefact_missing/);

    await pool.query(
      `INSERT INTO image_artefact (instance_id, image_digest, object_key)
       VALUES ($1, 'sha256:abc', 'artefacts/abc.tar')`,
      [id],
    );
    await expect(
      pool.query(`INSERT INTO backup (kind, instance_id) VALUES ('instance', $1)`, [id]),
    ).resolves.toBeDefined();
  });

  it('invariant 7: a backup cannot reference a render set that was never applied', async () => {
    const id = await instanceId();
    const render = await pool.query<{ id: string }>(
      `INSERT INTO render_set (instance_id, content_hash) VALUES ($1, $2) RETURNING id`,
      [id, 'c'.repeat(64)],
    );

    await expect(
      pool.query(
        `INSERT INTO backup (kind, instance_id, render_set_id) VALUES ('instance', $1, $2)`,
        [id, render.rows[0]?.id],
      ),
    ).rejects.toThrow(/never applied/);
  });

  it('invariant 12: sync_state=unsupported is legal only for a forward-auth gate', async () => {
    const id = await instanceId();
    await pool.query(
      `INSERT INTO instance_route (instance_id, host, publish_model, auth_mode)
       VALUES ($1, $2, 'subdomain', 'native')`,
      [id, `route-${id.slice(0, 8)}.test`],
    );

    await expect(
      pool.query(
        `INSERT INTO entitlement (subject_idp_id, instance_id, product_role, source, sync_state)
         VALUES ('subject', $1, 'user', 'group', 'unsupported')`,
        [id],
      ),
    ).rejects.toThrow(/only for an fa_gate instance/);
  });

  it('invariant 10: the sync loop cannot write a group mapping', async () => {
    const groupId = randomUUID();
    await pool.query(`INSERT INTO idp_group (idp_id, path) VALUES ($1, $2)`, [
      groupId,
      `/seamnex/${groupId}`,
    ]);

    const client = await pool.connect();
    try {
      await client.query(`SET seamnex.writer = 'identity-sync'`);
      await expect(
        client.query(
          `INSERT INTO group_mapping (group_idp_id, role, scope_type, propagate_to_product, created_by)
           VALUES ($1, 'R3', 'platform', true, 'sync')`,
          [groupId],
        ),
      ).rejects.toThrow(/never written by the sync loop/);
    } finally {
      await client.query('RESET seamnex.writer');
      client.release();
    }

    // An audited admin action on the same row is allowed.
    await expect(
      pool.query(
        `INSERT INTO group_mapping (group_idp_id, role, scope_type, propagate_to_product, created_by)
         VALUES ($1, 'R3', 'platform', true, 'admin')`,
        [groupId],
      ),
    ).resolves.toBeDefined();
  });

  it('bounds restore_concurrency to the design floor and ceiling (DD-15, AC-52)', async () => {
    await expect(
      pool.query(`UPDATE settings SET value = '13'::jsonb WHERE key = 'restore_concurrency'`),
    ).rejects.toThrow(/between 4 and 12/);
    await expect(
      pool.query(`UPDATE settings SET value = '3'::jsonb WHERE key = 'restore_concurrency'`),
    ).rejects.toThrow(/between 4 and 12/);
    await expect(
      pool.query(`UPDATE settings SET value = '8'::jsonb WHERE key = 'restore_concurrency'`),
    ).resolves.toBeDefined();
  });

  it('caps a native client at a 300 s token lifespan', async () => {
    const id = await instanceId();
    await pool.query(
      `INSERT INTO instance_route (instance_id, host, publish_model, auth_mode)
       VALUES ($1, $2, 'subdomain', 'native')`,
      [id, `native-${id.slice(0, 8)}.test`],
    );

    await expect(
      pool.query(
        `INSERT INTO idp_client (instance_id, client_id, client_secret_ref, protocol, access_token_lifespan_seconds)
         VALUES ($1, $2, 'secret://x', 'oidc', 600)`,
        [id, `client-${id.slice(0, 8)}`],
      ),
    ).rejects.toThrow(/300 s/);
  });
});

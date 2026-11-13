import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withAuditedMutation } from '@seamnex/db';
import {
  createTestDatabase,
  hasDatabase,
  skipUnlessDatabase,
  type TestDatabase,
} from '@seamnex/db/testing';
import type { EnvSchemaFile } from '@seamnex/domain';
import { AppModule } from '../../src/app.module';
import { JobService } from '../../src/jobs/job.service';
import { PG_POOL } from '../../src/database/database.module';
import { AUDIT_SERVICE, type AuditService } from '../../src/modules/m17-audit/audit.contract';
import {
  SECRETS_SERVICE,
  type SecretsService,
} from '../../src/modules/m15-secrets/secrets.contract';
import {
  RENDERER_SERVICE,
  type RendererService,
} from '../../src/modules/m03-renderer/renderer.contract';
import { SYNTHETIC_STEPS } from '../../src/jobs/synthetic-job';

/**
 * Integration coverage for the three cross-cutting mechanisms (audit, jobs, secrets).
 *
 * Gated on a real PostgreSQL and Redis: these are the exit criteria that cannot be proven by a
 * unit test, and a green unit suite must never be mistaken for them.
 *
 * Two isolation rules, both learned the hard way:
 *   - the database is a throwaway one created and dropped by this file, so a run cannot write to
 *     (or delete from) whatever `DATABASE_URL` happens to point at;
 *   - the root key is its own file under `temp/test/`, never `.env.example`'s `SEAMNEX_ROOT_KEY_FILE`,
 *     because overwriting that re-keys a developer's secret store and orphans every ciphertext.
 */
const redisUrl = process.env.REDIS_URL ?? '';
const canRun = hasDatabase && redisUrl.length > 0;
const skipReason = canRun
  ? false
  : hasDatabase
    ? 'Set REDIS_URL (pnpm dev:stack) to run the API integration suite.'
    : skipUnlessDatabase() || 'Set REDIS_URL to run the API integration suite.';

if (!canRun && process.env.SEAMNEX_REQUIRE_DATABASE_TESTS === '1') {
  throw new Error(
    `SEAMNEX_REQUIRE_DATABASE_TESTS=1 but the suite cannot run: ${String(skipReason)}`,
  );
}

let app: INestApplicationContext | undefined;
let database: TestDatabase | undefined;
let pool: Pool;
let jobs: JobService;
let audit: AuditService;
let secrets: SecretsService;

beforeAll(async () => {
  if (!canRun) return;

  // Always a fresh key: a stale short key from an earlier run would make the suite fail for a
  // reason that has nothing to do with the code under test. It lives under `temp/test/` so it
  // cannot collide with the development key.
  const rootKeyFile = resolve(process.cwd(), 'temp/test/seamnex-root-key');
  mkdirSync(dirname(rootKeyFile), { recursive: true });
  writeFileSync(rootKeyFile, `${randomBytes(32).toString('base64')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.env.SEAMNEX_ROOT_KEY_FILE = rootKeyFile;

  database = await createTestDatabase();
  process.env.DATABASE_URL = database.url;

  app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ['error'],
  });
  pool = app.get<Pool>(PG_POOL);
  jobs = app.get(JobService);
  audit = app.get<AuditService>(AUDIT_SERVICE);
  secrets = app.get<SecretsService>(SECRETS_SERVICE);
});

afterAll(async () => {
  if (!canRun) return;
  await jobs?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  await database?.drop();
});

/**
 * `payload.manual` keeps the deploy-worker out of the test: otherwise a developer running
 * `pnpm dev` alongside `pnpm test` would have two writers for the same job state machine.
 */
function manualJob(instanceId: string, extra: { idempotencyKey?: string } = {}) {
  return jobs.create({
    kind: 'synthetic',
    instanceId,
    steps: SYNTHETIC_STEPS,
    payload: { manual: true },
    ...extra,
  });
}

let instanceCounter = 0;

async function createInstance(): Promise<string> {
  const id = randomUUID();
  instanceCounter += 1;
  const key = `D${900 + instanceCounter}`;
  await pool.query(
    `INSERT INTO catalog_entry (key, domain, product, guarantee_class, packaging)
     VALUES ($1, 'Core Operations', 'Integration', 'native', 'compose')
     ON CONFLICT (key) DO NOTHING`,
    [key],
  );
  await pool.query(
    `INSERT INTO instance (id, entry_key, slug, domain_route, state, source_path)
     VALUES ($1, $2, $3, $4, 'ready', 'compose')`,
    [id, key, `it-${id.slice(0, 8)}`, `it-${id.slice(0, 8)}.test`],
  );
  return id;
}

describe.skipIf(skipReason !== false)('audit append point', () => {
  it('writes a chain that verifies over a range', async () => {
    const first = await audit.append({
      action: 'it.chain.one',
      actorType: 'system',
      actorId: 'integration',
      targetType: 'platform',
      targetId: 'it',
      outcome: 'success',
    });
    await audit.append({
      action: 'it.chain.two',
      actorType: 'system',
      actorId: 'integration',
      targetType: 'platform',
      targetId: 'it',
      outcome: 'success',
    });

    const verification = await audit.verify(first.seq, String(Number(first.seq) + 1));
    expect(verification.checked).toBeGreaterThanOrEqual(2);
    expect(verification.valid).toBe(true);
    expect(verification.firstBrokenSeq).toBeNull();
  });

  it('refuses the state change when the audit append fails (AD-20)', async () => {
    const marker = `it.failclosed.${randomUUID()}`;
    let mutationRan = false;

    await expect(
      withAuditedMutation(
        pool,
        () => {
          throw new Error('audit store unavailable');
        },
        async (tx) => {
          mutationRan = true;
          await tx.query(
            `INSERT INTO audit_event (actor_type, actor_id, action, target_type, target_id, outcome)
             VALUES ('system', 'it', $1, 'platform', 'it', 'success')`,
            [marker],
          );
        },
      ),
    ).rejects.toThrow(/audit store unavailable/);

    expect(mutationRan, 'the mutation must not run after a failed audit append').toBe(false);
    const rows = await pool.query('SELECT 1 FROM audit_event WHERE action = $1', [marker]);
    expect(rows.rowCount).toBe(0);
  });

  it('rolls the audit row back when the mutation fails', async () => {
    const marker = `it.rollback.${randomUUID()}`;
    await expect(
      withAuditedMutation(
        pool,
        async (tx) => {
          await tx.query(
            `INSERT INTO audit_event (actor_type, actor_id, action, target_type, target_id, outcome)
             VALUES ('system', 'it', $1, 'platform', 'it', 'success')`,
            [marker],
          );
        },
        () => {
          throw new Error('mutation failed');
        },
      ),
    ).rejects.toThrow(/mutation failed/);

    const rows = await pool.query('SELECT 1 FROM audit_event WHERE action = $1', [marker]);
    expect(rows.rowCount, 'an unaudited attempt must not leave a row behind').toBe(0);
  });
});

describe.skipIf(skipReason !== false)('job model', () => {
  it('runs queued → running → succeeded with steps', async () => {
    const instanceId = await createInstance();
    const { job } = await manualJob(instanceId);
    expect(job.state).toBe('queued');

    await jobs.transition(job.id, 'running', { actorId: 'it' });
    await jobs.setStep(job.id, 1, 'succeeded');
    await jobs.appendLog(job.id, 'stdout', 'first line');
    const finished = await jobs.transition(job.id, 'succeeded', { actorId: 'it' });

    expect(finished.state).toBe('succeeded');
    expect(finished.finished_at).not.toBeNull();
    const steps = await jobs.steps(job.id);
    expect(steps).toHaveLength(SYNTHETIC_STEPS.length);
    expect(steps[0]?.state).toBe('succeeded');
  });

  it('replays an idempotency key instead of creating a second job', async () => {
    const instanceId = await createInstance();
    const key = `idem-${randomUUID()}`;
    const first = await manualJob(instanceId, { idempotencyKey: key });
    const second = await manualJob(instanceId, { idempotencyKey: key });

    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
  });

  it('refuses a second active job on the same lane with a 409', async () => {
    const instanceId = await createInstance();
    await manualJob(instanceId);
    await expect(manualJob(instanceId)).rejects.toMatchObject({
      code: 'INSTANCE_BUSY',
      status: 409,
    });
  });

  it('allows cancellation before apply and refuses it after', async () => {
    const cancelling = await createInstance();
    const { job } = await manualJob(cancelling);
    const cancelled = await jobs.cancel(job.id, 'it');
    expect(cancelled.state).toBe('cancelled');

    const applied = await createInstance();
    const second = await manualJob(applied);
    await jobs.transition(second.job.id, 'running');
    await jobs.setStep(second.job.id, 1, 'succeeded');
    await jobs.setStep(second.job.id, 2, 'succeeded');
    await jobs.setStep(second.job.id, 3, 'succeeded'); // apply
    // The status matters as much as the code: this answered `400 VALIDATION_FAILED` while the
    // catalogue promised 409, because the filter discarded `AppError.status`.
    await expect(jobs.cancel(second.job.id, 'it')).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
    });
  });

  it('refuses an idempotency key reused with a different payload', async () => {
    const instanceId = await createInstance();
    const key = `idem-conflict-${randomUUID()}`;
    await jobs.create({
      kind: 'synthetic',
      instanceId,
      idempotencyKey: key,
      steps: SYNTHETIC_STEPS,
      payload: { manual: true, flavour: 'first' },
    });

    await expect(
      jobs.create({
        kind: 'synthetic',
        instanceId,
        idempotencyKey: key,
        steps: SYNTHETIC_STEPS,
        payload: { manual: true, flavour: 'second' },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  });

  it('masks a secret canary out of the job log', async () => {
    const instanceId = await createInstance();
    const canary = `seamnex-canary-${randomUUID()}`;
    const { job } = await manualJob(instanceId);
    await jobs.appendLog(job.id, 'stderr', `client_secret=${canary}`);

    const logs = await jobs.logs(job.id);
    expect(JSON.stringify(logs)).not.toContain(canary);
  });
});

describe.skipIf(skipReason !== false)('secrets module', () => {
  it('stores a value, masks the projection and audits the read', async () => {
    const canary = `seamnex-canary-${randomUUID()}`;
    const owner = `it-${randomUUID()}`;
    const stored = await secrets.put('platform', owner, 'integration-secret', canary);

    expect(stored.masked).toBe('********');
    expect(JSON.stringify(stored)).not.toContain(canary);

    const described = await secrets.describe(stored.id);
    expect(described.version).toBe(1);
    expect(JSON.stringify(described)).not.toContain(canary);

    const plaintext = await secrets.open(stored.id, 'integration test');
    expect(plaintext).toBe(canary);

    const audited = await pool.query(
      `SELECT 1 FROM audit_event WHERE action = 'secret.read' AND target_id = $1`,
      [stored.id],
    );
    expect(audited.rowCount).toBe(1);

    const rotated = await secrets.rotate(stored.id, `${canary}-v2`);
    expect(rotated.version).toBe(2);
    expect(await secrets.open(stored.id, 'after rotation')).toBe(`${canary}-v2`);
  });

  it('refuses a ciphertext whose AAD no longer matches its row identity', async () => {
    const canary = `seamnex-canary-${randomUUID()}`;
    const stored = await secrets.put('platform', `it-${randomUUID()}`, 'tamper', canary);

    // Every stored column stays internally consistent; only the row identity changes. The AAD is
    // recomputed from (secret_id, version), so the GCM tag must fail. Reading `row.aad` back —
    // what the first version did — would let this decrypt, which is the whole point of the binding.
    await pool.query(
      'UPDATE secret_version SET version = 99 WHERE secret_id = $1 AND version = 1',
      [stored.id],
    );

    await expect(secrets.open(stored.id, 'tamper test')).rejects.toMatchObject({
      code: 'SECRET_UNAVAILABLE',
    });

    const audited = await pool.query(
      `SELECT 1 FROM audit_event
        WHERE action = 'secret.read' AND target_id = $1 AND outcome = 'failure'`,
      [stored.id],
    );
    expect(audited.rowCount, 'a failed decrypt must leave a trace').toBe(1);
  });

  it('never stores the plaintext in the database', async () => {
    const canary = `seamnex-canary-${randomUUID()}`;
    const stored = await secrets.put('platform', `it-${randomUUID()}`, 'no-plaintext', canary);
    const rows = await pool.query(
      'SELECT encode(ciphertext, $2) AS body FROM secret_version WHERE secret_id = $1',
      [stored.id, 'base64'],
    );
    expect(JSON.stringify(rows.rows)).not.toContain(canary);
  });
});

describe.skipIf(skipReason !== false)('environment rules', () => {
  /**
   * The D11 failure, as a test: a declaration asked for 64 hexadecimal characters in a sentence,
   * nothing read the sentence, and a 12-character key reached a container that aborts on it.
   *
   * This exercises the three links that had to exist for that to be preventable — the projection
   * (`validation_rule`), the resolver reading it, and the field error the wizard renders — on a real
   * database, because the projection is SQL and a unit test cannot prove it.
   */
  it('projects a declaration rule and refuses a value it does not allow', async () => {
    const env = app!.get<RendererService>(RENDERER_SERVICE);
    const entryKey = 'D991';
    await pool.query(
      `INSERT INTO catalog_entry (key, domain, product, guarantee_class, packaging)
       VALUES ($1, 'Core Operations', 'Integration', 'native', 'compose')
       ON CONFLICT (key) DO NOTHING`,
      [entryKey],
    );

    const file: EnvSchemaFile = {
      format: 'env-schema/v1',
      entryKey,
      variables: [
        {
          name: 'MB_ENCRYPTION_SECRET_KEY',
          purpose: 'Key Metabase encrypts stored data-source credentials with.',
          type: 'secret',
          required: true,
          defaultValue: null,
          constraint: '64 hexadecimal characters (openssl rand -hex 32)',
          conditional: null,
          secret: true,
          overrideCeiling: 'profile_and_instance',
          rule: {
            minLength: 16,
            pattern: '^[0-9a-fA-F]{64}$',
            patternDescription: '64 hexadecimal characters (openssl rand -hex 32)',
          },
        },
      ],
    };

    const projected = await env.applySchemas({
      schemas: [file],
      revision: 'it-env-rules',
      actorId: 'it',
    });
    expect(projected.refused).toEqual([]);
    expect(projected.applied).toHaveLength(1);

    const stored = await pool.query<{ validation_rule: unknown }>(
      `SELECT validation_rule FROM env_schema_var WHERE entry_key = $1 AND name = 'MB_ENCRYPTION_SECRET_KEY'`,
      [entryKey],
    );
    expect(stored.rows[0]?.validation_rule).toMatchObject({ minLength: 16 });

    // The value that actually broke the deployment.
    const short = await env.plan({
      entryKey,
      overrides: { MB_ENCRYPTION_SECRET_KEY: '123456789012' },
    });
    expect(short.fieldErrors).toEqual([
      {
        field: 'MB_ENCRYPTION_SECRET_KEY',
        code: 'min_length',
        message: 'At least 16 characters are required; this value has 12.',
      },
    ]);

    // Long enough, wrong shape: the pattern is the second half of the same declaration.
    const wrongShape = await env.plan({
      entryKey,
      overrides: { MB_ENCRYPTION_SECRET_KEY: 'z'.repeat(64) },
    });
    expect(wrongShape.fieldErrors.map((error) => error.code)).toEqual(['pattern']);
    // The value is a secret: it never appears in the message that refuses it.
    expect(JSON.stringify(wrongShape.fieldErrors)).not.toContain('zzzz');

    const accepted = await env.plan({
      entryKey,
      overrides: { MB_ENCRYPTION_SECRET_KEY: 'a'.repeat(64) },
    });
    expect(accepted.fieldErrors).toEqual([]);
  });

  /**
   * The third reload conflict, alongside "do not delete a variable an instance stores" and "do not
   * lower a ceiling under a value": a rule may not be tightened under a value it would refuse.
   * Without it the projection would succeed and the *next* deploy of that instance would fail at the
   * preview with no edit to blame.
   */
  it('refuses a rule that would invalidate a stored instance value', async () => {
    const env = app!.get<RendererService>(RENDERER_SERVICE);
    const entryKey = 'D992';
    const instanceId = randomUUID();
    await pool.query(
      `INSERT INTO catalog_entry (key, domain, product, guarantee_class, packaging)
       VALUES ($1, 'Core Operations', 'Integration', 'native', 'compose')
       ON CONFLICT (key) DO NOTHING`,
      [entryKey],
    );
    await pool.query(
      `INSERT INTO instance (id, entry_key, slug, domain_route, state, source_path)
       VALUES ($1, $2, 'it-rule-conflict', 'it-rule-conflict.test', 'ready', 'compose')`,
      [instanceId, entryKey],
    );

    const declared = {
      name: 'SITE_NAME',
      purpose: 'Company name shown in documents.',
      type: 'string' as const,
      required: false,
      defaultValue: null,
      constraint: null,
      conditional: null,
      secret: false,
      overrideCeiling: 'profile_and_instance' as const,
    };
    const first = await env.applySchemas({
      schemas: [{ format: 'env-schema/v1', entryKey, variables: [declared] }],
      revision: 'it-rule-r1',
      actorId: 'it',
    });
    expect(first.refused).toEqual([]);

    await env.updateInstanceEnv(instanceId, { SITE_NAME: 'abc' }, 'it');

    const tightened = await env.applySchemas({
      schemas: [
        {
          format: 'env-schema/v1',
          entryKey,
          variables: [{ ...declared, rule: { minLength: 10 } }],
        },
      ],
      revision: 'it-rule-r2',
      actorId: 'it',
    });
    expect(tightened.refused).toHaveLength(1);
    expect(tightened.refused[0]?.reason).toMatch(/it-rule-conflict/);
    expect(tightened.refused[0]?.reason).toMatch(/min_length/);
  });
});

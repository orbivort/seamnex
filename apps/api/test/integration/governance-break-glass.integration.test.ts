import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import type { INestApplicationContext } from '@nestjs/common';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  hasDatabase,
  insertInstance,
  skipUnlessDatabase,
  type TestDatabase,
} from '@seamnex/db/testing';
import { AppModule } from '../../src/app.module';
import { GovernanceWritesService } from '../../src/modules/m18-governance/governance-writes.service';

/**
 * Break-glass decisions must be **single-use** and **audited in the same commit** (ADR-BE-04,
 * AD-20, invariant 8).
 *
 * The defect guarded here was three commits pretending to be one: the caller read the row, decided
 * in TypeScript, then issued an `UPDATE` with no state predicate, and appended the audit row
 * separately. Two approvers acting on one request both succeeded, the second silently overwrote
 * `approver`, and an elevation could move with no evidence. Only a real database can prove the fix —
 * the guarantee is a row lock plus a `WHERE ... AND state = 'requested'` predicate, not a branch in
 * TypeScript.
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

const REQUESTER = 'it-requester';
/** Two distinct approvers: `breakglass.approve` is R2 (scoped) and R3 (full), never the requester. */
const APPROVER = 'it-approver';
const OTHER_APPROVER = 'it-approver-two';

let app: INestApplicationContext | undefined;
let database: TestDatabase | undefined;
let pool: Pool;
let writes: GovernanceWritesService;
let instanceId: string;

beforeAll(async () => {
  if (!canRun) return;

  // Same isolation rules as `phase1.integration.test.ts`: a throwaway database, and a root key in
  // its own file so re-keying a developer's secret store is impossible.
  const rootKeyFile = resolve(process.cwd(), 'temp/test/seamnex-root-key');
  mkdirSync(dirname(rootKeyFile), { recursive: true });
  writeFileSync(rootKeyFile, `${randomBytes(32).toString('base64')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.env.SEAMNEX_ROOT_KEY_FILE = rootKeyFile;

  database = await createTestDatabase();
  process.env.DATABASE_URL = database.url;
  pool = database.pool;

  /*
   * `requestBreakGlass` grants immediately when no second party exists (CL-12's recovery fallback),
   * so the directory must contain an enabled person other than the requester for a request to stay
   * `requested`. Without this seed every elevation would open already `active` and the decision path
   * would never be exercised.
   */
  for (const [idpId, username] of [
    [REQUESTER, 'requester'],
    [APPROVER, 'approver'],
    [OTHER_APPROVER, 'approver-two'],
  ] as const) {
    await pool.query(`INSERT INTO idp_user (idp_id, username, enabled) VALUES ($1, $2, true)`, [
      idpId,
      username,
    ]);
  }

  instanceId = randomUUID();
  await insertInstance(pool, instanceId);

  app = await NestFactory.createApplicationContext(AppModule, {
    abortOnError: false,
    logger: ['error'],
  });
  writes = app.get(GovernanceWritesService);
});

afterAll(async () => {
  if (!canRun) return;
  await app?.close().catch(() => undefined);
  await database?.drop();
});

/** A request that stays in `requested`, so a decision is still required. */
async function openRequest(): Promise<string> {
  const session = await writes.requestBreakGlass(
    {
      instanceId,
      accessMode: 'read_only',
      justification:
        'Integration test: the decision must be single-use, and every transition must be audited.',
    },
    REQUESTER,
  );
  return session.id;
}

async function auditCount(action: string, targetId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_event WHERE action = $1 AND target_id = $2`,
    [action, targetId],
  );
  return result.rows[0]?.n ?? 0;
}

async function stateOf(id: string): Promise<string> {
  const result = await pool.query<{ state: string }>(
    'SELECT state FROM break_glass_session WHERE id = $1',
    [id],
  );
  return result.rows[0]?.state ?? '(missing)';
}

describe.skipIf(skipReason !== false)('break-glass decisions', () => {
  it('opens a request without granting it, and audits the request', async () => {
    const id = await openRequest();
    expect(await stateOf(id)).toBe('requested');
    expect(await auditCount('breakglass.requested', id)).toBe(1);
  });

  it('approves once and records exactly one decision', async () => {
    const id = await openRequest();
    const decided = await writes.decideBreakGlass(id, 'approve', APPROVER, 'R3');

    expect(decided.state).toBe('active');
    expect(await stateOf(id)).toBe('active');
    expect(await auditCount('breakglass.approve', id)).toBe(1);
  });

  it('refuses a second decision on the same request', async () => {
    const id = await openRequest();
    await writes.decideBreakGlass(id, 'approve', APPROVER, 'R3');

    // Previously this succeeded: the state was read before the UPDATE and the UPDATE carried no
    // predicate, so `approver` was overwritten and the audit chain gained a second "approved" row.
    await expect(
      writes.decideBreakGlass(id, 'approve', OTHER_APPROVER, 'R3'),
    ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });

    expect(await auditCount('breakglass.approve', id)).toBe(1);
    const approver = await pool.query<{ approver: string }>(
      'SELECT approver FROM break_glass_session WHERE id = $1',
      [id],
    );
    expect(approver.rows[0]?.approver).toBe(APPROVER);
  });

  it('lets exactly one of two concurrent decisions win', async () => {
    const id = await openRequest();

    const outcomes = await Promise.allSettled([
      writes.decideBreakGlass(id, 'approve', APPROVER, 'R3'),
      writes.decideBreakGlass(id, 'approve', OTHER_APPROVER, 'R3'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await stateOf(id)).toBe('active');
    expect(await auditCount('breakglass.approve', id)).toBe(1);
  });

  it('refuses a decision from a role without the capability', async () => {
    const id = await openRequest();
    // R1 may request an elevation and revoke one, but does not decide it.
    await expect(writes.decideBreakGlass(id, 'approve', REQUESTER, 'R1')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await stateOf(id)).toBe('requested');
  });
});

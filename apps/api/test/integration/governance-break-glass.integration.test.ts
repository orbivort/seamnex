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

/*
 * Approvers whose `role_binding` rows belong to exactly one case.
 *
 * A binding is global state: `decideBreakGlass` reads the deciding subject's live grants, so a row
 * written for one case would silently decide the next one. A dedicated subject per case keeps its
 * grant local to it, needs no cleanup afterwards, and is what leaves `UNBOUND_APPROVER` able to
 * prove the documented fallback (no binding at all → the session's role, platform-scoped).
 */
const CORE_OWNER = 'it-approver-core-operations';
const REVENUE_OWNER = 'it-approver-revenue';
const UNBOUND_APPROVER = 'it-approver-unbound';

/** `insertInstance` projects catalog_entry `D01-01` with this domain: it is the target's domain. */
const TARGET_DOMAIN = 'Core Operations';
/** A domain this suite's instance does not live in, so a binding here covers nothing it targets. */
const FOREIGN_DOMAIN = 'Revenue & Customer';

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
    [CORE_OWNER, 'approver-core-operations'],
    [REVENUE_OWNER, 'approver-revenue'],
    [UNBOUND_APPROVER, 'approver-unbound'],
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

/**
 * A request that stays in `requested`, so a decision is still required.
 *
 * The mode is a parameter because approver eligibility is decided on it (FR-4.11): a `scoped` grant
 * may approve a read-only elevation and nothing else, and that half of the rule is only reachable
 * with a read-write request in the fixture.
 */
async function openRequest(accessMode: 'read_only' | 'read_write' = 'read_only'): Promise<string> {
  const session = await writes.requestBreakGlass(
    {
      instanceId,
      accessMode,
      justification:
        'Integration test: the decision must be single-use, and every transition must be audited.',
    },
    REQUESTER,
  );
  return session.id;
}

/**
 * One case's approver grant, written straight into `role_binding` — the table `grantsFor` reads —
 * rather than through a directory sync, which would add a second row this case did not ask for.
 *
 * `granted_by` names the seed, as in `workflow-authority.integration.test.ts`: a grant that cannot
 * say who made it is exactly what the binding table exists to prevent. The subject's `idp_user` row
 * is seeded in `beforeAll`, so each subject can be reused by its own case without cleanup.
 */
async function seedGrant(
  subjectIdpId: string,
  role: 'R2' | 'R3',
  scopeType: 'platform' | 'domain' | 'instance',
  scopeId: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO role_binding (subject_idp_id, role, scope_type, scope_id, granted_by)
     VALUES ($1, $2, $3, $4, 'integration-test')`,
    [subjectIdpId, role, scopeType, scopeId],
  );
}

/** Asserts a subject really holds nothing, which is what makes the platform fallback reachable. */
async function grantCount(subjectIdpId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM role_binding WHERE subject_idp_id = $1',
    [subjectIdpId],
  );
  return result.rows[0]?.n ?? 0;
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

  /*
   * FR-4.11 / AC-47 / NFR-4.4 — the cases below exist because approver eligibility used to live in
   * the console alone (`ISSUE-05`): the API answered on the role's capability, so an R2 auditor
   * talking to it directly could have a read-write elevation approved and audited as legitimate.
   *
   * The rule is now decided inside the decision transaction, on the locked row, and a refusal must
   * leave an `access.denied` row *and* no `breakglass.approve` row: a refusal that moved the state
   * (or only half the evidence) would be the same defect with a different symptom.
   */

  it('refuses a read-write elevation from an R2 auditor, and leaves the request pending', async () => {
    const id = await openRequest('read_write');

    // R2 holds `breakglass.approve` as `scoped`, so it may approve read-only elevations only. The
    // refusal is a 403 with its own code: the role may approve, just not this mode, and the fix is
    // a different approver rather than a different role.
    await expect(writes.decideBreakGlass(id, 'approve', APPROVER, 'R2')).rejects.toMatchObject({
      code: 'APPROVAL_MODE_FORBIDDEN',
      status: 403,
    });

    expect(await stateOf(id)).toBe('requested');
    expect(await auditCount('breakglass.approve', id)).toBe(0);
    // Exactly one: the refusal is written outside the rolled-back transaction, best effort. Two rows
    // would mean the refusal was recorded twice for one decision.
    expect(await auditCount('access.denied', id)).toBe(1);
  });

  it('lets an R2 auditor approve a read-only elevation', async () => {
    // The positive half of the mode rule, and the reason it cannot be "R2 may never approve": the
    // auditor's fallback grant is platform-scoped, which covers this instance, so only the mode is
    // in question. A rule that refused here would take the auditor's queue away entirely.
    expect(await grantCount(APPROVER)).toBe(0);
    const id = await openRequest();

    const decided = await writes.decideBreakGlass(id, 'approve', APPROVER, 'R2');

    expect(decided.state).toBe('active');
    expect(await stateOf(id)).toBe('active');
    expect(await auditCount('breakglass.approve', id)).toBe(1);
    expect(await auditCount('access.denied', id)).toBe(0);
  });

  it('lets an R2 auditor decline a read-write elevation it may not approve', async () => {
    // Declining is deliberately not gated: a request an approver cannot grant must still be
    // refusable, or the queue would fill with elevations only a domain owner could clear. A test
    // that gated `reject` too would pass on the code above and take that away.
    const id = await openRequest('read_write');

    const decided = await writes.decideBreakGlass(id, 'reject', APPROVER, 'R2');

    expect(decided.state).toBe('rejected');
    expect(await stateOf(id)).toBe('rejected');
    expect(await auditCount('breakglass.reject', id)).toBe(1);
    expect(await auditCount('access.denied', id)).toBe(0);
  });

  it('treats an approver with no binding row as a platform-scoped owner', async () => {
    // The documented fallback in `approvalGrants`: a subject with no `role_binding` row keeps the
    // role its session carries, otherwise a fresh install could not decide its first elevation.
    // Asserted explicitly so the case cannot pass on a binding some other case left behind.
    expect(await grantCount(UNBOUND_APPROVER)).toBe(0);
    const id = await openRequest('read_write');

    const decided = await writes.decideBreakGlass(id, 'approve', UNBOUND_APPROVER, 'R3');

    expect(decided.state).toBe('active');
    expect(await auditCount('breakglass.approve', id)).toBe(1);
  });

  it('lets a domain owner approve a read-write elevation targeting their own domain', async () => {
    // R3 holds `breakglass.approve` as `full`, so the mode is not the question — the scope is. The
    // instance is `D01-01`, whose catalog entry sits in `Core Operations` (`insertInstance`), so a
    // binding on that domain covers it. This is the case ISSUE-05 broke: a legitimate read-write
    // approval has to keep working once the rule exists.
    await seedGrant(CORE_OWNER, 'R3', 'domain', TARGET_DOMAIN);
    const id = await openRequest('read_write');

    const decided = await writes.decideBreakGlass(id, 'approve', CORE_OWNER, 'R3');

    expect(decided.state).toBe('active');
    expect(await stateOf(id)).toBe('active');
    expect(await auditCount('breakglass.approve', id)).toBe(1);
    expect(await auditCount('access.denied', id)).toBe(0);
  });

  it('refuses an owner of another domain approving the elevation', async () => {
    // The scope half of the rule, and a separate code from the mode refusal because the fix differs:
    // this approver can become the right one only by owning the target's domain (or holding a
    // platform binding), not by retrying. Read-only is used deliberately, so the refusal cannot be
    // the mode rule answering instead.
    await seedGrant(REVENUE_OWNER, 'R3', 'domain', FOREIGN_DOMAIN);
    const id = await openRequest('read_only');

    await expect(writes.decideBreakGlass(id, 'approve', REVENUE_OWNER, 'R3')).rejects.toMatchObject(
      { code: 'APPROVAL_SCOPE_FORBIDDEN', status: 403 },
    );

    expect(await stateOf(id)).toBe('requested');
    expect(await auditCount('breakglass.approve', id)).toBe(0);
    expect(await auditCount('access.denied', id)).toBe(1);
  });
});

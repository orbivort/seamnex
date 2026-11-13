import { createHash, randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  API_OPERATIONS,
  AuthSessionSchema,
  CAPABILITY_MATRIX,
  isReservedPolicyKey,
  operationKey,
  PLATFORM_ROLES,
  type ApiOperation,
  type Capability,
  type PlatformRole,
} from '@seamnex/domain';
import { createApplication } from '../../src/bootstrap/create-app';
import { loadConfig } from '../../src/config/config';
import { PG_POOL } from '../../src/database/database.module';

/**
 * The authorization matrix, exercised over HTTP for every role and every declared operation.
 *
 * Nothing is a hand-written expectation: roles come from `PLATFORM_ROLES`, operations from
 * `API_OPERATIONS`, outcomes from `CAPABILITY_MATRIX`. A route that gains a policy key, a role that
 * gains a capability or a new operation changes this suite instead of escaping it.
 *
 * Two deliberate shapes, both about authorization only:
 *   - `POST /me/logout` runs last for each role: it is declared (`auth.session.read`, reserved, so
 *     any signed-in actor may call it) and destroys the credential under test, so leaving it
 *     mid-loop would make every later assertion depend on list order;
 *   - `GET /jobs/:id/stream` is excluded: SSE holds the connection open, and the refusal shape is
 *     already covered by its five sibling job operations.
 *
 * `scoped` is not a blanket yes: every resource id here is a synthetic UUID outside any seeded
 * scope, so the PDP may answer 403 — but only with the scope-coverage reason, asserted from the
 * audit trail. A 403 in any other shape (no grant at all) is a wiring regression and fails.
 */
const canRun =
  (process.env.DATABASE_URL ?? '').length > 0 && (process.env.REDIS_URL ?? '').length > 0;
const skipReason = canRun
  ? false
  : 'Set DATABASE_URL and REDIS_URL to boot the API for the authorization matrix.';

/**
 * Each role signs in from its own `x-forwarded-for` so the per-client sign-in bucket does not
 * collapse six identities into one allowance. Fastify only honours that header when `trustProxy`
 * is on, and `TRUST_PROXY` is unset in a bare shell by design (ADR-BE-13).
 */
process.env.TRUST_PROXY ??= '1';

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'seamnex_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'seamnex_csrf';
const ORIGIN =
  (process.env.APP_ORIGINS ?? 'http://localhost:5173').split(',')[0]?.trim() ??
  'http://localhost:5173';

const RESOURCE_ID = '00000000-0000-4000-8000-000000000000';
const SEGMENTS: Readonly<Record<string, string>> = {
  key: 'D01-01',
  slug: 'espocrm-dev',
  seq: '1',
  action: 'start',
  decision: 'approve',
};
const STREAM = 'GET /jobs/:id/stream';
const TERMINAL = 'POST /me/logout';
/**
 * The break-glass action route carries two authorities in one dynamic segment: `approve`/`reject`
 * need `breakglass.approve`, `revoke`/`expire` need `breakglass.revoke`. A single synthetic
 * `action` value cannot represent both, so the loop skips it and the dedicated test below asserts
 * each action against the matrix.
 */
const BREAK_GLASS_ACTION = 'POST /break-glass-sessions/:id/:action';
/** Exact wording from `PdpService.scopeCovers` for a scoped grant that does not reach the resource. */
const SCOPE_REFUSAL = 'the scoped grant does not cover the resource';

/** The stub directory's usernames; the roles themselves come from `PLATFORM_ROLES`. */
const DIRECTORY: Readonly<Record<PlatformRole, string>> = {
  R1: 'dev-admin',
  R2: 'dev-auditor',
  R3: 'dev-owner',
  R4: 'dev-product',
  R5: 'dev-user',
  R6: 'dev-guest',
};
/** AC-46: the two roles whose directory accounts have a second factor enrolled. */
const MFA_ROLES: ReadonlySet<PlatformRole> = new Set<PlatformRole>(['R1', 'R2']);

const OPERATIONS: readonly ApiOperation[] = [
  ...API_OPERATIONS.filter((operation) => {
    const key = operationKey(operation);
    return (
      operation.anonymous !== true &&
      key !== STREAM &&
      key !== TERMINAL &&
      key !== BREAK_GLASS_ACTION
    );
  }),
  ...API_OPERATIONS.filter((operation) => operationKey(operation) === TERMINAL),
];

type Method = ApiOperation['method'];
/** `OutgoingHttpHeaders` allows numeric values (`content-length`), so the alias has to as well. */
type HttpHeaders = Readonly<Record<string, string | number | string[] | undefined>>;
type HttpResult = { readonly status: number; readonly headers: HttpHeaders; readonly text: string };
type Session = { readonly cookie: string; readonly csrfToken: string; readonly sub: string };
type Expectation = 'allow' | 'deny' | 'scoped';

const SESSIONS = new Map<PlatformRole, Session>();
const MACHINE_NAME = 'test-registry';
const MACHINE_TOKEN = randomBytes(32).toString('base64url');

let app: NestFastifyApplication | undefined;
let server: FastifyInstance;
let pool: Pool;
let machineReady = false;
let auditedDenials = 0;

beforeAll(async () => {
  if (!canRun) return;
  app = await createApplication(loadConfig());
  await app.init();
  server = app.getHttpAdapter().getInstance() as FastifyInstance;
  pool = app.get<Pool>(PG_POOL);

  for (const [index, role] of PLATFORM_ROLES.entries()) {
    SESSIONS.set(role, await openSession(role, `10.2.0.${index + 1}`));
  }
  try {
    await pool.query('DELETE FROM machine_client WHERE name = $1', [MACHINE_NAME]);
    await pool.query('INSERT INTO machine_client (name, token_hash, scope) VALUES ($1, $2, $3)', [
      MACHINE_NAME,
      createHash('sha256').update(MACHINE_TOKEN, 'utf8').digest('hex'),
      'registry.read',
    ]);
    machineReady = true;
  } catch {
    // An unmigrated database has no `machine_client` table; the scope rule is unit-tested, and this
    // suite stays useful for the human roles instead of failing for a setup reason.
    machineReady = false;
  }
});

afterAll(async () => {
  if (!canRun) return;
  if (machineReady) {
    await pool
      .query('DELETE FROM machine_client WHERE name = $1', [MACHINE_NAME])
      .catch(() => undefined);
  }
  await app
    ?.get<Pool>(PG_POOL)
    .end()
    .catch(() => undefined);
  await app?.close().catch(() => undefined);
});

async function request(
  method: Method,
  url: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  const response = await server.inject({ method, url, headers });
  return { status: response.statusCode, headers: response.headers, text: response.body };
}

function json(result: HttpResult): unknown {
  return result.text.length === 0 ? null : (JSON.parse(result.text) as unknown);
}

function setCookies(headers: HttpHeaders): readonly string[] {
  const raw = headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Signs a directory user in and reads the CSRF token back from `GET /auth/session`. */
async function openSession(role: PlatformRole, forwardFor: string): Promise<Session> {
  const verifier = randomBytes(48).toString('base64url');
  const body: Record<string, unknown> = {
    code: `stub:${DIRECTORY[role]}`,
    codeVerifier: verifier,
    codeChallenge: challengeFor(verifier),
    redirectUri: `${ORIGIN}/sign-in`,
  };
  if (MFA_ROLES.has(role)) body.mfaCode = '123456';

  const signIn = await server.inject({
    method: 'POST',
    url: '/api/v1/auth/session',
    headers: { origin: ORIGIN, 'x-forwarded-for': forwardFor },
    payload: body,
  });
  if (signIn.statusCode !== 200) {
    throw new Error(
      `sign-in failed for ${role} (${DIRECTORY[role]}): ${signIn.statusCode} ${signIn.body}`,
    );
  }

  const issued = setCookies(signIn.headers)
    .map((entry) => entry.split(';')[0] ?? '')
    .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
  if (issued === undefined) throw new Error(`no ${SESSION_COOKIE} cookie was issued for ${role}`);

  const current = AuthSessionSchema.parse(
    json(await request('GET', '/api/v1/auth/session', { cookie: issued })),
  );
  if (current.subject === null || current.csrfToken === null) {
    throw new Error(`GET /auth/session did not describe the session of ${role}`);
  }

  return {
    // Both cookies travel together: the readable `seamnex_csrf` is the double-submit half of the check.
    cookie: `${issued}; ${CSRF_COOKIE}=${current.csrfToken}`,
    csrfToken: current.csrfToken,
    sub: current.subject.idpId,
  };
}

function sessionFor(role: PlatformRole): Session {
  const session = SESSIONS.get(role);
  if (session === undefined)
    throw new Error(`no session for ${role}: the beforeAll sign-in did not run`);
  return session;
}

/** `:params` become fixed values so two runs send the same request (`D01-01` is the seeded catalogue key). */
function urlFor(path: string): string {
  return `/api/v1${path.replace(/:(\w+)/g, (_match, name: string) => SEGMENTS[name] ?? RESOURCE_ID)}`;
}

function expectationFor(operation: ApiOperation, role: PlatformRole): Expectation {
  // An any-of operation is allowed by the strongest grant in its set: one `full` key is enough,
  // and a `scoped` key keeps the answer scoped only when nothing stronger applies.
  const keys = operation.policyAnyOf ?? [operation.policyKey];
  // `auth.session.read` is the caller's own session, which no matrix can grant or withhold.
  if (keys.some(isReservedPolicyKey)) return 'allow';
  const accesses = keys.map((key) => CAPABILITY_MATRIX[key as Capability][role]);
  if (accesses.includes('full')) return 'allow';
  if (accesses.includes('scoped')) return 'scoped';
  return 'deny';
}

async function auditMark(): Promise<string> {
  const result = await pool.query<{ seq: string }>(
    'SELECT coalesce(max(seq), 0)::text AS seq FROM audit_event',
  );
  return result.rows[0]?.seq ?? '0';
}

/** Every `access.denied` reason recorded for this actor since the mark, keyed by policy key. */
async function denialReasons(actorId: string, sinceSeq: string): Promise<Map<string, Set<string>>> {
  const result = await pool.query<{ policy_key: string | null; reason: string | null }>(
    `SELECT DISTINCT detail->>'policyKey' AS policy_key, detail->>'reason' AS reason
       FROM audit_event
      WHERE action = 'access.denied' AND actor_id = $1 AND seq > $2::bigint`,
    [actorId, sinceSeq],
  );

  const reasons = new Map<string, Set<string>>();
  for (const row of result.rows) {
    if (row.policy_key === null) continue;
    const known = reasons.get(row.policy_key) ?? new Set<string>();
    if (row.reason !== null) known.add(row.reason);
    reasons.set(row.policy_key, known);
  }
  return reasons;
}

describe.skipIf(skipReason !== false)('authorization matrix', () => {
  /**
   * Regression for the inverted authority: the route used to be gated on `breakglass.approve`, so
   * R1 — the only role holding `breakglass.revoke` — was refused, while R2 and R3 could revoke a
   * live elevation with a capability the matrix does not grant them. A missing elevation answers
   * 404 when the caller is allowed and 403 when it is not, which is what this distinguishes.
   *
   * It runs before the role loops because each of those ends by signing its role out.
   */
  it('matches each break-glass action to the capability that owns it', async () => {
    const cases = [
      { action: 'approve', capability: 'breakglass.approve' },
      { action: 'reject', capability: 'breakglass.approve' },
      { action: 'revoke', capability: 'breakglass.revoke' },
      { action: 'expire', capability: 'breakglass.revoke' },
    ] as const satisfies readonly { action: string; capability: Capability }[];

    for (const role of PLATFORM_ROLES) {
      const session = sessionFor(role);
      for (const { action, capability } of cases) {
        const result = await request(
          'POST',
          `/api/v1/break-glass-sessions/${RESOURCE_ID}/${action}`,
          { cookie: session.cookie, origin: ORIGIN, 'x-seamnex-csrf': session.csrfToken },
        );
        const allowed = CAPABILITY_MATRIX[capability][role] !== 'none';
        const label = `${role} ${action} (${capability})`;
        if (allowed) {
          expect(result.status, `${label} must not be refused: ${result.text}`).not.toBe(403);
        } else {
          expect(result.status, `${label} must be refused: ${result.text}`).toBe(403);
        }
      }
    }
  });

  for (const role of PLATFORM_ROLES) {
    it(`authorizes ${role} exactly as CAPABILITY_MATRIX declares`, async () => {
      const session = sessionFor(role);
      const sinceSeq = await auditMark();
      const denied: string[] = [];
      const scopedRefusals = new Set<string>();

      for (const operation of OPERATIONS) {
        const key = operationKey(operation);
        const headers: Record<string, string> = { cookie: session.cookie };
        if (operation.method !== 'GET') {
          headers.origin = ORIGIN;
          headers['x-seamnex-csrf'] = session.csrfToken;
        }

        const result = await request(operation.method, urlFor(operation.path), headers);
        const expectation = expectationFor(operation, role);

        if (expectation === 'deny') {
          // Deny-by-default: the only legal answer, whatever the handler would have done.
          expect(result.status, `${role} ${key} must be refused`).toBe(403);
          denied.push(operation.policyKey);
        } else if (expectation === 'allow') {
          // Phase 4 handlers are deferred, so 200/202/204/404/409/412/422/500/501 are all legal;
          // an authorization refusal is not.
          expect(result.status, `${role} ${key} must not be refused`).not.toBe(403);
        } else {
          // `scoped`: the synthetic resource is outside every seeded scope, so the PDP may refuse.
          expect(result.status, `${role} ${key} (scoped) must stay authenticated`).not.toBe(401);
          if (result.status === 403) scopedRefusals.add(operation.policyKey);
        }
      }

      const reasons = await denialReasons(session.sub, sinceSeq);
      for (const policyKey of denied) {
        // AC-38: a refusal that leaves no trail did not happen as far as governance is concerned.
        expect(reasons.has(policyKey), `${role} ${policyKey} must leave an access.denied row`).toBe(
          true,
        );
      }
      for (const policyKey of scopedRefusals) {
        expect(
          [...(reasons.get(policyKey) ?? [])],
          `${role} ${policyKey} may only be refused for scope coverage`,
        ).toContain(SCOPE_REFUSAL);
      }

      auditedDenials += denied.length;
    });
  }

  it('audits at least ten refusals across the matrix', () => {
    // Filled by the tests above, each of which also asserts the row for every denial it observed.
    expect(auditedDenials).toBeGreaterThanOrEqual(10);
  });

  it('gives a machine client its scope and nothing beyond it', async () => {
    if (!machineReady) return; // no migrated `machine_client` table: see beforeAll

    const bearer = { authorization: `Bearer ${MACHINE_TOKEN}` };
    const registry = await request('GET', '/api/v1/registry/instances', bearer);
    // `registry.read` maps to `registry.view`; the handler behind it may still be deferred.
    expect([401, 403], `registry read answered ${String(registry.status)}`).not.toContain(
      registry.status,
    );

    const audit = await request('GET', '/api/v1/audit-events', bearer);
    // `registry.read` does not include `audit.view`, and a machine has no human role to fall back on.
    expect(audit.status).toBe(403);
  });
});

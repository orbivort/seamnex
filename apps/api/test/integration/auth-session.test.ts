import { createHash, randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthSessionSchema,
  LogoutResponseSchema,
  MeSchema,
  type AuthSession,
} from '@seamnex/domain';
import { createApplication } from '../../src/bootstrap/create-app';
import { loadConfig } from '../../src/config/config';
import { PG_POOL } from '../../src/database/database.module';
import { REDIS } from '../../src/redis/redis.module';

/**
 * Phase 3 session surface over HTTP (deliverable 3.2, AC-46). A unit test cannot see the cookie a
 * browser receives, the guard order in `route-table.ts` (identity → CSRF/origin → PDP, so an
 * unauthenticated request is a 401 and a tokenless mutation is a 403) or the audit row a refused
 * second factor leaves behind.
 *
 * Every sign-in sets `x-forwarded-for`: `POST /auth/session` is the one rate-limited operation
 * (10 per 300 s per client), and a shared bucket would make a second run answer 429.
 */
const canRun =
  (process.env.DATABASE_URL ?? '').length > 0 && (process.env.REDIS_URL ?? '').length > 0;
const skipReason = canRun
  ? false
  : 'Set DATABASE_URL and REDIS_URL to boot the API for the session suite.';

/**
 * This suite isolates rate-limit buckets by sending `x-forwarded-for`, which Fastify only honours
 * when `trustProxy` is on. `TRUST_PROXY` is unset in a bare shell (the secure default, ADR-BE-13),
 * so the harness opts in explicitly — the same thing the dev stack does for its edge.
 */
process.env.TRUST_PROXY ??= '1';

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'seamnex_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'seamnex_csrf';
const ORIGIN =
  (process.env.APP_ORIGINS ?? 'http://localhost:5173').split(',')[0]?.trim() ??
  'http://localhost:5173';
const FOREIGN_ORIGIN = 'https://evil.example';

type Method = 'GET' | 'POST';
/** `OutgoingHttpHeaders` allows numeric values (`content-length`), so the alias has to as well. */
type HttpHeaders = Readonly<Record<string, string | number | string[] | undefined>>;
type HttpResult = { readonly status: number; readonly headers: HttpHeaders; readonly text: string };
type SignInInput = {
  code: string;
  verifier: string;
  challenge?: string;
  mfaCode?: string;
  origin?: string;
  forwardFor: string;
  /** What a browser would send: the session it already holds, if any. */
  cookie?: string;
};

let app: NestFastifyApplication | undefined;
let server: FastifyInstance;
let pool: Pool;
let redis: Redis;

beforeAll(async () => {
  if (!canRun) return;
  app = await createApplication(loadConfig());
  await app.init();
  server = app.getHttpAdapter().getInstance() as FastifyInstance;
  pool = app.get<Pool>(PG_POOL);
  redis = app.get<Redis>(REDIS);
  // The per-identity sign-in bucket (ADR-BE-13) survives between runs otherwise, and a second
  // invocation of the suite inside the same five-minute window would refuse a legitimate sign-in.
  const keys = await redis.keys('seamnex:rl:auth-subject:*');
  if (keys.length > 0) await redis.del(...keys);
});

afterAll(async () => {
  if (!canRun) return;
  // Redis holds the session records (a test-scoped database); closing the container is enough.
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
  payload?: Record<string, unknown>,
): Promise<HttpResult> {
  const injected = { method, url, headers, ...(payload === undefined ? {} : { payload }) };
  const response = await server.inject(injected);
  return { status: response.statusCode, headers: response.headers, text: response.body };
}

function json(result: HttpResult): unknown {
  return result.text.length === 0 ? null : (JSON.parse(result.text) as unknown);
}

function problemCode(result: HttpResult): string {
  const body = json(result) as { code?: unknown } | null;
  return typeof body?.code === 'string' ? body.code : '(no code)';
}

function setCookies(headers: HttpHeaders): readonly string[] {
  const raw = headers['set-cookie'];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw.map(String) : [String(raw)];
}

function challengeFor(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** RFC 7636: 43–128 unreserved verifier characters; an S256 challenge is 43 base64url ones. */
function pkce(): { readonly verifier: string; readonly challenge: string } {
  const verifier = randomBytes(48).toString('base64url'); // exactly 64 characters
  return { verifier, challenge: challengeFor(verifier) };
}

async function signIn(input: SignInInput): Promise<HttpResult> {
  const body: Record<string, unknown> = {
    code: input.code,
    codeVerifier: input.verifier,
    codeChallenge: input.challenge ?? challengeFor(input.verifier),
    redirectUri: `${ORIGIN}/sign-in`,
  };
  if (input.mfaCode !== undefined) body.mfaCode = input.mfaCode;
  const headers: Record<string, string> = {
    origin: input.origin ?? ORIGIN,
    'x-forwarded-for': input.forwardFor,
  };
  if (input.cookie !== undefined) headers.cookie = input.cookie;
  return request('POST', '/api/v1/auth/session', headers, body);
}

/**
 * Both cookies, as a browser holds them. The session half is `HttpOnly` and carries the credential;
 * the CSRF half is the double-submit token the client echoes in `x-seamnex-csrf`.
 */
function browserCookies(headers: HttpHeaders): string {
  return setCookies(headers)
    .map((entry) => entry.split(';')[0] ?? '')
    .filter((pair) => pair.length > 0)
    .join('; ');
}

/** Highest audit sequence so far: a row written before the request cannot satisfy the assertion. */
async function auditMark(): Promise<string> {
  const result = await pool.query<{ seq: string }>(
    'SELECT coalesce(max(seq), 0)::text AS seq FROM audit_event',
  );
  return result.rows[0]?.seq ?? '0';
}

async function countAudit(action: string, sinceSeq: string, actorId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_event
      WHERE action = $1 AND actor_id = $2 AND seq > $3::bigint`,
    [action, actorId, sinceSeq],
  );
  return result.rows[0]?.n ?? 0;
}

async function hasRoleBinding(subjectIdpId: string): Promise<boolean> {
  try {
    const result = await pool.query(
      'SELECT 1 FROM role_binding WHERE subject_idp_id = $1 LIMIT 1',
      [subjectIdpId],
    );
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false; // an older database: a seeded binding is optional for this suite
  }
}

describe.skipIf(skipReason !== false)('session surface (Phase 3)', () => {
  it('answers 200 authenticated:false for GET /auth/session without a cookie', async () => {
    const result = await request('GET', '/api/v1/auth/session');

    // A cold start probes the session; a 401 here would trip the client's seamnex:unauthorized handler.
    expect(result.status).toBe(200);
    const body = AuthSessionSchema.parse(json(result));
    expect(body.authenticated).toBe(false);
    expect(body.subject).toBeNull();
    expect(body.csrfToken).toBeNull();
    // ADR-BE-13: no response may be stored by a shared cache.
    expect(String(result.headers['cache-control'] ?? '')).toContain('no-store');
    // The opaque session id is the cookie's secret; it must not appear in a JSON body.
    expect(json(result)).not.toHaveProperty('sessionId');
  });

  it('answers 401 application/problem+json with code UNAUTHORIZED for a protected operation', async () => {
    const result = await request('GET', '/api/v1/instances');

    expect(result.status).toBe(401);
    expect(String(result.headers['content-type'] ?? '')).toContain('application/problem+json');
    expect(problemCode(result)).toBe('UNAUTHORIZED');
  });

  it('derives a 64-character PKCE verifier and its S256 challenge', () => {
    const { verifier, challenge } = pkce();

    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('refuses an R1 sign-in without a second factor and audits the refusal', async () => {
    const before = await auditMark();
    const result = await signIn({
      code: 'stub:dev-admin',
      verifier: pkce().verifier,
      forwardFor: '10.1.1.1',
    });

    expect(result.status).toBe(401);
    expect(problemCode(result)).toBe('MFA_REQUIRED');
    // AC-46 evidence: the refusal is auditable even though no session exists.
    expect(await countAudit('auth.mfa.refused', before, 'stub:dev-admin')).toBeGreaterThan(0);
  });

  it('refuses a sign-in whose verifier does not match the challenge', async () => {
    const presented = pkce();
    const result = await signIn({
      code: 'stub:dev-user',
      verifier: presented.verifier,
      challenge: challengeFor(pkce().verifier), // a challenge for a verifier nobody sent
      forwardFor: '10.1.1.3',
    });

    expect(result.status).toBe(401);
    expect(problemCode(result)).toBe('UNAUTHORIZED');
  });

  it('refuses a sign-in from an origin the platform does not serve', async () => {
    const result = await signIn({
      code: 'stub:dev-user',
      verifier: pkce().verifier,
      origin: FOREIGN_ORIGIN,
      forwardFor: '10.1.1.4',
    });

    expect(result.status).toBe(403);
    expect(problemCode(result)).toBe('ORIGIN_REJECTED');
  });

  it('audits an unknown directory user without saying whether the account exists', async () => {
    const before = await auditMark();
    const result = await signIn({
      code: 'stub:nobody',
      verifier: pkce().verifier,
      forwardFor: '10.1.2.1',
    });

    expect(result.status).toBe(401);
    expect(problemCode(result)).toBe('UNAUTHORIZED');
    // The detail is the same one a mismatched code produces: no enumeration oracle.
    expect(JSON.stringify(json(result))).not.toContain('directory user');
    expect(await countAudit('auth.signin.failed', before, 'stub:nobody')).toBeGreaterThan(0);
  });

  it('ends the previous session when the same browser signs in again', async () => {
    const first = await signIn({
      code: 'stub:dev-guest',
      verifier: pkce().verifier,
      forwardFor: '10.1.2.2',
    });
    expect(first.status).toBe(200);
    const firstCookie = setCookies(first.headers)
      .map((entry) => entry.split(';')[0] ?? '')
      .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
    if (firstCookie === undefined) throw new Error('first sign-in did not set seamnex_session');

    // The browser sends the session it already holds, which is what lets the server replace it.
    const second = await signIn({
      code: 'stub:dev-guest',
      verifier: pkce().verifier,
      forwardFor: '10.1.2.3',
      cookie: firstCookie,
    });
    expect(second.status).toBe(200);

    // Re-authenticating replaces the session instead of accumulating one: a shared browser must not
    // keep an older credential alive after the user signs in again.
    const reused = await request('GET', '/api/v1/me', { cookie: firstCookie });
    expect(reused.status).toBe(401);
    expect(problemCode(reused)).toBe('SESSION_EXPIRED');
  });

  describe('signed in as R1', () => {
    let session: AuthSession;
    let cookie: string;
    let cookies: readonly string[];

    beforeAll(async () => {
      const result = await signIn({
        code: 'stub:dev-admin',
        verifier: pkce().verifier,
        mfaCode: '123456',
        forwardFor: '10.1.1.2',
      });
      if (result.status !== 200)
        throw new Error(`R1 sign-in failed: ${result.status} ${result.text}`);
      session = AuthSessionSchema.parse(json(result));
      cookies = setCookies(result.headers);
      // The session id is only in the HttpOnly cookie now (ADR-BE-13), so the harness reads it from
      // the wire rather than from a JSON field that would hand it to any script. Both cookies travel
      // together, exactly as a browser would send them back.
      cookie = browserCookies(result.headers);
      if (cookie.length === 0) throw new Error('sign-in did not set the session cookies');
    });

    it('sets an HttpOnly seamnex_session and a readable seamnex_csrf for an MFA-satisfied session', () => {
      expect(session.authenticated).toBe(true);
      expect(session.subject?.idpId).toBe('stub:dev-admin');
      expect(session.mfaSatisfied).toBe(true);
      expect(cookies).toHaveLength(2);
      const sessionCookie = cookies.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`)) ?? '';
      const csrfCookie = cookies.find((entry) => entry.startsWith(`${CSRF_COOKIE}=`)) ?? '';
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toContain('SameSite=Lax');
      // Readable by the SPA on purpose: it echoes the value in x-seamnex-csrf, and the server-side
      // binding is what makes a forged cookie insufficient.
      expect(csrfCookie).not.toBe('');
      expect(csrfCookie).not.toContain('HttpOnly');
    });

    it('renews both cookies while the session is in use (sliding idle lifetime)', async () => {
      const result = await request('GET', '/api/v1/me', { cookie });

      expect(result.status).toBe(200);
      const renewed = setCookies(result.headers);
      const sessionCookie = renewed.find((entry) => entry.startsWith(`${SESSION_COOKIE}=`)) ?? '';
      // Without the renewal the browser drops the cookie at the deadline computed at sign-in, even
      // though the server keeps touching `lastSeen` for an active user.
      expect(sessionCookie, 'an authenticated response must renew seamnex_session').not.toBe('');
      expect(sessionCookie).toContain('HttpOnly');
      expect(sessionCookie).toMatch(/Max-Age=[1-9]\d*/);
    });

    it('reuses the cookie on GET /me and reports identity, roles and MFA state', async () => {
      const result = await request('GET', '/api/v1/me', { cookie });

      expect(result.status).toBe(200);
      const me = MeSchema.parse(json(result));
      expect(me.id).toBe('stub:dev-admin');
      expect(me.roles.length).toBeGreaterThan(0);
      expect(me.mfaSatisfied).toBe(true);
      // `role_binding` is seeded data, not schema: a fresh database legitimately has none, and the
      // profile then reports the role the provider asserted in the session.
      if (await hasRoleBinding('stub:dev-admin')) {
        expect(me.username).toBe('dev-admin');
        expect(me.primaryRole).toBe('R1');
      }
    });

    it('refuses POST /me/logout without x-seamnex-csrf', async () => {
      // The origin check runs first, so the Origin header is present and only the token is missing.
      const result = await request('POST', '/api/v1/me/logout', { cookie, origin: ORIGIN });

      expect(result.status).toBe(403);
      expect(problemCode(result)).toBe('CSRF_FAILED');
    });

    it('signs out with the cookie, the token and an allowed origin', async () => {
      /*
       * ADR-BE-22 §Session reuse — "drop on any signal". The unit suite asserts the key walk against a
       * double; this is the only place revocation is observed against the real Redis, which is what
       * "the cached product session is gone" actually means.
       */
      const subject = session.subject?.idpId ?? 'stub:dev-admin';
      const cached = `relay:instance-integration:${subject}`;
      await redis.set(cached, '{"cookies":["p=1"]}', 'EX', 60);

      const headers = { cookie, origin: ORIGIN, 'x-seamnex-csrf': session.csrfToken ?? '' };
      const result = await request('POST', '/api/v1/me/logout', headers);

      expect(result.status).toBe(200);
      expect(await redis.keys(`relay:*:${subject}`)).toEqual([]);
      const body = LogoutResponseSchema.parse(json(result));
      expect(body.statement.length).toBeGreaterThan(0);
      // An unverified product lifetime is `null`; the statement says so rather than inventing a time.
      for (const residual of body.residualSessions) {
        expect(typeof residual.instanceId).toBe('string');
        expect(residual.maxRemainingMinutes === null || residual.maxRemainingMinutes >= 0).toBe(
          true,
        );
      }
    });
  });
});

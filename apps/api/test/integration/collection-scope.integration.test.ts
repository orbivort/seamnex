import { createHash, randomBytes } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthSessionSchema,
  type AuditEvent,
  type CapacitySnapshot,
  type CatalogEntry,
  type ForecastPoint,
  type Instance,
  type JobPage,
} from '@seamnex/domain';
import { createApplication } from '../../src/bootstrap/create-app';
import { loadConfig } from '../../src/config/config';
import { policyRefusalDetail } from '../../src/contract/guards/policy.guard';

/**
 * ADR-BE-44 — the four unaddressed reads a scoped grant used to be refused.
 *
 * Before the change, `/instances`, `/jobs`, `/capacity` and `/capacity/forecast` resolved to
 * `{type:'instance', id:''}`, so the PDP had no id to resolve a domain from and answered 403 to a
 * role that held the capability at `scoped` level. R3 (`dev-owner`, bound to `CRM & Sales
 * Pipeline`) is that role. The fix decides from the grant itself, publishes the predicate on the
 * request context and lets the handler filter, which is what these cases observe from outside:
 * `200`, and rows confined to the caller's domain.
 *
 * Two rules shape the assertions:
 *
 *   - the **catalogue is the oracle**. The list filters join `catalog_entry.domain`, so "belongs to
 *     the CRM domain" is read from the platform-wide `GET /catalog` answer (as R1), never from the
 *     instance's own `domain` field, which the deployment document may have set independently;
 *   - **every case must be able to fail**. On a host whose seed deploys nothing, a row-by-row loop
 *     checks nothing, so the cases that would become vacuous say so in place and fall back to the
 *     status assertion, which is the regression the suite exists for.
 */
const canRun =
  (process.env.DATABASE_URL ?? '').length > 0 && (process.env.REDIS_URL ?? '').length > 0;
const skipReason = canRun
  ? false
  : 'Set DATABASE_URL and REDIS_URL to boot the API for the scoped collection suite.';

/**
 * Each role signs in from its own `x-forwarded-for` so the per-client sign-in bucket does not
 * collapse four identities into one allowance. Fastify only honours that header when `trustProxy`
 * is on, and `TRUST_PROXY` is unset in a bare shell by design (ADR-BE-13).
 */
process.env.TRUST_PROXY ??= '1';

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'seamnex_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'seamnex_csrf';
const ORIGIN =
  (process.env.APP_ORIGINS ?? 'http://localhost:5173').split(',')[0]?.trim() ??
  'http://localhost:5173';
const BASE = '/api/v1';

/** The domain the seeded R3 (`dev-owner`) is bound to, verbatim from `dev-seed.ts`. */
const CRM_DOMAIN = 'CRM & Sales Pipeline';

type Role = 'R1' | 'R2' | 'R3' | 'R5';

/**
 * Only four of the six seeded identities are needed: R1 and R2 are the platform-wide reference,
 * R3 is the domain-scoped subject under test, and R5 holds `instance.view_logs` at `none` — the
 * role that would be widened by a fix that answered "allowed" without a scope.
 */
const DIRECTORY: Readonly<Record<Role, string>> = {
  R1: 'dev-admin',
  R2: 'dev-auditor',
  R3: 'dev-owner',
  R5: 'dev-user',
};
/** AC-46: the two roles whose directory accounts have a second factor enrolled. */
const MFA_ROLES: ReadonlySet<Role> = new Set<Role>(['R1', 'R2']);

type HttpHeaders = Readonly<Record<string, string | number | string[] | undefined>>;
type HttpResult = { readonly status: number; readonly headers: HttpHeaders; readonly text: string };
type Session = { readonly cookie: string; readonly csrfToken: string; readonly sub: string };

const SESSIONS = new Map<Role, Session>();

/**
 * The platform-wide read, captured once as R1: the catalogue's key→domain projection and the whole
 * fleet. Both are the oracle the scoped answers are measured against, so they are read through the
 * API rather than the pool — a fixture inserted by hand would prove the query right against a
 * shape the platform itself never produces.
 */
const DOMAIN_OF_ENTRY = new Map<string, string>();
let FLEET: readonly Instance[] = [];
const CRM_INSTANCE_IDS = new Set<string>();
let OUTSIDE_INSTANCE_IDS: readonly string[] = [];
let OUTSIDE_ENTRY_KEYS: readonly string[] = [];

let app: NestFastifyApplication | undefined;
let server: FastifyInstance;

beforeAll(async () => {
  if (!canRun) return;
  app = await createApplication(loadConfig());
  await app.init();
  server = app.getHttpAdapter().getInstance() as FastifyInstance;

  for (const [index, role] of (['R1', 'R2', 'R3', 'R5'] as const).entries()) {
    SESSIONS.set(role, await openSession(role, `10.44.0.${index + 1}`));
  }

  const catalogue = json(await get(`${BASE}/catalog`, sessionFor('R1').cookie));
  if (!Array.isArray(catalogue)) throw new Error('GET /catalog did not answer with a list');
  for (const entry of catalogue as CatalogEntry[]) DOMAIN_OF_ENTRY.set(entry.key, entry.domain);

  const fleet = json(await get(`${BASE}/instances`, sessionFor('R1').cookie));
  if (!Array.isArray(fleet)) throw new Error('GET /instances did not answer with a list for R1');
  FLEET = fleet as Instance[];

  const outsideIds: string[] = [];
  const outsideKeys = new Set<string>();
  for (const instance of FLEET) {
    if (domainOf(instance) === CRM_DOMAIN) {
      CRM_INSTANCE_IDS.add(instance.id);
    } else {
      outsideIds.push(instance.id);
      outsideKeys.add(instance.entryKey);
    }
  }
  OUTSIDE_INSTANCE_IDS = outsideIds;
  OUTSIDE_ENTRY_KEYS = [...outsideKeys];
});

afterAll(async () => {
  if (!canRun) return;
  await app?.close().catch(() => undefined);
});

async function request(method: 'GET', url: string, cookie: string): Promise<HttpResult> {
  const response = await server.inject({ method, url, headers: { cookie } });
  return { status: response.statusCode, headers: response.headers, text: response.body };
}

/** Every read in this suite is a `GET`; the sign-in path below is the only other verb it sends. */
async function get(url: string, cookie: string): Promise<HttpResult> {
  return request('GET', url, cookie);
}

function json(result: HttpResult): unknown {
  return result.text.length === 0 ? null : (JSON.parse(result.text) as unknown);
}

/** The domain the list filters join on for this instance, or `undefined` when the entry is absent. */
function domainOf(instance: Instance): string | undefined {
  return DOMAIN_OF_ENTRY.get(instance.entryKey);
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
async function openSession(role: Role, forwardFor: string): Promise<Session> {
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
    url: `${BASE}/auth/session`,
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

  const current = AuthSessionSchema.parse(json(await get(`${BASE}/auth/session`, issued)));
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

function sessionFor(role: Role): Session {
  const session = SESSIONS.get(role);
  if (session === undefined)
    throw new Error(`no session for ${role}: the beforeAll sign-in did not run`);
  return session;
}

/** The newest sequence number the trail holds, read through the audit API as R2. */
async function newestSeq(): Promise<number> {
  const result = await get(`${BASE}/audit-events?limit=1`, sessionFor('R2').cookie);
  if (result.status !== 200) {
    throw new Error(`GET /audit-events as R2 answered ${result.status}: ${result.text}`);
  }
  const page = json(result) as { items: AuditEvent[] };
  return page.items[0]?.seq ?? 0;
}

describe.skipIf(skipReason !== false)('scoped collection reads (ADR-BE-44)', () => {
  /**
   * The regression itself: 403 → 200 for a role that holds the capability at `scoped` level. That
   * assertion is independent of the data, which matters because the dev seed projects a catalogue
   * but deploys nothing — on such a host the body is `[]` and the per-row checks below are empty,
   * so the status is the evidence.
   */
  it('answers a domain-scoped list with its own instances instead of a 403', async () => {
    const result = await get(`${BASE}/instances`, sessionFor('R3').cookie);
    expect(result.status, `R3 GET /instances: ${result.text}`).toBe(200);

    const rows = json(result) as Instance[];
    expect(Array.isArray(rows), `GET /instances must answer with a list: ${result.text}`).toBe(
      true,
    );

    for (const row of rows) {
      // The filter joins `catalog_entry.domain`, so that is the property asserted — not the
      // instance's own `domain` field, which the deployment document can spell differently.
      expect(domainOf(row), `R3 may not see ${row.id} of ${row.entryKey}`).toBe(CRM_DOMAIN);
    }

    const scoped = new Set(rows.map((row) => row.id));
    const platform = new Set(FLEET.map((row) => row.id));
    // A scoped read can never reach a row the platform-wide read does not hold.
    expect(
      [...scoped].filter((id) => !platform.has(id)),
      'a scoped list must not exceed the platform-wide list',
    ).toEqual([]);
    // ...and a row of the caller's own domain must not be hidden from it: the fix is a filter, not
    // a refusal dressed up as an empty page.
    expect(
      [...CRM_INSTANCE_IDS].filter((id) => !scoped.has(id)),
      'a scoped list must not hide an instance of the caller’s own domain',
    ).toEqual([]);

    const outside = OUTSIDE_ENTRY_KEYS[0];
    if (outside !== undefined) {
      // A query filter narrows the set the scope already confined; it can never widen it. Asked for
      // an entry outside the grant, the route answers an empty list rather than a refusal.
      const filtered = await get(
        `${BASE}/instances?entryKey=${encodeURIComponent(outside)}`,
        sessionFor('R3').cookie,
      );
      expect(filtered.status, `R3 GET /instances?entryKey=${outside}: ${filtered.text}`).toBe(200);
      expect(json(filtered)).toEqual([]);
    }
  });

  /**
   * The same answer for jobs, whose reach is their instance's: the domain behind the job's
   * `entry_key`, and `NULL` for platform work (a catalogue reload, a verification).
   */
  it('lists only jobs of the caller’s domain', async () => {
    const result = await get(`${BASE}/jobs?limit=100`, sessionFor('R3').cookie);
    expect(result.status, `R3 GET /jobs: ${result.text}`).toBe(200);

    const page = json(result) as JobPage;
    expect(Array.isArray(page.items), `GET /jobs must answer with a page: ${result.text}`).toBe(
      true,
    );

    for (const job of page.items) {
      /*
       * ADR-BE-44 makes `instance_id IS NOT NULL` part of the scoped predicate: a job with no
       * instance is platform work, and no scoped grant contains the platform. So a null instance
       * here is a leak rather than a tolerated case.
       */
      expect(
        job.instanceId,
        `job ${job.id} has no instance and must not reach a scoped caller`,
      ).not.toBeNull();

      // The instance is authoritative when the row has one; `entry_key` is the job's own record of
      // it, which is all a page holds once the join is gone.
      const entryKey =
        FLEET.find((row) => row.id === job.instanceId)?.entryKey ?? job.entryKey ?? '';
      expect(DOMAIN_OF_ENTRY.get(entryKey), `job ${job.id} belongs to ${entryKey}`).toBe(
        CRM_DOMAIN,
      );
    }

    // `total` describes the filtered set: a page of rows the caller cannot see is not a page.
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);

    const outside = OUTSIDE_INSTANCE_IDS[0];
    if (outside !== undefined) {
      // A filter that names an instance outside the grant answers an empty page, not a refusal and
      // not that instance's jobs.
      const filtered = await get(
        `${BASE}/jobs?limit=100&instanceId=${outside}`,
        sessionFor('R3').cookie,
      );
      expect(filtered.status, `R3 GET /jobs?instanceId=${outside}: ${filtered.text}`).toBe(200);
      const empty = json(filtered) as JobPage;
      expect(empty.items, 'an out-of-domain instance has no jobs this caller may see').toEqual([]);
      expect(empty.total).toBe(0);
    }
  });

  /**
   * Capacity is the one surface where a scope applies to part of the document: `instanceUsage` is
   * confined, while `host`, `allocated`, `verdict` and `forecast` describe the machine and stay
   * platform-wide (a board whose numbers did not add up to its verdict would be worse than a
   * narrower table).
   */
  it('confines the capacity table to the caller’s domain and keeps the host figures', async () => {
    const result = await get(`${BASE}/capacity`, sessionFor('R3').cookie);
    expect(result.status, `R3 GET /capacity: ${result.text}`).toBe(200);

    const snapshot = json(result) as CapacitySnapshot;
    // Host totals and the verdict are present and platform-wide: they are the machine, not a tenant.
    expect(snapshot.host.cpuCores).toBeGreaterThan(0);
    expect(snapshot.host.memoryMb).toBeGreaterThan(0);
    expect(typeof snapshot.verdict.admissible).toBe('boolean');
    expect(snapshot.verdict.headline.length).toBeGreaterThan(0);
    expect(Array.isArray(snapshot.forecast)).toBe(true);

    for (const usage of snapshot.instanceUsage) {
      const entryKey = FLEET.find((row) => row.id === usage.instanceId)?.entryKey ?? usage.entryKey;
      expect(DOMAIN_OF_ENTRY.get(entryKey), `capacity row ${usage.instanceId} (${entryKey})`).toBe(
        CRM_DOMAIN,
      );
    }

    // The scoped table is a subset of the platform-wide one: R3 loses rows, never gains one.
    const platform = json(
      await get(`${BASE}/capacity`, sessionFor('R1').cookie),
    ) as CapacitySnapshot;
    const platformIds = new Set(platform.instanceUsage.map((row) => row.instanceId));
    expect(
      snapshot.instanceUsage.map((row) => row.instanceId).filter((id) => !platformIds.has(id)),
      'a scoped capacity table must be a subset of the platform-wide table',
    ).toEqual([]);
  });

  /** Listed next to `/capacity` because one screen reads both; a refused sparkline is not a screen. */
  it('answers the capacity forecast for a domain-scoped caller', async () => {
    const result = await get(`${BASE}/capacity/forecast`, sessionFor('R3').cookie);
    expect(result.status, `R3 GET /capacity/forecast: ${result.text}`).toBe(200);

    const points = json(result) as ForecastPoint[];
    expect(Array.isArray(points), `GET /capacity/forecast must answer with a list`).toBe(true);
    for (const point of points) {
      expect(point.day.length).toBeGreaterThan(0);
      expect(point.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(point.cpuPercent).toBeLessThanOrEqual(100);
    }
  });

  /**
   * Addressing an instance is **not** a collection read: `/instances/:id` still resolves the
   * resource, so an instance outside the grant is refused by the policy layer. `403` alone is not
   * proof — a handler refuses business rules with the same status — so the case asserts the
   * policy layer's own wording.
   */
  it('still refuses an instance outside the caller’s domain', async (context) => {
    const outside = OUTSIDE_INSTANCE_IDS[0];
    if (outside === undefined) {
      // Documented skip: the seeded fleet holds no instance outside CRM & Sales Pipeline, so there
      // is nothing to refuse. With a populated fleet this case proves the addressed read kept its
      // scoped resolution instead of inheriting the collection answer.
      context.skip('the seeded fleet has no instance outside the caller’s domain');
      return;
    }

    const result = await get(`${BASE}/instances/${outside}`, sessionFor('R3').cookie);
    expect(result.status, `R3 GET /instances/${outside}: ${result.text}`).toBe(403);
    const body = json(result) as { detail?: unknown };
    expect(body.detail).toBe(policyRefusalDetail('instance.view_logs'));
  });

  /** The other half of "did not widen": a role holding the capability at `none` is still refused. */
  it('still refuses a role that holds nothing', async () => {
    const result = await get(`${BASE}/instances`, sessionFor('R5').cookie);
    expect(result.status, `R5 GET /instances: ${result.text}`).toBe(403);

    const body = json(result) as { detail?: unknown };
    // The refusal has to be the policy layer's, not a handler's own 403.
    expect(body.detail).toBe(policyRefusalDetail('instance.view_logs'));
  });

  /**
   * The contrast that makes the whole change meaningful: a `full` grant answers the same routes
   * with the whole fleet, including the instances R3's domain does not reach.
   */
  it('leaves the platform-wide reads unfiltered for the two full-access roles', async () => {
    for (const role of ['R1', 'R2'] as const) {
      for (const path of ['/instances', '/jobs?limit=100', '/capacity'] as const) {
        const result = await get(`${BASE}${path}`, sessionFor(role).cookie);
        expect(result.status, `${role} GET ${path}: ${result.text}`).toBe(200);
      }
    }

    const auditor = json(await get(`${BASE}/instances`, sessionFor('R2').cookie)) as Instance[];
    const visible = new Set(auditor.map((row) => row.id));
    expect(
      FLEET.map((row) => row.id).filter((id) => !visible.has(id)),
      'R2 must see the whole fleet R1 sees',
    ).toEqual([]);
    expect(
      OUTSIDE_INSTANCE_IDS.filter((id) => !visible.has(id)),
      'R2 must see the instances R3’s domain does not reach',
    ).toEqual([]);
  });

  /**
   * A collection allow is deliberately never cached (the cache stores the literal `'allow'`, which
   * would come back without the scope and leave the handler unable to filter), and an allow writes
   * no `access.denied` row. This case proves the second half from the evidence trail.
   *
   * It runs after the addressed refusal above, which is why it takes its own mark: a denial of
   * `/instances/:id` is expected and is an `instance` target, while a denial of a *collection* read
   * names the collection. Any row newer than the mark with a `collection` target is a regression.
   */
  it('records no denial for a collection read it allowed', async () => {
    const mark = await newestSeq();
    for (const path of ['/instances', '/jobs?limit=1', '/capacity', '/capacity/forecast']) {
      const result = await get(`${BASE}${path}`, sessionFor('R3').cookie);
      // `capacity` answers 404 on a host whose filesystem cannot be measured; that is not a policy
      // refusal, which is what this case is about. A lapsed or refused session would be.
      expect([401, 403], `R3 GET ${path} must not be refused: ${result.text}`).not.toContain(
        result.status,
      );
    }

    const actor = encodeURIComponent(sessionFor('R3').sub);
    const trail = await get(
      `${BASE}/audit-events?action=access.denied&actor=${actor}&limit=100`,
      sessionFor('R2').cookie,
    );
    expect(trail.status, `R2 GET /audit-events: ${trail.text}`).toBe(200);

    const page = json(trail) as { items: AuditEvent[] };
    const fresh = page.items.filter((event) => event.seq > mark);
    expect(
      fresh
        .filter((event) => event.targetType === 'collection')
        .map((event) => `${event.seq}:${event.targetId}`),
      'an allowed collection read must not leave a refusal behind',
    ).toEqual([]);
  });
});

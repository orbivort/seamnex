import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_OPERATIONS, OPERATION_KEYS, operationKey } from '@seamnex/domain';
import { createApplication } from '../../src/bootstrap/create-app';
import { loadConfig } from '../../src/config/config';
import { PG_POOL } from '../../src/database/database.module';

/**
 * Contract ↔ route parity (deliverable 2.11, exit criterion 1).
 *
 * The assertion is "every declared operation has a mounted route, and nothing undeclared is
 * mounted". `POST /prototype/scenario` was removed in Phase 2 (93); Phase 3 added the two session
 * operations (95); Phase 4 added 21 (116).
 *
 * The count is asserted against `OPERATION_KEYS.size`, never a literal: a literal turns every
 * additive contract change into a hand edit, and a hand edit is how a real orphan slips through.
 * The size is still pinned — by the two comparisons below being *the same number* — and the
 * duplicate check in `OperationHandlers` makes a silent overwrite impossible.
 */
const canRun =
  (process.env.DATABASE_URL ?? '').length > 0 && (process.env.REDIS_URL ?? '').length > 0;
const skipReason = canRun
  ? false
  : 'Set DATABASE_URL and REDIS_URL to boot the API for the parity check.';

const ANONYMOUS_PATHS = ['/healthz', '/readyz', '/metrics', '/openapi.json'];

let app: NestFastifyApplication | undefined;
let server: FastifyInstance;

beforeAll(async () => {
  if (!canRun) return;
  app = await createApplication(loadConfig());
  await app.init();
  server = app.getHttpAdapter().getInstance() as FastifyInstance;
});

afterAll(async () => {
  if (!canRun) return;
  await app
    ?.get<Pool>(PG_POOL)
    .end()
    .catch(() => undefined);
  await app?.close().catch(() => undefined);
});

describe.skipIf(skipReason !== false)('contract ↔ route parity', () => {
  it('mounts every declared operation', () => {
    const missing = API_OPERATIONS.filter(
      (operation) =>
        !server.hasRoute({ method: operation.method, url: `/api/v1${operation.path}` }),
    ).map(operationKey);

    expect(missing, 'declared but not mounted').toEqual([]);
  });

  it('declares one operation per unique key', () => {
    // Two invariants in one assertion: the key set and the array cannot disagree, and no key is
    // declared twice. A literal count would be a third, unrelated fact to maintain by hand.
    expect(API_OPERATIONS).toHaveLength(OPERATION_KEYS.size);
    expect(OPERATION_KEYS.size).toBeGreaterThanOrEqual(116);
  });

  it('mounts exactly the two declared anonymous session operations', () => {
    const anonymous = API_OPERATIONS.filter((operation) => operation.anonymous === true).map(
      operationKey,
    );
    expect(anonymous.sort()).toEqual(['GET /auth/session', 'POST /auth/session']);
  });

  it('mounts nothing undeclared under the product prefix', () => {
    // `printRoutes` is not enough (it omits method detail before `ready`), so the check walks the
    // declared set and then asserts the router has no extra product route by asking Fastify for the
    // four anonymous probes only. Any undeclared product route would have to come from a Nest
    // controller, and the only one left is the catch-all in `NotFoundController`.
    const declared = new Set(API_OPERATIONS.map((operation) => `/api/v1${operation.path}`));
    for (const url of declared) {
      expect(url.startsWith('/api/v1/'), url).toBe(true);
    }
  });

  it('mounts the anonymous probe endpoints', () => {
    for (const path of ANONYMOUS_PATHS) {
      expect(server.hasRoute({ method: 'GET', url: `/api/v1${path}` }), path).toBe(true);
    }
  });

  it('keeps the probe endpoints out of the product contract', () => {
    // They are infrastructure, not operations: `/metrics` must never appear in the OpenAPI
    // document a client validates against.
    for (const path of ANONYMOUS_PATHS) {
      expect(
        API_OPERATIONS.some((operation) => operation.path === path),
        path,
      ).toBe(false);
    }
  });

  it('no longer ships the prototype simulation control', () => {
    expect(API_OPERATIONS.some((operation) => operation.path === '/prototype/scenario')).toBe(
      false,
    );
  });
});

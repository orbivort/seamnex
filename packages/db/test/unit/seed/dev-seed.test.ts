import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeCheckout } from './sample-entry';

/**
 * The seed is a script, like `cli.ts`: it loads the environment, resolves subject ids from the
 * identity provider, writes inside one transaction and exits. Its collaborators (`createPool`,
 * `loadRootEnv`, the provider's HTTP API) are mocked and the module is imported per case, so the
 * transaction handling and the exit codes are tested without a database or a Keycloak realm.
 */
const doubles = vi.hoisted(() => ({
  createPool: vi.fn(),
  loadRootEnv: vi.fn(),
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  end: vi.fn(),
}));

vi.mock('../../../src/client', () => ({ createPool: doubles.createPool }));
/*
 * Only the `.env` load is doubled. `REPOSITORY_ROOT` is a path constant the seed resolves its
 * fixtures against, and stubbing it would make the suite read a directory of the test's invention —
 * the fixtures would then be "found" wherever the double said, which is the failure this suite is
 * meant to catch.
 */
vi.mock('../../../src/env', async (importOriginal) => ({
  ...(await importOriginal()),
  loadRootEnv: doubles.loadRootEnv,
}));

const CONNECTION = 'postgres://seamnex:seamnex@localhost:5432/seamnex';
const originalEnv = {
  AUTH_PROVIDER: process.env.AUTH_PROVIDER,
  SEAMNEX_KEYCLOAK_ADMIN_URL: process.env.SEAMNEX_KEYCLOAK_ADMIN_URL,
  SEAMNEX_KEYCLOAK_REALM: process.env.SEAMNEX_KEYCLOAK_REALM,
  KEYCLOAK_PUBLIC_URL: process.env.KEYCLOAK_PUBLIC_URL,
  KEYCLOAK_REALM: process.env.KEYCLOAK_REALM,
  SEAMNEX_CATALOG_REPO_PATH: process.env.SEAMNEX_CATALOG_REPO_PATH,
};

/**
 * The working tree each run writes into. A temporary directory, never the repository's own `temp/`:
 * the seed creates `catalog/` and its documents, and a unit test that did that in place would be
 * indistinguishable from an operator preparing a catalogue.
 */
const trees: string[] = [];
let currentTree = '';

let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  doubles.createPool.mockReturnValue({ connect: doubles.connect, end: doubles.end });
  doubles.connect.mockResolvedValue({ query: doubles.query, release: doubles.release });
  doubles.query.mockResolvedValue({ rows: [], rowCount: 1 });
  doubles.end.mockResolvedValue(undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const directory of trees.splice(0)) rmSync(directory, { recursive: true, force: true });
  process.exitCode = undefined;
});

async function runSeed(
  env: Record<string, string | undefined>,
  /** Runs against the fresh tree before the seed reads it, for the "tree already there" cases. */
  prepare?: (tree: string) => void,
): Promise<number | string | undefined> {
  const previousExitCode = process.exitCode;
  currentTree = mkdtempSync(join(tmpdir(), 'seamnex-seed-'));
  trees.push(currentTree);
  prepare?.(currentTree);
  for (const [key, value] of Object.entries({
    ...env,
    SEAMNEX_CATALOG_REPO_PATH: currentTree,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.exitCode = undefined;

  vi.resetModules();
  try {
    await import('../../../src/seed/dev-seed');
    await vi.waitFor(() => {
      expect(process.exitCode).toBeDefined();
    });
    return process.exitCode;
  } finally {
    process.exitCode = previousExitCode;
  }
}

/** Statements issued through the client, in order. */
function statements(): string[] {
  return doubles.query.mock.calls.map((call) => String(call[0]));
}

/** The parameter arrays of every statement whose text contains `fragment`. */
function paramsFor(fragment: string): unknown[][] {
  return doubles.query.mock.calls
    .filter((call) => String(call[0]).includes(fragment))
    .map((call) => call[1] as unknown[]);
}

function stubResponse(body: unknown): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function refusedResponse(status: number): {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
} {
  return { ok: false, status, json: () => Promise.resolve({}) };
}

/** A provider that hands out a token and one id per username. */
function stubKeycloak(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((input: unknown) => {
    const url = String(input);
    if (url.includes('/realms/master/protocol/openid-connect/token')) {
      return Promise.resolve(stubResponse({ access_token: 'admin-token' }));
    }
    const username = new URL(url).searchParams.get('username') ?? 'unknown';
    return Promise.resolve(stubResponse([{ id: `kc-${username}` }]));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('development seed under the stub provider', () => {
  it('mirrors the six identities, their group tree and their platform grants', async () => {
    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    expect(code).toBe(0);
    expect(doubles.loadRootEnv).toHaveBeenCalledTimes(1);
    expect(doubles.createPool).toHaveBeenCalledWith({
      connectionString: CONNECTION,
      max: 2,
      applicationName: 'seamnex-seed',
    });

    const issued = statements();
    expect(issued[0]).toBe('BEGIN');
    expect(issued.at(-1)).toBe('COMMIT');

    const users = paramsFor('INSERT INTO idp_user');
    expect(users.map((params) => params[0])).toEqual([
      'stub:dev-admin',
      'stub:dev-auditor',
      'stub:dev-owner',
      'stub:dev-product',
      'stub:dev-user',
      'stub:dev-guest',
    ]);
    // The email and display name are derived, so a seeded row is legible in the console.
    expect(users[0]?.[1]).toBe('dev-admin');
    expect(users[0]?.[2]).toBe('dev-admin@seamnex.local');
    // dev-admin and dev-auditor enrol in MFA; the rest do not.
    expect(users.map((params) => params[4])).toEqual([true, true, false, false, false, false]);

    expect(paramsFor('INSERT INTO idp_group_member (')).toHaveLength(9);
    expect(logSpy).toHaveBeenCalledWith('development identity data seeded (6 users)');
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.end).toHaveBeenCalledTimes(1);
  });

  it('creates each group path once, ancestors first, with a parent link', async () => {
    await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    const groups = paramsFor('INSERT INTO idp_group (');
    expect(groups.map((params) => params[1])).toEqual([
      '/seamnex-admins',
      '/seamnex-auditors',
      '/seamnex-domain-owners',
      '/seamnex-domains',
      '/seamnex-domains/revenue-customer',
      '/seamnex-product-admins',
      '/seamnex-instances',
      '/seamnex-instances/core-crm',
      '/seamnex-users',
      '/seamnex-guests',
      '/seamnex-instances/finance-suite',
    ]);
    // `idp_group.parent_id` is a foreign key, so an ancestor must exist before its child.
    expect(groups[2]).toEqual(['seamnex-domain-owners', '/seamnex-domain-owners', null]);
    expect(groups[3]).toEqual(['seamnex-domains', '/seamnex-domains', null]);
    expect(groups[4]).toEqual([
      'seamnex-domains-revenue-customer',
      '/seamnex-domains/revenue-customer',
      'seamnex-domains',
    ]);
    // A shared ancestor is written once, not once per child.
    expect(groups.filter((params) => params[1] === '/seamnex-instances')).toHaveLength(1);
  });

  it('writes a grant only where the role has a referent, and keys it on the resolved subject', async () => {
    await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    const grants = paramsFor('INSERT INTO role_binding');
    // R4 and R6 are instance-scoped and this seed creates no instances, so they get no row.
    expect(grants.map((params) => [params[0], params[1], params[2], params[3]])).toEqual([
      ['stub:dev-admin', 'R1', 'platform', null],
      ['stub:dev-auditor', 'R2', 'platform', null],
      // A catalog domain, not the cluster that groups D1-D4: `PdpService` and FR-5.9 compare the
      // scope with `catalog_entry.domain`, so a cluster name resolved to no product at all.
      ['stub:dev-owner', 'R3', 'domain', 'CRM & Sales Pipeline'],
      ['stub:dev-user', 'R5', 'platform', null],
    ]);
  });

  it('writes no stub-era cleanup in stub mode', async () => {
    await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    // The provider-switch cleanup is what must not run under the stub. A grant whose scope moved
    // between releases is reconciled in both modes: it deletes by subject and scope, never by the
    // `stub:%` predicate that marks a retired identity.
    expect(statements().filter((sql) => sql.includes("LIKE 'stub:%'"))).toEqual([]);
  });

  it('refuses to start without DATABASE_URL', async () => {
    const code = await runSeed({ DATABASE_URL: undefined, AUTH_PROVIDER: undefined });

    expect(code).toBe(1);
    expect(doubles.createPool).not.toHaveBeenCalled();
    expect(doubles.end).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]?.[0]).toBe('DATABASE_URL is required to seed development data.');
  });

  it('reconciles a development grant whose scope moved between releases', async () => {
    await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    // R3 used to be seeded against the cluster "Revenue & Customer", which matches no
    // `catalog_entry.domain`. A re-seed has to remove that row, otherwise the operator keeps a grant
    // that resolves to nothing and gains a second one beside it.
    expect(paramsFor('DELETE FROM role_binding')).toContainEqual([
      'stub:dev-owner',
      'R3',
      'domain',
      'CRM & Sales Pipeline',
    ]);
  });

  it('treats an empty DATABASE_URL as absent', async () => {
    const code = await runSeed({ DATABASE_URL: '', AUTH_PROVIDER: undefined });

    expect(code).toBe(1);
    expect(doubles.createPool).not.toHaveBeenCalled();
  });

  it('rolls back, releases and reports a failing write', async () => {
    doubles.query.mockImplementation((sql: unknown) => {
      if (String(sql).includes('role_binding')) {
        return Promise.reject(new Error('permission denied for table'));
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    expect(code).toBe(1);
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
    expect(errorSpy.mock.calls[0]?.[0]).toBe('permission denied for table');
    expect(doubles.release).toHaveBeenCalledTimes(1);
    expect(doubles.end).toHaveBeenCalledTimes(1);
  });

  it('keeps the original failure when ROLLBACK is not possible either', async () => {
    doubles.query.mockImplementation((sql: unknown) => {
      const text = String(sql);
      if (text === 'BEGIN') return Promise.reject(new Error('could not begin'));
      if (text === 'ROLLBACK') return Promise.reject(new Error('connection already closed'));
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('could not begin');
  });

  it('stringifies a non-Error failure', async () => {
    doubles.query.mockRejectedValue('backend closed the connection');

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    expect(code).toBe(1);
    expect(errorSpy.mock.calls[0]?.[0]).toBe('backend closed the connection');
  });
});

describe('development seed under an OIDC provider', () => {
  it('resolves the provider-side subject ids instead of guessing them', async () => {
    const fetchMock = stubKeycloak();

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: 'oidc' });

    expect(code).toBe(0);
    // One token exchange plus one exact lookup per account.
    expect(fetchMock).toHaveBeenCalledTimes(7);
    const tokenCall = fetchMock.mock.calls[0];
    expect(String(tokenCall?.[0])).toContain('/realms/master/protocol/openid-connect/token');
    expect(paramsFor('INSERT INTO idp_user').map((params) => params[0])).toEqual([
      'kc-dev-admin',
      'kc-dev-auditor',
      'kc-dev-owner',
      'kc-dev-product',
      'kc-dev-user',
      'kc-dev-guest',
    ]);
    expect(logSpy).toHaveBeenCalledWith('development identity data seeded (6 users)');
  });

  it('sends the bootstrap token when looking an account up', async () => {
    const fetchMock = stubKeycloak();

    await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: 'oidc' });

    const lookup = fetchMock.mock.calls[1];
    const init = lookup?.[1] as { headers: Record<string, string> } | undefined;
    expect(init?.headers.authorization).toBe('Bearer admin-token');
    expect(String(lookup?.[0])).toContain(
      '/admin/realms/seamnex/users?username=dev-admin&exact=true',
    );
  });

  it('retires the stub-era rows before writing provider-keyed ones', async () => {
    stubKeycloak();

    await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: 'oidc' });

    const issued = statements();
    const entitlements = issued.findIndex((sql) => sql.includes('DELETE FROM entitlement'));
    const bindings = issued.findIndex((sql) => sql.includes('DELETE FROM role_binding'));
    const users = issued.findIndex((sql) => sql.includes('DELETE FROM idp_user'));
    const firstInsert = issued.findIndex((sql) => sql.includes('INSERT INTO idp_user'));

    expect(entitlements).toBeGreaterThanOrEqual(0);
    expect(bindings).toBeGreaterThan(entitlements);
    expect(users).toBeGreaterThan(bindings);
    expect(firstInsert).toBeGreaterThan(users);
  });

  it('uses the configured realm and Keycloak URL', async () => {
    const fetchMock = stubKeycloak();

    const code = await runSeed({
      DATABASE_URL: CONNECTION,
      AUTH_PROVIDER: 'oidc',
      SEAMNEX_KEYCLOAK_ADMIN_URL: 'http://kc.internal:8080',
      SEAMNEX_KEYCLOAK_REALM: 'seamnex',
    });

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://kc.internal:8080/realms/master/protocol/openid-connect/token',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/admin/realms/seamnex/users');
  });

  it('prefers the SEAMNEX_ names over the pre-Seamnex spelling', async () => {
    const fetchMock = stubKeycloak();

    const code = await runSeed({
      DATABASE_URL: CONNECTION,
      AUTH_PROVIDER: 'oidc',
      SEAMNEX_KEYCLOAK_ADMIN_URL: 'http://kc.current:8080',
      SEAMNEX_KEYCLOAK_REALM: 'seamnex',
      KEYCLOAK_PUBLIC_URL: 'http://kc.legacy:8080',
      KEYCLOAK_REALM: 'legacy',
    });

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://kc.current:8080/realms/master/protocol/openid-connect/token',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/admin/realms/seamnex/users');
  });

  it('still reads the pre-Seamnex names when the new ones are absent', async () => {
    const fetchMock = stubKeycloak();

    const code = await runSeed({
      DATABASE_URL: CONNECTION,
      AUTH_PROVIDER: 'oidc',
      KEYCLOAK_PUBLIC_URL: 'http://kc.legacy:8080',
      KEYCLOAK_REALM: 'legacy',
    });

    expect(code).toBe(0);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'http://kc.legacy:8080/realms/master/protocol/openid-connect/token',
    );
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/admin/realms/legacy/users');
  });

  it('falls back to stub subjects, loudly, when the bootstrap credential is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(refusedResponse(401))),
    );

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: 'oidc' });

    expect(code).toBe(0);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(
      /bootstrap admin credential was refused \(401\)/,
    );
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/seeding stub subjects/);
    expect(paramsFor('INSERT INTO idp_user')[0]?.[0]).toBe('stub:dev-admin');
  });

  it('falls back when the token endpoint returns no access_token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(stubResponse({ token_type: 'Bearer' }))),
    );

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: 'oidc' });

    expect(code).toBe(0);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/no access_token/);
  });

  it('falls back when an account lookup is refused', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        String(input).includes('/openid-connect/token')
          ? Promise.resolve(stubResponse({ access_token: 'admin-token' }))
          : Promise.resolve(refusedResponse(503)),
      ),
    );

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: 'oidc' });

    expect(code).toBe(0);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/reading dev-admin answered 503/);
  });

  it('falls back when an account is absent from the realm', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: unknown) =>
        String(input).includes('/openid-connect/token')
          ? Promise.resolve(stubResponse({ access_token: 'admin-token' }))
          : Promise.resolve(stubResponse([])),
      ),
    );

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: 'oidc' });

    expect(code).toBe(0);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(
      /dev-admin is not in realm seamnex; run pnpm kc:admin/,
    );
  });

  it('falls back when the provider cannot be reached at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: 'oidc' });

    expect(code).toBe(0);
    expect(String(warnSpy.mock.calls[0]?.[0])).toMatch(/fetch failed/);
    expect(paramsFor('INSERT INTO idp_user')[0]?.[0]).toBe('stub:dev-admin');
  });
});

/**
 * ADR-BE-42 §9.3 — the seed projects a checkout and writes no file.
 *
 * The suite creates the checkout itself, because the platform no longer ships one: `writeCheckout`
 * builds synthetic documents in the temporary root. What is asserted is the projector's behaviour,
 * not the content of any particular product.
 */
describe('catalog projection', () => {
  it('projects a checkout into an empty projection and writes nothing into the tree', async () => {
    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined }, (root) =>
      writeCheckout(root, ['D01-01', 'D02-01']),
    );

    expect(code).toBe(0);

    // The projection: the columns are copied out of each document, the document itself is the payload.
    const entries = paramsFor('INSERT INTO catalog_entry (');
    expect(entries.map((params) => params[0])).toEqual(['D01-01', 'D02-01']);
    expect(entries.map((params) => params[1])).toEqual([
      'Testing & Fixtures',
      'Testing & Fixtures',
    ]);
    expect(JSON.parse(String(entries[0]?.[8])).key).toBe('D01-01');

    // The revision label is the documented kind (`content-<16 hex>`, §2.1 of the format reference),
    // never an invented `seed`: the first reload is the thing that stamps a whole-tree revision, and
    // claiming one here would be inventing evidence. The full hash is kept beside it.
    const revisions = paramsFor('INSERT INTO catalog_entry_revision');
    expect(revisions.map((params) => params[0])).toEqual(['D01-01', 'D02-01']);
    expect(revisions.map((params) => params[1])).toEqual([
      expect.stringMatching(/^content-[0-9a-f]{16}$/),
      expect.stringMatching(/^content-[0-9a-f]{16}$/),
    ]);
    expect(revisions.map((params) => params[2])).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);

    // The tree is the operator's: the seed added no file to it.
    expect(readdirSync(join(currentTree, 'catalog')).sort()).toEqual([
      'D01-01.json',
      'D02-01.json',
      'env',
    ]);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('catalog: 2 entries declared in'));
    // No document was skipped, so the operator is not told about a gap that does not exist.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('skips with exit 0 and names the acquisition step when no checkout exists', async () => {
    // AC-7: a host that has never fetched a tag is a supported state — and the alternative, failing
    // the seed, would stop `pnpm dev` on a stack whose catalogue simply has not been acquired yet.
    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    expect(code).toBe(0);
    expect(paramsFor('INSERT INTO catalog_entry (')).toEqual([]);
    expect(existsSync(join(currentTree, 'catalog'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('pnpm catalog:sync --ref <tag>'));
  });

  it('fails when the checkout exists and declares no readable document', async () => {
    // AC-8: projecting nothing looks exactly like a database nobody seeded, so the run must not
    // report success. `{}` is a JSON object the served schema refuses.
    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined }, (root) => {
      mkdirSync(join(root, 'catalog'), { recursive: true });
      writeFileSync(join(root, 'catalog', 'D01-01.json'), '{}', 'utf8');
    });

    expect(code).toBe(1);
    expect(statements()).toContain('ROLLBACK');
    expect(statements()).not.toContain('COMMIT');
    expect(String(errorSpy.mock.calls[0]?.[0])).toMatch(/declares no readable entry document/);
  });

  it('leaves an operator catalogue alone, and does not seed beside it', async () => {
    doubles.query.mockImplementation((sql: unknown) => {
      if (String(sql).includes('count(*)::int AS total FROM catalog_entry')) {
        return Promise.resolve({ rows: [{ total: 4 }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    });

    const code = await runSeed({ DATABASE_URL: CONNECTION, AUTH_PROVIDER: undefined });

    expect(code).toBe(0);
    expect(paramsFor('INSERT INTO catalog_entry (')).toEqual([]);
    expect(paramsFor('INSERT INTO catalog_entry_revision')).toEqual([]);
    // A configured catalogue is authoritative. Topping it up would make the seed a second author of
    // rows the checkout owns, and the reload would then delete the difference.
    expect(existsSync(join(currentTree, 'catalog'))).toBe(false);
    expect(logSpy).toHaveBeenCalledWith('catalog not projected: 4 entries are already projected');
  });
});

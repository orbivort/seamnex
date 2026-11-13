import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureSecretFile } from './secret-file.mjs';

/**
 * Development bootstrap for the platform's own Keycloak admin client (4D.1).
 *
 * `POST /instances` provisions one client per instance through the Admin API, which needs a
 * service-account token. The realm ships `seamnex-portal` and `seamnex-console` only, so without this client
 * `registerIdentity` takes its documented `ADAPTER_UNAVAILABLE` path: the deployment succeeds, the
 * instance records "no identity client", and the product keeps its local credential forever.
 *
 * The realm-as-code import cannot create it here — `keycloak-config-cli` already exits 1 on this
 * realm (see the comment in `docker/compose.dev.yml`), so the client is created idempotently with
 * the bootstrap admin credential instead. The same entry is added to `platform/realm/realm.json`,
 * so once the import is repaired it becomes declarative and this script finds nothing to do.
 *
 * The secret is generated once, kept in `temp/`, mounted read-only into the API roles, and never
 * printed. Re-running the script reuses it, so the client and the mounted file cannot disagree.
 */

export const KC_ADMIN_CLIENT_ID = 'seamnex-platform-admin';
/**
 * The service-account roles the platform needs, and nothing else.
 *
 *   - `view-clients` / `manage-clients`: one OIDC client per deployed instance (4D.1);
 *   - `view-users`: the identity mirror reads users, groups, membership and credentials (3.6/4D).
 *     Without it the sync worker answers `ADAPTER_UNAVAILABLE` on its first cycle, and the platform
 *     never learns which accounts exist — which is a worse failure than a noisy grant.
 *   - `manage-users`: FR-4.4's disable is written to the realm, because the mirror is rebuilt from
 *     it. Without it `POST /admin/users/{id}/disable` answers `ADAPTER_UNAVAILABLE` rather than
 *     reporting an offboarding that the next sync cycle reverses.
 */
const KC_ADMIN_CLIENT_ROLES = ['view-clients', 'manage-clients', 'view-users', 'manage-users'];

/** The dev probe identity used by the SSO check; mirrors `platform/realm/realm-dev-users.json`. */
export const KC_PROBE_USERNAME = 'dev-user';
const KC_PROBE_PASSWORD = 'dev-user';

const SECRET_FILE = 'kc-admin-client-secret';
const PROBE_FILE = 'sso-probe-password';

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

/**
 * Creates the two files the API mounts, if they are missing.
 *
 * Called before `compose up` — by `scripts/compose.mjs` and by `scripts/kc-admin.mjs` — because a
 * bind mount of a missing file makes runc refuse to create the container at all:
 *
 *   error mounting ".../temp/kc-admin-client-secret" ... not a directory
 *
 * Safe to call repeatedly; existing contents are never overwritten, since rotating the client
 * secret is a deliberate action and a bootstrap that silently changed it would lock the API out.
 */
export function ensureKeycloakFiles(root, log = () => {}) {
  const dir = join(root, 'temp');
  ensureDir(dir);

  const secretPath = join(dir, SECRET_FILE);
  if (
    ensureSecretFile(secretPath, {
      contents: `${randomBytes(32).toString('base64url')}\n`,
      label: `temp/${SECRET_FILE}`,
      log,
    })
  ) {
    log(`generated ${SECRET_FILE}`);
  }

  const probePath = join(dir, PROBE_FILE);
  if (
    ensureSecretFile(probePath, {
      contents: `${KC_PROBE_PASSWORD}\n`,
      label: `temp/${PROBE_FILE}`,
      log,
    })
  ) {
    log(`wrote ${PROBE_FILE}`);
  }

  return {
    secretPath,
    probePath,
    secret: readFileSync(secretPath, 'utf8').trim(),
    probePassword: readFileSync(probePath, 'utf8').trim(),
  };
}

/**
 * Ensures the realm identity the SSO check signs in as.
 *
 * The check cannot submit a login form without an account, and the realm-as-code import that would
 * have created the development users exits 1 on this realm (see `docker/compose.dev.yml`). This is
 * the same class of dev-only credential as `KEYCLOAK_ADMIN_PASSWORD`: a local test account in a
 * local realm, never something a deployment inherits.
 */
export async function ensureProbeUser({
  url,
  realm,
  adminUser,
  adminPassword,
  username,
  password,
  email,
  log = () => {},
}) {
  const accessToken = await token({ url, adminUser, adminPassword });
  const base = `${url}/admin/realms/${realm}`;
  const found =
    (await api(base, `/users?username=${encodeURIComponent(username)}&exact=true`, accessToken)) ??
    [];
  if (found.length > 0) {
    log(`realm user ${username} already exists`);
    return;
  }
  await api(base, '/users', accessToken, {
    method: 'POST',
    body: JSON.stringify({
      username,
      email: email ?? `${username}@seamnex.local`,
      firstName: 'Platform',
      lastName: 'Probe',
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: password, temporary: false }],
    }),
  });
  log(`created realm user ${username} for the SSO check`);
}

async function token({ url, adminUser, adminPassword }) {
  const response = await fetch(`${url}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUser,
      password: adminPassword,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `the bootstrap admin credential was refused (${response.status}); is Keycloak up?`,
    );
  }
  const payload = await response.json();
  if (typeof payload.access_token !== 'string')
    throw new Error('the token endpoint returned no access_token');
  return payload.access_token;
}

async function api(base, path, accessToken, init = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Keycloak ${init.method ?? 'GET'} ${path} answered ${response.status} ${detail.slice(0, 200)}`,
    );
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text.length === 0 ? null : JSON.parse(text);
}

/**
 * Creates or updates the admin client and grants it exactly the two client roles it needs.
 *
 * Idempotent: an existing client is updated in place, and an already-assigned role is not assigned
 * twice (Keycloak answers 204 for a redundant mapping anyway, but the check keeps the log honest).
 */
export async function provisionKeycloakAdminClient({
  url,
  realm,
  adminUser,
  adminPassword,
  secret,
  log = () => {},
}) {
  const accessToken = await token({ url, adminUser, adminPassword });
  const base = `${url}/admin/realms/${realm}`;

  const found =
    (await api(base, `/clients?clientId=${encodeURIComponent(KC_ADMIN_CLIENT_ID)}`, accessToken)) ??
    [];
  const representation = {
    clientId: KC_ADMIN_CLIENT_ID,
    name: 'Platform admin (client provisioning)',
    enabled: true,
    protocol: 'openid-connect',
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    implicitFlowEnabled: false,
    secret,
    // The platform only ever calls the Admin API with this client; a browser redirect for it would
    // be a credential surface with no legitimate user.
    redirectUris: [],
    webOrigins: [],
  };

  let clientId = found[0]?.id;
  if (clientId === undefined) {
    await api(base, '/clients', accessToken, {
      method: 'POST',
      body: JSON.stringify(representation),
    });
    const created =
      (await api(
        base,
        `/clients?clientId=${encodeURIComponent(KC_ADMIN_CLIENT_ID)}`,
        accessToken,
      )) ?? [];
    clientId = created[0]?.id;
    if (clientId === undefined)
      throw new Error('the admin client was created but could not be read back');
    log(`created ${KC_ADMIN_CLIENT_ID}`);
  } else {
    await api(base, `/clients/${clientId}`, accessToken, {
      method: 'PUT',
      body: JSON.stringify(representation),
    });
    log(`${KC_ADMIN_CLIENT_ID} already exists; representation and secret reconciled`);
  }

  const serviceAccount = await api(base, `/clients/${clientId}/service-account-user`, accessToken);
  if (serviceAccount?.id === undefined)
    throw new Error('the admin client has no service-account user');

  const realmManagement =
    (await api(base, '/clients?clientId=realm-management', accessToken)) ?? [];
  const realmManagementId = realmManagement[0]?.id;
  if (realmManagementId === undefined) throw new Error('the realm has no realm-management client');

  const assigned =
    (await api(
      base,
      `/users/${serviceAccount.id}/role-mappings/clients/${realmManagementId}`,
      accessToken,
    )) ?? [];
  const assignedNames = new Set(assigned.map((role) => role.name));
  const missing = KC_ADMIN_CLIENT_ROLES.filter((name) => !assignedNames.has(name));

  if (missing.length > 0) {
    const available =
      (await api(
        base,
        `/users/${serviceAccount.id}/role-mappings/clients/${realmManagementId}/available`,
        accessToken,
      )) ?? [];
    const roles = available.filter((role) => missing.includes(role.name));
    if (roles.length !== missing.length) {
      throw new Error(`the realm does not offer ${missing.join(', ')} on realm-management`);
    }
    await api(
      base,
      `/users/${serviceAccount.id}/role-mappings/clients/${realmManagementId}`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify(roles),
      },
    );
    log(`granted ${missing.join(', ')} to ${KC_ADMIN_CLIENT_ID}`);
  } else {
    log(`${KC_ADMIN_CLIENT_ID} already holds ${KC_ADMIN_CLIENT_ROLES.join(', ')}`);
  }

  // Prove the grant works, with the client's own credentials: a 200 on the client list is the same
  // call `KeycloakAdminClient.upsertClient` makes, so this is the check that matters.
  const verify = await fetch(`${url}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: KC_ADMIN_CLIENT_ID,
      client_secret: secret,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!verify.ok) throw new Error(`the admin client could not mint a token (${verify.status})`);
  const verifyPayload = await verify.json();
  const probe = await fetch(`${base}/clients?first=0&max=1`, {
    headers: { authorization: `Bearer ${verifyPayload.access_token}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!probe.ok) throw new Error(`the admin client cannot list clients (${probe.status})`);

  return { clientId: KC_ADMIN_CLIENT_ID };
}

/* ------------------------------------------------------------------------------------------------
 * ADR-BE-23 — the install-time trigger.
 *
 * The three functions below decide *whether* install should reconcile the client, *whether the realm
 * is ready enough to try*, and *whether an existing credential actually works*. They are separate
 * from `provisionKeycloakAdminClient` on purpose: the same decision is used by `scripts/compose.mjs`
 * and `scripts/dev.mjs`, which start different subsets of the stack, and a decision that lives in
 * two call sites is a decision that drifts.
 * ---------------------------------------------------------------------------------------------- */

/** ADR-BE-23 §Decision rule 4: the only accepted values, and the default. */
export const KC_BOOTSTRAP_MODES = ['auto', 'force', 'off'];

/**
 * `SEAMNEX_KC_ADMIN_BOOTSTRAP` resolved to a mode.
 *
 * An unrecognised value resolves to `auto` with a note rather than to `off`: a typo must not
 * silently disable the step this record exists to make reliable, and it must not abort an install
 * over a spelling either.
 */
export function kcBootstrapMode(env) {
  const raw = (env.SEAMNEX_KC_ADMIN_BOOTSTRAP ?? '').trim().toLowerCase();
  if (raw.length === 0) return { mode: 'auto', note: null };
  if (KC_BOOTSTRAP_MODES.includes(raw)) return { mode: raw, note: null };
  return {
    mode: 'auto',
    note: `SEAMNEX_KC_ADMIN_BOOTSTRAP="${raw}" is not one of ${KC_BOOTSTRAP_MODES.join('|')}; using auto`,
  };
}

/**
 * Whether install should reconcile the admin client, and why not when it should not.
 *
 * Mirrors `adapterAvailable(config, 'keycloak')` (`apps/api/src/common/adapters.ts`): the same four
 * settings the API treats as "the Keycloak adapter is configured" are what make the client
 * meaningful here. A catalog entry that requires OIDC is deliberately not consulted — an entry may
 * need it while the platform itself runs `AUTH_PROVIDER=stub`.
 */
export function kcBootstrapDecision(env, { stackDeclaresKeycloak = true } = {}) {
  const { mode, note } = kcBootstrapMode(env);
  const decided = (run, reason) => ({ run, mode, note, reason });
  if (mode === 'off') return decided(false, 'SEAMNEX_KC_ADMIN_BOOTSTRAP=off');

  const provider = (env.AUTH_PROVIDER ?? 'stub').trim().toLowerCase();
  if (provider !== 'oidc')
    return decided(
      false,
      `AUTH_PROVIDER=${provider === '' ? 'stub' : provider} (Keycloak is not this platform's identity provider)`,
    );

  const adapters = (env.SEAMNEX_ADAPTERS_MODE ?? 'real').trim().toLowerCase();
  if (adapters === 'disabled') return decided(false, 'SEAMNEX_ADAPTERS_MODE=disabled');

  if ((env.SEAMNEX_KEYCLOAK_ADMIN_URL ?? '').trim().length === 0)
    return decided(false, 'SEAMNEX_KEYCLOAK_ADMIN_URL is empty');

  if ((env.SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE ?? '').trim().length === 0)
    return decided(false, 'SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE is empty');

  if (!stackDeclaresKeycloak)
    return decided(false, 'the compose stack declares no keycloak service');

  return decided(true, `AUTH_PROVIDER=oidc, adapters=${adapters}`);
}

/** True when the compose file being started declares `service` as a top-level service key. */
export function stackDeclaresService(composeFile, service) {
  if (!existsSync(composeFile)) return false;
  const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s{0,4}${escaped}:\\s*$`, 'm').test(readFileSync(composeFile, 'utf8'));
}

/** True when the stack declares a `keycloak` service (never matches `keycloak-config-cli`). */
export function stackDeclaresKeycloak(composeFile) {
  return stackDeclaresService(composeFile, 'keycloak');
}

async function probeUrl(url, timeoutMs) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? 'ok' : `HTTP ${response.status}`;
  } catch {
    // A transport failure says nothing about the realm, only that nothing answered: the caller
    // reports it as unreachable rather than inventing a status.
    return 'unreachable';
  }
}

/**
 * Three states, because they have three different remediations.
 *
 * `master` discovery proves the server answers at all; the platform realm's discovery proves the
 * import has run. Collapsing them into one boolean is what makes an operator restart Keycloak when
 * the realm import is what failed.
 */
export async function probeKeycloak({ url, realm, timeoutMs = 5_000 }) {
  const base = url.replace(/\/+$/, '');
  const master = await probeUrl(
    `${base}/realms/master/.well-known/openid-configuration`,
    timeoutMs,
  );
  if (master === 'unreachable')
    return { state: 'unreachable', detail: `nothing answered at ${base}` };
  if (master !== 'ok')
    return { state: 'unreachable', detail: `master realm discovery answered ${master}` };
  const target = await probeUrl(
    `${base}/realms/${encodeURIComponent(realm)}/.well-known/openid-configuration`,
    timeoutMs,
  );
  if (target === 'ok') return { state: 'ready', detail: `${base}/realms/${realm}` };
  return { state: 'realm_missing', detail: `realm "${realm}" is not applied yet (${target})` };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until the realm answers or the budget runs out; the caller decides what a timeout means. */
export async function waitForKeycloak({
  url,
  realm,
  timeoutMs = 0,
  intervalMs = 2_000,
  log = () => {},
}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let announced = false;
  for (;;) {
    const probe = await probeKeycloak({ url, realm });
    if (probe.state === 'ready') return probe;
    if (Date.now() >= deadline) return probe;
    if (!announced) {
      log(`waiting up to ${Math.round(timeoutMs / 1000)}s for Keycloak: ${probe.detail}`);
      announced = true;
    }
    await sleep(intervalMs);
  }
}

async function readJson(url, init) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: body.length === 0 ? null : JSON.parse(body),
    };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

/**
 * `--check` / `pnpm kc:check`: prove the credential without writing anything.
 *
 * Every probe here is a call the API itself makes, so a green result means `upsertClient` will work
 * rather than that a file exists. The secret is used, never printed.
 */
export async function checkKeycloakAdminClient({ url, realm, secret }) {
  const base = url.replace(/\/+$/, '');
  const credentials = Buffer.from(`${KC_ADMIN_CLIENT_ID}:${secret}`).toString('base64');
  const token = await readJson(
    `${base}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/token`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // Sent as a header, not a query string: a URL ends up in logs and in proxy access records.
        authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    },
  );
  if (!token.ok)
    return {
      ok: false,
      problems: [
        token.status === 0
          ? `the token endpoint at ${base} did not answer`
          : `${KC_ADMIN_CLIENT_ID} could not mint a token (${token.status}); the mounted secret and the client record disagree`,
      ],
    };

  const accessToken = token.body?.access_token;
  if (typeof accessToken !== 'string')
    return { ok: false, problems: ['the token endpoint returned no access_token'] };

  const authorize = { headers: { authorization: `Bearer ${accessToken}` } };
  const admin = `${base}/admin/realms/${encodeURIComponent(realm)}`;
  const problems = [];

  const client = await readJson(
    `${admin}/clients?clientId=${encodeURIComponent(KC_ADMIN_CLIENT_ID)}`,
    authorize,
  );
  if (!client.ok) {
    problems.push(
      `listing clients answered ${client.status}; the service account lacks view-clients`,
    );
    return { ok: false, problems };
  }
  const clientId = (client.body ?? []).find((row) => row.clientId === KC_ADMIN_CLIENT_ID)?.id;
  if (clientId === undefined) {
    problems.push(`the client ${KC_ADMIN_CLIENT_ID} does not exist; run the provisioning step`);
    return { ok: false, problems };
  }

  const serviceAccount = await readJson(
    `${admin}/clients/${clientId}/service-account-user`,
    authorize,
  );
  const realmManagement = await readJson(`${admin}/clients?clientId=realm-management`, authorize);
  const realmManagementId = (realmManagement.body ?? []).find(
    (row) => row.clientId === 'realm-management',
  )?.id;
  if (
    !serviceAccount.ok ||
    serviceAccount.body?.id === undefined ||
    realmManagementId === undefined
  ) {
    problems.push('the service account could not be read; the client has no service-account user');
    return { ok: false, problems };
  }

  const granted = await readJson(
    `${admin}/users/${serviceAccount.body.id}/role-mappings/clients/${realmManagementId}`,
    authorize,
  );
  if (!granted.ok) {
    problems.push(
      `reading the client-role mappings answered ${granted.status}; the service account lacks view-users`,
    );
    return { ok: false, problems };
  }
  const assigned = new Set((granted.body ?? []).map((role) => role.name));
  const missing = KC_ADMIN_CLIENT_ROLES.filter((name) => !assigned.has(name));
  if (missing.length > 0) problems.push(`the service account is missing ${missing.join(', ')}`);

  return { ok: problems.length === 0, problems };
}

/**
 * A lock around the reconcile step, so two installers started together cannot interleave `PUT`s.
 *
 * Contention is not an error: the other process is doing the same idempotent work, and waiting on a
 * lock would turn an accidental double `pnpm dev:stack` into a stalled one.
 */
export function acquireBootstrapLock(lockPath, { staleMs = 5 * 60_000, log = () => {} } = {}) {
  try {
    const fd = openSync(lockPath, 'wx');
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return { release: () => removeQuietly(lockPath) };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let age;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      // The other process released it between the open and the stat: try once more.
      return acquireBootstrapLock(lockPath, { staleMs, log });
    }
    if (age < staleMs) return null;
    log(`removed a stale bootstrap lock (${Math.round(age / 1000)}s old)`);
    removeQuietly(lockPath);
    return acquireBootstrapLock(lockPath, { staleMs, log });
  }
}

function removeQuietly(path) {
  try {
    unlinkSync(path);
  } catch {
    // Already gone: releasing a lock twice is not a failure.
    return;
  }
}

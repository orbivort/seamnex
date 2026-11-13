#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  KC_ADMIN_CLIENT_ID,
  KC_PROBE_USERNAME,
  acquireBootstrapLock,
  checkKeycloakAdminClient,
  ensureKeycloakFiles,
  ensureProbeUser,
  kcBootstrapDecision,
  provisionKeycloakAdminClient,
  stackDeclaresKeycloak,
  waitForKeycloak,
} from './lib/kc-admin.mjs';

/**
 * `pnpm kc:admin` — make the platform's Keycloak admin client exist (4D.1, ADR-BE-23).
 *
 * Four modes, one code path:
 *
 *   (none)      manual. Behaves as it always has: run, and fail loudly. `pnpm kc:admin` is the
 *               documented repair, so an explicit invocation is never refused.
 *   --auto      what the installer calls. `SEAMNEX_KC_ADMIN_BOOTSTRAP` decides the posture:
 *               `auto` warns and continues, `force` fails, `off` skips. Detection is
 *               `kcBootstrapDecision()` — the same four settings the API treats as "the Keycloak
 *               adapter is configured".
 *   --check     prove the credential and write nothing: token, client, service-account roles.
 *   --wait=<s>  how long to wait for the realm before reporting; 120 s in `--auto`, 0 by hand.
 *
 * Idempotent. Safe to run on every start: the representation and secret are reconciled, only
 * missing roles are granted, and the secret in `temp/kc-admin-client-secret` is never rotated here.
 */

const USAGE =
  'usage: node scripts/kc-admin.mjs [--auto] [--check] [--wait=<seconds>] [--no-probe-user]';

const root = dirname(import.meta.dirname);
const envPath = join(root, '.env');
const composeFile = join(root, 'docker', 'compose.dev.yml');

function log(message) {
  process.stdout.write(`[kc-admin] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[kc-admin] ${message}\n`);
}

function parseFlags(argv) {
  const flags = { auto: false, check: false, wait: null, probeUser: true };
  for (const arg of argv) {
    if (arg === '--auto') {
      flags.auto = true;
    } else if (arg === '--check') {
      flags.check = true;
    } else if (arg === '--no-probe-user') {
      flags.probeUser = false;
    } else if (arg.startsWith('--wait=')) {
      const seconds = Number(arg.slice('--wait='.length));
      // A NaN would make the deadline `NaN`, which compares false forever — an install that hangs
      // is worse than one that refuses an argument it cannot read.
      if (!Number.isFinite(seconds) || seconds < 0) {
        return { error: `--wait expects a number of seconds, got "${arg}"` };
      }
      flags.wait = Math.min(seconds, 600) * 1_000;
    } else {
      return { error: `unknown argument "${arg}"` };
    }
  }
  return { flags };
}

/**
 * The root `.env` with the process environment layered over it.
 *
 * The same parser `pnpm dev` uses, so a quoted value means the same thing to both entry points. An
 * exported variable wins, the way `loadRootEnv()` treats one: the file is the default, the current
 * shell is the intention — which is what makes `SEAMNEX_KC_ADMIN_BOOTSTRAP=off pnpm dev:stack` mean
 * what the operator expects.
 */
function readEnvFile() {
  const file = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  return { ...file, ...process.env };
}

/** The secret is read, never printed, and never passed as an argument to another process. */
function readSecret(path) {
  try {
    const value = readFileSync(path, 'utf8').trim();
    return value.length === 0 ? null : value;
  } catch {
    return null;
  }
}

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : join(root, path);
}

const parsed = parseFlags(process.argv.slice(2));
if (parsed.error !== undefined) {
  warn(parsed.error);
  warn(USAGE);
  process.exit(2);
}
const { flags } = parsed;

const env = readEnvFile();
// The same two settings the API reads; the bare names are the pre-Seamnex spelling and stay as a
// fallback so an existing `.env` keeps working.
const url = env.SEAMNEX_KEYCLOAK_ADMIN_URL ?? env.KEYCLOAK_PUBLIC_URL ?? 'http://localhost:8082';
const realm = env.SEAMNEX_KEYCLOAK_REALM ?? env.KEYCLOAK_REALM ?? 'seamnex';
const adminUser = env.KEYCLOAK_ADMIN ?? 'admin';
const adminPassword = env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
const secretPath = resolveFromRoot(
  env.SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE ?? './temp/kc-admin-client-secret',
);

const decision = kcBootstrapDecision(env, {
  stackDeclaresKeycloak: stackDeclaresKeycloak(composeFile),
});
if (decision.note !== null) warn(decision.note);

if (flags.auto) {
  if (!decision.run) {
    log(`skipped (${decision.reason})`);
    process.exit(0);
  }
  log(decision.reason);
} else {
  // An explicit invocation is the operator's decision, not the installer's: report what detection
  // thinks so the two never disagree silently, but do not refuse the command.
  log(
    decision.run
      ? decision.reason
      : `running explicitly although detection would skip: ${decision.reason}`,
  );
}

const posture = flags.auto ? decision.mode : 'manual';
const fatal = posture === 'manual' || posture === 'force';
const budget = flags.wait ?? (flags.auto ? 120_000 : 0);

/**
 * Failure handling is the whole difference between the modes (ADR-BE-23 §Behaviour by state): the
 * manual and `force` paths fail, `auto` states the consequence and continues. The sentence names the
 * consequence, not the mechanism, because a green install with no identity client is exactly the
 * outcome this record exists to make impossible to miss.
 */
function unavailability(probe) {
  return probe.state === 'realm_missing'
    ? `the realm "${realm}" is not applied (${probe.detail}); the realm import (keycloak-config-cli) must exit 0 first`
    : `Keycloak is not reachable (${probe.detail})`;
}

const reachable = await waitForKeycloak({ url, realm, timeoutMs: budget, log });
if (reachable.state !== 'ready') {
  const message = unavailability(reachable);
  if (fatal) {
    warn(message);
    warn(
      'no per-instance OIDC client can be registered until this succeeds; rerun `pnpm kc:admin`',
    );
    process.exit(1);
  }
  warn(
    `${message}; no per-instance OIDC client can be registered, so product sign-in keeps the product's own credential until \`pnpm kc:admin\` runs`,
  );
  process.exit(0);
}

if (flags.check) {
  const secret = readSecret(secretPath);
  if (secret === null) {
    warn(
      `the secret file ${secretPath} is missing or empty; run \`pnpm kc:admin\` to provision it`,
    );
    process.exit(1);
  }
  const verdict = await checkKeycloakAdminClient({ url, realm, secret });
  if (verdict.ok) {
    log(`${KC_ADMIN_CLIENT_ID} can mint a token, list clients and read its own roles`);
    process.exit(0);
  }
  for (const problem of verdict.problems) warn(problem);
  process.exit(1);
}

const lock = acquireBootstrapLock(join(root, 'temp', '.kc-admin-bootstrap.lock'), { log });
if (lock === null) {
  log('another run holds the bootstrap lock; it is doing the same idempotent work');
  process.exit(0);
}

try {
  const files = ensureKeycloakFiles(root, log);
  await provisionKeycloakAdminClient({
    url,
    realm,
    adminUser,
    adminPassword,
    secret: files.secret,
    log,
  });
  log(`${KC_ADMIN_CLIENT_ID} is ready; the API mounts ${files.secretPath}`);

  /**
   * The probe identity is a development account written into the realm. The installer only creates
   * it when the environment declares one (`SEAMNEX_SSO_PROBE_USERNAME`), so an automatic run cannot
   * seed a test user into a realm that never asked for it; an explicit `pnpm kc:admin` keeps the
   * historical behaviour.
   */
  const declaredProbeUser = (env.SEAMNEX_SSO_PROBE_USERNAME ?? '').trim();
  const createProbeUser = flags.probeUser && (flags.auto ? declaredProbeUser.length > 0 : true);
  if (createProbeUser) {
    await ensureProbeUser({
      url,
      realm,
      adminUser,
      adminPassword,
      username: declaredProbeUser.length > 0 ? declaredProbeUser : KC_PROBE_USERNAME,
      password: files.probePassword,
      log,
    });
  } else {
    log(
      flags.probeUser
        ? 'probe identity skipped (SEAMNEX_SSO_PROBE_USERNAME is empty)'
        : 'probe identity skipped (--no-probe-user)',
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (fatal) {
    warn(message);
    process.exitCode = 1;
  } else {
    warn(
      `${message}; no per-instance OIDC client can be registered until \`pnpm kc:admin\` succeeds`,
    );
  }
} finally {
  lock.release();
}

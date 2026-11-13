#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import {
  ensureKeycloakFiles,
  kcBootstrapDecision,
  stackDeclaresKeycloak,
} from './lib/kc-admin.mjs';
import { ensureRootKey } from './lib/root-key.mjs';
import { ensureRuntimeDirs } from './lib/runtime-dirs.mjs';

/**
 * `pnpm dev` brings up the real stack.
 *
 * Deliberately plain Node, no bash: the frontend team works on Windows and macOS, and a script that
 * only runs in a POSIX shell becomes a second, undocumented setup path.
 *
 * Order: .env → datastores → migrations → seed → turbo (portal, console, api).
 * Frontend-only work can keep the old behaviour with `pnpm dev:web`.
 */

const root = dirname(import.meta.dirname);
const envPath = join(root, '.env');
const composeFile = join(root, 'docker', 'compose.dev.yml');

function log(message) {
  process.stdout.write(`[dev] ${message}\n`);
}

function fail(message, code = 1) {
  process.stderr.write(`[dev] ${message}\n`);
  process.exitCode = code;
}

function ensureEnvFile() {
  if (existsSync(envPath)) return;
  writeFileSync(envPath, readFileSync(join(root, '.env.example'), 'utf8'), 'utf8');
  log('created .env from .env.example');
}

function ensureCredentialFiles() {
  // Shared with `scripts/compose.mjs`: the compose stack mounts the same files, so the bootstrap
  // lives in one module instead of two implementations that can drift. The Keycloak pair is created
  // here as well so a host-run API finds the paths `.env` points at instead of failing on a missing
  // file, and so `docker compose up` of the full stack never meets a missing mount source.
  ensureRootKey(root, log);
  ensureKeycloakFiles(root, log);
  // The API container cannot create these inside the bind mounts (it runs as uid 1000 while a mount
  // Docker created for a missing source belongs to root), so they are created here, on the host.
  ensureRuntimeDirs(root, log);
}

/**
 * `util.parseEnv` is the same parser Node's own `--env-file` uses, so a quoted value, an escaped
 * `\n` or an `export ` prefix means the same thing here as it does to `docker compose --env-file`
 * and to `process.loadEnvFile`. The regex this replaces ignored all three, so `.env` could be read
 * two different ways depending on which entry point started.
 */
function readEnvFile() {
  return parseEnv(readFileSync(envPath, 'utf8'));
}

/**
 * `docker` is a real `docker.exe`, so it is spawned without a shell and its arguments — which
 * include the absolute `.env` path — never reach `cmd.exe` quoting.
 *
 * `pnpm` on Windows is a `.cmd` shim, and since Node's fix for CVE-2024-27980 a `.cmd` cannot be
 * spawned with `shell: false` (it fails with `EINVAL`). That one command keeps a shell; every
 * argument it is given is a literal flag, so there is nothing to interpolate.
 */
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const PNPM_SHELL = process.platform === 'win32';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    ...options,
  });
  return result.status === 0;
}

function dockerAvailable() {
  const result = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return result.status === 0;
}

function startDatastores() {
  if (!dockerAvailable()) {
    fail(
      'Docker is not available. Start Docker Desktop, then run `pnpm dev` again.\n' +
        '  Frontend-only work does not need it: `pnpm dev:web`.',
      1,
    );
    return false;
  }

  log('starting postgres and redis');
  // `--env-file` keeps compose interpolation (POSTGRES_*, SEAMNEX_PG_HOST_PORT) on the same root `.env`
  // the API reads, instead of the implicit `docker/.env` lookup next to the compose file.
  const target = ['--env-file', envPath, '-f', composeFile];
  const args = ['compose', ...target, 'up', '-d', '--wait', 'postgres', 'redis'];
  if (!run('docker', args)) {
    fail(
      'the datastore services did not become healthy; see `docker compose -f docker/compose.dev.yml logs`',
    );
    return false;
  }
  return true;
}

/**
 * ADR-BE-23 — repair the platform's Keycloak admin client before the API starts.
 *
 * `pnpm dev` starts no Keycloak, so this is mostly a no-op. It earns its place on the other path:
 * a `dev:stack` whose Keycloak data was re-created since the last reconcile leaves the mounted
 * secret and the client record disagreeing, and every later deploy would silently skip identity
 * registration. The budget is deliberately short — a frontend developer must not wait two minutes
 * for a dependency they deliberately did not start.
 */
function reconcileKeycloakAdminClient(env) {
  // The file is the default, an exported variable the current intention — the same precedence the
  // child (`scripts/kc-admin.mjs`) applies, so the two cannot disagree about whether to run.
  const decision = kcBootstrapDecision(
    { ...env, ...process.env },
    { stackDeclaresKeycloak: stackDeclaresKeycloak(composeFile) },
  );
  if (decision.note !== null) log(decision.note);
  if (!decision.run) {
    log(`keycloak admin client: skipped (${decision.reason})`);
    return true;
  }

  log('reconciling the platform Keycloak admin client');
  const result = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'kc-admin.mjs'), '--auto', '--wait=3'],
    { cwd: root, stdio: 'inherit' },
  );
  if ((result.status ?? 1) === 0) return true;
  // `auto` already stated the consequence; only a `force` posture may stop the dev loop.
  if (decision.mode !== 'force') return true;
  fail('the Keycloak admin client could not be reconciled and SEAMNEX_KC_ADMIN_BOOTSTRAP=force');
  return false;
}

function migrate(env) {
  log('applying schema migrations');
  const status = spawnSync(PNPM, ['--filter', '@seamnex/db', 'migrate:up'], {
    cwd: root,
    stdio: 'inherit',
    shell: PNPM_SHELL,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
  });
  if (status.status !== 0) {
    fail('migrations failed; the stack is up but the schema is not ready');
    return false;
  }

  log('seeding development data');
  const seeded = spawnSync(PNPM, ['--filter', '@seamnex/db', 'seed'], {
    cwd: root,
    stdio: 'inherit',
    shell: PNPM_SHELL,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
  });
  // The seed's status used to be dropped, so a stack whose default catalogue failed to materialise
  // still booted and every catalogue screen showed an empty product. A failed seed is a failed
  // startup, exactly like a failed migration.
  if (seeded.status !== 0) {
    fail('the development seed failed; the default catalogue is not usable');
    return false;
  }

  /*
   * The seed writes `catalog/env/<KEY>.json`; `env_schema_var` is M03's and is projected by its own
   * command. Running it here is what makes "a fresh clone is usable after one command" true for the
   * environment half as well: without it the deploy wizard has no variables to offer and
   * `GET /catalog/:key/env-schema` answers `[]` for a product that declares 30.
   *
   * Idempotent by content hash, so a warm stack pays one read per file and writes nothing.
   */
  log('projecting the default environment schemas');
  const projected = spawnSync(PNPM, ['catalog:project'], {
    cwd: root,
    stdio: 'inherit',
    shell: PNPM_SHELL,
    env: { ...process.env, DATABASE_URL: env.DATABASE_URL },
  });
  if (projected.status !== 0) {
    fail('the environment projection failed; deployments would start with no declared variables');
    return false;
  }
  return true;
}

function startDevServers(env) {
  log('starting portal, console and api (Ctrl+C stops them)');
  const child = spawn(PNPM, ['turbo', 'run', 'dev', '--parallel'], {
    cwd: root,
    stdio: 'inherit',
    shell: PNPM_SHELL,
    env: { ...process.env, ...env },
  });

  const forward = (signal) => {
    if (child.exitCode === null) child.kill(signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));
  child.on('exit', (code) => {
    process.exitCode = code ?? 0;
  });
}

ensureEnvFile();
ensureCredentialFiles();
const env = readEnvFile();

// Identity is reconciled before the API starts, so the first deploy of the session can register a
// client: a deployment that runs without it succeeds and leaves the product on its own credential.
const identityReady = startDatastores() && reconcileKeycloakAdminClient(env);
if (identityReady && migrate(env)) {
  startDevServers(env);
}

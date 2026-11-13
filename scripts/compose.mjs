#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ensureKeycloakFiles,
  kcBootstrapDecision,
  stackDeclaresKeycloak,
  stackDeclaresService,
} from './lib/kc-admin.mjs';
import { ensureRootKey } from './lib/root-key.mjs';
import { ensureRuntimeDirs } from './lib/runtime-dirs.mjs';

/**
 * The one door `pnpm dev:stack` (and `:down`, `:logs`) goes through.
 *
 * Compose looks for `.env` *next to the compose file* unless `--env-file` says otherwise, and the
 * compose file lives in `docker/`. A root `.env` was therefore ignored, so `SEAMNEX_PG_HOST_PORT=5434`
 * fell back to the default 5432 and `up` died with "ports are not available: ... 127.0.0.1:5432"
 * on any machine that already runs a native PostgreSQL. `scripts/dev.mjs` passes `--env-file`
 * already; this keeps the CLI path on the same file instead of a second, drifting lookup rule.
 *
 * Profiles are hoisted because `--profile` is a `docker compose` *global* flag and must precede the
 * subcommand, while pnpm appends extra arguments at the end (`pnpm dev:stack --profile
 * observability`). Everything else is forwarded untouched.
 */

const root = dirname(import.meta.dirname);
const envPath = join(root, '.env');
const composeFile = join(root, 'docker', 'compose.dev.yml');

/**
 * How long the realm import may take before the install stops waiting for it (ADR-BE-23).
 *
 * It covers the CLI's own availability check (120 s, `docker/compose.dev.yml`) plus one cold
 * Keycloak start, and is bounded so an import that never finishes cannot hang an install.
 */
const REALM_IMPORT_TIMEOUT_MS = 180_000;

/** The one-shot service that applies `platform/realm/*.json`. Its exit code gates the reconcile. */
const REALM_IMPORT_SERVICE = 'keycloak-config-cli';

// Compose treats a missing `--env-file` as a hard error and a fresh clone has none yet, so seed it
// from the example exactly as `pnpm dev` does: `pnpm dev:stack` has to work on first run too.
if (!existsSync(envPath)) copyFileSync(join(root, '.env.example'), envPath);

// Every credential file the API container bind-mounts has to exist *before* `up`: Docker does not
// treat a missing bind-mount source as an error, it creates a directory in its place, and the
// container then dies in runc with "not a directory: Are you trying to mount a directory onto a
// file". All three of these are mounted, and only the root key used to be created here — the two
// Keycloak files were written by `pnpm kc:admin`, which the README says to run *after* the stack is
// up, so a fresh clone could never start it.
const log = (message) => process.stdout.write(`[compose] ${message}\n`);
try {
  ensureRootKey(root, log);
  ensureKeycloakFiles(root, log);
  // `pnpm dev:stack` starts the same API: without writable runtime directories the deploy job fails
  // at "Resolve source" and 4A.8 refuses to commit instance definitions.
  ensureRuntimeDirs(root, log);
} catch (error) {
  // A path that cannot be repaired is a `[compose]` line, not a stack trace: the message already
  // says what to move aside, and reaching Docker would only bury it under a runc error.
  process.stderr.write(`[compose] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const leading = [];
const trailing = [];
const forwarded = process.argv.slice(2);
for (let index = 0; index < forwarded.length; index += 1) {
  const arg = forwarded[index];
  const next = forwarded[index + 1];
  if (arg === '--profile' && next !== undefined) {
    leading.push(arg, next);
    index += 1;
  } else if (arg.startsWith('--profile=')) {
    leading.push(arg);
  } else {
    trailing.push(arg);
  }
}

const args = ['compose', '--env-file', envPath, '-f', composeFile, ...leading, ...trailing];

/**
 * The stack applies its own schema before `up`.
 *
 * The image carries sources, not tables: `policy_version`, `instance_param` and
 * `seamnex_ensure_partition()` are created by `packages/db` migrations and by nothing else. `pnpm dev`
 * ran them (see `scripts/dev.mjs`), `pnpm dev:stack` did not, so on a fresh `seamnex-dev_pgdata` volume
 * the API crash-looped inside `PolicyCompiler.onApplicationBootstrap` and compose reported only
 * `dependency failed to start: container seamnex-dev-api-1 is unhealthy` — a container error for a
 * database that had never been created. The datastores are therefore waited on, the migrations are
 * applied, and only then is the requested command run.
 *
 * Applied migrations are a no-op (one ledger read), so a warm stack pays milliseconds for this.
 * `DATABASE_URL` comes from the same root `.env` the CLI would load itself; passing it explicitly
 * keeps an exported shell value from aiming the migrations at a different database.
 */
/**
 * The root `.env` as a map, for the two callers that need more than one key: the migration step
 * wants `DATABASE_URL`, and ADR-BE-23's detection wants the Keycloak settings. Compose itself does
 * its own parsing with `--env-file`; this reader exists only for the steps compose does not run.
 */
function readRootEnv() {
  const values = {};
  if (!existsSync(envPath)) return values;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match !== null) values[match[1]] = match[2];
  }
  return values;
}

function readEnvValue(key) {
  return readRootEnv()[key];
}

function applySchema() {
  const datastores = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      envPath,
      '-f',
      composeFile,
      ...leading,
      'up',
      '-d',
      '--wait',
      'postgres',
      'redis',
    ],
    { cwd: root, stdio: 'inherit' },
  );
  if (datastores.status !== 0) {
    process.stderr.write(
      '[compose] postgres and redis did not become healthy; run `pnpm dev:stack:logs postgres`\n',
    );
    return false;
  }

  // `pnpm` is a .cmd shim on Windows, so it needs a shell there; `docker` does not and keeps argv.
  const migrated = spawnSync('pnpm', ['--filter', '@seamnex/db', 'migrate:up'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      DATABASE_URL: readEnvValue('DATABASE_URL') ?? process.env.DATABASE_URL ?? '',
    },
  });
  if (migrated.status !== 0) {
    process.stderr.write(
      '[compose] schema migrations failed; the API would start against an empty database\n',
    );
    return false;
  }
  return true;
}

// `up` (with or without `-d`) is the only subcommand that needs a schema. `down`, `logs`, `ps` and
// `config` must stay single calls: they are used to inspect a stack that is already broken.
if (trailing[0] === 'up' && !applySchema()) {
  process.exit(1);
}

// No shell: `docker` is a real executable on every platform (unlike `pnpm`, which is a .cmd file on
// Windows), and passing an argument array through a shell only invites quoting bugs — the paths here
// contain spaces on some machines — plus Node's deprecation warning for shell-with-args.
const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });

if (result.error) {
  process.stderr.write(`[compose] ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
  if (result.status === 0 && trailing[0] === 'up') reconcileKeycloakAdminClient(trailing.slice(1));
}

/**
 * ADR-BE-23 — reconcile the platform's Keycloak admin client once the realm has been applied.
 *
 * Two properties are load-bearing. The step runs **after** `keycloak-config-cli`, because the client
 * it reconciles is declared in `platform/realm/*.json` and an earlier run would be undone by the
 * import. And it runs in a **child** (`scripts/kc-admin.mjs --auto`), because this file is
 * synchronous end to end and the wait belongs with the code that owns the decision.
 */
function reconcileKeycloakAdminClient(upArguments) {
  // A partial `up` (named services) does not start the realm import, so there is nothing to wait
  // for. `pnpm dev:stack up postgres` must not become a Keycloak call.
  if (upArguments.some((argument) => !argument.startsWith('-'))) return;

  // Exported variables win over the file, matching the child's precedence (`scripts/kc-admin.mjs`).
  const decision = kcBootstrapDecision(
    { ...readRootEnv(), ...process.env },
    { stackDeclaresKeycloak: stackDeclaresKeycloak(composeFile) },
  );
  if (decision.note !== null) process.stderr.write(`[compose] ${decision.note}\n`);
  if (!decision.run) {
    log(`keycloak admin client: skipped (${decision.reason})`);
    return;
  }

  if (!realmImportFinished(decision.mode)) return;

  const reconciled = spawnSync(
    process.execPath,
    [join(root, 'scripts', 'kc-admin.mjs'), '--auto', '--wait=60'],
    { cwd: root, stdio: 'inherit' },
  );
  if ((reconciled.status ?? 1) !== 0) {
    reconcileFailed('the admin client could not be reconciled', decision.mode);
  }
}

/**
 * Blocks until the realm import has finished, and says whether it succeeded.
 *
 * `wait`, not `up --wait`: a one-shot that legitimately exits 0 is not "running", and only the exit
 * code distinguishes "realm applied" from "realm import failed". A stack that manages its realm by
 * hand declares no import service, and there is nothing to wait for.
 */
function realmImportFinished(mode) {
  if (!stackDeclaresService(composeFile, REALM_IMPORT_SERVICE)) {
    log('the stack declares no realm import; reconciling without waiting');
    return true;
  }

  log(`waiting for the realm import (${REALM_IMPORT_SERVICE})`);
  const imported = spawnSync(
    'docker',
    ['compose', '--env-file', envPath, '-f', composeFile, ...leading, 'wait', REALM_IMPORT_SERVICE],
    { cwd: root, stdio: 'inherit', timeout: REALM_IMPORT_TIMEOUT_MS },
  );
  const timedOut = imported.error?.code === 'ETIMEDOUT';
  if (!timedOut && (imported.status ?? 1) === 0) return true;

  const detail = timedOut
    ? `did not finish within ${Math.round(REALM_IMPORT_TIMEOUT_MS / 1000)} s`
    : `exited with code ${imported.status}`;
  reconcileFailed(`the realm import ${detail}; the admin client was not reconciled`, mode);
  return false;
}

/** `auto` warns and the install continues; `force` is the mode an operator chose to fail on. */
function reconcileFailed(message, mode) {
  process.stderr.write(`[compose] ${message}\n`);
  if (mode === 'force') process.exitCode = 1;
}

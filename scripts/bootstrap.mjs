#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';
import { pnpmCommandLine } from './lib/pnpm.mjs';

/**
 * NFR-6.2 / NFR-6.3 — one documented bootstrap, idempotent and re-runnable.
 *
 * `pnpm dev` is a developer loop; this is the install path. It exists so "a clean host becomes a
 * working platform" is a command with a verifiable end state instead of a paragraph of prose, and so
 * a second run is a no-op rather than a second install. Everything it does is delegated to the code
 * that already owns it — `scripts/compose.mjs` for the stack (which already seeds `.env`, writes the
 * credential files, applies the schema, waits for the realm import and reconciles the admin client),
 * the package scripts for the catalogue — because a bootstrap that reimplements its steps is a
 * bootstrap that drifts from them.
 *
 * What it adds on top: a preflight that names the missing prerequisite instead of failing inside
 * turbo, the deterministic projection of whichever catalogue checkout exists, an independent readiness check, and
 * a summary of what is now reachable and what still needs a human (NFR-6.2's timing budget, S-9's
 * "unfamiliar operator").
 *
 * Usage:
 *   pnpm bootstrap            # install, or repair, a host
 *   pnpm bootstrap --check    # verify an install; changes nothing
 *   pnpm bootstrap --wait=300 # readiness deadline in seconds (default 240)
 */

const root = dirname(import.meta.dirname);
const envPath = join(root, '.env');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const waitSeconds = numberArgument('--wait', 240);

/**
 * `pnpm` is a `.cmd` shim on Windows and cannot be spawned without a shell there (Node's fix for
 * CVE-2024-27980 returns EINVAL), so its command line is built by `lib/pnpm.mjs` and spawned as a
 * string — never as an argv array beside `shell: true`, which Node deprecated as DEP0190.
 * `docker` is a real executable everywhere and keeps its argv.
 */
function runPnpm(args, options = {}) {
  return spawnSync(pnpmCommandLine(args), {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    ...options,
  });
}

/**
 * The published API port. `docker/compose.dev.yml` maps `127.0.0.1:8080` to the container's 8080
 * unconditionally, so this is the port that exists on the host regardless of `PORT` — using `PORT`
 * here would poll a port nothing published.
 */
const API_BASE_URL = 'http://127.0.0.1:8080/api/v1';

const problems = [];
const warnings = [];

function log(message) {
  process.stdout.write(`[bootstrap] ${message}\n`);
}

function warn(message) {
  warnings.push(message);
  process.stderr.write(`[bootstrap] warning: ${message}\n`);
}

function fail(message) {
  problems.push(message);
  process.stderr.write(`[bootstrap] ${message}\n`);
}

function numberArgument(name, fallback) {
  const match = argv.find((argument) => argument.startsWith(`${name}=`));
  if (match === undefined) return fallback;
  const value = Number.parseInt(match.slice(name.length + 1), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options });
}

function readEnv() {
  if (!existsSync(envPath)) return {};
  return parseEnv(readFileSync(envPath, 'utf8'));
}

// ---------------------------------------------------------------------------------------------
// Preflight — the three prerequisites the runbook names, checked where they are cheap to explain.
// ---------------------------------------------------------------------------------------------

function checkNode() {
  const declared = manifest.engines?.node ?? '';
  const floor = /(?:>=|\^|~)?\s*(\d+)\.(\d+)\.(\d+)/.exec(declared);
  const ceiling = /<\s*(\d+)/.exec(declared);
  const [major, minor, patch] = process.versions.node.split('.').map(Number);

  if (floor === null) {
    warn(`package.json declares no parseable engines.node ("${declared}"); skipping the check`);
    return true;
  }
  const [needMajor, needMinor, needPatch] = [Number(floor[1]), Number(floor[2]), Number(floor[3])];
  const belowFloor =
    major < needMajor ||
    (major === needMajor && minor < needMinor) ||
    (major === needMajor && minor === needMinor && patch < needPatch);
  const aboveCeiling = ceiling !== null && major >= Number(ceiling[1]);

  if (belowFloor || aboveCeiling) {
    fail(
      `Node ${process.versions.node} does not satisfy "${declared}" from package.json. ` +
        'Install the version `package.json` pins (Corepack and `volta` both read it), then re-run.',
    );
    return false;
  }
  log(`node ${process.versions.node} satisfies ${declared}`);
  return true;
}

function checkPnpm() {
  const declared = manifest.packageManager ?? '';
  const result = runPnpm(['--version']);
  if (result.status !== 0) {
    fail(
      'pnpm is not on PATH. Enable Corepack (`corepack enable`) and run `corepack prepare ' +
        `${declared || 'pnpm'} --activate\`, or install the version package.json pins.`,
    );
    return false;
  }
  const found = (result.stdout ?? '').trim();
  const expected = /pnpm@(\d+\.\d+\.\d+)/.exec(declared);
  if (expected !== null && Number(found.split('.')[0]) !== Number(expected[1].split('.')[0])) {
    fail(
      `pnpm ${found} is a different major than package.json's "${declared}". A different major ` +
        'resolves a different lockfile format, so the install would not be the one that was tested.',
    );
    return false;
  }
  if (expected !== null && found !== expected[1]) {
    // A minor difference is usually harmless, but the runbook promises the pinned toolchain and a
    // silent drift is how "works on my host" starts.
    warn(`pnpm ${found} differs from package.json's pinned ${expected[1]}; Corepack would pin it.`);
  }
  log(`pnpm ${found}`);
  return true;
}

function checkDocker() {
  if (run('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    fail(
      'Docker is not reachable. Start Docker Desktop (or the daemon) and re-run. Every runtime ' +
        'dependency — PostgreSQL, Redis, Keycloak, the S3 gateway — runs in the stack.',
    );
    return false;
  }
  const compose = run('docker', ['compose', 'version'], { stdio: 'ignore' });
  if (compose.status !== 0) {
    fail('Docker Compose v2 is required (`docker compose`, not `docker-compose`).');
    return false;
  }
  log('docker and docker compose v2 are available');
  return true;
}

// ---------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------

/**
 * `.env` is the install's identity: the database password, the identity provider, the ports. Creating
 * it from the example is right for a first run and wrong for a re-run — re-copying would discard an
 * operator's edits — so an existing file is never touched.
 */
function ensureEnvFile() {
  if (existsSync(envPath)) {
    log('.env is present; leaving it untouched');
    return true;
  }
  if (checkOnly) {
    fail('there is no .env, so nothing is installed to check. Run `pnpm bootstrap` first.');
    return false;
  }
  copyFileSync(join(root, '.env.example'), envPath);
  log('created .env from .env.example — review it before exposing this host');
  return true;
}

/**
 * The workspace itself.
 *
 * `--frozen-lockfile` matters: an install that resolves fresh ranges is not the install that was
 * tested, and NFR-6.3's "same procedure on another host" means the same dependency graph. A warm tree
 * makes this a ledger read. `mocks:init` writes the untracked MSW worker the SPAs import, so a clean
 * clone's console can render without a manual step the runbook would otherwise have to remember.
 */
function installWorkspace() {
  for (const [label, args] of [
    ['installing workspace dependencies', ['install', '--frozen-lockfile']],
    ['generating the mock service worker (untracked)', ['mocks:init']],
  ]) {
    log(label);
    const result = runPnpm(args, { stdio: 'inherit' });
    if ((result.status ?? 1) !== 0) {
      fail(`"pnpm ${args.join(' ')}" failed; nothing after it can run against this tree.`);
      return false;
    }
  }
  return true;
}

/** The stack owns its own bootstrap; this only decides whether to run it. */
function bringUpStack() {
  log('bringing up the stack (schema, realm import and admin client included)');
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'compose.mjs'), 'up', '-d'], {
    cwd: root,
    stdio: 'inherit',
  });
  if ((result.status ?? 1) !== 0) {
    fail(
      'the stack did not come up. Inspect it with `pnpm dev:stack:logs`, and re-run this command — ' +
        'every step is idempotent, so a partial install is repaired rather than duplicated.',
    );
    return false;
  }
  return true;
}

/**
 * The catalogue and the identity mirror are data, not schema: migrations leave both empty.
 *
 * The seed is deterministic and idempotent (its own header says so) and it is what grants the realm's
 * `dev-*` accounts their role bindings — without it the console signs in and every screen is empty,
 * which reads as a broken install. `catalog:project` is content-hash driven, so a warm host pays one
 * read per file.
 *
 * Neither step fetches anything (ADR-BE-42): the catalogue is a checkout, and a host that has not
 * synced one starts with an empty catalogue on purpose. The closing note names that step instead of
 * promising content this repository no longer ships.
 */
function projectData(env) {
  const databaseUrl = env.DATABASE_URL ?? process.env.DATABASE_URL ?? '';
  for (const [label, args] of [
    ['seeding identity and projecting the catalogue checkout', ['--filter', '@seamnex/db', 'seed']],
    ['projecting the catalogue environment schemas', ['catalog:project']],
  ]) {
    log(label);
    const result = runPnpm(args, {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
    });
    if ((result.status ?? 1) !== 0) {
      fail(`"${args.join(' ')}" failed; the platform would start with an unusable catalogue.`);
      return false;
    }
  }
  log(
    'catalogue content is not shipped with the platform: run `pnpm catalog:sync --ref <tag>` ' +
      '(Catalog → "Sync from source") to serve a tag.',
  );
  return true;
}

/**
 * Readiness is checked here rather than trusted from `up --wait`: compose's healthcheck proves the
 * container's socket answers, this proves the API answers on the host's port with its dependencies
 * reachable — which is what "a working platform" means to the operator reading the runbook.
 */
async function waitForReady() {
  const deadline = Date.now() + waitSeconds * 1_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_BASE_URL}/readyz`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const report = await response.json();
        const dependencies = (report.dependencies ?? [])
          .map((dependency) => `${dependency.name}:${dependency.ok ? 'ok' : 'down'}`)
          .join(', ');
        log(`ready at ${API_BASE_URL}/readyz (${dependencies || 'no dependencies reported'})`);
        return true;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(2_000);
  }
  fail(
    `the API did not become ready at ${API_BASE_URL}/readyz within ${waitSeconds} s (${lastError}). ` +
      'Read `pnpm dev:stack:logs api`; the stack is up but the platform is not served.',
  );
  return false;
}

// ---------------------------------------------------------------------------------------------
// Posture — things a working install can still be wrong about, reported rather than hidden.
// ---------------------------------------------------------------------------------------------

function reportPosture(env) {
  if ((env.POSTGRES_PASSWORD ?? '').startsWith('seamnex_dev_password')) {
    warn(
      'POSTGRES_PASSWORD is the example value. Change it (and DATABASE_URL, and not the volume) ' +
        'before this host holds anything you care about.',
    );
  }
  if ((env.AUTH_PROVIDER ?? '') === 'stub') {
    warn('AUTH_PROVIDER=stub authenticates nobody; it is a development affordance, not a sign-in.');
  }
  if ((env.SEAMNEX_ROOT_KEY_STRICT_MODE ?? '0') === '0') {
    warn(
      'SEAMNEX_ROOT_KEY_STRICT_MODE=0 accepts a world-readable root key. Use 1 on a POSIX host; ' +
        'it is 0 here only because a Docker Desktop bind mount reports 0777.',
    );
  }
  if (!existsSync(join(root, env.SEAMNEX_ROOT_KEY_FILE ?? 'temp/seamnex-root-key'))) {
    warn('the root key file is missing; stored credentials cannot be decrypted until it exists.');
  }
  if (
    !existsSync(
      join(root, env.SEAMNEX_KEYCLOAK_ADMIN_CLIENT_SECRET_FILE ?? 'temp/kc-admin-client-secret'),
    )
  ) {
    warn(
      'the Keycloak admin-client secret file is missing; deployments cannot register a client per ' +
        'instance, so each product keeps its own local credential.',
    );
  }
  if ((env.PORT ?? '8080') !== '8080') {
    // The readiness probe reads the published host port, and `docker/compose.dev.yml` publishes 8080
    // whatever `PORT` says. A host that moved it would look uninstalled for a reason this names.
    warn(
      `PORT=${env.PORT} does not change the published port: the stack maps 127.0.0.1:8080. ` +
        'Change the compose mapping too, or the API answers where this check does not look.',
    );
  }
  // Stated, not warned: TLS is ISSUE-07 and this install path deliberately does not claim it.
  log(
    'TLS is not part of this install. The stack publishes on 127.0.0.1 and expects a TLS-terminating ' +
      'edge in front of it; do not expose these ports directly.',
  );
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  log(checkOnly ? 'checking an existing install' : 'bootstrapping this host');

  const prerequisites = checkNode() && checkPnpm() && checkDocker();
  const hasEnv = ensureEnvFile();
  const env = readEnv();

  if (checkOnly) {
    if (prerequisites && hasEnv) {
      await waitForReady();
      reportPosture(env);
    }
  } else if (prerequisites && hasEnv) {
    // The datastores have to be up before the seed can reach them, and `compose.mjs up` applies the
    // schema first, so the order below is: workspace, stack, data, readiness — not data, stack.
    if (installWorkspace() && bringUpStack()) {
      projectData(env);
      await waitForReady();
      reportPosture(env);
    }
  }

  if (problems.length > 0) {
    process.stderr.write(
      `\n[bootstrap] ${problems.length} problem(s); this host is not installed.\n`,
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    [
      '',
      '[bootstrap] this host is installed and verified.',
      '  API                      http://127.0.0.1:8080/api/v1/healthz',
      '  Readiness                http://127.0.0.1:8080/api/v1/readyz',
      '  Keycloak                 http://127.0.0.1:8082 (realm: ' +
        `${env.SEAMNEX_KEYCLOAK_REALM ?? 'seamnex'})`,
      '  Console                  pnpm dev:console  (Vite on 5174; not part of this stack)',
      '  Sign in as               dev-admin (the realm import provisions the dev accounts)',
      '',
      '  Next: follow docs/operations/bootstrap.md — deploy a product from the',
      '  console, then take a backup. That deployment is S-9’s evidence, not this line.',
      '',
    ].join('\n'),
  );
}

await main();

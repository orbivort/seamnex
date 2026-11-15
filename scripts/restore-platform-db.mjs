#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

/**
 * `pnpm restore:platform-db --dump <platform.dump>` — the control-plane database, restored by an
 * operator (FR-1.35, FR-1.36, AC-30).
 *
 * Why this exists beside the in-product restore: `pg_restore --clean` needs a role that owns the
 * schema, and the platform connects as `seamnex_app`, which by design holds no DDL rights and cannot
 * write `audit_event` (migration `0010_grants`). Handing the API an owner credential for the duration
 * of a restore is one option — `SEAMNEX_PLATFORM_RESTORE_DB_URL` — and this script is the other: the
 * restore happens on the clean host, before `api` and the workers start (design §10.6 step 3), with
 * credentials the platform never holds.
 *
 * The two paths run the same statement set. A run that skips the database because no credential was
 * configured records the outstanding step and cannot end `complete`; that is deliberate, because a
 * completed restore that never restored the control plane is the defect this whole path replaces.
 */

const USAGE =
  'usage: node scripts/restore-platform-db.mjs --dump <platform.dump> [--url <owner db url>] [--docker-host <host>] [--yes]';

const root = dirname(import.meta.dirname);

/** Addresses a helper container on the host network can reach; a compose name cannot be resolved. */
const HOST_REACHABLE = ['127.0.0.1', 'localhost', '::1', 'host.docker.internal'];

/** Tables worth printing after the restore: a row count is the cheapest proof it is not empty. */
const PROOF_TABLES = [
  'instance',
  'instance_route',
  'backup',
  'restore_run',
  'deployment_job',
  'audit_event',
  'entitlement',
];

function log(message) {
  process.stdout.write(`[restore-platform-db] ${message}\n`);
}

function warn(message) {
  process.stderr.write(`[restore-platform-db] ${message}\n`);
}

function parseFlags(argv) {
  const flags = { dump: null, url: null, dockerHost: null, yes: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dump') flags.dump = argv[(index += 1)] ?? null;
    else if (arg.startsWith('--dump=')) flags.dump = arg.slice('--dump='.length);
    else if (arg === '--url') flags.url = argv[(index += 1)] ?? null;
    else if (arg.startsWith('--url=')) flags.url = arg.slice('--url='.length);
    else if (arg === '--docker-host') flags.dockerHost = argv[(index += 1)] ?? null;
    else if (arg.startsWith('--docker-host='))
      flags.dockerHost = arg.slice('--docker-host='.length);
    else if (arg === '--yes') flags.yes = true;
    else return { error: `unknown argument "${arg}"` };
  }
  return { flags };
}

/** The root `.env` with the environment layered over it, the same way `pnpm dev` reads it. */
function readEnv() {
  const path = join(root, '.env');
  const file = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  return { ...file, ...process.env };
}

function resolveFromRoot(path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

const parsed = parseFlags(process.argv.slice(2));
if (parsed.error !== undefined) {
  warn(parsed.error);
  warn(USAGE);
  process.exit(2);
}
const { flags } = parsed;

if (flags.dump === null) {
  warn('--dump is required: the `platform.dump` artefact out of the recovery set');
  warn(USAGE);
  process.exit(2);
}

const dumpPath = resolveFromRoot(flags.dump);
if (!existsSync(dumpPath)) {
  warn(`no dump at ${dumpPath}`);
  process.exit(1);
}
const dumpBytes = statSync(dumpPath).size;
if (dumpBytes === 0) {
  warn(`${dumpPath} is empty; a set that captured nothing cannot be restored`);
  process.exit(1);
}

/**
 * pg_dump's custom format starts with `PGDMP`. It is a five-byte check that costs nothing and turns
 * "the dump is corrupt" into a message before the first `DROP TABLE`, rather than a page of
 * pg_restore complaints against a live database.
 */
const magic = readFileSync(dumpPath).subarray(0, 5).toString('latin1');
if (magic !== 'PGDMP') {
  warn(`${dumpPath} is not a custom-format pg_dump archive (it does not start with PGDMP)`);
  process.exit(1);
}

const env = readEnv();
// The credential comes from the operator or from the setting the API reads; never from argv, because
// a process argument is visible to every user on the host.
const url = (flags.url ?? env.SEAMNEX_PLATFORM_RESTORE_DB_URL ?? '').trim();
if (url.length === 0) {
  warn('no owner database URL: pass --url or set SEAMNEX_PLATFORM_RESTORE_DB_URL');
  warn(
    'the application role cannot run this restore: it holds no DDL rights and cannot write audit_event',
  );
  process.exit(1);
}

let connection;
try {
  const parsedUrl = new URL(url);
  connection = {
    host: parsedUrl.hostname,
    port: parsedUrl.port === '' ? '5432' : parsedUrl.port,
    database: parsedUrl.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(parsedUrl.username),
    password: decodeURIComponent(parsedUrl.password),
  };
} catch {
  // The value is never echoed: a malformed URL usually still carries the password.
  warn('the database URL is not a valid postgres:// URL');
  process.exit(1);
}

if (!HOST_REACHABLE.includes(connection.host)) {
  warn(
    `the helper container runs on the host network, so it cannot resolve "${connection.host}"; use the published 127.0.0.1 address`,
  );
  process.exit(1);
}
if (connection.password.length === 0) {
  warn('the database URL carries no password; the restore needs an owner credential');
  process.exit(1);
}

const dockerHost = flags.dockerHost ?? env.SEAMNEX_DOCKER_HOST ?? 'unix:///var/run/docker.sock';
const pathMap = env.SEAMNEX_DOCKER_PATH_MAP ?? '';

log(
  `restoring ${connection.database} on ${connection.host}:${connection.port} as ${connection.user} from ${dumpPath} (${Math.round(dumpBytes / 1024)} KiB)`,
);
if (!flags.yes) {
  log('this replaces every table the dump contains; re-run with --yes to proceed');
  process.exit(2);
}

/** The host spelling of a directory, so the daemon can bind it (same rule as the API's helper). */
function mountSource(directory) {
  const pairs = pathMap
    .split(',')
    .map((pair) => pair.trim())
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const separator = pair.indexOf('=');
      return [
        pair
          .slice(0, separator)
          .trim()
          .replace(/[\\/]+$/, ''),
        pair
          .slice(separator + 1)
          .trim()
          .replace(/[\\/]+$/, ''),
      ];
    })
    .filter(([from, to]) => from.length > 0 && to.length > 0)
    .sort((left, right) => right[0].length - left[0].length);

  for (const [from, to] of pairs) {
    if (directory === from) return to;
    const boundary = directory.charAt(from.length);
    if (directory.startsWith(from) && (boundary === '/' || boundary === '\\')) {
      return `${to}${directory.slice(from.length)}`;
    }
  }
  return directory;
}

/**
 * One helper container, one command. The password travels in a 0600 file inside the mounted
 * directory and is removed in `finally`, so a failed restore leaves no credential behind either.
 */
function runHelper({ directory, passFile, args }) {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'host',
      '-v',
      `${mountSource(directory)}:/backup`,
      '-e',
      `PGPASSFILE=/backup/${passFile}`,
      '-e',
      `PGHOST=${connection.host}`,
      '-e',
      `PGPORT=${connection.port}`,
      '-e',
      `PGDATABASE=${connection.database}`,
      '-e',
      `PGUSER=${connection.user}`,
      'postgres:18-alpine',
      ...args,
    ],
    { env: { PATH: process.env.PATH ?? '', DOCKER_HOST: dockerHost }, encoding: 'utf8' },
  );
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const directory = dirname(dumpPath);
const passFile = `.pgpass-restore-${process.pid}`;
writeFileSync(
  join(directory, passFile),
  `${connection.host}:${connection.port}:${connection.database}:${connection.user}:${connection.password}\n`,
  { mode: 0o600 },
);

/**
 * Partition upkeep, the same statements `ensurePlatformPartitions` runs in the API.
 *
 * The dump carries the partitions that existed when it was taken, so a set older than the lookahead
 * window comes back without today's `job_log` partition and without the current audit month — and
 * every log append, and every audited mutation, then fails closed. Creation goes through the
 * `SECURITY DEFINER` function, so this needs no DDL right of its own.
 */
function ensurePartitions() {
  const lookahead = Number.parseInt(env.SEAMNEX_PARTITION_LOOKAHEAD_DAYS ?? '9', 10);
  const days = Number.isInteger(lookahead) && lookahead > 0 && lookahead <= 180 ? lookahead : 9;
  const sql = [
    `SELECT seamnex_ensure_partition(
       'job_log',
       'job_log_p' || to_char(day AT TIME ZONE 'UTC', 'YYYYMMDD'),
       day,
       day + interval '1 day')
     FROM generate_series(
       date_trunc('day', now() AT TIME ZONE 'UTC')::timestamp AT TIME ZONE 'UTC',
       date_trunc('day', now() AT TIME ZONE 'UTC')::timestamp AT TIME ZONE 'UTC' + make_interval(days => ${days}),
       interval '1 day') AS day;`,
    `SELECT seamnex_ensure_partition(
       'audit_event',
       'audit_event_p' || to_char(month AT TIME ZONE 'UTC', 'YYYYMM'),
       month,
       month + interval '1 month')
     FROM generate_series(
       date_trunc('month', now() AT TIME ZONE 'UTC')::timestamp AT TIME ZONE 'UTC',
       date_trunc('month', now() AT TIME ZONE 'UTC')::timestamp AT TIME ZONE 'UTC' + interval '2 months',
       interval '1 month') AS month;`,
  ].join('\n');
  const result = runHelper({
    directory,
    passFile,
    args: ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  });
  if (result.code !== 0) {
    warn(
      `partition upkeep failed (psql exited ${result.code}); the restored log tables may refuse writes`,
    );
    for (const line of result.stderr
      .split('\n')
      .filter((entry) => entry.trim() !== '')
      .slice(0, 10)) {
      warn(line);
    }
    return false;
  }
  log(`partitions ensured: ${days + 1} job_log day(s) and 3 audit month(s)`);
  return true;
}

try {
  const restored = runHelper({
    directory,
    passFile,
    args: [
      'pg_restore',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--single-transaction',
      // `--dbname` takes a database, and `pg_restore` requires it: unlike `psql` it does not fall back
      // to `PGDATABASE`. The archive is the positional argument — passing the path to `--dbname`
      // made the helper read stdin (empty) and fail with "input file is too short (read 0, expected
      // 5)". Only the database name is in argv; the password stays in the 0600 file.
      '--dbname',
      connection.database,
      `/backup/${dumpPath.split(/[\\/]/).pop()}`,
    ],
  });
  if (restored.code !== 0) {
    warn(`pg_restore exited ${restored.code}`);
    for (const line of restored.stderr
      .split('\n')
      .filter((entry) => entry.trim() !== '')
      .slice(0, 20)) {
      warn(line);
    }
    process.exitCode = 1;
  } else {
    log('pg_restore finished without error; the dump was applied in one transaction');
    // Kept non-fatal for the exit code's sake only in appearance: the counts below are still printed,
    // but a platform whose log partitions are missing cannot record anything, so it is reported red.
    if (!ensurePartitions()) process.exitCode = 1;
    const existing = runHelper({
      directory,
      passFile,
      args: [
        'psql',
        '-X',
        '-A',
        '-t',
        '-c',
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      ],
    });
    const tables = new Set(
      existing.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== ''),
    );
    if (existing.code !== 0) {
      warn('the restore succeeded but the row counts could not be read');
    } else {
      log(`public tables now present: ${tables.size}`);
      for (const table of PROOF_TABLES) {
        if (!tables.has(table)) {
          log(`  ${table}: absent`);
          continue;
        }
        const counted = runHelper({
          directory,
          passFile,
          args: ['psql', '-X', '-A', '-t', '-c', `SELECT count(*) FROM ${table}`],
        });
        log(`  ${table}: ${counted.code === 0 ? counted.stdout.trim() : 'unreadable'}`);
      }
    }
    log('start `api` and the workers next, then verify the audit chain from the Recovery screen');
  }
} finally {
  rmSync(join(directory, passFile), { force: true });
}

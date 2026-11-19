/**
 * Seeds or refreshes the advisory database the image scan reads offline (NFR-4.6 / S-10).
 *
 * The scanner container is started with no network, so it cannot download advisories at scan time.
 * This script is the one place that does have a route: it runs the same pinned scanner image with
 * `--download-db-only`, writing into `SEAMNEX_SCAN_CACHE_DIR`, which the API mounts into the scanner.
 * Without it a `cached` scan refuses to run — deliberately, because a scan against a missing or
 * months-old database reports "no findings" for an image nobody really looked at.
 *
 * It is safe to re-run: the OCI artifact is re-fetched and the cache replaced in place. Run it after
 * an upgrade of `SEAMNEX_SCANNER_IMAGE`, and on a schedule (daily or weekly) so the cache stays inside
 * `SEAMNEX_SCAN_DB_MAX_AGE_HOURS`.
 *
 *   pnpm scan:db:update
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const env = { ...readEnvFile(), ...process.env };

const SCANNER_IMAGE = env.SEAMNEX_SCANNER_IMAGE ?? 'aquasec/trivy:0.57.1';
const DB_MODE = env.SEAMNEX_SCAN_DB_MODE ?? 'cached';
const DB_REPOSITORY = env.SEAMNEX_SCAN_DB_REPOSITORY ?? 'ghcr.io/aquasec/trivy-db';
const CACHE_DIR = resolveFromRoot(env.SEAMNEX_SCAN_CACHE_DIR ?? './temp/trivy-cache');
const JAVA_DB_REPOSITORY =
  env.SEAMNEX_SCAN_JAVA_DB_REPOSITORY ?? DB_REPOSITORY.replace(/trivy-db$/, 'trivy-java-db');
const HOST_CACHE = mountSource(CACHE_DIR, env.SEAMNEX_DOCKER_PATH_MAP ?? '');

const log = (message) => console.log(`[scan:db] ${message}`);
const warn = (message) => console.error(`[scan:db] ${message}`);

/**
 * `.env` is read the way Node's own `--env-file` reads it (`util.parseEnv`), so a quoted value or an
 * `export ` prefix means the same thing here as it does to the API and to `docker compose`. The file
 * is optional: every setting below has the same default the API ships.
 */
function readEnvFile() {
  try {
    return parseEnv(readFileSync(join(ROOT, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

/** Same rule as `config.ts`: a relative path speaks from the repository root, an absolute one is used. */
function resolveFromRoot(value) {
  const trimmed = value.trim();
  if (trimmed.length === 0 || isAbsolute(trimmed)) return trimmed;
  return resolve(ROOT, trimmed);
}

/**
 * The host spelling of a directory, so the daemon can bind it. Same rule as the API's
 * `common/docker/mount.ts`: `containerPath=hostPath` pairs, longest prefix first. Duplicated rather
 * than imported because this file runs under plain `node` without a TypeScript build step.
 */
function mountSource(directory, pathMap) {
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

/** One `docker run` of the pinned scanner. `--rm` keeps no container behind, even on failure. */
function download(trivyArgs, label, { optional = false } = {}) {
  log(`${label}: ${SCANNER_IMAGE}`);
  try {
    execFileSync(
      'docker',
      ['run', '--rm', '-v', `${HOST_CACHE}:/cache`, SCANNER_IMAGE, ...trivyArgs],
      {
        stdio: 'inherit',
        timeout: 15 * 60 * 1000,
        env: {
          ...process.env,
          ...(env.DOCKER_HOST === undefined ? {} : { DOCKER_HOST: env.DOCKER_HOST }),
          DOCKER_CLI_HINTS: 'false',
        },
      },
    );
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (optional) {
      warn(`${label} could not be downloaded: ${message}`);
      return false;
    }
    throw new Error(
      `${label} could not be downloaded: ${message}\n` +
        '  The scanner container needs a route to the repository. Use `SEAMNEX_SCAN_DB_REPOSITORY` ' +
        'to name an internal mirror, or seed this cache on a host that has egress and copy it over.',
      { cause: error },
    );
  }
}

/** What the API reads to decide freshness, printed so the operator can see what it will see. */
function report() {
  const database = join(CACHE_DIR, 'db', 'trivy.db');
  if (!existsSync(database)) {
    // Never a silent zero: the seeding run did not produce what the scan needs.
    throw new Error(`no vulnerability database was written to ${join(CACHE_DIR, 'db')}`);
  }
  const metadata = readMetadata(join(CACHE_DIR, 'db', 'metadata.json'));
  const sizeMiB = Math.round(statSync(database).size / 1024 / 1024);
  log(`database ready: ${database} (${sizeMiB} MiB)`);
  if (metadata !== null) log(`database timestamp: ${metadata} (this is what the age limit reads)`);
  log(
    existsSync(join(CACHE_DIR, 'java-db', 'trivy-java.db'))
      ? 'java database ready: JAR-packaged dependencies are covered'
      : 'java database absent: Trivy will skip JAR scanning and the job log will say so',
  );
}

function readMetadata(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed.DownloadedAt ?? parsed.UpdatedAt ?? null;
  } catch {
    return null;
  }
}

function main() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 30_000,
      env: process.env,
    });
  } catch {
    throw new Error('Docker is not reachable; start the daemon (DOCKER_HOST) and re-run.');
  }

  mkdirSync(CACHE_DIR, { recursive: true });
  log(
    `cache directory: ${CACHE_DIR}${HOST_CACHE === CACHE_DIR ? '' : ` (host spelling ${HOST_CACHE})`}`,
  );
  if (DB_MODE !== 'cached') {
    log(
      `SEAMNEX_SCAN_DB_MODE=${DB_MODE} fetches the database per scan; this cache is only read by a ` +
        '`cached` deployment, but seeding it now is what makes that switch safe.',
    );
  }

  download(
    ['image', '--download-db-only', '--cache-dir', '/cache', '--db-repository', DB_REPOSITORY],
    'vulnerability database',
  );
  // Best effort: a missing java database narrows coverage, it does not stop a scan, and the job log
  // reports the gap rather than the deployment failing on an ecosystem it may not even use.
  download(
    [
      'image',
      '--download-java-db-only',
      '--cache-dir',
      '/cache',
      '--java-db-repository',
      JAVA_DB_REPOSITORY,
    ],
    'java database',
    { optional: true },
  );

  report();
  log(
    'a containerised API needs this tree mounted and mapped, e.g. ' +
      '`- ../temp/trivy-cache:/var/lib/seamnex/trivy-cache` with ' +
      '`SEAMNEX_SCAN_CACHE_DIR=/var/lib/seamnex/trivy-cache` and the matching SEAMNEX_DOCKER_PATH_MAP pair',
  );
}

try {
  main();
} catch (error) {
  warn(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../config/config';

/**
 * NFR-4.6 / S-10 — the vulnerability database the scanner reads, and whether it may be read at all.
 *
 * The scanner is a second container started with no network (`image-scan.ts`). That boundary is the
 * point of the design, so the database cannot be fetched at scan time: it is seeded on the host by
 * `pnpm scan:db:update` and mounted into the scanner. The failure this module exists to prevent is
 * the quiet one — a cache that is missing or months old answers "no findings" for an image nobody
 * really looked at, which is the same "scanned nothing, claimed compliant" defect in a new costume.
 *
 * Hence two answers, and no third: the database is usable, or the scan is an `error`. Age is measured
 * from what the database says about itself (`DownloadedAt`, then `UpdatedAt`, then the file's mtime),
 * never from when this process happened to start.
 */
export type VulnDatabaseStatus =
  | { readonly ok: true; readonly mode: ScanDbMode; readonly updatedAt: Date | null }
  | { readonly ok: false; readonly mode: ScanDbMode; readonly failure: string };

/**
 * `cached` reads what `pnpm scan:db:update` wrote, `online` lets Trivy fetch and refresh the database
 * through the scanner container's network, and `mirror` does the same against an internal repository.
 *
 * The accepted values are declared by the Zod schema in `config.ts`; the tuple is repeated here rather
 * than imported because `config.ts` must not depend on `common/`, and a value it rejects is normalised
 * to `cached` — the strictest posture, never a silently wider one.
 */
export const SCAN_DB_MODES = ['cached', 'online', 'mirror'] as const;
export type ScanDbMode = (typeof SCAN_DB_MODES)[number];

/** The one command an operator can act on when the database is missing or stale. */
const REFRESH = '`pnpm scan:db:update`';

/** Days-to-hours aside, this is the shipped ceiling: a weekly refresh keeps the cache inside it. */
const DEFAULT_MAX_AGE_HOURS = 168;

export function scanDbMode(config: AppConfig): ScanDbMode {
  const raw = String(config.SEAMNEX_SCAN_DB_MODE ?? '')
    .trim()
    .toLowerCase();
  return (SCAN_DB_MODES as readonly string[]).includes(raw) ? (raw as ScanDbMode) : 'cached';
}

/** The Trivy cache directory, empty when the operator removed the default. */
export function scanCacheDir(config: AppConfig): string {
  return String(config.SEAMNEX_SCAN_CACHE_DIR ?? '').trim();
}

/** `ghcr.io/aquasec/trivy-db` unless pointed at an internal mirror. */
export function vulnDatabaseRepository(config: AppConfig): string {
  return String(config.SEAMNEX_SCAN_DB_REPOSITORY ?? '').trim();
}

/**
 * The network the scanner container joins.
 *
 * Empty means "derive": a cached scan has no reason to reach anything, while the two networked modes
 * are useless without a route. Naming a network is how a `mirror` deployment reaches the registry it
 * was configured for.
 */
export function scannerNetwork(config: AppConfig): string {
  const configured = String(config.SEAMNEX_SCAN_NETWORK ?? '').trim();
  if (configured.length > 0) return configured;
  return scanDbMode(config) === 'cached' ? 'none' : 'bridge';
}

/** Whether JAR-packaged dependencies were covered. `--skip-java-db-update` makes that a real gap. */
export function javaDatabaseSeeded(config: AppConfig): boolean {
  const cacheDir = scanCacheDir(config);
  return cacheDir.length > 0 && existsSync(join(cacheDir, 'java-db', 'trivy-java.db'));
}

/**
 * Whether a scan may run right now.
 *
 * `now` is a parameter so the age rule is testable without waiting a week.
 */
export function vulnDatabaseStatus(config: AppConfig, now: Date = new Date()): VulnDatabaseStatus {
  const mode = scanDbMode(config);
  // The networked modes update the database themselves; there is nothing local to inspect.
  if (mode !== 'cached') return { ok: true, mode, updatedAt: null };

  const cacheDir = scanCacheDir(config);
  if (cacheDir.length === 0) {
    return {
      ok: false,
      mode,
      failure: `no scanner cache directory is configured (SEAMNEX_SCAN_CACHE_DIR); seed the database with ${REFRESH}`,
    };
  }

  const dbDirectory = join(cacheDir, 'db');
  const databasePath = join(dbDirectory, 'trivy.db');
  // Only the database itself proves the cache is complete: a `metadata.json` left behind by an
  // interrupted download would otherwise read as a usable database.
  if (!existsSync(databasePath)) {
    return {
      ok: false,
      mode,
      failure: `no vulnerability database is present in ${dbDirectory}; seed it with ${REFRESH}`,
    };
  }

  const updatedAt = databaseUpdatedAt(dbDirectory, databasePath);
  if (updatedAt === null) {
    return {
      ok: false,
      mode,
      failure: `the vulnerability database in ${cacheDir} carries no readable timestamp; refresh it with ${REFRESH}`,
    };
  }

  const limitHours = maxAgeHours(config);
  // A negative age is a clock that moved backwards; it is not freshness worth reporting on.
  const ageHours = Math.max(0, (now.getTime() - updatedAt.getTime()) / 3_600_000);
  if (ageHours > limitHours) {
    return {
      ok: false,
      mode,
      failure:
        `the vulnerability database is ${Math.round(ageHours)} h old, over the ${limitHours} h limit ` +
        `(SEAMNEX_SCAN_DB_MAX_AGE_HOURS); refresh it with ${REFRESH}`,
    };
  }

  return { ok: true, mode, updatedAt };
}

function maxAgeHours(config: AppConfig): number {
  const configured = Number(config.SEAMNEX_SCAN_DB_MAX_AGE_HOURS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_AGE_HOURS;
}

/** The database's own word on when it was downloaded, with the file's mtime as the fallback. */
function databaseUpdatedAt(dbDirectory: string, databasePath: string): Date | null {
  const declared = declaredUpdate(dbDirectory);
  if (declared !== null) return declared;
  try {
    return statSync(databasePath).mtime;
  } catch {
    // Unreadable and untimestamped: the caller reports "no readable timestamp".
    return null;
  }
}

function declaredUpdate(dbDirectory: string): Date | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(join(dbDirectory, 'metadata.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    // Absent or truncated: the database file's mtime answers the same question.
    return null;
  }

  // Trivy writes `DownloadedAt`; older artefacts carry only `UpdatedAt`.
  for (const key of ['DownloadedAt', 'UpdatedAt']) {
    const value = parsed[key];
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

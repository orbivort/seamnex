import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Directories the API container bind-mounts and then writes into.
 *
 * Docker does not treat a missing bind-mount source as an error: it creates a directory in its
 * place, owned by root. The API runs as `node` (uid 1000), so on a Docker Desktop host such a
 * directory is not writable by the process that needs it, and the first `mkdir` fails:
 *
 *   - `catalog-repo/instances` — 4A.8 commits `instances/<slug>/instance.yaml` there before a job
 *     may apply (`REPOSITORY_UNAVAILABLE` when it cannot);
 *   - `instances` — render sets and source checkouts (`EACCES` in the deploy job at "Resolve
 *     source");
 *   - `backups`, `age` — backup archives and the age identity;
 *   - `traefik/dynamic` — the route projection's file provider.
 *
 * Creating them here, on the host, means the mount arrives with the host's ACL and the container
 * user can write to it. A directory that already holds data is never touched. An *empty* one is
 * reported instead of removed: it may be a Docker-created root directory whose mode cannot be
 * changed from the host on a bind mount, so the operator has to delete it once and re-run.
 *
 * @param {string} root Repository root.
 * @param {(message: string) => void} log Progress sink (`[dev]` / `[compose]`).
 * @returns {{ created: string[]; empty: string[] }} What was created, and what existed but is empty.
 */
export function ensureRuntimeDirs(root, log = () => {}) {
  const relative = [
    join('temp', 'instances'),
    join('temp', 'backups'),
    join('temp', 'age'),
    join('temp', 'traefik', 'dynamic'),
    join('temp', 'catalog-repo', 'instances'),
  ];
  const created = [];
  const empty = [];

  for (const entry of relative) {
    const directory = join(root, entry);
    try {
      statSync(directory);
      if (readdirSync(directory).length === 0) empty.push(entry);
      continue;
    } catch {
      // Absent: create it below, on the host, where the mount keeps the host's ACL.
    }
    try {
      mkdirSync(directory, { recursive: true, mode: 0o777 });
      created.push(entry);
    } catch (error) {
      throw new Error(
        `could not create ${directory}: ${error instanceof Error ? error.message : String(error)}.\n` +
          '  The API writes runtime state there; without it a deployment fails with EACCES or REPOSITORY_UNAVAILABLE.',
        { cause: error },
      );
    }
  }

  if (created.length > 0) log(`created writable runtime directories: ${created.join(', ')}`);
  if (empty.length > 0) {
    log(
      `existing empty runtime directories: ${empty.join(', ')}. ` +
        'If a deployment fails with EACCES on one of them, delete it and re-run: a directory Docker ' +
        'created for a missing mount belongs to root and only a re-created one inherits the host ACL.',
    );
  }
  return { created, empty };
}

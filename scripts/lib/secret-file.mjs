import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

/**
 * Creates a file that a container bind-mounts, before the container is created.
 *
 * Docker does not fail on a bind-mount source that does not exist: it creates a **directory** in its
 * place. The next start then dies inside runc with
 *
 *   error mounting ".../temp/kc-admin-client-secret" ... not a directory: Are you trying to mount a
 *   directory onto a file (or vice-versa)?
 *
 * which names neither the cause nor the fix, and leaves the placeholder behind so every later
 * `up` fails the same way. This module owns both halves of the guarantee: create the file, and
 * repair a placeholder a previous run left in `temp/`.
 *
 * A directory at one of these paths has exactly one origin — Docker's placeholder for a missing
 * source — and it is always empty. An empty one is therefore removed and replaced; a non-empty one
 * is somebody's data and stops the run with an instruction instead of being deleted.
 *
 * Contents are never overwritten: rotating a secret is a deliberate action, and a bootstrap that
 * silently changed one would lock out whatever is already using it.
 *
 * @param {string} path absolute path of the mounted file
 * @param {object} options
 * @param {string} options.contents file contents, written verbatim
 * @param {string} options.label how the file is named in log lines (repo-relative)
 * @param {(message: string) => void} [options.log]
 * @returns {boolean} whether the file was created by this call
 */
export function ensureSecretFile(path, { contents, label, log = () => {} }) {
  const name = label ?? path;

  if (existsSync(path)) {
    if (statSync(path).isFile()) return false;

    if (readdirSync(path).length > 0) {
      throw new Error(
        `${name} is a non-empty directory, not a file, so the container mount cannot work. ` +
          `Move it aside and run again; it must be a file holding the secret.`,
      );
    }

    // Empty: Docker's placeholder for the missing source file. Removing it is what makes the next
    // mount resolve to the file written below instead of failing runc again.
    rmdirSync(path);
    log(`replaced the empty directory Docker left at ${name}`);
  }

  mkdirSync(dirname(path), { recursive: true });
  // 0600 because every one of these files is a credential. Windows treats the mode as advisory and
  // the file lives under the git-ignored `temp/`, so the chmod is best-effort, not a guarantee.
  writeFileSync(path, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows: mode bits are advisory; the mount itself is read-only.
  }
  return true;
}

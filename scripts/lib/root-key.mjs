import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureSecretFile } from './secret-file.mjs';

/**
 * The development root key, in one place because every entry point needs it.
 *
 * `pnpm dev` generated it and `pnpm dev:stack` did not. The compose stack bind-mounts
 * `temp/seamnex-root-key` into the API container, and Docker creates a **directory** for a bind mount
 * whose source does not exist — so the container started healthy, then answered the first secret
 * write with `503 SECRET_UNAVAILABLE`. The failure only appears when a deployment carries a secret,
 * which is exactly when it is most expensive to discover.
 *
 * The "it is a directory" repair lives in `secret-file.mjs` and is shared with the two Keycloak
 * files, because all three are mounted the same way and fail the same way.
 *
 * @param {string} root repository root
 * @param {(message: string) => void} [log]
 * @returns {boolean} whether a key was created
 */
export function ensureRootKey(root, log = () => {}) {
  const created = ensureSecretFile(join(root, 'temp', 'seamnex-root-key'), {
    // 32 random bytes, base64 — the format the secrets module expects (design §11.4).
    contents: `${randomBytes(32).toString('base64')}\n`,
    label: 'temp/seamnex-root-key',
    log,
  });
  if (created) log('generated a development root key at temp/seamnex-root-key');
  return created;
}

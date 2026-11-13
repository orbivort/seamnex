import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { AppError } from '../../common/problem/app-error';

/**
 * Envelope encryption (design §11.4, deliverable 1.6).
 *
 *   root key (AES-256, host-mounted file, never in the database)
 *     └─ wraps a per-version data key (DEK)
 *          └─ encrypts the secret value with AES-256-GCM
 *
 * Why two layers: a value can be re-wrapped under a new root key without decrypting and re-entering
 * every secret, and a leaked database row is useless without the root key file.
 *
 * AAD binds a ciphertext to its secret id and version, so an attacker with write access to the table
 * cannot move a ciphertext to another row and have it decrypt.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type RootKey = { readonly id: string; readonly key: Buffer };

export type SealedSecret = {
  readonly dekId: string;
  readonly dekWrapped: Buffer;
  readonly ciphertext: Buffer;
  readonly aad: string;
};

export const ROOT_KEY_FILE_MODE = 0o600;

/**
 * Reads the host-mounted root key. A missing or malformed key is a configuration error, not a retry.
 *
 * `strictMode` is the permission check, and it has one legitimate exception. A bind mount on Docker
 * Desktop (Windows, and macOS by default) reports **0777** for every file regardless of the host
 * ACL, so a correct `0600` key on disk arrives as world-writable and the store refuses to start.
 * The check therefore stays on by default and the development stack opts out explicitly
 * (`SEAMNEX_ROOT_KEY_STRICT_MODE=0`), which is a visible decision in one file rather than a silent
 * weakening everywhere.
 */
export function loadRootKey(path: string, options: { strictMode?: boolean } = {}): RootKey {
  const strictMode = options.strictMode ?? true;
  let raw: string;
  try {
    const stats = statSync(path);
    if (strictMode && process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
      throw new AppError({
        code: 'SECRET_UNAVAILABLE',
        detail: `The root key file is readable by other users (mode ${(stats.mode & 0o777).toString(8)}).`,
        remediation:
          'Set the file mode to 0600. On a bind mount that cannot express POSIX modes (Docker Desktop reports 0777), set SEAMNEX_ROOT_KEY_STRICT_MODE=0 for that host.',
      });
    }
    raw = readFileSync(path, 'utf8').trim();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError({
      code: 'SECRET_UNAVAILABLE',
      detail: `The root key file is missing or unreadable (${path}).`,
      cause: error,
    });
  }

  const key = decodeKey(raw);
  if (key === undefined) {
    throw new AppError({
      code: 'SECRET_UNAVAILABLE',
      detail: 'The root key file does not contain a 32-byte key (base64 or hex).',
    });
  }

  return { id: createHash('sha256').update(key).digest('hex').slice(0, 16), key };
}

function decodeKey(raw: string): Buffer | undefined {
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const decoded = Buffer.from(raw, 'base64');
    return decoded.length === KEY_BYTES ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function generateRootKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/** Seals a value under a fresh DEK. The plaintext buffer is zeroed by the caller. */
export function seal(plaintext: Buffer, rootKey: RootKey, aad: string): SealedSecret {
  const dek = randomBytes(KEY_BYTES);
  try {
    const wrapped = encrypt(dek, rootKey.key, `${aad}:dek`);
    const ciphertext = encrypt(plaintext, dek, aad);
    return {
      dekId: createHash('sha256').update(dek).digest('hex').slice(0, 16),
      dekWrapped: wrapped,
      ciphertext,
      aad,
    };
  } finally {
    dek.fill(0);
  }
}

/** Reverses `seal`. A wrong root key or a moved ciphertext fails the GCM tag check. */
export function open(sealed: SealedSecret, rootKey: RootKey): Buffer {
  let dek: Buffer;
  try {
    dek = decrypt(sealed.dekWrapped, rootKey.key, `${sealed.aad}:dek`);
  } catch (error) {
    throw new AppError({
      code: 'SECRET_UNAVAILABLE',
      detail: 'The secret could not be unwrapped with the current root key.',
      cause: error,
    });
  }

  try {
    return decrypt(sealed.ciphertext, dek, sealed.aad);
  } finally {
    dek.fill(0);
  }
}

/**
 * GCM helper. The AAD is authenticated but not stored inside the payload, so a ciphertext copied
 * to another row (another id or version) fails the tag check instead of decrypting.
 */
function encrypt(plaintext: Buffer, key: Buffer, aad: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function decrypt(payload: Buffer, key: Buffer, aad: string): Buffer {
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = payload.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

export function aadFor(secretId: string, version: number): string {
  return `seamnex:secret:${secretId}:v${version}`;
}

import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aadFor,
  generateRootKey,
  loadRootKey,
  open,
  seal,
  type RootKey,
} from '../../../../src/modules/m15-secrets/envelope';
import { AppError } from '../../../../src/common/problem/app-error';

const rootKey: RootKey = { id: 'test', key: randomBytes(32) };

describe('envelope encryption', () => {
  it('round-trips a value', () => {
    const plaintext = Buffer.from('a-value-that-must-not-leak', 'utf8');
    const sealed = seal(plaintext, rootKey, aadFor('secret-1', 1));
    expect(open(sealed, rootKey).toString('utf8')).toBe('a-value-that-must-not-leak');
  });

  it('uses a different DEK per version, so identical values do not look identical', () => {
    const value = Buffer.from('same', 'utf8');
    const first = seal(value, rootKey, aadFor('secret-1', 1));
    const second = seal(value, rootKey, aadFor('secret-1', 2));
    expect(first.dekId).not.toBe(second.dekId);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it('refuses a ciphertext moved to another row (AAD binds id and version)', () => {
    const sealed = seal(Buffer.from('value', 'utf8'), rootKey, aadFor('secret-1', 1));
    // Same ciphertext, different identity: the GCM tag no longer verifies.
    expect(() => open({ ...sealed, aad: aadFor('secret-2', 1) }, rootKey)).toThrow();
  });

  it('fails to open with the wrong root key', () => {
    const sealed = seal(Buffer.from('value', 'utf8'), rootKey, aadFor('secret-1', 1));
    const other: RootKey = { id: 'other', key: randomBytes(32) };
    expect(() => open(sealed, other)).toThrow(AppError);
  });

  it('rejects a missing root key file with a coded problem, not a stack trace', () => {
    expect(() => loadRootKey('./temp/does-not-exist')).toThrow(/root key file is missing/);
  });
});

const dirs: string[] = [];

function keyFile(content: string, mode = 0o600): string {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-root-key-'));
  dirs.push(dir);
  const path = join(dir, 'seamnex-root-key');
  writeFileSync(path, content, { encoding: 'utf8', mode });
  // `mode` on creation is filtered through the process umask, and Windows ignores it outright, so
  // the requested bits are applied again: the permission check reads the mode on disk, and a test
  // that asked for 0644 must not silently get 0600 on a host with a strict umask.
  chmodSync(path, mode);
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('root key loading', () => {
  it('generates a key that loads back as 32 bytes', () => {
    const generated = generateRootKey();

    expect(Buffer.from(generated, 'base64')).toHaveLength(32);
    expect(loadRootKey(keyFile(generated)).key).toHaveLength(32);
  });

  it('accepts a base64 key of exactly 32 bytes', () => {
    const raw = randomBytes(32).toString('base64');

    const loaded = loadRootKey(keyFile(`${raw}\n`));

    expect(loaded.key).toHaveLength(32);
    expect(loaded.key.equals(Buffer.from(raw, 'base64'))).toBe(true);
    expect(loaded.id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accepts a hex key, which is what `openssl rand -hex 32` produces', () => {
    const hex = randomBytes(32).toString('hex');

    expect(loadRootKey(keyFile(hex)).key.equals(Buffer.from(hex, 'hex'))).toBe(true);
  });

  it('refuses a base64 key that decodes to the wrong length', () => {
    // Nineteen bytes is exactly the kind of near-miss a truncated copy produces; it is refused
    // rather than stretched, because a short AES key is not a weaker key, it is not a key.
    expect(() => loadRootKey(keyFile(randomBytes(19).toString('base64')))).toThrow(/32-byte key/);
  });

  it('refuses a file that is not a key at all', () => {
    expect(() => loadRootKey(keyFile('hello, world'))).toThrow(/32-byte key/);
  });

  it('refuses a key any other user can read, when the host can express file modes', () => {
    // Docker Desktop bind mounts report 0777 for every file, which is why the check is skippable;
    // the check itself must still run where POSIX modes are real. The platform is pinned so the
    // assertion holds on the CI runner as well as on a developer machine. The file is deliberately
    // group- and world-readable: a 0600 key is the case the store must accept, so creating one here
    // would assert a refusal the code has no reason to raise.
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const path = keyFile(randomBytes(32).toString('base64'), 0o644);

      expect(() => loadRootKey(path)).toThrow(/readable by other users/);
      // The documented opt-out for a mount that cannot express modes.
      expect(() => loadRootKey(path, { strictMode: false })).not.toThrow();
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
  });
});

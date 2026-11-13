import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aadFor,
  loadRootKey,
  open,
  seal,
  type RootKey,
} from '../../../../src/modules/m15-secrets/envelope';
import { AppError } from '../../../../src/common/problem/app-error';

/**
 * Damage to a sealed payload, at the two places it can happen. A wrapped DEK that does not decrypt
 * is a *configuration* failure (the wrong root key file) and is translated into a coded refusal; a
 * ciphertext that fails its GCM tag after a successful unwrap is a *tamper* signal and is left as
 * the raw crypto error, because translating it would hide which of the two happened.
 */
const rootKey: RootKey = { id: 'test', key: randomBytes(32) };

const dirs: string[] = [];

function keyFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'seamnex-root-key-'));
  dirs.push(dir);
  const path = join(dir, 'seamnex-root-key');
  writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('opening a damaged payload', () => {
  it('refuses a truncated wrapped DEK as an unavailable secret', () => {
    const sealed = seal(Buffer.from('value', 'utf8'), rootKey, aadFor('secret-1', 1));

    // Too short to carry an IV, so the unwrap itself fails: that is the root key's problem.
    expect(() =>
      open({ ...sealed, dekWrapped: sealed.dekWrapped.subarray(0, 5) }, rootKey),
    ).toThrow(AppError);
    expect(() =>
      open({ ...sealed, dekWrapped: sealed.dekWrapped.subarray(0, 5) }, rootKey),
    ).toThrow(/could not be unwrapped with the current root key/);
  });

  it('leaves a body that fails its tag check as a raw crypto error', () => {
    const sealed = seal(Buffer.from('value', 'utf8'), rootKey, aadFor('secret-1', 1));
    const truncated = { ...sealed, ciphertext: sealed.ciphertext.subarray(0, 24) };

    let thrown: unknown;
    try {
      open(truncated, rootKey);
    } catch (error) {
      thrown = error;
    }

    // The DEK unwrapped fine, so this is not a key problem: the caller must be able to tell a moved
    // or edited ciphertext from a misconfigured host.
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(AppError);
  });
});

describe('root key spellings', () => {
  it('accepts an upper-case hex key, which is the same key', () => {
    const hex = randomBytes(32).toString('hex');

    const loaded = loadRootKey(keyFile(hex.toUpperCase()));

    expect(loaded.key.equals(Buffer.from(hex, 'hex'))).toBe(true);
    // The id is derived from the key bytes, so its spelling cannot change it either.
    expect(loaded.id).toBe(loadRootKey(keyFile(hex)).id);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { AnchorSigner, canonical } from '../../../../src/modules/m17-audit/anchor-signer';

/**
 * NFR-4.10 / AC-15 — the anchor signature is the control, so it is tested against real Ed25519
 * keys rather than a double, with the secret store as the only fake.
 */
const PAYLOAD = { day: '2026-11-15', lastSeq: '42', lastHash: 'a'.repeat(64) };

function secrets(initial?: string) {
  const state = { value: initial ?? null };
  return {
    state,
    find: vi.fn(async () => (state.value === null ? null : { id: 'secret-1' })),
    put: vi.fn(async (_scope: string, _owner: string, _name: string, value: string) => {
      state.value = value;
      return { id: 'secret-1' };
    }),
    open: vi.fn(async () => state.value as string),
  };
}

describe('canonical', () => {
  it('serialises the three fields in a fixed order a verifier can reproduce', () => {
    expect(canonical(PAYLOAD)).toBe(
      `{"day":"2026-11-15","lastSeq":"42","lastHash":"${'a'.repeat(64)}"}`,
    );
  });
});

describe('AnchorSigner', () => {
  it('generates a key on first use, seals it in the platform scope and signs the anchor', async () => {
    const store = secrets();
    const signer = new AnchorSigner(store as never);

    const signature = await signer.sign(PAYLOAD);

    const stored = JSON.parse(store.state.value as string) as { keyId: string; privateKey: string };
    expect(store.put).toHaveBeenCalledWith(
      'platform',
      'platform',
      'audit_anchor_signing_key',
      expect.any(String),
    );
    expect(signature.startsWith(`ed25519:${stored.keyId}:`)).toBe(true);
    expect(stored.privateKey).toContain('PRIVATE KEY');
    await expect(signer.verify(PAYLOAD, signature)).resolves.toBe(true);
  });

  it('reuses the stored key instead of minting one per anchor', async () => {
    const store = secrets();
    const signer = new AnchorSigner(store as never);

    await signer.sign(PAYLOAD);
    await signer.sign(PAYLOAD);

    expect(store.put).toHaveBeenCalledOnce();
    expect(store.open).toHaveBeenCalledOnce();
  });

  it('does not create a key just to describe one', async () => {
    const store = secrets();
    const signer = new AnchorSigner(store as never);

    await expect(signer.describe()).resolves.toBeNull();
    expect(store.put).not.toHaveBeenCalled();
  });

  it('publishes the public half with a key id, which is what the export carries', async () => {
    const store = secrets();
    const signer = new AnchorSigner(store as never);
    const signature = await signer.sign(PAYLOAD);

    const described = await signer.describe();

    expect(described).toMatchObject({ algorithm: 'ed25519' });
    expect(described?.publicKey).toContain('PUBLIC KEY');
    expect(signature).toContain(described?.keyId as string);
  });

  it('rejects a signature over different fields, which is the case the control exists for', async () => {
    const store = secrets();
    const signer = new AnchorSigner(store as never);
    const signature = await signer.sign(PAYLOAD);

    await expect(signer.verify({ ...PAYLOAD, lastSeq: '43' }, signature)).resolves.toBe(false);
  });

  it('rejects a signature from a key this deployment does not hold', async () => {
    const store = secrets();
    const signer = new AnchorSigner(store as never);
    await signer.sign(PAYLOAD);

    await expect(signer.verify(PAYLOAD, 'ed25519:0000000000000000:c2ln')).resolves.toBe(false);
  });

  it('reports an absent or malformed signature as not verifiable rather than throwing', async () => {
    const signer = new AnchorSigner(secrets() as never);

    await expect(signer.verify(PAYLOAD, null)).resolves.toBe(false);
    await expect(signer.verify(PAYLOAD, 'anchor-signature-fixture')).resolves.toBe(false);
    await expect(signer.verify(PAYLOAD, 'ed25519:onlytwo')).resolves.toBe(false);
  });

  it('reports a signature as unverifiable when this deployment holds no key at all', async () => {
    const signer = new AnchorSigner(secrets() as never);

    await expect(signer.verify(PAYLOAD, 'ed25519:0f3c9a7d21b45e68:c2ln')).resolves.toBe(false);
  });

  it('fails loudly when the sealed value is not a key pair', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const store = secrets(
      JSON.stringify({
        keyId: 'k',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      }),
    );

    await expect(new AnchorSigner(store as never).sign(PAYLOAD)).rejects.toThrow(/not a key pair/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { AnchorStore, ANCHOR_PREFIX } from '../../../../src/modules/m17-audit/anchor-store.service';

/**
 * NFR-4.10 — the anchor's off-host copy is what makes tamper evidence survive the host. The object
 * is the verifier's whole input, so the test is about its contents: the anchor, the signature, and
 * the public key needed to check it without a platform secret.
 */
const ANCHOR = {
  day: '2026-11-15',
  lastSeq: '42',
  lastHash: 'a'.repeat(64),
  signature: 'ed25519:0f3c9a7d21b45e68:c2ln',
  storedAt: '2026-11-16T00:01:00.000Z',
};

const SIGNING = { algorithm: 'ed25519' as const, keyId: '0f3c9a7d21b45e68', publicKey: 'PEM' };

function setup() {
  const store = { putText: vi.fn(async (_key: string, _body: string) => undefined) };
  return { store, anchorStore: new AnchorStore(store as never) };
}

describe('AnchorStore', () => {
  it('writes one object per day, under the anchor prefix', async () => {
    const { store, anchorStore } = setup();

    await expect(
      anchorStore.put(ANCHOR, SIGNING, {
        seq: '42',
        hash: ANCHOR.lastHash,
        ts: '2026-11-15T23:00:00.000Z',
      }),
    ).resolves.toBe(`${ANCHOR_PREFIX}/2026-11-15.json`);

    expect(store.putText).toHaveBeenCalledWith('audit-anchors/2026-11-15.json', expect.any(String));
  });

  it('carries the anchor, the signature and the public key an auditor needs', async () => {
    const { store, anchorStore } = setup();

    await anchorStore.put(ANCHOR, SIGNING, null);

    const body = JSON.parse(store.putText.mock.calls[0]?.[1] as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      version: 1,
      day: '2026-11-15',
      lastSeq: '42',
      lastHash: ANCHOR.lastHash,
      signature: ANCHOR.signature,
      signing: SIGNING,
      // Named for what it is: not covered by the signature.
      chainHeadAtExport: null,
    });
    expect(String(body.signatureCovers)).toContain('day');
  });

  it('names the key a day is expected at', () => {
    const { anchorStore } = setup();
    expect(anchorStore.keyFor('2026-11-15')).toBe('audit-anchors/2026-11-15.json');
  });
});

import { Inject, Injectable } from '@nestjs/common';
import { BackupObjectStore } from '../../common/storage/object-store';
import type { AuditAnchorRecord, AuditAnchorSigning, AuditChainHead } from './audit.contract';

/** Where the daily anchor lives, relative to the bucket root. One object per closed day. */
export const ANCHOR_PREFIX = 'audit-anchors';

/**
 * NFR-4.10 — the anchor's off-host copy.
 *
 * A signature stored next to the data it protects proves nothing against someone who can rewrite
 * both, which is why the daily anchor is written to the object store rather than only to
 * `audit_anchor`. It used to travel off-host only when an operator happened to schedule a platform
 * backup; a chain whose tamper evidence depends on an unrelated schedule has none.
 *
 * The object is plain JSON and carries the public key, because verification must work for whoever
 * holds the file: no age identity, no platform secret, no call back to this service.
 */
@Injectable()
export class AnchorStore {
  constructor(@Inject(BackupObjectStore) private readonly store: BackupObjectStore) {}

  /** Idempotent: the same day written twice produces the same bytes under the same key. */
  async put(
    anchor: AuditAnchorRecord,
    signing: AuditAnchorSigning | null,
    chainHead: AuditChainHead | null,
  ): Promise<string> {
    const key = `${ANCHOR_PREFIX}/${anchor.day}.json`;
    await this.store.putText(
      key,
      JSON.stringify(
        {
          version: 1,
          day: anchor.day,
          lastSeq: anchor.lastSeq,
          lastHash: anchor.lastHash,
          signature: anchor.signature,
          // How to check the file without this platform: neither field is a secret.
          signatureCovers: 'canonical JSON of {"day","lastSeq","lastHash"} in that order',
          signing,
          /*
           * Not covered by the signature, and named so nobody assumes it is: it is what the
           * platform claimed at export time, which only becomes evidence once the *next* day's
           * anchor signs past it.
           */
          chainHeadAtExport: chainHead,
          storedOffHostAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return key;
  }

  /** The key a day's anchor is expected at, for diagnostics and for the console's recovery view. */
  keyFor(day: string): string {
    return `${ANCHOR_PREFIX}/${day}.json`;
  }
}

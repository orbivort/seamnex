import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';
import { forwardRef, Inject, Injectable, Logger } from '@nestjs/common';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import type { AuditAnchorSigning } from './audit.contract';

/**
 * NFR-4.10 / AC-15 — the key that signs each day's anchor.
 *
 * An anchor the platform can rewrite is not evidence of anything, so the row is signed and the
 * public half is published with the export: an auditor can check a day's anchor against the file
 * the platform handed them, without holding a secret and without trusting this process. Ed25519
 * because it is one short signature over a few dozen bytes, it needs no parameter choices, and
 * `node:crypto` already provides it — a dependency would buy nothing.
 *
 * The private key is generated on first use and sealed in the platform-scope secret store, so it
 * inherits the envelope hierarchy (`rootKeyId`), the rotation path and the audited read that every
 * other secret has. It never leaves this class, and it is never logged.
 */
const SCOPE = 'platform' as const;
const OWNER_ID = 'platform';
const NAME = 'audit_anchor_signing_key';
const ALGORITHM = 'ed25519' as const;
/** `ed25519:<keyId>:<base64url>`. The prefix makes a stored value self-describing on inspection. */
const PREFIX = `${ALGORITHM}:`;

export type AnchorPayload = {
  /** The UTC day this anchor closes, `YYYY-MM-DD`. */
  readonly day: string;
  readonly lastSeq: string;
  readonly lastHash: string;
};

type Material = {
  readonly keyId: string;
  readonly publicKey: string;
  readonly privateKey: string;
};

@Injectable()
export class AnchorSigner {
  private readonly logger = new Logger('audit.anchor');
  private cached: Material | undefined;

  // The reverse edge of the M15↔M17 cycle: the secret store audits its own reads through M17.
  constructor(
    @Inject(forwardRef(() => SECRETS_SERVICE)) private readonly secrets: SecretsService,
  ) {}

  /**
   * Signs one anchor. A missing key is generated, a readable one is reused; an unreadable store
   * throws so the day goes unanchored rather than silently unsigned.
   */
  async sign(payload: AnchorPayload): Promise<string> {
    const material = await this.material(true);
    if (material === null) {
      // `create: true` either returns a key or throws; an unsigned anchor is never an answer.
      throw new Error('the audit anchor signing key is unavailable');
    }
    const signature = sign(null, Buffer.from(canonical(payload), 'utf8'), privateKeyOf(material));
    return `${PREFIX}${material.keyId}:${signature.toString('base64url')}`;
  }

  /**
   * The public half for the export, without creating a key.
   *
   * A deployment that has never anchored has nothing to publish, and minting a key just to describe
   * one would make "there is a signing key" true before any anchor used it.
   */
  async describe(): Promise<AuditAnchorSigning | null> {
    const material = await this.material(false);
    if (material === null) return null;
    return { algorithm: ALGORITHM, keyId: material.keyId, publicKey: material.publicKey };
  }

  /**
   * Checks a stored signature against the key this deployment holds.
   *
   * `false` covers three honest cases and one dishonest one: no signature, a malformed one, a
   * signature from a key this deployment no longer holds (a rotated or restored key), and a
   * signature that does not match the anchor's own fields — which is the case the control exists
   * for. The caller reports "not verifiable" rather than picking one of them.
   */
  async verify(payload: AnchorPayload, signature: string | null): Promise<boolean> {
    if (signature === null || !signature.startsWith(PREFIX)) return false;
    const rest = signature.slice(PREFIX.length);
    const separator = rest.indexOf(':');
    if (separator <= 0) return false;
    const keyId = rest.slice(0, separator);
    const material = await this.material(false);
    if (material === null) return false;
    if (material.keyId !== keyId) {
      this.logger.warn({ msg: 'anchor signature uses a key this deployment does not hold', keyId });
      return false;
    }
    try {
      return verify(
        null,
        Buffer.from(canonical(payload), 'utf8'),
        publicKeyOf(material),
        Buffer.from(rest.slice(separator + 1), 'base64url'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Reads (and, when allowed, creates) the key material.
   *
   * Two processes racing on first use both write a version; each then opens the *latest* one, so
   * they converge on the same key instead of signing with two. `expected` is the owner assertion —
   * a `secret_id` that drifted onto another scope's secret must not be opened as this one.
   */
  private async material(create: boolean): Promise<Material | null> {
    if (this.cached !== undefined) return this.cached;

    let found = await this.secrets.find(SCOPE, OWNER_ID, NAME);
    if (found === null) {
      if (!create) return null;
      const generated = generate();
      await this.secrets.put(SCOPE, OWNER_ID, NAME, JSON.stringify(generated));
      found = await this.secrets.find(SCOPE, OWNER_ID, NAME);
      if (found === null) {
        throw new Error('the anchor signing key was written but cannot be read back');
      }
    }

    const value = await this.secrets.open(found.id, 'sign the daily audit anchor', {
      scope: SCOPE,
      ownerId: OWNER_ID,
    });
    this.cached = parse(value);
    return this.cached;
  }
}

/**
 * The signed bytes.
 *
 * Field order is fixed here rather than left to `JSON.stringify` of a caller's object: the verifier
 * (which may be someone else's tooling) has to reproduce exactly these bytes, and property order is
 * the one thing a JSON serialisation does not preserve by itself.
 */
export function canonical(payload: AnchorPayload): string {
  return JSON.stringify({ day: payload.day, lastSeq: payload.lastSeq, lastHash: payload.lastHash });
}

function generate(): Material {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    keyId: fingerprint(publicPem),
    publicKey: publicPem,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function parse(value: string): Material {
  const parsed = JSON.parse(value) as Partial<Material>;
  if (
    typeof parsed.keyId !== 'string' ||
    typeof parsed.publicKey !== 'string' ||
    typeof parsed.privateKey !== 'string'
  ) {
    throw new Error('the stored audit anchor signing key is not a key pair');
  }
  return { keyId: parsed.keyId, publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}

/** A short, stable name for the public key: what a signature carries so a verifier can pick it. */
function fingerprint(publicKeyPem: string): string {
  return createHash('sha256').update(publicKeyPem, 'utf8').digest('hex').slice(0, 16);
}

function privateKeyOf(material: Material) {
  return createPrivateKey(material.privateKey);
}

function publicKeyOf(material: Material) {
  return createPublicKey(material.publicKey);
}

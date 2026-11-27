import type { AuditActorType, AuditOutcome, OutboxRow, Queryable } from '@seamnex/db';

/** Injection token for the audit service. Modules depend on this file, never on the implementation. */
export const AUDIT_SERVICE = Symbol('seamnex.audit.service');

/** Injection token for the transactional outbox (AD-18). */
export const OUTBOX_SERVICE = Symbol('seamnex.audit.outbox');

export type OutboxEvent = {
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload?: Record<string, unknown>;
};

export type OutboxHandler = (row: OutboxRow) => Promise<void>;

/**
 * The outbox as other modules see it.
 *
 * Producers used to import `m17-audit/outbox` and inject the concrete class, which is a deep import
 * into another module — the boundary rule exempted it only because the directory was called `audit`
 * and sat outside `modules/`. The token is the interface it always was.
 */
export interface Outbox {
  /** Emit inside the caller's transaction, never on its own connection. */
  emit(tx: Queryable, event: OutboxEvent): Promise<void>;
  on(eventType: string, handler: OutboxHandler): void;
  claim(limit?: number): Promise<OutboxRow[]>;
  dispatchBatch(limit?: number): Promise<number>;
}

export type AuditAppendInput = {
  readonly action: string;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly outcome: AuditOutcome;
  /** Masked before insert; a caller cannot accidentally write a secret into the chain. */
  readonly detail?: Record<string, unknown>;
  readonly requestId?: string;
};

export type AuditAppendResult = { readonly seq: string; readonly hash: string };

export type AuditVerification = {
  readonly valid: boolean;
  readonly checked: number;
  readonly firstBrokenSeq: string | null;
};

/** FR-1.35 — one day's anchor as the platform recovery set exports it. */
export type AuditAnchorRecord = {
  readonly day: string;
  readonly lastSeq: string;
  readonly lastHash: string;
  /**
   * NFR-4.10 — `ed25519:<keyId>:<base64url>` over the canonical `{day,lastSeq,lastHash}`.
   * `null` on a row written before signing existed; those remain anchors, just weaker evidence.
   */
  readonly signature: string | null;
  readonly storedAt: string;
};

/** The public half of the anchor key, published so an auditor needs no secret to verify. */
export type AuditAnchorSigning = {
  readonly algorithm: 'ed25519';
  readonly keyId: string;
  readonly publicKey: string;
};

export type AuditChainHead = {
  readonly seq: string;
  readonly hash: string;
  readonly ts: string;
};

export type AuditAnchorExport = {
  readonly anchors: readonly AuditAnchorRecord[];
  /** Null when this deployment has never signed an anchor, which is also when no key exists. */
  readonly signing: AuditAnchorSigning | null;
  /** Null on a chain that has no events yet. */
  readonly chainHead: AuditChainHead | null;
};

export interface AuditService {
  /**
   * Takes the chain-tip row lock for the current transaction. Callers that also lock business rows
   * must call this **first**, so every audited transaction acquires locks in the same order; two
   * orders is a deadlock waiting for production traffic. `append` takes the same lock, so a caller
   * that forgets is still correct — it just takes it later.
   */
  lockChain(tx: Queryable): Promise<void>;

  /**
   * Appends one row. When `tx` is supplied the append joins that transaction, which is what makes
   * AD-20 fail-closed: a failed append rolls the mutation back with it. Without `tx` the append
   * runs in its own transaction that holds the chain lock, so it is never a naked autocommit.
   *
   * Throws `AppError` (`AUDIT_UNAVAILABLE`) when the row cannot be written.
   */
  append(input: AuditAppendInput, tx?: Queryable): Promise<AuditAppendResult>;

  /** Convenience for the PDP: writes an `access.denied` row for a refused action. */
  denied(input: Omit<AuditAppendInput, 'action' | 'outcome'>): Promise<void>;

  /** Recomputes the chain over a range and reports the first broken sequence. */
  verify(fromSeq: string, toSeq: string): Promise<AuditVerification>;

  /**
   * Daily anchor row (design §7.2 `audit_anchor`), signed, written once per closed day.
   *
   * Returns the stored row, or `null` when the day holds no events — an anchor over nothing would
   * record a sequence that no event backs. Re-anchoring a day that already has a row is a no-op:
   * the first writer wins, because a second signature over a later sequence would let the platform
   * move an anchor after the fact, which is the one property the control exists to deny.
   */
  anchor(day?: Date): Promise<AuditAnchorRecord | null>;

  /**
   * FR-1.35 — the anchors plus the chain head, for the platform recovery set.
   *
   * The anchors alone prove the chain up to the last anchored day; the head is what lets a restore
   * tell "the tail is intact" from "events after the anchor are missing". The query stays here
   * because `audit_event` and `audit_anchor` are this module's tables: a backup that copied the SQL
   * would become a second owner of the chain's shape. Read-only, and deliberately no audit row of
   * its own — a backup reading the chain is not an event the chain needs to hold.
   */
  exportAnchors(): Promise<AuditAnchorExport>;

  /**
   * The hash recorded at one sequence, and null when the chain has no row there.
   *
   * A restore recomputes the chain over the restored range and compares its own row at the exported
   * head against the exported hash: that comparison is what ties the recomputation to *this* set
   * instead of to whatever chain happens to be in the database. The query stays here because
   * `audit_event` is this module's table.
   */
  headHash(seq: string): Promise<string | null>;
}

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

  /** Daily anchor row (design §7.2 `audit_anchor`). Idempotent per day. */
  anchor(day?: Date): Promise<void>;
}

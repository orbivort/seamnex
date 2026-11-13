import type { ApiOperation } from '@seamnex/domain';
import type { FastifyReply } from 'fastify';
import type { RequestContext } from '../common/identity/request-context';

/**
 * One request, after the dispatcher has resolved identity and validated the declared surface.
 *
 * A handler receives already-parsed values and returns a typed result; it never touches the HTTP
 * status, the problem document or the ETag header. That separation is what keeps `202`/`204`/`412`
 * conformance uniform across 93 operations instead of being re-implemented per controller.
 */
export type OperationInput = {
  readonly operation: ApiOperation;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** The `prefix: true` query family, keyed by declaration name (`env` → `{MAIL_HOST: …}`). */
  readonly families: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Parsed request cookies; only the platform's own two names are read. */
  readonly cookies: Readonly<Record<string, string>>;
  readonly context: RequestContext;
  readonly requestId: string;
  /** Only for a handler that writes the reply itself (`text/event-stream`). */
  readonly reply: FastifyReply;
};

export type OperationResult =
  | {
      readonly kind: 'body';
      readonly body: unknown;
      /** Defaults to 200; a handler only overrides it for a documented non-200 success. */
      readonly status?: number;
      /** Set on a `conditional` operation so the client can send it back as `If-Match`. */
      readonly etag?: string;
      /**
       * Response metadata for a body the contract cannot carry it in — a collection with `limit`
       * answers with an array, so the total travels in `x-total-count` instead of a new envelope.
       * A handler supplies only fixed header names with values it computed.
       */
      readonly headers?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'accepted'; readonly jobId: string }
  | { readonly kind: 'noContent' }
  /** The handler owns the reply (SSE): the dispatcher writes nothing. */
  | { readonly kind: 'stream' };

export type OperationHandler = (input: OperationInput) => Promise<OperationResult>;

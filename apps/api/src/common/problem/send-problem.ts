import type { ProblemDetail } from '@seamnex/domain';
import type { FastifyReply } from 'fastify';
import { currentRequestId } from '../logging/logger';
import { isAppError } from './app-error';

/**
 * The one place a problem document is written to a reply.
 *
 * There used to be two: `ProblemFilter` (which had the full request-id fallback chain and masked
 * the 5xx log) and `RouteTableService.respondProblem` (which checked only `request.requestId`).
 * Two implementations of "what a 409 looks like" is exactly the drift `to-problem.ts` claims to
 * have removed — the mapping was shared, the delivery was not.
 *
 * The contract dispatcher answers from a raw Fastify route and never reaches a Nest filter, so the
 * writer takes a reply and a document rather than an `ArgumentsHost`. The filter is now a thin
 * adapter over this function, which means both paths cannot diverge again.
 */

/** A reply and the problem document to put on it. */
export type ProblemResponse = {
  readonly problem: ProblemDetail;
  readonly requestId: string;
  /** Response metadata the caller computed (`retry-after`, `www-authenticate`, …). */
  readonly headers?: Readonly<Record<string, string>>;
};

/** The `requestId` Fastify carries, the ALS value, or the inbound header — in that order. */
export function requestIdFor(request: {
  readonly requestId?: unknown;
  readonly headers?: Record<string, unknown>;
}): string {
  const fromRequest = request.requestId;
  if (typeof fromRequest === 'string' && fromRequest.length > 0) return fromRequest;

  const fromStore = currentRequestId();
  if (typeof fromStore === 'string' && fromStore.length > 0) return fromStore;

  const fromHeader = request.headers?.['x-request-id'];
  if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader;

  return 'unknown';
}

/**
 * Response metadata an error carries. Only `AppError` can carry any; a foreign `HttpException` has
 * nowhere to put a header, which is the reason `AppError.headers` exists.
 */
export function problemHeadersFor(exception: unknown): Readonly<Record<string, string>> {
  return isAppError(exception) ? (exception.headers ?? {}) : {};
}

/** Writes `application/problem+json` with the request id and any caller-supplied headers. */
export function sendProblem(reply: FastifyReply, response: ProblemResponse): void {
  let out = reply
    .status(response.problem.status)
    .header('content-type', 'application/problem+json; charset=utf-8')
    .header('x-request-id', response.requestId);

  for (const [name, value] of Object.entries(response.headers ?? {})) {
    out = out.header(name, value);
  }

  void out.send(response.problem);
}

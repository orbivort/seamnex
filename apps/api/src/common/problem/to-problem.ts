import { HttpException } from '@nestjs/common';
import type { FieldError, ProblemDetail } from '@seamnex/domain';
import { ZodError } from 'zod';
import { AppError } from './app-error';
import { isKnownProblemCode, problemFor } from './problem-catalog';

export const GENERIC_500_DETAIL =
  'The platform could not complete the request. The request id identifies the failure in the logs.';

/**
 * The error-to-problem mapping, extracted from `ProblemFilter` so the contract dispatcher — which
 * answers on a raw Fastify route and therefore never reaches a Nest exception filter — produces a
 * byte-identical document. Two implementations of "what is a 409" would drift.
 */
export function toProblem(exception: unknown): ProblemDetail {
  if (exception instanceof AppError) {
    // A code is a promise to the client: an uncatalogued one is a programmer error, and answering
    // it must not throw inside the error path — so it degrades to the generic 500.
    if (!isKnownProblemCode(exception.code)) {
      return problemFor('INTERNAL_ERROR', { detail: GENERIC_500_DETAIL });
    }
    return {
      ...problemFor(exception.code, {
        detail: exception.detail,
        fieldErrors: exception.fieldErrors,
        ...(exception.status === undefined ? {} : { status: exception.status }),
      }),
      ...(exception.remediation === undefined ? {} : { remediation: exception.remediation }),
    };
  }

  if (exception instanceof ZodError) {
    const fieldErrors: FieldError[] = exception.issues.map((issue) => ({
      field: issue.path.length === 0 ? 'body' : issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    return problemFor('VALIDATION_FAILED', {
      detail: 'One or more fields do not match the declared schema.',
      fieldErrors,
    });
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    if (status >= 500) {
      return problemFor('INTERNAL_ERROR', { detail: GENERIC_500_DETAIL, status });
    }
    return problemFor(codeForStatus(status), {
      detail: httpDetail(exception),
      status,
    });
  }

  // Fastify's own errors (body too large, unsupported media type) arrive as plain objects.
  const fastifyStatus = (exception as { statusCode?: unknown }).statusCode;
  if (typeof fastifyStatus === 'number' && fastifyStatus >= 400 && fastifyStatus < 500) {
    return problemFor(codeForStatus(fastifyStatus), {
      detail: (exception as { message?: string }).message ?? 'The request was refused.',
      status: fastifyStatus,
    });
  }

  return problemFor('INTERNAL_ERROR', { detail: GENERIC_500_DETAIL });
}

export function httpDetail(exception: HttpException): string {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message = (response as { message: unknown }).message;
    return Array.isArray(message) ? message.join('; ') : String(message);
  }
  return exception.message;
}

export function codeForStatus(
  status: number,
):
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'STATE_CONFLICT'
  | 'GONE'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PRECONDITION_FAILED'
  | 'RATE_LIMITED'
  | 'STREAM_LIMIT'
  | 'UNAVAILABLE'
  | 'INTERNAL_ERROR' {
  switch (status) {
    // 422 keeps the validation code with a different status: the body parsed, the rule did not.
    case 400:
    case 422:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHORIZED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 405:
      return 'METHOD_NOT_ALLOWED';
    case 409:
      return 'STATE_CONFLICT';
    case 410:
      return 'GONE';
    case 412:
      return 'PRECONDITION_FAILED';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 415:
      return 'UNSUPPORTED_MEDIA_TYPE';
    // 429 is a rate limit, not a stream ceiling. `STREAM_LIMIT` is a separate 429 the job-stream
    // service raises itself (`jobs/job-stream.ts`), with its own remediation; answering a rate
    // limit with it told the client to poll instead of to wait for `Retry-After`.
    case 429:
      return 'RATE_LIMITED';
    case 503:
      return 'UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED';
  }
}

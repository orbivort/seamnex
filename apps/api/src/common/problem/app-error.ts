import type { FieldError } from '@seamnex/domain';

/**
 * Every deliberate failure is an `AppError`: the HTTP layer renders it, the audit layer can record
 * its code, and a handler that throws an unknown error gets a 500 with no internal detail.
 */
export type AppErrorOptions = {
  readonly code: string;
  readonly status?: number;
  readonly detail: string;
  readonly fieldErrors?: readonly FieldError[];
  readonly remediation?: string;
  /**
   * Response metadata the refusal must carry — `retry-after` on a throttle, `www-authenticate` on
   * a challenge. It lives on the error so a guard can express it without touching the reply; the
   * filter and the dispatcher both write it through `sendProblem`.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly cause?: unknown;
};

export class AppError extends Error {
  readonly code: string;
  /**
   * `undefined` means "use the catalogue status for this code". A caller that omits it cannot
   * accidentally turn a 503 into a 500.
   */
  readonly status: number | undefined;
  readonly detail: string;
  readonly fieldErrors: readonly FieldError[];
  readonly remediation: string | undefined;
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(options: AppErrorOptions) {
    super(options.detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.status = options.status;
    this.detail = options.detail;
    this.fieldErrors = options.fieldErrors ?? [];
    this.remediation = options.remediation;
    this.headers = options.headers;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

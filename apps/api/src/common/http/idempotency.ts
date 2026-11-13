import { AppError } from '../problem/app-error';

/**
 * Deliverable 2.10 — `Idempotency-Key` replay.
 *
 * The window is a database unique index, not an in-memory map: `deployment_job.idempotency_key`
 * is unique while present and the scheduler reaper NULLs keys older than 24 h (`JobService.reapIdempotencyKeys`).
 * This module only reads and validates the header; the replay itself is `JobService.create`,
 * which already answers the original job for a repeated key and `IDEMPOTENCY_CONFLICT` when the
 * same key arrives with a different payload.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_LENGTH = 255;

export function readIdempotencyKey(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const raw = headers[IDEMPOTENCY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > MAX_LENGTH) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'The Idempotency-Key header is longer than the platform accepts.',
      fieldErrors: [
        {
          field: 'Idempotency-Key',
          code: 'too_big',
          message: `Expected at most ${MAX_LENGTH} characters.`,
        },
      ],
    });
  }
  return trimmed;
}

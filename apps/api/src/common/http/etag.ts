import { createHash } from 'node:crypto';
import { AppError } from '../problem/app-error';

/**
 * ADR-BE-09 D2 — optimistic concurrency as the contract declares it.
 *
 * A validator is derived from the representation's own version fields (`updated_at`, `version`),
 * never from a hash of the response body: the body can change ordering without a semantic change,
 * and a body hash forces a full serialisation on every write.
 */
export function etagFor(parts: readonly (string | number | Date | null | undefined)[]): string {
  const material = parts
    .map((part) => (part instanceof Date ? part.toISOString() : String(part ?? '')))
    .join('\u0000');
  return `"${createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 32)}"`;
}

/**
 * `If-Match` is either `*` or a comma-separated list; weak validators are compared by value
 * because the platform never emits them and some proxies add the prefix.
 */
export function ifMatchSatisfied(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  const candidates = header.split(',').map((value) => value.trim().replace(/^W\//, ''));
  return candidates.includes('*') || candidates.includes(etag);
}

/**
 * `required: false` is for a representation that only participates in concurrency when the caller
 * opts in (`PATCH /workflows/:id`); `required: true` matches the prototype's settings behaviour,
 * where a missing `If-Match` is a `412`, not a silent overwrite.
 */
export function assertIfMatch(options: {
  readonly header: string | undefined;
  readonly etag: string;
  readonly required: boolean;
  readonly detail: string;
}): void {
  if (options.header === undefined && !options.required) return;
  if (ifMatchSatisfied(options.header, options.etag)) return;
  throw new AppError({
    code: 'PRECONDITION_FAILED',
    detail: options.detail,
    remediation: 'Reload the resource and resend the change with the current ETag.',
  });
}

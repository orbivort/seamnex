import { AppError } from '../problem/app-error';

/**
 * ADR-BE-09 D1 — keyset pagination.
 *
 * The prototype's "cursor" is a decimal array offset, which shifts under concurrent inserts.
 * Phase 2 pages by the sort key instead: `(created_at, id)` for jobs, `seq` for audit events.
 * The wire envelope is unchanged (`pageOf`), so neither app needs a change.
 */
export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export type Cursor = { readonly createdAt: string; readonly id: string } | { readonly seq: string };

export type Page<T> = {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly total: number;
};

/** `limit` is clamped rather than rejected: an over-large page is a client convenience, not an error. */
export function readLimit(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) return DEFAULT_PAGE_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'The page limit must be a positive integer.',
      fieldErrors: [
        { field: 'limit', code: 'invalid_type', message: 'Expected a positive integer.' },
      ],
    });
  }
  return Math.min(parsed, MAX_PAGE_LIMIT);
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw malformedCursor();
  }
  if (typeof decoded !== 'object' || decoded === null) throw malformedCursor();
  const record = decoded as Record<string, unknown>;
  if (typeof record.seq === 'string' && record.seq.length > 0) return { seq: record.seq };
  if (
    typeof record.createdAt === 'string' &&
    record.createdAt.length > 0 &&
    typeof record.id === 'string' &&
    record.id.length > 0
  ) {
    return { createdAt: record.createdAt, id: record.id };
  }
  throw malformedCursor();
}

/**
 * Trims an over-fetched page (the query asks for `limit + 1` rows) and derives the next cursor.
 * `total` comes from the same predicate and is passed in rather than recomputed here.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  total: number,
  cursorOf: (row: T) => Cursor,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null,
    total,
  };
}

function malformedCursor(): AppError {
  return new AppError({
    code: 'VALIDATION_FAILED',
    status: 422,
    detail: 'The cursor is not a value this endpoint issued.',
    fieldErrors: [{ field: 'cursor', code: 'invalid_string', message: 'Malformed cursor.' }],
  });
}

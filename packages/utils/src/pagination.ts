export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
  total: number;
};

/** Slice an in-memory list using the API's opaque cursor convention. */
export function sliceByCursor<T>(items: T[], cursor: string | null, limit: number): CursorPage<T> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const start = cursor === null ? 0 : Math.max(Number.parseInt(cursor, 10) || 0, 0);
  const page = items.slice(start, start + safeLimit);
  const nextIndex = start + page.length;
  return {
    items: page,
    nextCursor: nextIndex < items.length ? String(nextIndex) : null,
    total: items.length,
  };
}

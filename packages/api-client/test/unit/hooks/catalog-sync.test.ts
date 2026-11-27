import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../../src/query-keys';
import type * as Http from '../../../src/http';

/**
 * ADR-BE-42 — the two catalogue-checkout hooks.
 *
 * Same reasoning as the rest of this package's hook suite: rendering would need a DOM runner, and the
 * part a screen depends on is the captured `queryFn`/`mutationFn`, not TanStack's scheduler. What is
 * asserted here is the wiring the sync action rests on — the path, the method, that the body carries
 * a ref and never a URL, and that a success invalidates the checkout view it just rewrote.
 */
const recorded = vi.hoisted(() => ({
  queries: [] as { queryKey: unknown; queryFn?: (ctx: { signal?: AbortSignal }) => unknown }[],
  mutations: [] as {
    mutationFn?: (variables: unknown) => unknown;
    onSuccess?: (result: unknown, variables: unknown) => void;
  }[],
  invalidations: [] as unknown[],
  request: vi.fn(async (_path: string, _options?: unknown) => ({})),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: (typeof recorded.queries)[number]) => {
    recorded.queries.push(options);
    return {};
  },
  useMutation: (options: (typeof recorded.mutations)[number]) => {
    recorded.mutations.push(options);
    return {};
  },
  useQueryClient: () => ({
    invalidateQueries: (input: unknown) => {
      recorded.invalidations.push(input);
      return Promise.resolve();
    },
  }),
}));

vi.mock('../../../src/http', async (importOriginal) => {
  const actual = await importOriginal<typeof Http>();
  return { ...actual, request: recorded.request };
});

const { useCatalogRepository, useSyncCatalog } = await import('../../../src/hooks/catalog');

beforeEach(() => {
  recorded.queries.length = 0;
  recorded.mutations.length = 0;
  recorded.invalidations.length = 0;
  recorded.request.mockClear();
});

describe('useCatalogRepository', () => {
  it('reads the checkout under the key the catalogue invalidation already covers', async () => {
    useCatalogRepository();

    expect(recorded.queries).toHaveLength(1);
    expect(recorded.queries[0]?.queryKey).toEqual(queryKeys.catalogRepository);
    // Under `['catalog', …]`, so a reload or a sync invalidates it with the projection it describes.
    expect(queryKeys.catalogRepository[0]).toBe(queryKeys.catalog[0]);

    await recorded.queries[0]?.queryFn?.({});

    expect(recorded.request).toHaveBeenCalledWith('/catalog/repository', {
      schema: expect.anything(),
      signal: undefined,
    });
  });
});

describe('useSyncCatalog', () => {
  it('posts a ref and no URL', async () => {
    useSyncCatalog();

    await recorded.mutations[0]?.mutationFn?.({ ref: 'catalog-2026.11.0' });

    // The source is configuration: the request cannot name a host (ADR-BE-42 §10.2 rule 1).
    expect(recorded.request).toHaveBeenCalledWith('/catalog/sync', {
      schema: expect.anything(),
      method: 'POST',
      body: { ref: 'catalog-2026.11.0' },
    });
  });

  it('sends an empty body when the server default ref applies', async () => {
    useSyncCatalog();

    await recorded.mutations[0]?.mutationFn?.({});

    expect(recorded.request).toHaveBeenCalledWith('/catalog/sync', {
      schema: expect.anything(),
      method: 'POST',
      body: {},
    });
  });

  it('invalidates the projection, the checkout, posture, registry and audit on success', () => {
    useSyncCatalog();

    recorded.mutations[0]?.onSuccess?.({}, {});

    expect(recorded.invalidations).toEqual([
      { queryKey: queryKeys.catalog },
      { queryKey: queryKeys.catalogRepository },
      { queryKey: queryKeys.posture },
      { queryKey: queryKeys.registry },
      { queryKey: queryKeys.audit },
    ]);
  });
});

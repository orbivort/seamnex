import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageScanReportSchema, TrustedRegistryStateSchema } from '@seamnex/domain';
import type * as Http from '../../../src/http';
import { queryKeys } from '../../../src/query-keys';
import * as security from '../../../src/hooks/security';

/**
 * NFR-4.16 / NFR-4.6 — the wiring of the two security reads and the allow-list write.
 *
 * The allow-list is a control, so what the screen must get right is not the markup but the request:
 * one endpoint, one schema, and a success that invalidates every read whose answer the new revision
 * changes — the catalogue (which validates images), posture (which reports the allow-list) and the
 * audit trail (which records the change). Removing a namespace is what makes the invalidation matter:
 * a live product's image can become untrusted the moment the revision is accepted.
 */
type QueryCall = {
  queryKey: unknown;
  queryFn?: (context: { signal?: AbortSignal | undefined }) => Promise<unknown>;
  enabled?: boolean;
};

type MutationCall = {
  mutationFn?: (variables: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, variables: unknown) => void;
};

type RecordedRequest = { path: string; options: Record<string, unknown> };

const recorder = vi.hoisted(() => ({
  queries: [] as QueryCall[],
  mutations: [] as MutationCall[],
  invalidations: [] as { queryKey?: unknown }[],
  request: vi.fn(async (_path: string, _options?: unknown): Promise<unknown> => ({})),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: QueryCall) => {
    recorder.queries.push(options);
    return {};
  },
  useMutation: (options: MutationCall) => {
    recorder.mutations.push(options);
    return {};
  },
  useQueryClient: () => ({
    invalidateQueries: (input: { queryKey?: unknown }) => {
      recorder.invalidations.push(input);
      return Promise.resolve();
    },
  }),
}));

vi.mock('../../../src/http', async (importOriginal) => {
  const actual = await importOriginal<typeof Http>();
  return { ...actual, request: recorder.request };
});

function lastQuery(): QueryCall {
  const query = recorder.queries.at(-1);
  if (query === undefined) throw new Error('the hook declared no query');
  return query;
}

function lastMutation(): MutationCall {
  const mutation = recorder.mutations.at(-1);
  if (mutation === undefined) throw new Error('the hook declared no mutation');
  return mutation;
}

function lastRequest(): RecordedRequest {
  const call = recorder.request.mock.calls.at(-1);
  if (call === undefined) throw new Error('the hook sent no request');
  return { path: call[0], options: (call[1] ?? {}) as Record<string, unknown> };
}

function invalidatedKeys(): unknown[] {
  return recorder.invalidations.map((entry) => entry.queryKey);
}

beforeEach(() => {
  recorder.queries.length = 0;
  recorder.mutations.length = 0;
  recorder.invalidations.length = 0;
  recorder.request.mockClear();
});

describe('useTrustedRegistries', () => {
  it('reads the current revision with the schema that pins its shape', async () => {
    security.useTrustedRegistries();

    const query = lastQuery();
    expect(query.queryKey).toEqual(queryKeys.trustedRegistries);
    expect(query.enabled).toBe(true);

    await query.queryFn?.({ signal: undefined });

    expect(lastRequest()).toEqual({
      path: '/security/trusted-registries',
      options: expect.objectContaining({ schema: TrustedRegistryStateSchema }),
    });
  });

  it('skips the request when the caller knows the role cannot read the control', () => {
    security.useTrustedRegistries({ enabled: false });

    expect(lastQuery().enabled).toBe(false);
  });

  it('forwards the abort signal of the screen', async () => {
    const controller = new AbortController();
    security.useTrustedRegistries();

    await lastQuery().queryFn?.({ signal: controller.signal });

    expect(lastRequest().options.signal).toBe(controller.signal);
  });
});

describe('useUpdateTrustedRegistries', () => {
  it('posts the revision and invalidates every read the new revision changes', async () => {
    security.useUpdateTrustedRegistries();
    const mutation = lastMutation();
    const body = {
      add: ['ghcr.io/seamnex'],
      remove: [],
      note: 'Adding the platform namespace for the Metabase image.',
    };

    await mutation.mutationFn?.(body);

    expect(lastRequest()).toEqual({
      path: '/security/trusted-registries',
      options: expect.objectContaining({
        method: 'POST',
        body,
        schema: TrustedRegistryStateSchema,
      }),
    });

    mutation.onSuccess?.({}, body);

    // The allow-list is an input to the catalogue's image validation and to the posture screen, and
    // the change itself is audited: a stale copy of any of the three would contradict the platform.
    expect(invalidatedKeys()).toEqual([
      queryKeys.trustedRegistries,
      queryKeys.audit,
      queryKeys.catalog,
      queryKeys.posture,
    ]);
  });
});

describe('useImageScanReport', () => {
  it('reads the retained report for a digest, encoding it as a query value', async () => {
    security.useImageScanReport('inst-crm', 'sha256:abc');

    const query = lastQuery();
    expect(query.queryKey).toEqual(queryKeys.imageScan('inst-crm', 'sha256:abc'));
    expect(query.enabled).toBe(true);

    await query.queryFn?.({ signal: undefined });

    expect(lastRequest()).toEqual({
      // The colon is escaped: an unencoded digest in a query string is not a valid value.
      path: '/instances/inst-crm/image-scan?digest=sha256%3Aabc',
      options: expect.objectContaining({ schema: ImageScanReportSchema }),
    });
  });

  it('does not fetch when no image is selected, and still names an empty digest', async () => {
    security.useImageScanReport('inst-crm', null);

    const query = lastQuery();
    expect(query.enabled).toBe(false);
    expect(query.queryKey).toEqual(queryKeys.imageScan('inst-crm', ''));

    // A caller that ignores `enabled` (a screen previewing the URL) still gets a well-formed request
    // rather than the string `undefined` in a query value.
    await query.queryFn?.({ signal: undefined });
    expect(lastRequest().path).toBe('/instances/inst-crm/image-scan?digest=');
  });

  it('does not fetch for an empty digest', () => {
    security.useImageScanReport('inst-crm', '');

    expect(lastQuery().enabled).toBe(false);
  });
});

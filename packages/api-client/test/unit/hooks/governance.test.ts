import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditExportSchema,
  AuditPageSchema,
  AuditProofSchema,
  AuditRangeVerificationSchema,
  BreakGlassRevealSchema,
  BreakGlassSessionSchema,
  CapacitySnapshotSchema,
  LicenseGateSchema,
  OperationsResponseSchema,
  PostureSummarySchema,
} from '@seamnex/domain';
import type * as Http from '../../../src/http';
import { queryKeys } from '../../../src/query-keys';
import * as governance from '../../../src/hooks/governance';

/**
 * The governance hooks are wiring, and the wiring is the contract: endpoint, method, key, body,
 * schema, and what a success invalidates.
 *
 * This suite is the focused counterpart to `hooks.test.ts` (which constructs every hook in the
 * package once). Here each hook is called on its own so a regression names the screen it breaks,
 * and every argument that changes the request — a filter, a cursor, an empty target, a disabled
 * gate — is varied rather than defaulted.
 *
 * Rendering is not attempted: `useQuery`/`useMutation` are recorders and every captured function
 * is invoked directly, which is exactly the part a screen relies on.
 */
type QueryCall = {
  queryKey: unknown;
  // `signal: undefined` is passed explicitly by the runner below, hence the widened property type.
  queryFn?: (context: {
    signal?: AbortSignal | undefined;
    pageParam?: unknown;
  }) => Promise<unknown>;
  enabled?: boolean;
  refetchInterval?: number | false;
  initialPageParam?: unknown;
  getNextPageParam?: (lastPage: { nextCursor: string | null }, pages: unknown[]) => unknown;
  placeholderData?: unknown;
};

type MutationCall = {
  mutationFn?: (variables: unknown) => Promise<unknown>;
  onSuccess?: (data: unknown, variables: unknown) => void;
};

type RecordedRequest = { path: string; options: Record<string, unknown> };

const recorder = vi.hoisted(() => ({
  queries: [] as QueryCall[],
  infinite: [] as QueryCall[],
  mutations: [] as MutationCall[],
  invalidations: [] as { queryKey?: unknown }[],
  request: vi.fn(async (_path: string, _options?: unknown): Promise<unknown> => ({})),
  /**
   * Stands in for TanStack's placeholder marker. The hook only forwards it, so the assertion that
   * matters is identity — passing an unrelated object would still look right in a shape check.
   */
  keepPrevious: { marker: 'keepPreviousData' },
}));

vi.mock('@tanstack/react-query', () => ({
  keepPreviousData: recorder.keepPrevious,
  useQuery: (options: QueryCall) => {
    recorder.queries.push(options);
    return {};
  },
  useInfiniteQuery: (options: QueryCall) => {
    recorder.queries.push(options);
    recorder.infinite.push(options);
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

/** Runs the captured reader. `pageParam` is what an infinite query passes for a fresh page. */
async function runQuery(query: QueryCall = lastQuery(), pageParam: unknown = null): Promise<void> {
  await query.queryFn?.({ signal: undefined, pageParam });
}

function requests(): RecordedRequest[] {
  return recorder.request.mock.calls.map((call) => ({
    path: call[0],
    options: (call[1] ?? {}) as Record<string, unknown>,
  }));
}

function lastRequest(): RecordedRequest {
  const recorded = requests().at(-1);
  if (recorded === undefined) throw new Error('the hook sent no request');
  return recorded;
}

function invalidatedKeys(): unknown[] {
  return recorder.invalidations.map((entry) => entry.queryKey);
}

/**
 * The list endpoints read a bare JSON array. `[]` alone would also pass for `z.array(z.unknown())`,
 * so an item has to be rejected for the assertion to say anything about the element schema.
 */
function expectValidatedArray(schema: unknown): void {
  const parsed = schema as { safeParse: (input: unknown) => { success: boolean } };
  expect(parsed.safeParse([]).success).toBe(true);
  expect(parsed.safeParse([{}]).success).toBe(false);
  expect(parsed.safeParse({}).success).toBe(false);
}

beforeEach(() => {
  recorder.queries.length = 0;
  recorder.infinite.length = 0;
  recorder.mutations.length = 0;
  recorder.invalidations.length = 0;
  recorder.request.mockClear();
});

describe('useAuditPages', () => {
  it('asks for the first page without a cursor, at the page size the console renders', async () => {
    governance.useAuditPages();

    const query = lastQuery();
    expect(query.queryKey).toEqual([...queryKeys.audit, 'pages', {}]);
    expect(query.initialPageParam).toBeNull();
    expect(query.placeholderData).toBe(recorder.keepPrevious);

    await runQuery(query, null);

    expect(lastRequest()).toEqual({
      path: '/audit-events?limit=25',
      options: expect.objectContaining({ schema: AuditPageSchema }),
    });
  });

  it('appends the cursor when the next page is requested', async () => {
    governance.useAuditPages();

    await runQuery(lastQuery(), 'cursor-2');

    expect(lastRequest().path).toBe('/audit-events?limit=25&cursor=cursor-2');
  });

  it('carries every filter onto the request and onto the key', async () => {
    const filters = {
      action: 'license.updated',
      actor: 'lena',
      outcome: 'denied',
      target: 'inst-crm',
    };
    governance.useAuditPages(filters);

    await runQuery();

    expect(lastRequest().path).toBe(
      '/audit-events?action=license.updated&actor=lena&outcome=denied&target=inst-crm&limit=25',
    );
    // The key follows the filters, so one actor's page cannot be served as another's.
    expect(lastQuery().queryKey).toEqual([...queryKeys.audit, 'pages', filters]);
  });

  it('omits a filter the caller left empty instead of sending an empty one', async () => {
    governance.useAuditPages({ actor: '', outcome: '' });

    await runQuery();

    // `actor=` would be read server-side as "filter by nobody", which matches no row.
    expect(lastRequest().path).toBe('/audit-events?limit=25');
  });

  it('publishes the next cursor and stops at the end of the chain', () => {
    governance.useAuditPages();

    const query = lastQuery();
    expect(query.getNextPageParam?.({ nextCursor: 'c2' }, [{}])).toBe('c2');
    expect(query.getNextPageParam?.({ nextCursor: null }, [{}, {}])).toBeNull();
  });

  it('does not carry one page cursor into the following request', async () => {
    governance.useAuditPages({ actor: 'lena' });

    await runQuery(lastQuery(), 'c2');
    await runQuery(lastQuery(), null);

    // The cursor is copied per request; mutating the shared parameter set would re-request page 2.
    expect(requests().map((entry) => entry.path)).toEqual([
      '/audit-events?actor=lena&limit=25&cursor=c2',
      '/audit-events?actor=lena&limit=25',
    ]);
  });
});

describe('useAuditProof', () => {
  it('reads the proof of the row on screen', async () => {
    governance.useAuditProof(7, true);

    const query = lastQuery();
    expect(query.queryKey).toEqual(queryKeys.auditProof(7));
    expect(query.enabled).toBe(true);

    await runQuery(query);

    expect(lastRequest()).toEqual({
      path: '/audit-events/7/proof',
      options: expect.objectContaining({ schema: AuditProofSchema }),
    });
  });

  it('requests nothing when the row is not selected or the reader is closed', () => {
    // Sequence numbers start at 1, so 0 is "no row yet", not row zero.
    governance.useAuditProof(0, true);
    expect(lastQuery().enabled).toBe(false);

    governance.useAuditProof(7, false);
    expect(lastQuery().enabled).toBe(false);
  });
});

describe('useExportAudit', () => {
  it('posts the range and refetches the chain the export appends to', async () => {
    governance.useExportAudit();
    const mutation = lastMutation();
    const body = { from: '2026-11-01T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z' };

    await mutation.mutationFn?.(body);

    expect(lastRequest()).toEqual({
      path: '/audit-events/export',
      options: expect.objectContaining({ method: 'POST', body, schema: AuditExportSchema }),
    });

    mutation.onSuccess?.({ exportedAt: body.to }, body);
    expect(invalidatedKeys()).toEqual([queryKeys.audit]);
  });
});

describe('useLicenses', () => {
  it('lists the ledger under its own key', async () => {
    governance.useLicenses();

    expect(lastQuery().queryKey).toEqual(queryKeys.licenses);

    await runQuery();

    expect(lastRequest().path).toBe('/licenses');
    expectValidatedArray(lastRequest().options['schema']);
  });
});

describe('useSetHostedService', () => {
  it('flips the gate with a PUT and invalidates every view that shows it', async () => {
    governance.useSetHostedService('inst-crm');
    const mutation = lastMutation();

    await mutation.mutationFn?.(true);
    expect(lastRequest()).toEqual({
      path: '/licenses/inst-crm/hosted-service',
      options: expect.objectContaining({
        method: 'PUT',
        body: { enabled: true },
        schema: LicenseGateSchema,
      }),
    });

    // `false` must travel as a value, not be dropped as an absent flag.
    await mutation.mutationFn?.(false);
    expect(lastRequest().options['body']).toEqual({ enabled: false });

    mutation.onSuccess?.({}, false);
    // A gate moves the ledger, the instance view, the posture score and the chain.
    expect(invalidatedKeys()).toEqual([
      queryKeys.licenses,
      queryKeys.instances,
      queryKeys.posture,
      queryKeys.audit,
    ]);
  });
});

describe('usePatchRegister', () => {
  it('reads the register as an array of records', async () => {
    governance.usePatchRegister();

    expect(lastQuery().queryKey).toEqual(queryKeys.patches);

    await runQuery();

    expect(lastRequest().path).toBe('/patch-register');
    expectValidatedArray(lastRequest().options['schema']);
  });
});

describe('usePosture', () => {
  it('reads the summary the score is rendered from', async () => {
    governance.usePosture();

    expect(lastQuery().queryKey).toEqual(queryKeys.posture);

    await runQuery();

    expect(lastRequest()).toEqual({
      path: '/posture',
      options: expect.objectContaining({ schema: PostureSummarySchema }),
    });
  });
});

describe('useBreakGlassSessions', () => {
  it('fetches by default and does not poll unless asked', async () => {
    governance.useBreakGlassSessions();

    const query = lastQuery();
    expect(query.queryKey).toEqual(queryKeys.breakGlass);
    expect(query.enabled).toBe(true);
    // Polling is opt-in: only a screen that renders a live time box should pay for it.
    expect(query.refetchInterval).toBe(false);

    await runQuery(query);

    expect(lastRequest().path).toBe('/break-glass-sessions');
    expectValidatedArray(lastRequest().options['schema']);
  });

  it('honours the gate and the polling interval it is given', () => {
    governance.useBreakGlassSessions({ enabled: false, refetchIntervalMs: 30_000 });

    expect(lastQuery().enabled).toBe(false);
    expect(lastQuery().refetchInterval).toBe(30_000);
  });
});

describe('useCreateBreakGlass', () => {
  it('posts the elevation request and refreshes the register and the chain', async () => {
    governance.useCreateBreakGlass();
    const mutation = lastMutation();
    const body = {
      instanceId: 'inst-crm',
      accessMode: 'read_only',
      justification: 'vendor support during incident 4412',
    };

    await mutation.mutationFn?.(body);

    expect(lastRequest()).toEqual({
      path: '/break-glass-sessions',
      options: expect.objectContaining({ method: 'POST', body, schema: BreakGlassSessionSchema }),
    });

    mutation.onSuccess?.({}, body);
    expect(invalidatedKeys()).toEqual([queryKeys.breakGlass, queryKeys.audit]);
  });
});

describe('useBreakGlassAction', () => {
  it('posts to the transition named in the input, for each of the three', async () => {
    governance.useBreakGlassAction();
    const mutation = lastMutation();

    for (const action of ['approve', 'reject', 'revoke'] as const) {
      await mutation.mutationFn?.({ id: 'bg-1', action });
    }

    expect(requests().map((entry) => entry.path)).toEqual([
      '/break-glass-sessions/bg-1/approve',
      '/break-glass-sessions/bg-1/reject',
      '/break-glass-sessions/bg-1/revoke',
    ]);
    // The action is the whole intent; a body here would be an invented payload.
    expect(requests()[0]?.options).not.toHaveProperty('body');
    expect(requests()[0]?.options).toEqual(
      expect.objectContaining({ method: 'POST', schema: BreakGlassSessionSchema }),
    );

    mutation.onSuccess?.({}, { id: 'bg-1', action: 'approve' });
    expect(invalidatedKeys()).toEqual([queryKeys.breakGlass, queryKeys.audit]);
  });
});

describe('useCapacity', () => {
  it('reads the ledger, and only on the step that asks for it', async () => {
    governance.useCapacity();

    expect(lastQuery().queryKey).toEqual(queryKeys.capacity);
    expect(lastQuery().enabled).toBe(true);

    await runQuery();

    expect(lastRequest()).toEqual({
      path: '/capacity',
      options: expect.objectContaining({ schema: CapacitySnapshotSchema }),
    });

    governance.useCapacity({ enabled: false });
    // A snapshot read on an earlier step is stale by the time the later step uses it.
    expect(lastQuery().enabled).toBe(false);
  });
});

describe('useCapacityForecast', () => {
  it('keys the forecast apart from the snapshot it projects', async () => {
    governance.useCapacityForecast();

    expect(lastQuery().queryKey).toEqual([...queryKeys.capacity, 'forecast']);

    await runQuery();

    expect(lastRequest().path).toBe('/capacity/forecast');
    expectValidatedArray(lastRequest().options['schema']);
  });
});

describe('useRegistry', () => {
  it('reads the registered instances and the stale subset from different keys', async () => {
    governance.useRegistry();
    governance.useStaleRegistry();

    expect(recorder.queries.map((query) => query.queryKey)).toEqual([
      queryKeys.registry,
      queryKeys.registryStale,
    ]);

    for (const query of recorder.queries) await runQuery(query);

    expect(requests().map((entry) => entry.path)).toEqual([
      '/registry/instances',
      '/registry/stale',
    ]);
    expectValidatedArray(requests()[0]?.options['schema']);
  });
});

describe('useRegistryOperations', () => {
  it('encodes the target so a path-like key cannot rewrite the query', async () => {
    governance.useRegistryOperations('infra/edge a&b');

    const query = lastQuery();
    expect(query.queryKey).toEqual([...queryKeys.registry, 'operations', 'infra/edge a&b']);
    expect(query.enabled).toBe(true);

    await runQuery(query);

    expect(lastRequest()).toEqual({
      path: '/registry/operations?target=infra%2Fedge%20a%26b',
      options: expect.objectContaining({ schema: OperationsResponseSchema }),
    });
  });

  it('does not ask for the operations of no target', () => {
    governance.useRegistryOperations('');

    expect(lastQuery().enabled).toBe(false);
  });
});

describe('useVerifyAuditRange', () => {
  it('posts the range and refetches the chain it verified', async () => {
    governance.useVerifyAuditRange();
    const mutation = lastMutation();
    const body = { fromSeq: 10, toSeq: 42 };

    await mutation.mutationFn?.(body);

    expect(lastRequest()).toEqual({
      path: '/audit-events/verify',
      options: expect.objectContaining({
        method: 'POST',
        body,
        schema: AuditRangeVerificationSchema,
      }),
    });

    mutation.onSuccess?.({}, body);
    expect(invalidatedKeys()).toEqual([queryKeys.audit]);
  });
});

describe('useRevealBreakGlass', () => {
  it('reveals a credential without leaving anything behind in the cache', async () => {
    governance.useRevealBreakGlass();
    const mutation = lastMutation();

    await mutation.mutationFn?.('bg-1');

    expect(lastRequest()).toEqual({
      path: '/break-glass-sessions/bg-1/reveal',
      options: expect.objectContaining({ method: 'POST', schema: BreakGlassRevealSchema }),
    });

    // A success handler that invalidated a query would schedule a refetch of a value that is
    // shown once, for seconds — the leak the endpoint is shaped to avoid.
    expect(mutation.onSuccess).toBeUndefined();
    expect(recorder.invalidations).toEqual([]);
  });
});

describe('unmounting a governance screen', () => {
  it('forwards the abort signal of every reader to its request', async () => {
    const controller = new AbortController();
    governance.useAuditPages();
    governance.useAuditProof(7, true);
    governance.useLicenses();
    governance.usePatchRegister();
    governance.usePosture();
    governance.useBreakGlassSessions();
    governance.useCapacity();
    governance.useCapacityForecast();
    governance.useRegistry();
    governance.useStaleRegistry();
    governance.useRegistryOperations('inst-crm');

    for (const query of recorder.queries) {
      await query.queryFn?.({ signal: controller.signal, pageParam: null });
    }

    expect(recorder.queries).toHaveLength(11);
    expect(recorder.request).toHaveBeenCalledTimes(11);
    // Without the signal a screen that closes mid-flight still resolves into a dead cache entry.
    for (const entry of requests()) {
      expect(entry.options).toEqual(expect.objectContaining({ signal: controller.signal }));
    }
  });
});

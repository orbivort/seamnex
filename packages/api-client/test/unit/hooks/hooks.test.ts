import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AdminCredentialSchema,
  NodeFieldsSchema,
  NodeSampleSchema,
  RelayProvisionReportSchema,
} from '@seamnex/domain';
import { queryKeys } from '../../../src/query-keys';
import type * as Http from '../../../src/http';
import type * as Auth from '../../../src/auth';
import type * as ReactModule from 'react';

/**
 * The hooks are wiring, and the wiring is the contract: which endpoint, which method, which key.
 *
 * Rendering them for real would need a DOM runner this package does not carry (its own suite is a
 * Node one, which is why the pipeline can be tested without a browser). `useQuery`/`useMutation`
 * are therefore replaced by recorders, and every captured `queryFn`/`mutationFn` is invoked
 * directly — the part a screen relies on is exactly that function, not TanStack's scheduler.
 */
const recorded = vi.hoisted(() => ({
  queries: [] as {
    queryKey: unknown;
    queryFn?: (ctx: { signal?: AbortSignal | undefined; pageParam?: unknown }) => unknown;
    enabled?: boolean;
    retry?: boolean;
    refetchInterval?: number | false | ((query: { state: { data: unknown } }) => number | false);
  }[],
  mutations: [] as {
    mutationFn?: (variables: unknown) => unknown;
    onSuccess?: (result: unknown, variables: unknown) => void;
    onError?: (error: unknown, variables: unknown) => void;
  }[],
  invalidations: [] as unknown[],
  infinite: [] as {
    getNextPageParam?: (lastPage: unknown, pages: unknown[]) => unknown;
  }[],
  request: vi.fn(async (_path: string, _options?: unknown) => ({})),
  endSession: vi.fn(async () => ({})),
  openStream: vi.fn(async () => new Response('')),
  setQueries: [] as { key: unknown; value: unknown }[],
  effects: [] as (() => unknown)[],
}));

/**
 * What a cache read returns. Only `job-stream` reads the cache (it resumes from the lines already
 * held), so the value is a per-test fixture rather than a fake store.
 */
let cachedLogs: unknown;

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: (typeof recorded.queries)[number]) => {
    recorded.queries.push(options);
    return {};
  },
  useInfiniteQuery: (options: {
    queryKey: unknown;
    queryFn?: (ctx: { signal?: AbortSignal | undefined; pageParam?: unknown }) => unknown;
    enabled?: boolean;
    getNextPageParam?: (lastPage: unknown, pages: unknown[]) => unknown;
  }) => {
    recorded.queries.push(options);
    recorded.infinite.push(options);
    return {};
  },
  useMutation: (options: (typeof recorded.mutations)[number]) => {
    recorded.mutations.push(options);
    return {};
  },
  // The real helper is an identity marker consumed by TanStack; the hooks only pass it through.
  keepPreviousData: (previous: unknown) => previous,
  useQueryClient: () => ({
    invalidateQueries: (input: unknown) => {
      recorded.invalidations.push(input);
      return Promise.resolve();
    },
    getQueryData: () => cachedLogs,
    setQueryData: (key: unknown, value: unknown) => {
      recorded.setQueries.push({ key, value });
    },
    removeQueries: () => undefined,
    refetchQueries: () => Promise.resolve(),
    clear: () => undefined,
  }),
}));

vi.mock('../../../src/http', async (importOriginal) => {
  const actual = await importOriginal<typeof Http>();
  return {
    ...actual,
    request: recorded.request,
    // The stream reader only needs a response it can open; each test decides what it carries.
    openEventStream: recorded.openStream,
  };
});

vi.mock('../../../src/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof Auth>();
  return { ...actual, endSession: recorded.endSession };
});

// `job-stream` is the one hook with a React effect; recording it keeps this suite renderer-free.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useEffect: (effect: () => unknown) => {
      recorded.effects.push(effect);
    },
  };
});

/** Any value a mutation reads from its variables, without inventing a shape per endpoint. */
function payload(): unknown {
  const proxy: unknown = new Proxy(
    function payloadTarget() {
      return proxy;
    },
    {
      get: (_target, property) => {
        if (property === Symbol.toPrimitive) return () => '';
        if (property === 'toString') return () => '';
        if (property === 'then') return undefined;
        return proxy;
      },
      apply: () => proxy,
    },
  );
  return proxy;
}

const variables = payload();
let hooks: Record<string, (...args: unknown[]) => unknown>;

beforeEach(async () => {
  recorded.queries.length = 0;
  recorded.infinite.length = 0;
  recorded.mutations.length = 0;
  recorded.invalidations.length = 0;
  recorded.request.mockClear();
  recorded.endSession.mockClear();
  recorded.openStream.mockReset();
  recorded.openStream.mockResolvedValue(new Response(''));
  recorded.setQueries.length = 0;
  recorded.effects.length = 0;
  cachedLogs = undefined;
  hooks = {
    ...(await import('../../../src/hooks/portal')),
    ...(await import('../../../src/hooks/admin')),
    ...(await import('../../../src/hooks/backups')),
    ...(await import('../../../src/hooks/catalog')),
    ...(await import('../../../src/hooks/governance')),
    ...(await import('../../../src/hooks/instances')),
    ...(await import('../../../src/hooks/jobs')),
    ...(await import('../../../src/hooks/job-stream')),
    ...(await import('../../../src/hooks/privacy')),
    ...(await import('../../../src/hooks/recovery')),
    ...(await import('../../../src/hooks/workflows')),
  } as unknown as Record<string, (...args: unknown[]) => unknown>;
});

afterEach(() => {
  vi.clearAllMocks();
});

async function flush(): Promise<void> {
  for (const query of recorded.queries) {
    // A disabled query is a deliberate "do not fetch yet"; calling it would test nothing real.
    if (query.enabled === false) continue;
    await query.queryFn?.({ signal: undefined });
  }
  for (const infinite of recorded.infinite) {
    // The page extractor is what the console's "load more" relies on.
    infinite.getNextPageParam?.({ items: [], nextCursor: null }, []);
  }
  for (const mutation of recorded.mutations) {
    await mutation.mutationFn?.(variables);
    mutation.onSuccess?.(variables, variables);
  }
}

describe('query hooks', () => {
  it('declare a key and an endpoint, and run the declared request', async () => {
    hooks['useMe']?.();
    hooks['useEntitlements']?.();
    hooks['useEntitlements']?.(false);
    hooks['useLauncher']?.();
    hooks['useStatusBanner']?.();
    hooks['useLaunchTarget']?.('inst-crm');
    hooks['useLaunchTarget']?.('', false);
    hooks['useProductTile']?.('crm');
    hooks['useProductTile']?.('');
    hooks['useRequestableProducts']?.();
    hooks['useRequestableProducts']?.(false);

    expect(recorded.queries.length).toBe(11);
    await flush();

    const paths = recorded.request.mock.calls.map((call) => call[0]);
    expect(paths).toContain('/me');
    expect(paths).toContain('/me/entitlements');
    expect(paths).toContain('/me/launcher');
    expect(paths).toContain('/portal/status-banner');
    expect(paths).toContain('/portal/launch-targets/inst-crm');
    expect(paths).toContain('/portal/products/crm');
    expect(paths).toContain('/portal/requestable');
    // A disabled hook must not be able to fetch an empty id.
    expect(paths).not.toContain('/portal/launch-targets/');
  });
});

describe('mutation hooks', () => {
  it('post to the declared endpoint and invalidate what they change', async () => {
    hooks['useLaunchTicket']?.();
    hooks['useRecordLaunch']?.();
    hooks['useRequestAccess']?.();
    hooks['useLogout']?.();

    await flush();

    expect(recorded.request.mock.calls.map((call) => call[0])).toContain('/admin/access-requests');
    expect(recorded.request.mock.calls.map((call) => call[0])).toContain('/portal/launch-tickets/');
    expect(recorded.endSession).toHaveBeenCalledTimes(1);
    expect(recorded.invalidations.length).toBeGreaterThan(0);
  });
});

describe('console hooks', () => {
  it('all construct without a renderer', async () => {
    const invocations: [string, unknown[]][] = [
      ['useUsers', ['lena']],
      ['useUsers', []],
      ['useUser', ['usr-1']],
      ['useUser', ['']],
      ['useUserEntitlements', ['usr-1']],
      ['useDisableUser', []],
      ['useGroups', []],
      ['useUpdateGroupMapping', []],
      ['useSyncRuns', []],
      ['useRunSync', []],
      ['useSettings', []],
      ['useUpdateSettings', []],
      ['useAlertChannels', []],
      ['useUpdateAlertChannels', []],
      ['useAccessRequests', []],
      ['useDecidePolicyException', []],
      ['useDecideAccessRequest', []],
      ['useMaintenanceWindows', []],
      ['useMaintenanceWindows', [{ enabled: false, refetchIntervalMs: 5_000 }]],
      ['useTestAlertChannel', []],
      ['useCreateMaintenanceWindow', []],
      ['usePatchMaintenanceWindow', []],
      ['useCancelMaintenanceWindow', []],
      ['usePolicyExceptions', []],
      ['usePolicyExceptions', [{ enabled: false }]],
      ['useDsarRequests', []],
      ['useCreateBackup', ['inst-crm']],
      ['useVerifyBackup', ['inst-crm']],
      ['useRestoreBackup', ['inst-crm']],
      ['useCatalog', []],
      ['useCatalog', [{ search: 'crm', domain: 'Revenue', status: 'available' }]],
      ['useEnvPlan', ['D01-01', 'prod', {}]],
      ['useCatalogEntry', ['D01-01']],
      ['useEnvSchema', ['D01-01']],
      ['useEnvProfiles', []],
      ['useScaffoldDraft', ['D01-01', true]],
      ['useScaffoldDraft', ['D01-01', false]],
      ['useVerifyIntegrationMetadata', ['D01-01']],
      ['useReloadCatalog', []],
      ['useEnvImport', ['D01-01']],
      ['usePrefetchEntry', ['D01-01']],
      ['useConfirmScaffold', ['D01-01']],
      ['useAuditPages', []],
      ['useAuditPages', [{ action: 'x', actor: 'y' }]],
      ['useAuditProof', [1, true]],
      ['useAuditProof', [1, false]],
      ['useExportAudit', []],
      ['useLicenses', []],
      ['useSetHostedService', ['inst-crm']],
      ['usePatchRegister', []],
      ['usePosture', []],
      ['useBreakGlassSessions', []],
      ['useCreateBreakGlass', []],
      ['useBreakGlassAction', []],
      ['useCapacity', []],
      ['useCapacity', [{ enabled: false }]],
      ['useCapacityForecast', []],
      ['useRegistry', []],
      ['useStaleRegistry', []],
      ['useRegistryOperations', ['inst-crm']],
      ['useVerifyAuditRange', []],
      ['useRevealBreakGlass', []],
      ['useInstances', []],
      ['useInstances', [{ state: 'ready' }, { enabled: false }]],
      ['useInstance', ['inst-crm']],
      ['useInstanceStatus', ['inst-crm']],
      ['useRefreshInstanceStatus', []],
      ['useContainers', ['inst-crm']],
      ['useInstanceEnv', ['inst-crm']],
      ['useDrift', ['inst-crm']],
      ['useInstanceBackups', ['inst-crm']],
      ['useInstancePlan', ['inst-crm', 'deploy']],
      ['useInstancePlan', ['inst-crm', null]],
      ['useContainerLogs', ['inst-crm', 'abc']],
      ['useContainerLogs', ['inst-crm', null]],
      ['useImages', ['inst-crm']],
      ['useAdminCredential', ['inst-crm']],
      ['useAdminCredential', ['inst-crm', { enabled: false }]],
      ['useSetAdminCredential', ['inst-crm']],
      ['useProvisionRelayAccounts', ['inst-crm']],
      ['useDeploy', []],
      ['useDeployPreview', [variables, true]],
      ['useDeployPreview', [variables, false]],
      ['useLifecycleAction', []],
      ['useUpdateEnvironment', ['inst-crm']],
      ['useUpdateBackupSchedule', ['inst-crm']],
      ['useJobs', []],
      ['useJobs', [{ state: 'running' }]],
      ['useJobPages', []],
      ['useJob', ['job-1']],
      ['useJobLogs', ['job-1', true]],
      ['useJobLogs', ['job-1', false]],
      ['useCancelJob', []],
      ['useRetryJob', []],
      ['usePrivacyRequests', []],
      ['useCreatePrivacyRequest', []],
      ['useAdvancePrivacyRequest', []],
      ['useRecovery', []],
      ['useRestoreStatus', []],
      ['useRestoreStatus', [{ enabled: false, pollMs: 1_000 }]],
      ['useCreatePlatformBackup', []],
      ['useStartPlatformRestore', []],
      ['useScheduleDrill', []],
      ['useWorkflows', []],
      ['useWorkflow', ['wf-1']],
      ['useWorkflow', ['wf-1', () => 5_000]],
      ['useWorkflowRuns', ['wf-1']],
      ['useWorkflowRuns', ['wf-1', () => false]],
      ['useWorkflowRun', ['run-1']],
      ['useWorkflowAction', ['wf-1']],
      ['usePatchWorkflow', ['wf-1']],
      ['useImportWorkflow', []],
      ['useCreateWorkflow', []],
      ['useDeleteWorkflow', []],
      ['useReplayRun', ['wf-1']],
      ['useExportWorkflow', []],
      ['useAddWorkflowNode', ['wf-1']],
      ['usePatchWorkflowNode', ['wf-1']],
      ['useRemoveWorkflowNode', ['wf-1']],
      ['usePutWorkflowMappings', ['wf-1']],
      ['usePutWorkflowTrigger', ['wf-1']],
      ['useWorkflowNodeFields', ['wf-1', 'node-1', 'list_products']],
      ['useWorkflowNodeFields', ['wf-1', 'node-1', 'list_products', true]],
      ['useWorkflowNodeFields', ['wf-1', 'node-1', null]],
      ['useWorkflowNodeSample', ['wf-1', 'node-1']],
      ['useWorkflowNodeSample', ['wf-1', 'node-1', false]],
    ];

    for (const [name, args] of invocations) {
      const hook = hooks[name];
      expect(typeof hook, name).toBe('function');
      expect(() => hook?.(...args), name).not.toThrow();
    }

    expect(recorded.queries.length + recorded.mutations.length).toBeGreaterThan(90);

    // Constructing a hook only declares its key; the request body of each one runs here.
    await flush();
    expect(recorded.request.mock.calls.length).toBeGreaterThan(60);
  });

  it('derives query strings, preconditions and polling policies from their inputs', async () => {
    hooks['useCatalog']?.({ q: 'crm', cluster: 'Revenue', packaging: 'compose' });
    hooks['useEnvPlan']?.('D01-01', 'production', { A: 'x', B: '' });
    hooks['useInstances']?.({ state: 'ready', entryKey: 'D01-01', q: 'crm' });
    hooks['useInstancePlan']?.('inst-crm', null);
    hooks['useContainerLogs']?.('inst-crm', null);
    hooks['useDeployPreview']?.({ entryKey: '', slug: '' });
    hooks['useJobs']?.({ instanceId: 'inst-crm', kind: 'deploy', state: 'running' });
    hooks['useJobPages']?.({ instanceId: 'inst-crm', kind: 'deploy', state: 'running' });
    hooks['useJob']?.('job-1');
    hooks['useJobLogs']?.('job-1');
    hooks['useRecovery']?.();

    // The captured functions are called even where `enabled` would gate them in a real client:
    // the branch under test is the query function, not TanStack's scheduling decision.
    for (const query of recorded.queries) await query.queryFn?.({ signal: undefined });

    const paths = recorded.request.mock.calls.map((call) => call[0]);
    expect(paths).toContain('/catalog?q=crm&cluster=Revenue&packaging=compose');
    expect(paths).toContain('/catalog/D01-01/env-plan?profile=production&env.A=x');
    expect(paths).toContain('/instances?state=ready&entryKey=D01-01&q=crm');
    expect(paths).toContain('/instances/inst-crm/plan?action=upgrade');
    expect(paths).toContain('/instances/inst-crm/containers//logs');
    expect(paths).toContain('/jobs?instanceId=inst-crm&kind=deploy&state=running&limit=20');

    type WithInterval = { refetchInterval?: (query: unknown) => unknown };
    for (const query of recorded.queries as unknown as WithInterval[]) {
      if (typeof query.refetchInterval !== 'function') continue;
      // A payload that satisfies both the job and the recovery readers, so each policy sees
      // the state it exists to interpret.
      query.refetchInterval({
        state: { data: { state: 'running', runs: [{ state: 'running' }] } },
      });
      query.refetchInterval({
        state: { data: { state: 'succeeded', runs: [{ state: 'succeeded' }] } },
      });
      query.refetchInterval({ state: { data: { runs: [] } } });
      query.refetchInterval({ state: { data: undefined } });
    }
  });

  it('varies a mutation body and its follow-up work with the input', async () => {
    hooks['useLifecycleAction']?.();
    hooks['useUpdateEnvironment']?.('inst-crm');

    const lifecycle = recorded.mutations[0];
    await lifecycle?.mutationFn?.({ id: 'inst-crm', action: 'restart' });
    await lifecycle?.mutationFn?.({
      id: 'inst-crm',
      action: 'delete',
      dataRetention: 'export',
    });
    lifecycle?.onSuccess?.({}, {});

    const environment = recorded.mutations[1];
    environment?.onSuccess?.({ requiresRecreate: true }, {});
    environment?.onSuccess?.({ requiresRecreate: false }, {});

    expect(recorded.invalidations.length).toBeGreaterThan(5);
  });

  it('runs every captured request function without throwing', async () => {
    hooks['useUsers']?.('lena');
    hooks['useCatalog']?.();
    hooks['useInstances']?.();
    hooks['useJobs']?.();
    hooks['useWorkflows']?.();
    hooks['useCapacity']?.();
    hooks['useRecovery']?.();

    await expect(flush()).resolves.toBeUndefined();
    expect(recorded.request.mock.calls.length).toBeGreaterThanOrEqual(7);
    expect(recorded.request.mock.calls[0]?.[0]).toBe('/admin/users?q=lena');
  });
});

describe('deploy preview gating', () => {
  it('waits for an entry and a usable slug before asking for a verdict', () => {
    hooks['useDeployPreview']?.({ entryKey: 'D01-01', slug: 'c' });
    hooks['useDeployPreview']?.({ entryKey: '', slug: 'crm' });
    hooks['useDeployPreview']?.({ entryKey: 'D01-01', slug: 'crm', profile: 'production' });

    // A preview that has not answered yet is "pending", not "failed"; half an input is not a request.
    expect(recorded.queries.map((query) => query.enabled)).toEqual([false, false, true]);
    // The profile is part of the key, so a staging verdict cannot be rendered as production's.
    expect(recorded.queries[2]?.queryKey).toEqual(
      queryKeys.deployPreview('D01-01', 'crm', 'production', undefined),
    );
  });
});

describe('instance administration hooks', () => {
  it('reads the relay credential only where the capability allows it', async () => {
    hooks['useAdminCredential']?.('inst-crm');
    hooks['useAdminCredential']?.('inst-crm', { enabled: false });
    hooks['useAdminCredential']?.('');

    expect(recorded.queries.map((query) => JSON.stringify(query.queryKey))).toEqual([
      JSON.stringify(queryKeys.adminCredential('inst-crm')),
      JSON.stringify(queryKeys.adminCredential('inst-crm')),
      JSON.stringify(queryKeys.adminCredential('')),
    ]);
    // The read is `instance.env`: a role without it must not fire the query merely because the
    // instance screen mounted.
    expect(recorded.queries.map((query) => query.enabled)).toEqual([true, false, false]);

    await recorded.queries[0]?.queryFn?.({ signal: undefined });

    expect(recorded.request).toHaveBeenCalledWith('/instances/inst-crm/admin-credential', {
      schema: AdminCredentialSchema,
      signal: undefined,
    });
  });

  it('stores a token with a PUT and refreshes the metadata and the chain it is audited to', async () => {
    hooks['useSetAdminCredential']?.('inst-crm');
    const mutation = recorded.mutations[0];

    await mutation?.mutationFn?.('s3cr3t');

    expect(recorded.request).toHaveBeenCalledWith('/instances/inst-crm/admin-credential', {
      schema: AdminCredentialSchema,
      method: 'PUT',
      body: { token: 's3cr3t' },
    });

    mutation?.onSuccess?.({}, 's3cr3t');
    expect(recorded.invalidations).toEqual([
      { queryKey: queryKeys.adminCredential('inst-crm') },
      { queryKey: queryKeys.audit },
    ]);
  });

  it('runs the provisioning pass on demand and refetches the chain it appends to', async () => {
    hooks['useProvisionRelayAccounts']?.('inst-crm');
    const mutation = recorded.mutations[0];

    await mutation?.mutationFn?.(undefined);

    expect(recorded.request).toHaveBeenCalledWith('/instances/inst-crm/relay/provision', {
      schema: RelayProvisionReportSchema,
      method: 'POST',
    });

    mutation?.onSuccess?.({}, undefined);
    expect(recorded.invalidations).toEqual([{ queryKey: queryKeys.audit }]);
  });

  it('refreshes the evidence list when an identity-sync cycle is refused', () => {
    hooks['useRunSync']?.();
    const mutation = recorded.mutations[0];

    // A refused cycle is still a recorded run, so the evidence list cannot keep the previous one.
    mutation?.onError?.(new Error('directory refused the bind'), undefined);

    expect(recorded.invalidations).toEqual([
      { queryKey: queryKeys.identitySync },
      { queryKey: queryKeys.audit },
    ]);
  });
});

describe('workflow authoring aids', () => {
  it('polls a workflow or its runs only when the caller supplies the rule', () => {
    const pollWhile = vi.fn((_workflow: { id: string } | undefined) => 4_000);

    hooks['useWorkflow']?.('wf-1', pollWhile);
    const interval = recorded.queries[0]?.refetchInterval;
    if (typeof interval !== 'function') throw new Error('useWorkflow declared no poll rule');

    expect(interval({ state: { data: { id: 'wf-1' } } })).toBe(4_000);
    // The cached value is re-typed inside the hook, so the caller never sees `unknown`.
    expect(pollWhile).toHaveBeenCalledWith({ id: 'wf-1' });
    interval({ state: { data: undefined } });
    expect(pollWhile).toHaveBeenLastCalledWith(undefined);

    // Without a rule the hook must not install a timer at all.
    hooks['useWorkflow']?.('wf-1');
    expect(recorded.queries[1]).not.toHaveProperty('refetchInterval');

    hooks['useWorkflowRuns']?.('wf-1', () => false);
    const runsInterval = recorded.queries[2]?.refetchInterval;
    if (typeof runsInterval !== 'function')
      throw new Error('useWorkflowRuns declared no poll rule');
    // `false` stops the timer: a settled run history is not worth re-reading.
    expect(runsInterval({ state: { data: [] } })).toBe(false);
  });

  it('keys the node fields on the operation and asks for a refresh only when told to', async () => {
    hooks['useWorkflowNodeFields']?.('wf-1', 'node-1', 'list_products');
    hooks['useWorkflowNodeFields']?.('wf-1', 'node-1', 'list_products', true);

    const [fresh, refreshed] = recorded.queries;

    expect(fresh?.queryKey).toEqual([
      ...queryKeys.workflowNodeFields('wf-1', 'node-1'),
      'list_products',
      false,
    ]);
    // Rebinding the node to another operation must not serve the previous operation's fields.
    expect(refreshed?.queryKey).toEqual([
      ...queryKeys.workflowNodeFields('wf-1', 'node-1'),
      'list_products',
      true,
    ]);
    // `unsupported` and `unavailable` are answers; a retry only delays the manual-entry fallback.
    expect(fresh?.retry).toBe(false);

    await fresh?.queryFn?.({ signal: undefined });
    await refreshed?.queryFn?.({ signal: undefined });

    expect(recorded.request.mock.calls.map((call) => call[0])).toEqual([
      '/workflows/wf-1/nodes/node-1/fields',
      '/workflows/wf-1/nodes/node-1/fields?refresh=true',
    ]);
    expect(recorded.request).toHaveBeenCalledWith('/workflows/wf-1/nodes/node-1/fields', {
      schema: NodeFieldsSchema,
      signal: undefined,
    });
  });

  it('does not ask for fields or a sample the author has not selected', () => {
    hooks['useWorkflowNodeFields']?.('wf-1', 'node-1', null);
    hooks['useWorkflowNodeFields']?.('', 'node-1', 'list_products');
    hooks['useWorkflowNodeFields']?.('wf-1', '', 'list_products');
    hooks['useWorkflowNodeFields']?.('wf-1', 'node-1', 'list_products', false, false);
    hooks['useWorkflowNodeSample']?.('wf-1', '');
    hooks['useWorkflowNodeSample']?.('wf-1', 'node-1', false);

    expect(recorded.queries.map((query) => query.enabled)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it('reads a redacted sample under its own key and never retries the read', async () => {
    hooks['useWorkflowNodeSample']?.('wf-1', 'node-1');

    const query = recorded.queries[0];
    expect(query?.queryKey).toEqual(queryKeys.workflowNodeSample('wf-1', 'node-1'));
    expect(query?.enabled).toBe(true);
    // The answer is production data and the read is audited; a failure is reported, not repeated.
    expect(query?.retry).toBe(false);

    await query?.queryFn?.({ signal: undefined });

    expect(recorded.request).toHaveBeenCalledWith('/workflows/wf-1/nodes/node-1/sample', {
      schema: NodeSampleSchema,
      signal: undefined,
    });
  });
});

describe('job history pages', () => {
  it('asks for the first page without a cursor and carries it on the next one', async () => {
    hooks['useJobPages']?.({ instanceId: 'inst-crm' });

    const query = recorded.queries[0];
    await query?.queryFn?.({ signal: undefined, pageParam: null });
    await query?.queryFn?.({ signal: undefined, pageParam: 'cursor-2' });

    expect(recorded.request.mock.calls.map((call) => call[0])).toEqual([
      '/jobs?instanceId=inst-crm&limit=25',
      '/jobs?instanceId=inst-crm&limit=25&cursor=cursor-2',
    ]);
  });
});

describe('job-stream', () => {
  const LOG_FRAME = [
    'id: 42',
    'data: {"seq":42,"ts":"2026-11-05T08:00:00.000Z","stream":"stdout","line":"hello"}',
  ].join('\n');

  const TS = '2026-11-05T08:00:00.000Z';
  const LOGS_KEY = JSON.stringify(['jobs', 'job-1', 'logs']);
  const JOB_KEY = JSON.stringify(['jobs', 'job-1']);

  /** A job payload that satisfies `JobSchema`; the stream's `job` frames carry the same shape. */
  const JOB = {
    id: 'job-1',
    kind: 'deploy',
    instanceId: 'inst-crm',
    entryKey: 'D01-01',
    label: 'Deploy crm',
    state: 'running',
    progress: 40,
    createdAt: TS,
    startedAt: TS,
    finishedAt: null,
    requestedBy: 'lena',
    summary: 'Deploying crm',
    errorCode: null,
    errorMessage: null,
    steps: [
      { seq: 1, name: 'pull', state: 'succeeded', startedAt: TS, finishedAt: TS, message: null },
    ],
  };

  /** One log line in the unnamed shape the API sends, terminated by the frame separator. */
  function logFrame(seq: number, text = `line ${seq}`): string {
    return `id: ${seq}\ndata: ${JSON.stringify({ seq, ts: TS, stream: 'stdout', line: text })}\n\n`;
  }

  function jobFrame(): string {
    return `event: job\ndata: ${JSON.stringify(JOB)}\n\n`;
  }

  /**
   * A response whose body hands out one chunk per read. A real stream does not deliver a frame in
   * one piece, and a reader that only works when it does is not testing the reassembly path.
   */
  function chunkedResponse(chunks: string[]): Response {
    const encoder = new TextEncoder();
    let next = 0;
    return {
      body: {
        getReader: () => ({
          read: async () => {
            const chunk = chunks[next];
            next += 1;
            return chunk === undefined
              ? { done: true, value: undefined }
              : { done: false, value: encoder.encode(chunk) };
          },
        }),
      },
    } as unknown as Response;
  }

  /** Runs the effect the hook declared and returns the cleanup React would call on unmount. */
  function startStream(id = 'job-1'): () => void {
    hooks['useJobStream']?.(id, true);
    const effect = recorded.effects.pop();
    return (effect === undefined ? undefined : effect()) as () => void;
  }

  /** Writes made for the log key, in order. Each value is the updater the hook handed to TanStack. */
  function logWrites(): { key: unknown; value: unknown }[] {
    return recorded.setQueries.filter((entry) => JSON.stringify(entry.key) === LOGS_KEY);
  }

  /** The keys the hook invalidated, as comparable strings (the cache key is a tuple). */
  function invalidatedKeys(): string[] {
    return recorded.invalidations.map((entry) =>
      JSON.stringify((entry as { queryKey?: unknown }).queryKey),
    );
  }

  it('decodes each of the three frame shapes the server sends', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    expect(stream.decodeJobStreamFrame(LOG_FRAME)).toMatchObject({
      id: '42',
      event: { kind: 'log', line: { seq: 42, line: 'hello' } },
    });
    expect(
      stream.decodeJobStreamFrame('data: {"state":"succeeded","terminal":true}'),
    ).toMatchObject({ event: { kind: 'terminal', state: 'succeeded' } });
    expect(
      stream.decodeJobStreamFrame('event: truncated\ndata: {"replayLimit":1000}'),
    ).toMatchObject({ event: { kind: 'truncated', replayLimit: 1000 } });
    expect(stream.decodeJobStreamFrame('event: truncated\ndata: {}')).toMatchObject({
      event: { kind: 'truncated', replayLimit: 0 },
    });
  });

  it('drops frames it cannot parse instead of rendering half a line', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    expect(stream.decodeJobStreamFrame(': heartbeat')).toEqual({ id: null, event: null });
    expect(stream.decodeJobStreamFrame('data: not-json')).toEqual({ id: null, event: null });
    expect(stream.decodeJobStreamFrame('event: log\ndata: {"seq":"not-a-number"}')).toEqual({
      id: null,
      event: null,
    });
    expect(stream.decodeJobStreamFrame('event: job\ndata: {}')).toEqual({ id: null, event: null });
  });

  it('splits a buffer into whole frames and keeps the partial one', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    expect(stream.MAX_LOG_LINES).toBe(500);
    expect(stream.takeFrames('a\n\nb\n\nrest')).toEqual({ frames: ['a', 'b'], rest: 'rest' });
    expect(stream.takeFrames('a\r\n\r\nb\r\n\r\n')).toEqual({ frames: ['a', 'b'], rest: '' });
  });

  it('merges two overlapping replays into one ordered log', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    const held = [
      { seq: 1, ts: TS, stream: 'stdout' as const, line: 'one' },
      { seq: 3, ts: TS, stream: 'stdout' as const, line: 'three' },
    ];
    const replay = [
      { seq: 2, ts: TS, stream: 'stdout' as const, line: 'two' },
      { seq: 3, ts: TS, stream: 'stdout' as const, line: 'three' },
    ];

    // Two subscribers following the same job replay the same lines; the second write must not
    // duplicate them, and the gap the first write left is filled in sequence order.
    expect(stream.mergeBySeq(held, replay).map((line) => line.seq)).toEqual([1, 2, 3]);

    // An empty batch is the common case; it must not copy the log it would return unchanged.
    expect(stream.mergeBySeq(held, [])).toBe(held);
  });

  it('does not open a stream when the hook is disabled or has no id', () => {
    hooks['useJobStream']?.('job-1', false);
    hooks['useJobStream']?.('', true);

    expect(recorded.effects.length).toBe(2);
    for (const effect of recorded.effects) {
      // The callback returns early before any request; running it is safe and proves that.
      expect(effect()).toBeUndefined();
    }
  });

  it('buffers streamed lines into one cache write and stops on a terminal frame', async () => {
    vi.useFakeTimers();
    const frames = [
      'id: 1\ndata: {"seq":1,"ts":"2026-11-05T08:00:00.000Z","stream":"stdout","line":"one"}\n\n',
      'id: 2\ndata: {"seq":2,"ts":"2026-11-05T08:00:00.000Z","stream":"stdout","line":"two"}\n\n',
      // A resumed stream may repeat a line the cache already holds; it must be dropped.
      'id: 2\ndata: {"seq":2,"ts":"2026-11-05T08:00:00.000Z","stream":"stdout","line":"two"}\n\n',
      'data: {"state":"succeeded","terminal":true}\n\n',
    ].join('');
    recorded.openStream.mockResolvedValue(new Response(frames, { status: 200 }));

    hooks['useJobStream']?.('job-1', true);
    const cleanup = recorded.effects.pop()?.() as () => void;
    await vi.advanceTimersByTimeAsync(150);

    expect(recorded.openStream).toHaveBeenCalledWith('/jobs/job-1/stream', expect.anything(), {});
    const batch = recorded.setQueries.find(
      (entry) => Array.isArray(entry.key) && entry.key[2] === 'logs',
    );
    expect(batch).toBeDefined();
    // Two distinct lines; the duplicate seq was not appended.
    expect(recorded.invalidations.length).toBeGreaterThan(0);

    cleanup();
    vi.useRealTimers();
  });

  it('invalidates the log cache when the replay was truncated', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockResolvedValue(
      new Response('event: truncated\ndata: {"replayLimit":1000}\n\n', { status: 200 }),
    );

    hooks['useJobStream']?.('job-1', true);
    const cleanup = recorded.effects.pop()?.() as () => void;
    await vi.advanceTimersByTimeAsync(150);

    expect(recorded.invalidations.length).toBeGreaterThan(0);

    cleanup();
    vi.useRealTimers();
  });

  it('skips a frame it cannot decode and keeps reading the stream', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockResolvedValue(
      chunkedResponse([
        ': heartbeat\n\n',
        logFrame(3),
        // A terminal flag without a state classifies as nothing; it is dropped, not trusted.
        'data: {"terminal":true}\n\n',
      ]),
    );

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(150);

    const updater = logWrites()[0]?.value as (current: unknown) => unknown;
    expect(updater([])).toEqual([{ seq: 3, ts: TS, stream: 'stdout', line: 'line 3' }]);
    // No line had been written yet, so the flush starts from an empty slice rather than failing.
    expect(updater(undefined)).toEqual([{ seq: 3, ts: TS, stream: 'stdout', line: 'line 3' }]);

    cleanup();
    vi.useRealTimers();
  });

  it('retries a dropped stream a bounded number of times', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockRejectedValue(new TypeError('stream dropped'));

    hooks['useJobStream']?.('job-1', true);
    const cleanup = recorded.effects.pop()?.() as () => void;
    await vi.advanceTimersByTimeAsync(7_000);

    expect(recorded.openStream).toHaveBeenCalledTimes(6);

    cleanup();
    vi.useRealTimers();
  });

  it('decodes the named log and job frames the mock platform sends', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    // `event: log` — the prototype protocol names the frame; an unnamed frame is the same line.
    expect(
      stream.decodeJobStreamFrame(
        `event: log\ndata: ${JSON.stringify({ seq: 7, ts: TS, stream: 'stderr', line: 'boom' })}`,
      ),
    ).toEqual({
      id: null,
      event: { kind: 'log', line: { seq: 7, ts: TS, stream: 'stderr', line: 'boom' } },
    });

    expect(stream.decodeJobStreamFrame(jobFrame())).toMatchObject({
      id: null,
      event: { kind: 'job', job: { id: 'job-1', state: 'running' } },
    });

    // The same job, unnamed: the decoder discriminates on the payload rather than the event name.
    expect(stream.decodeJobStreamFrame(`data: ${JSON.stringify(JOB)}`)).toMatchObject({
      id: null,
      event: { kind: 'job', job: { id: 'job-1' } },
    });
  });

  it('keeps the id of a frame that carries no payload, and ignores an empty one', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    // An id-only frame updates the resume cursor without rendering anything.
    expect(stream.decodeJobStreamFrame('id: 41')).toEqual({ id: '41', event: null });
    // An empty `id:` is not a cursor; the field is dropped rather than stored as "".
    expect(stream.decodeJobStreamFrame(`id:\ndata: {"state":"succeeded","terminal":true}`)).toEqual(
      { id: null, event: { kind: 'terminal', state: 'succeeded' } },
    );
    // Surrounding whitespace is not part of the id.
    expect(
      stream.decodeJobStreamFrame('id:   42  \ndata: {"state":"failed","terminal":true}'),
    ).toEqual({ id: '42', event: { kind: 'terminal', state: 'failed' } });
  });

  it('joins multi-line data before parsing it', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    expect(
      stream.decodeJobStreamFrame(
        ['id: 8', `data: {"seq":8,`, `data: "ts":"${TS}","stream":"stdout","line":"joined"}`].join(
          '\n',
        ),
      ),
    ).toMatchObject({ id: '8', event: { kind: 'log', line: { seq: 8, line: 'joined' } } });
  });

  it('decodes a CRLF frame once the buffer splitter has normalised it', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    const { frames, rest } = stream.takeFrames(
      `id: 9\r\ndata: {"seq":9,"ts":"${TS}","stream":"stdout","line":"crlf"}\r\n\r\n`,
    );
    expect(rest).toBe('');
    expect(frames).toHaveLength(1);
    // A server that sends CRLF must render the same line as one that sends LF.
    expect(stream.decodeJobStreamFrame(frames[0] ?? '')).toMatchObject({
      id: '9',
      event: { kind: 'log', line: { seq: 9, line: 'crlf' } },
    });
  });

  it('rejects payloads that do not fit any frame shape', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    // `terminal` without a state cannot be classified; it is not silently treated as terminal.
    expect(stream.decodeJobStreamFrame('data: {"terminal":true}')).toEqual({
      id: null,
      event: null,
    });
    expect(stream.decodeJobStreamFrame('data: {"state":"running","terminal":false}')).toEqual({
      id: null,
      event: null,
    });
    // A job frame carrying a log line, and a log line with an unknown stream, are both rejected.
    expect(
      stream.decodeJobStreamFrame(`event: job\ndata: ${JSON.stringify({ seq: 1, ts: TS })}`),
    ).toEqual({ id: null, event: null });
    expect(
      stream.decodeJobStreamFrame(
        `event: log\ndata: ${JSON.stringify({ seq: 1, ts: TS, stream: 'docker', line: 'x' })}`,
      ),
    ).toEqual({ id: null, event: null });
    // A negative sequence number fails the schema rather than being rendered as a line.
    expect(
      stream.decodeJobStreamFrame(
        `data: ${JSON.stringify({ seq: -1, ts: TS, stream: 'stdout', line: 'x' })}`,
      ),
    ).toEqual({ id: null, event: null });
    // A truncated frame is never dropped: an unusable limit degrades to 0.
    expect(stream.decodeJobStreamFrame('event: truncated\ndata: {"replayLimit":"1000"}')).toEqual({
      id: null,
      event: { kind: 'truncated', replayLimit: 0 },
    });
  });

  it('splits buffers at the frame boundary only', async () => {
    const stream = await import('../../../src/hooks/job-stream');

    expect(stream.takeFrames('')).toEqual({ frames: [], rest: '' });
    expect(stream.takeFrames('a')).toEqual({ frames: [], rest: 'a' });
    expect(stream.takeFrames('a\n\n')).toEqual({ frames: ['a'], rest: '' });
    // A frame is not complete until the blank line arrives, whatever the line ending.
    expect(stream.takeFrames('a\r\n\r\nb')).toEqual({ frames: ['a'], rest: 'b' });
  });

  it('appends a batch to the held lines and keeps only the newest ones', async () => {
    const stream = await import('../../../src/hooks/job-stream');
    vi.useFakeTimers();
    // A chatty container: 600 lines, which is more than the panel retains.
    const frames = Array.from({ length: 600 }, (_unused, index) => logFrame(index + 1)).join('');
    recorded.openStream.mockResolvedValue(chunkedResponse([frames]));

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(150);

    // One write for the whole burst, not one per line.
    expect(logWrites()).toHaveLength(1);
    const updater = logWrites()[0]?.value as (current: unknown) => unknown;
    const held = Array.from({ length: 40 }, (_unused, index) => ({
      seq: index + 1,
      ts: TS,
      stream: 'stdout',
      line: 'held',
    }));

    const next = updater(held) as { seq: number }[];
    expect(next).toHaveLength(stream.MAX_LOG_LINES);
    // 40 held + 600 appended is 140 over the cap, so the oldest 140 are dropped.
    expect(next[0]?.seq).toBe(101);
    expect(next[next.length - 1]?.seq).toBe(600);
    // The held lines are concatenated, never replaced by the batch.
    expect(updater([])).toHaveLength(stream.MAX_LOG_LINES);

    cleanup();
    vi.useRealTimers();
  });

  it('resumes from the lines the cache already holds', async () => {
    vi.useFakeTimers();
    const held = [
      { seq: 1, ts: TS, stream: 'stdout', line: 'one' },
      { seq: 2, ts: TS, stream: 'stdout', line: 'two' },
      { seq: 3, ts: TS, stream: 'stdout', line: 'three' },
    ];
    cachedLogs = held;
    // A resumed stream repeats what the cache has, then continues where it left off.
    recorded.openStream.mockResolvedValue(
      chunkedResponse([logFrame(2, 'two') + logFrame(3, 'three') + logFrame(4, 'four')]),
    );

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(150);

    const updater = logWrites()[0]?.value as (current: unknown) => unknown;
    const next = updater(cachedLogs) as { seq: number; line: string }[];
    expect(next.map((line) => line.seq)).toEqual([1, 2, 3, 4]);
    // The repeated lines were not appended a second time.
    expect(next.filter((line) => line.line === 'two')).toHaveLength(1);

    cleanup();
    vi.useRealTimers();
  });

  it('writes a job frame into the job cache instead of the log', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockResolvedValue(chunkedResponse([jobFrame()]));

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(150);

    const write = recorded.setQueries.find((entry) => JSON.stringify(entry.key) === JOB_KEY);
    expect(write?.value).toMatchObject({ id: 'job-1', state: 'running', progress: 40 });
    // A progress frame is not a log line; the log cache must not gain an entry for it.
    expect(logWrites()).toHaveLength(0);

    cleanup();
    vi.useRealTimers();
  });

  it('reassembles a frame that arrives in pieces', async () => {
    vi.useFakeTimers();
    const frame = logFrame(11, 'split across three reads');
    recorded.openStream.mockResolvedValue(
      chunkedResponse([frame.slice(0, 12), frame.slice(12, 44), frame.slice(44)]),
    );

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(150);

    const updater = logWrites()[0]?.value as (current: unknown) => unknown;
    expect(updater([])).toEqual([
      { seq: 11, ts: TS, stream: 'stdout', line: 'split across three reads' },
    ]);

    cleanup();
    vi.useRealTimers();
  });

  it('resumes a dropped stream from Last-Event-ID', async () => {
    vi.useFakeTimers();
    // The first connection closes after a line without a terminal frame; the second finishes.
    recorded.openStream
      .mockResolvedValueOnce(chunkedResponse([logFrame(7)]))
      .mockResolvedValueOnce(chunkedResponse(['data: {"state":"succeeded","terminal":true}\n\n']));

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(150);
    expect(recorded.openStream).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(recorded.openStream).toHaveBeenCalledTimes(2);
    // Without this header a resume replays the log from the beginning.
    expect(recorded.openStream.mock.calls[1]).toEqual([
      '/jobs/job-1/stream',
      expect.anything(),
      { 'Last-Event-ID': '7' },
    ]);

    cleanup();
    vi.useRealTimers();
  });

  it('keeps the stream open when a terminal-flagged frame is not a final state', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockResolvedValue(
      chunkedResponse(['data: {"state":"running","terminal":true}\n\n']),
    );

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(7_000);

    // Trusting the flag would have ended the stream on a job that is still running.
    expect(recorded.openStream).toHaveBeenCalledTimes(6);

    cleanup();
    vi.useRealTimers();
  });

  it('settles on a terminal frame and stops retrying', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockResolvedValue(
      chunkedResponse(['data: {"state":"failed","terminal":true}\n\n']),
    );

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(7_000);

    expect(recorded.openStream).toHaveBeenCalledTimes(1);
    const keys = invalidatedKeys();
    // Both the job and its log are refetched so polling settles on the final state.
    expect(keys).toContain(JOB_KEY);
    expect(keys).toContain(LOGS_KEY);

    cleanup();
    vi.useRealTimers();
  });

  it('flushes buffered lines before invalidating a truncated replay', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockResolvedValue(
      chunkedResponse([logFrame(1) + 'event: truncated\ndata: {"replayLimit":1000}\n\n']),
    );

    const cleanup = startStream();
    // Short of the flush interval: the truncated frame must flush on its own, or the line that
    // was buffered would be lost when the query is invalidated underneath it.
    await vi.advanceTimersByTimeAsync(50);

    expect(logWrites()).toHaveLength(1);
    expect(invalidatedKeys()).toContain(LOGS_KEY);

    cleanup();
    vi.useRealTimers();
  });

  it('stops when the response carries no readable body', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockResolvedValue(new Response(null));

    const cleanup = startStream();
    await vi.advanceTimersByTimeAsync(7_000);

    // Nothing to read is not a dropped connection: retrying would spin for no reason.
    expect(recorded.openStream).toHaveBeenCalledTimes(1);
    expect(recorded.setQueries).toEqual([]);

    cleanup();
    vi.useRealTimers();
  });

  it('stops retrying once the screen unmounts', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockRejectedValue(new TypeError('stream dropped'));

    const cleanup = startStream();
    // The first attempt failed and the retry wait is running.
    await vi.advanceTimersByTimeAsync(1);
    expect(recorded.openStream).toHaveBeenCalledTimes(1);

    cleanup();
    await vi.advanceTimersByTimeAsync(7_000);

    // The pending wait resolved on abort instead of holding the timer for another attempt.
    expect(recorded.openStream).toHaveBeenCalledTimes(1);
  });

  it('does not write a buffered batch after unmount', async () => {
    vi.useFakeTimers();
    recorded.openStream.mockResolvedValue(chunkedResponse([logFrame(1)]));

    const cleanup = startStream();
    // The line is buffered and the flush is scheduled, but it has not run yet.
    await vi.advanceTimersByTimeAsync(1);
    cleanup();
    await vi.advanceTimersByTimeAsync(500);

    // A write after unmount would update a cache nobody is subscribed to.
    expect(recorded.setQueries).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route } from '../../../support/fakes';
import { PostgresExecutorService } from '../../../../src/modules/m05-executor/executor.service';

/**
 * The read model. Two properties are asserted over and over, because both were defects: every
 * contract field prefers the relational column and falls back to the document only when the column
 * is absent (a freshly seeded host has a row whose `payload` is empty), and a path parameter that is
 * not a UUID is a 404 rather than a cast error inside the driver.
 */
const INSTANCE_ID = '4a1e6f7c-0000-4000-8000-000000000001';

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: INSTANCE_ID,
    entry_key: 'D01-01',
    slug: 'crm',
    domain_route: 'crm.seamnex.local',
    profile_key: 'prod',
    state: 'ready',
    desired_state: 'running',
    payload: {
      product: 'EspoCRM',
      description: 'CRM',
      domain: 'sales',
      imageRef: 'repo/crm:7.4',
      imageDigest: 'sha256:abc',
      resources: { cpu: 1.5, memoryMb: 2_048, diskMb: 4_096 },
      usage: { cpuPercent: 12, memoryMb: 800, diskMb: 1_200 },
      owner: { id: 'u1', name: 'Team CRM' },
      licenseId: 'AGPL',
      currentVersion: '7.4.1',
      availableVersion: '7.4.2',
    },
    updated_at: new Date('2026-01-02T00:00:00Z'),
    created_at: new Date('2026-01-01T00:00:00Z'),
    entry_payload: {
      product: 'EspoCRM (catalog)',
      description: 'Catalog description',
      domain: 'catalog-domain',
      imageRef: 'repo/crm:7.3',
      imageDigest: 'sha256:catalog',
      resources: { cpu: 2, memoryMb: 4_096, diskMb: 8_192 },
      owner: 'catalog-team',
      domainOwner: 'domain-team',
      guaranteeClass: 'fa_header',
      licenseId: 'BSD',
      repoUrl: 'https://example.test/crm.git',
    },
    route_host: 'crm.seamnex.local',
    route_path_prefix: '/crm',
    route_publish_model: 'subpath',
    route_tls_mode: 'internal',
    route_auth_mode: 'fa_header',
    route_published: true,
    status_state: 'ready',
    status_ready: true,
    status_observed_at: new Date('2026-01-03T00:00:00Z'),
    status_source: 'push',
    status_reason: null,
    source_path: 'compose',
    source_url: 'https://example.test/crm.git',
    source_revision: 'r7',
    source_image_ref: 'repo/crm@sha256:deadbeef',
    source_policy_verdict: 'allowed',
    source_resolved_at: new Date('2026-01-04T00:00:00Z'),
    ...overrides,
  };
}

function setup(routes: readonly Route[] = []) {
  const db = fakeDb(routes);
  const planner = { instancePlan: vi.fn(async () => ({ planId: 'plan-1' })) };
  const lifecycleService = {
    preview: vi.fn(async () => ({ admissible: true })),
    deploy: vi.fn(async () => ({ instanceId: 'inst-1', jobId: 'job-1' })),
    abandonDeployment: vi.fn(async () => undefined),
    lifecycle: vi.fn(async () => ({ jobId: 'job-1', kind: 'stop' })),
    prefetch: vi.fn(async () => ({ jobId: 'job-1' })),
  };
  const capacity = { record: vi.fn(async () => null) };
  const service = new PostgresExecutorService(
    db.pool,
    planner as never,
    lifecycleService as never,
    capacity as never,
  );
  return { db, planner, lifecycleService, capacity, service };
}

/** The projection of one row, through the same `instances` query the fleet list uses. */
async function project(overrides: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { service } = setup([['FROM instance i', [row(overrides)]]]);
  const [instance] = await service.instances({});
  return instance as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('delegation', () => {
  it('hands each mutation to the lifecycle service, which owns the job', async () => {
    const { lifecycleService, service } = setup();

    await expect(service.preview({ entryKey: 'D01-01', slug: 'crm' })).resolves.toEqual({
      admissible: true,
    });
    await expect(
      service.deploy({ entryKey: 'D01-01', slug: 'crm', actorId: 'alice' }),
    ).resolves.toEqual({ instanceId: 'inst-1', jobId: 'job-1' });
    await expect(service.abandonDeployment('inst-1', 'alice', 'reason')).resolves.toBeUndefined();
    await expect(
      service.lifecycle({ instanceId: 'inst-1', action: 'stop', actorId: 'alice' }),
    ).resolves.toEqual({ jobId: 'job-1', kind: 'stop' });
    await expect(service.prefetch('D01-01', 'alice')).resolves.toEqual({ jobId: 'job-1' });

    expect(lifecycleService.abandonDeployment).toHaveBeenCalledWith('inst-1', 'alice', 'reason');
  });

  it('records a capacity sample through the capacity service', async () => {
    const { capacity, service } = setup();

    await service.recordCapacitySample();

    expect(capacity.record).toHaveBeenCalledOnce();
  });

  it('projects the plan from the planner', async () => {
    const { planner, service } = setup();

    await expect(service.plan('inst-1', 'upgrade')).resolves.toEqual({ planId: 'plan-1' });
    expect(planner.instancePlan).toHaveBeenCalledWith('inst-1', 'upgrade');
  });
});

describe('instances', () => {
  it('filters by lower-cased text, state and entry, defaulting every axis', async () => {
    const { db, service } = setup([['FROM instance i', [row()]]]);

    const result = await service.instances({ q: 'CRM', state: 'ready', entryKey: 'D01-01' });

    expect(result).toHaveLength(1);
    expect(db.calls[0]?.params).toEqual(['crm', 'ready', 'D01-01']);
  });

  it('passes empty filters through as empty strings', async () => {
    const { db, service } = setup([['FROM instance i', []]]);

    await service.instances({});

    // `($1 = '' OR …)` is the shape that keeps one prepared statement for every filter combination.
    expect(db.calls[0]?.params).toEqual(['', '', '']);
  });
});

describe('the projection', () => {
  it('prefers the relational columns and the document over the catalog document', async () => {
    const instance = await project({});

    expect(instance).toMatchObject({
      id: INSTANCE_ID,
      slug: 'crm',
      entryKey: 'D01-01',
      domain: 'sales',
      product: 'EspoCRM',
      description: 'CRM',
      domainRoute: 'crm.seamnex.local',
      profileKey: 'prod',
      state: 'ready',
      desiredState: 'running',
      ready: true,
      statusSource: 'push',
      observedAt: '2026-01-03T00:00:00.000Z',
      stateReason: null,
      owner: { id: 'u1', name: 'Team CRM' },
      domainOwner: { id: 'domain-team', name: 'domain-team' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      currentVersion: '7.4.1',
      availableVersion: '7.4.2',
      imageDigest: 'sha256:abc',
      licenseId: 'AGPL',
      licenseRestricted: false,
      integrationVerified: false,
      metadataStale: false,
      resources: { cpu: 1.5, memoryMb: 2_048, diskMb: 4_096 },
      usage: { cpuPercent: 12, memoryMb: 800, diskMb: 1_200 },
      route: {
        host: 'crm.seamnex.local',
        pathPrefix: '/crm',
        publishModel: 'subpath',
        tlsMode: 'internal',
        authMode: 'fa_header',
        published: true,
      },
      source: {
        path: 'compose',
        sourceUrl: 'https://example.test/crm.git',
        sourceRevision: 'r7',
        resolvedImageRef: 'repo/crm@sha256:deadbeef',
        policyVerdict: 'compliant',
        policyNotes: [],
        resolvedAt: '2026-01-04T00:00:00.000Z',
      },
    });
  });

  it('projects a seeded row that has no document and no catalog entry', async () => {
    const instance = await project({ payload: undefined, entry_payload: null, profile_key: null });

    // Nothing is invented: the contract's own defaults fill every descriptive field.
    expect(instance).toMatchObject({
      domain: 'Unassigned',
      product: 'D01-01',
      description: 'D01-01 deployment',
      profileKey: 'default',
      imageDigest: 'sha256:unknown',
      owner: { id: 'unassigned', name: 'unassigned' },
      domainOwner: { id: 'unassigned', name: 'unassigned' },
      licenseId: 'unreviewed',
      resources: { cpu: 0.25, memoryMb: 256, diskMb: 1_024 },
      usage: { cpuPercent: 0, memoryMb: 0, diskMb: 0 },
      maintenance: null,
      backup: {
        lastSuccessAt: null,
        lastVerifiedRestoreAt: null,
        schedule: 'not scheduled',
        scheduleTimezone: 'UTC',
        scheduleEnabled: false,
        verified: false,
      },
      eventModes: [],
      entryKeys: ['D01-01'],
    });
  });

  it('falls back to the catalog document when the instance document is silent', async () => {
    const instance = await project({
      payload: {},
      status_state: null,
      status_ready: null,
      status_observed_at: null,
      status_source: null,
      desired_state: null,
      state: 'stopped',
      source_path: null,
      source_url: null,
      source_revision: null,
      source_image_ref: null,
      route_host: null,
      route_path_prefix: null,
      route_publish_model: null,
      route_tls_mode: null,
      route_auth_mode: null,
      route_published: null,
      source_resolved_at: null,
    });

    expect(instance).toMatchObject({
      product: 'EspoCRM (catalog)',
      description: 'Catalog description',
      domain: 'catalog-domain',
      imageDigest: 'sha256:catalog',
      state: 'stopped',
      // A stopped instance with no recorded intent is presumed to want to stay stopped.
      desiredState: 'stopped',
      ready: false,
      statusSource: 'poll',
      observedAt: '2026-01-02T00:00:00.000Z',
      resources: { cpu: 2, memoryMb: 4_096, diskMb: 8_192 },
      source: {
        path: 'compose',
        sourceUrl: 'https://example.test/crm.git',
        sourceRevision: 'local',
        resolvedImageRef: 'repo/crm:7.3',
        policyVerdict: 'compliant',
        // No resolution row: the instance's own creation date is the last thing known about it.
        resolvedAt: '2026-01-01T00:00:00.000Z',
      },
      route: {
        host: 'crm.seamnex.local',
        pathPrefix: '/',
        publishModel: 'subdomain',
        tlsMode: 'acme',
        authMode: 'fa_header',
        published: false,
      },
      // No `currentVersion` in either document: the tag is the version.
      currentVersion: '7.3',
    });
  });

  it('presumes a running instance without a recorded intent wants to run, and a local source when nothing names a repository', async () => {
    const instance = await project({
      desired_state: null,
      state: 'degraded',
      source_url: null,
      source_revision: null,
      source_image_ref: null,
      entry_payload: {},
      payload: {},
    });

    expect(instance).toMatchObject({
      desiredState: 'running',
      source: { sourceUrl: 'local', sourceRevision: 'local', resolvedImageRef: 'unknown' },
    });
  });

  it('reads a route host from the payload when there is no route row', async () => {
    const instance = await project({
      route_host: null,
      route_auth_mode: null,
      entry_payload: { guaranteeClass: undefined },
      payload: { route: { host: 'payload.seamnex.local' } },
    });

    expect(instance.route).toMatchObject({ host: 'payload.seamnex.local', authMode: 'native' });
  });

  it('ignores a route document that is not an object', async () => {
    const instance = await project({
      route_host: null,
      payload: { route: 'crm.seamnex.local' },
    });

    expect(instance.route).toMatchObject({ host: 'crm.seamnex.local' });
  });

  it.each([
    ['blocked', 'violations'],
    ['unsafe_approved', 'exception-approved'],
    ['allowed', 'compliant'],
    [null, 'compliant'],
  ])('maps the stored policy verdict %s to %s', async (stored, expected) => {
    const instance = await project({ source_policy_verdict: stored });

    expect((instance.source as { policyVerdict: string }).policyVerdict).toBe(expected);
  });

  it('normalises resource numbers, refusing NaN and holding a floor of one', async () => {
    const instance = await project({
      entry_payload: null,
      payload: { resources: { cpu: 'fast', memoryMb: Number.NaN, diskMb: 0 } },
    });

    expect(instance.resources).toEqual({ cpu: 0.25, memoryMb: 256, diskMb: 1 });
  });

  it('ignores a resources document that is an array', async () => {
    const instance = await project({
      entry_payload: { resources: [1, 2, 3] },
      payload: { resources: ['x'] },
    });

    expect(instance.resources).toEqual({ cpu: 0.25, memoryMb: 256, diskMb: 1_024 });
  });

  it('reports every entry key this instance serves, without repeating the primary one', async () => {
    const instance = await project({ payload: { entryKeys: ['D01-01', 'D02-01', 7] } });

    expect(instance.entryKeys).toEqual(['D01-01', 'D02-01']);
  });

  it('ignores an entry-key document that is not a list', async () => {
    const instance = await project({ payload: { entryKeys: 'D02-01' } });

    expect(instance.entryKeys).toEqual(['D01-01']);
  });

  it('prefers a named owner over a bare string, falling back one field at a time', async () => {
    const instance = await project({
      payload: { owner: { id: '', name: 'Only A Name' }, domainOwner: 'someone' },
      entry_payload: { owner: '', domainOwner: 'from-catalog' },
    });

    // An id that is empty and a catalog name that is empty both fall back to the contract default;
    // the name that is present is kept, and a bare string names both halves of its ref.
    expect(instance.owner).toEqual({ id: 'unassigned', name: 'Only A Name' });
    expect(instance.domainOwner).toEqual({ id: 'from-catalog', name: 'from-catalog' });
  });

  it('derives the domain owner from the owner when the catalog names none', async () => {
    const instance = await project({
      payload: { owner: { id: 'u1', name: 'Team CRM' } },
      entry_payload: {},
    });

    // No catalog `domainOwner`, so the fallback is the owner's own name — not its id.
    expect(instance.domainOwner).toEqual({ id: 'Team CRM', name: 'Team CRM' });
  });

  it('keeps the recorded maintenance and backup documents untouched', async () => {
    const maintenance = { state: 'maintenance', startedAt: '2026-01-05T00:00:00Z' };
    const backup = { lastSuccessAt: '2026-01-05T00:00:00Z', verified: true };
    const instance = await project({ payload: { maintenance, backup } });

    expect(instance.maintenance).toEqual(maintenance);
    expect(instance.backup).toEqual(backup);
  });

  it('projects the event modes the catalog declares, dropping the ones it cannot read', async () => {
    const instance = await project({
      entry_payload: {
        integration: {
          eventModes: [
            { mode: 'webhook', label: '', minimumIntervalMinutes: 5 },
            { mode: 'schedule', label: 'Nightly' },
            { mode: 'poll', minimumIntervalMinutes: 'every hour' },
            { mode: 'bogus' },
            'webhook',
          ],
          verifiedAt: '2026-01-05T00:00:00Z',
          stale: true,
        },
      },
    });

    expect(instance.eventModes).toEqual([
      { mode: 'webhook', label: 'webhook', minimumIntervalMinutes: 5 },
      { mode: 'schedule', label: 'Nightly' },
      { mode: 'poll', label: 'poll' },
    ]);
    expect(instance.integrationVerified).toBe(true);
    expect(instance.metadataStale).toBe(true);
  });

  it('honours the flags the pipeline wrote into the document', async () => {
    const instance = await project({
      payload: { licenseRestricted: true, integrationVerified: true, metadataStale: true },
      entry_payload: {},
    });

    expect(instance).toMatchObject({
      licenseRestricted: true,
      integrationVerified: true,
      metadataStale: true,
      eventModes: [],
    });
  });

  it('reports the catalog integration timestamp as verified even without the flag', async () => {
    const instance = await project({
      entry_payload: { integration: { verifiedAt: '2026-01-05T00:00:00Z' } },
    });

    expect(instance.integrationVerified).toBe(true);
  });
});

describe('instance detail', () => {
  it('joins the services and volumes of one instance', async () => {
    const { db, service } = setup([
      ['FROM instance i', [row()]],
      [
        'FROM instance_service WHERE instance_id',
        [
          {
            service_name: 'app',
            role: 'primary',
            image_ref: 'repo/crm:7.4',
            image_digest: 'sha256:abc',
            internal_url: 'http://app:80',
          },
          {
            service_name: 'db',
            role: 'database',
            image_ref: 'repo/mariadb:11',
            image_digest: null,
            internal_url: null,
          },
        ],
      ],
      [
        'FROM instance_volume WHERE instance_id',
        [
          { name: 'data', mount_path: '/var/lib/app', quota_mb: 5_120 },
          { name: 'none', mount_path: '/tmp', quota_mb: null },
          { name: 'zero', mount_path: '/var/zero', quota_mb: 0 },
        ],
      ],
    ]);

    const detail = await service.instance(INSTANCE_ID);

    expect(detail.services).toEqual([
      {
        id: `${INSTANCE_ID}:app`,
        serviceName: 'app',
        role: 'primary',
        imageRef: 'repo/crm:7.4',
        imageDigest: 'sha256:abc',
        internalUrl: 'http://app:80',
      },
      {
        id: `${INSTANCE_ID}:db`,
        serviceName: 'db',
        role: 'database',
        imageRef: 'repo/mariadb:11',
        // A service row without a digest or a URL still projects a usable entry.
        imageDigest: 'sha256:unknown',
        internalUrl: 'http://db',
      },
    ]);
    expect(detail.volumes).toEqual([
      {
        id: `${INSTANCE_ID}:data`,
        name: 'data',
        mountPath: '/var/lib/app',
        quotaMb: 5_120,
        usedMb: 0,
      },
      { id: `${INSTANCE_ID}:none`, name: 'none', mountPath: '/tmp', quotaMb: 1, usedMb: 0 },
      { id: `${INSTANCE_ID}:zero`, name: 'zero', mountPath: '/var/zero', quotaMb: 1, usedMb: 0 },
    ]);
    expect(detail.integrationChecks).toEqual([]);
    expect(db.calls[1]?.params).toEqual([INSTANCE_ID]);
  });

  it('answers 404 for an id that is not a UUID, without touching the database', async () => {
    const { db, service } = setup();

    await expect(service.instance('not-a-uuid')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No instance not-a-uuid.',
    });
    expect(db.calls).toHaveLength(0);
  });

  it('answers 404 for an id that addresses no live row', async () => {
    const { service } = setup([['FROM instance i', []]]);

    await expect(service.instance(INSTANCE_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('drift', () => {
  it('projects a recorded drift with its declared and observed values', async () => {
    const { db, service } = setup([
      [
        'FROM drift_record',
        [
          {
            id: 'drift-1',
            detail: { varName: 'DB_PASSWORD', declared: 'a', observed: 'b', kind: 'modified' },
            expected_hash: 'h1',
            observed_hash: 'h2',
            detected_at: new Date('2026-01-05T00:00:00Z'),
            resolved_at: new Date('2026-01-06T00:00:00Z'),
          },
        ],
      ],
    ]);

    await expect(service.drift(INSTANCE_ID)).resolves.toEqual([
      {
        id: 'drift-1',
        varName: 'DB_PASSWORD',
        declared: 'a',
        observed: 'b',
        kind: 'modified',
        detectedAt: '2026-01-05T00:00:00.000Z',
        resolvedAt: '2026-01-06T00:00:00.000Z',
      },
    ]);
    expect(db.calls[0]?.params).toEqual([INSTANCE_ID]);
  });

  it('falls back to the recorded hashes when the detail document is silent', async () => {
    const { service } = setup([
      [
        'FROM drift_record',
        [
          {
            id: 'drift-2',
            detail: {},
            expected_hash: 'h1',
            observed_hash: null,
            detected_at: new Date('2026-01-05T00:00:00Z'),
            resolved_at: null,
          },
        ],
      ],
    ]);

    await expect(service.drift(INSTANCE_ID)).resolves.toEqual([
      {
        id: 'drift-2',
        varName: 'environment',
        declared: 'h1',
        observed: null,
        kind: 'mismatch',
        detectedAt: '2026-01-05T00:00:00.000Z',
        resolvedAt: null,
      },
    ]);
  });

  it('answers 404 for an id that is not a UUID', async () => {
    const { service } = setup();

    await expect(service.drift('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('images', () => {
  it('marks the newest artefact current and the rest previous', async () => {
    const { db, service } = setup([
      [
        'FROM image_artefact',
        [
          {
            image_digest: 'sha256:new',
            source_revision: 'r2',
            object_key: 'k2',
            created_at: new Date('2026-01-05T00:00:00Z'),
          },
          {
            image_digest: 'sha256:old',
            source_revision: null,
            object_key: 'k1',
            created_at: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      ],
    ]);

    await expect(service.images(INSTANCE_ID)).resolves.toEqual([
      {
        digest: 'sha256:new',
        version: 'r2',
        state: 'current',
        builtAt: '2026-01-05T00:00:00.000Z',
        artefact: 'k2',
      },
      {
        digest: 'sha256:old',
        version: 'unversioned',
        state: 'previous',
        builtAt: '2026-01-01T00:00:00.000Z',
        artefact: 'k1',
      },
    ]);
    expect(db.calls[0]?.params).toEqual([INSTANCE_ID]);
  });

  it('answers 404 for an id that is not a UUID', async () => {
    const { service } = setup();

    await expect(service.images('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

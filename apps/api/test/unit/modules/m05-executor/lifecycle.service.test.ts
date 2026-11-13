import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { InstanceLifecycleService } from '../../../../src/modules/m05-executor/lifecycle.service';

/**
 * The lifecycle API creates the *job*, never the container, and three rules hold across the file:
 * admission happens before the instance row exists, a refused or failing deploy leaves nothing
 * behind, and the plan — not the caller's request — decides which profile and which values apply.
 * Each of those was a defect once, so each is asserted here rather than assumed.
 */
const ENTRY = { key: 'D01-01', packaging: 'compose', payload: { resources: { memoryMb: 2048 } } };

/** An entry the derived-environment table in `common/identity/derived-env` knows nothing about. */
const NO_DERIVATION_ENTRY: Route = [
  'FROM catalog_entry WHERE key',
  [{ key: 'X9', packaging: 'compose', payload: {} }],
];

const DEFAULTS: readonly Route[] = [
  ['FROM catalog_entry WHERE key', [ENTRY]],
  ['SELECT entry_key, state, domain_route', []],
  ['INSERT INTO instance (entry_key', [{ id: 'inst-new' }]],
  ['DELETE FROM instance WHERE id', { rows: [], rowCount: 1 }],
  ['SELECT id, slug, state FROM instance', [{ id: 'inst-1', slug: 'crm', state: 'ready' }]],
  ['scaffold_artefact', [{ present: false }]],
];

function plan(overrides: Record<string, unknown> = {}) {
  return {
    entryKey: 'D01-01',
    profileKey: 'default',
    values: [],
    fieldErrors: [],
    requiresRecreate: false,
    resolvedAt: new Date().toISOString(),
    ...overrides,
  };
}

function decision(overrides: Record<string, unknown> = {}) {
  return {
    admissible: true,
    headline: 'fits on this host',
    detail: '12 vCPU free',
    shortfall: { cpuMilli: 0, memoryMb: 0, diskMb: 0 },
    limits: { cpuMilli: 8_000, memoryMb: 16_384, diskMb: 200_000 },
    used: { cpuMilli: 2_000, memoryMb: 4_096, diskMb: 20_000 },
    source: 'measured',
    ...overrides,
  };
}

function setup(routes: readonly Route[] = []) {
  const db = fakeDb([...routes, ...DEFAULTS]);
  const renderer = {
    plan: vi.fn(async () => plan()),
    // The arguments are declared so `mock.calls` is a typed tuple: the applied map is read from it.
    updateInstanceEnv: vi.fn(
      async (_instanceId: string, _values: Record<string, string>, _actorId: string) => ({}),
    ),
  };
  const capacity = {
    admit: vi.fn(async () => decision()),
    reserve: vi.fn(async () => undefined),
    release: vi.fn(async () => undefined),
  };
  const audit = { append: vi.fn(async () => ({ seq: '1', hash: 'h' })) };
  const jobs = { create: vi.fn(async () => ({ job: { id: 'job-1' }, created: true })) };
  const pipelines = { stepsFor: vi.fn(() => ['prepare', 'apply']) };
  const config = {
    SEAMNEX_INGRESS_DOMAIN: 'seamnex.local',
    SEAMNEX_PRODUCT_URL_SCHEME: 'https',
    SEAMNEX_PRODUCT_URL_PORT: '',
  } as unknown as AppConfig;
  const service = new InstanceLifecycleService(
    db.pool,
    config,
    renderer as never,
    capacity as never,
    audit as never,
    jobs as never,
    pipelines as never,
  );
  return { db, renderer, capacity, audit, jobs, pipelines, service };
}

function deployInput(overrides: Record<string, unknown> = {}) {
  return { entryKey: 'D01-01', slug: 'crm', actorId: 'alice', ...overrides } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deploy', () => {
  it('creates the instance, the job and the audit row for an admitted request', async () => {
    const { db, renderer, capacity, audit, jobs, pipelines, service } = setup();
    renderer.plan.mockResolvedValue(
      plan({
        profileKey: 'prod',
        values: [{ name: 'A', value: '1', masked: false, overrideCeiling: 'instance' }],
      }),
    );

    const result = await service.deploy(
      deployInput({ profileKey: 'prod', envOverrides: { A: '1' }, revision: 'r2' }),
    );

    expect(result).toEqual({ instanceId: 'inst-new', jobId: 'job-1' });
    expect(capacity.admit).toHaveBeenCalledWith({
      resources: { cpuMilli: 1_000, memoryMb: 2_048, diskMb: 2_048 },
    });
    // The plan is the authority on the profile: the instance records the key that actually applied.
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO instance (entry_key'));
    expect(insert?.params.slice(0, 4)).toEqual(['D01-01', 'crm', 'crm.seamnex.local', 'prod']);
    // The owner is the authenticated person, which is what the portal grant is keyed on.
    expect(insert?.sql).toContain('owner_user_id');
    expect(insert?.params[4]).toBe('alice');
    expect(renderer.plan).toHaveBeenCalledWith({
      entryKey: 'D01-01',
      profileKey: 'prod',
      overrides: { A: '1' },
    });
    // Derived values and operator overrides are applied, not only the catalog default.
    expect(renderer.updateInstanceEnv).toHaveBeenCalledWith(
      'inst-new',
      expect.objectContaining({
        A: '1',
        ESPOCRM_SITE_URL: 'https://crm.seamnex.local',
        ESPOCRM_CONFIG_OIDC_CLIENT_ID: 'seamnex-crm',
      }),
      'alice',
    );
    expect(capacity.reserve).toHaveBeenCalledWith({
      instanceId: 'inst-new',
      resources: { cpuMilli: 1_000, memoryMb: 2_048, diskMb: 2_048 },
    });
    expect(pipelines.stepsFor).toHaveBeenCalledWith('deploy');
    expect(jobs.create).toHaveBeenCalledWith({
      kind: 'deploy',
      instanceId: 'inst-new',
      requestedBy: 'alice',
      payload: { action: 'deploy', entryKey: 'D01-01', profileKey: 'prod', revision: 'r2' },
      steps: ['prepare', 'apply'],
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.deploy.requested',
        targetId: 'inst-new',
        detail: expect.objectContaining({ entryKey: 'D01-01', slug: 'crm', jobId: 'job-1' }),
      }),
    );
  });

  it('omits the profile and revision it was not given', async () => {
    const { renderer, jobs, service } = setup();

    await service.deploy(deployInput());

    expect(renderer.plan).toHaveBeenCalledWith({ entryKey: 'D01-01', overrides: {} });
    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { action: 'deploy', entryKey: 'D01-01', profileKey: 'default' },
      }),
    );
  });

  it('writes only the values the renderer can apply, skipping masked, unset and vendored ones', async () => {
    const { renderer, service } = setup([NO_DERIVATION_ENTRY]);
    renderer.plan.mockResolvedValue(
      plan({
        values: [
          { name: 'MASKED', value: null, masked: true, overrideCeiling: 'instance' },
          { name: 'NOT_SET', value: null, masked: false, overrideCeiling: 'instance' },
          { name: 'VENDORED', value: 'x', masked: false, overrideCeiling: 'none' },
          { name: 'KEPT', value: 'kept', masked: false, overrideCeiling: 'instance' },
        ],
      }),
    );

    await service.deploy(deployInput({ entryKey: 'X9', slug: 'other' }));

    const [, applied] = renderer.updateInstanceEnv.mock.calls[0] ?? [];
    expect(applied).toEqual({ KEPT: 'kept' });
  });

  it('skips the environment write when nothing resolves for the entry', async () => {
    const { renderer, service } = setup([NO_DERIVATION_ENTRY]);
    renderer.plan.mockResolvedValue(plan());

    await service.deploy(deployInput({ entryKey: 'X9', slug: 'other' }));

    // D1 derives two values; an entry without a derivation and without overrides has nothing to say.
    expect(renderer.updateInstanceEnv).not.toHaveBeenCalled();
  });

  it('refuses less memory than the entry declares, before creating anything', async () => {
    const { db, capacity, service } = setup();

    await expect(
      service.deploy(deployInput({ resources: { cpu: 1, memoryMb: 512, diskMb: 2_048 } })),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: 'D01-01 is declared with 2048 MB of memory; 512 MB was requested.',
      fieldErrors: [expect.objectContaining({ field: 'resources.memoryMb' })],
    });
    expect(capacity.admit).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO instance'))).toBe(false);
  });

  it.each([
    ['the caller asked for the declared amount', { cpu: 1, memoryMb: 2_048, diskMb: 2_048 }],
    ['the caller asked for more', { cpu: 1, memoryMb: 4_096, diskMb: 2_048 }],
  ])('admits the request when %s', async (_label, resources) => {
    const { service } = setup();

    await expect(service.deploy(deployInput({ resources }))).resolves.toMatchObject({
      instanceId: 'inst-new',
    });
  });

  it('admits a request below no declared minimum, because none is declared', async () => {
    const { service } = setup([
      ['FROM catalog_entry WHERE key', [{ key: 'X9', packaging: 'compose', payload: {} }]],
    ]);

    await expect(
      service.deploy(
        deployInput({ entryKey: 'X9', resources: { cpu: 1, memoryMb: 64, diskMb: 512 } }),
      ),
    ).resolves.toMatchObject({ instanceId: 'inst-new' });
  });

  it('refuses a deployment the host cannot admit', async () => {
    const { capacity, db, service } = setup();
    capacity.admit.mockResolvedValue(
      decision({ admissible: false, headline: 'no room', detail: 'need 2 vCPU' }),
    );

    await expect(service.deploy(deployInput())).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
      detail: 'no room',
      remediation: expect.stringContaining('need 2 vCPU'),
    });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO instance'))).toBe(false);
  });

  it('refuses overrides the renderer rejects, instead of leaving a row that can never deploy', async () => {
    const { renderer, db, service } = setup();
    renderer.plan.mockResolvedValue(
      plan({
        fieldErrors: [{ field: 'A', code: 'above_ceiling', message: 'not overridable' }],
      }),
    );

    await expect(service.deploy(deployInput({ envOverrides: { A: 'x' } }))).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      fieldErrors: [{ field: 'A', code: 'above_ceiling', message: 'not overridable' }],
    });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO instance'))).toBe(false);
  });

  it('answers 404 for an entry that is not in the catalog', async () => {
    const { service } = setup([['FROM catalog_entry WHERE key', []]]);

    await expect(service.deploy(deployInput())).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No catalog entry D01-01.',
    });
  });

  it('refuses a slug a live deployment owns', async () => {
    const { service } = setup([
      [
        'SELECT entry_key, state, domain_route',
        [
          {
            entry_key: 'D01-01',
            state: 'ready',
            domain_route: 'crm.seamnex.local',
            deleted_at: null,
            reserved_until: null,
          },
        ],
      ],
    ]);

    await expect(service.deploy(deployInput())).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
      detail: 'The slug "crm" is already published by D01-01 (ready) at crm.seamnex.local.',
      fieldErrors: [{ field: 'slug', code: 'taken', message: 'Choose another route slug.' }],
      remediation: expect.stringContaining('A live deployment owns this route'),
    });
  });

  it('explains a slug held by a deletion, with the date it lapses', async () => {
    const { service } = setup([
      [
        'SELECT entry_key, state, domain_route',
        [
          {
            entry_key: 'D01-01',
            state: 'deleted',
            domain_route: 'crm.seamnex.local',
            deleted_at: new Date('2026-01-05T10:00:00Z'),
            reserved_until: new Date('2026-02-04T10:00:00Z'),
          },
        ],
      ],
    ]);

    await expect(service.deploy(deployInput())).rejects.toMatchObject({
      detail:
        'The slug "crm" is reserved until 04 Feb 2026: a deployment was deleted on 05 Jan 2026, and a slug stays reserved for 30 days after deletion.',
      remediation: expect.stringContaining('held by a deletion'),
    });
  });

  it('names an unknown reservation date rather than printing an empty one', async () => {
    const { service } = setup([
      [
        'SELECT entry_key, state, domain_route',
        [
          {
            entry_key: 'D01-01',
            state: 'deleted',
            domain_route: 'crm.seamnex.local',
            deleted_at: new Date('2026-01-05T10:00:00Z'),
            reserved_until: null,
          },
        ],
      ],
    ]);

    await expect(service.deploy(deployInput())).rejects.toMatchObject({
      detail: expect.stringContaining('reserved until an unknown date'),
    });
  });

  it('refuses when the insert returns no row', async () => {
    const { capacity, db, service } = setup([['INSERT INTO instance (entry_key', []]]);

    await expect(service.deploy(deployInput())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'The instance row was not created.',
    });
    // There is no row to compensate: the insert itself failed, so nothing was reserved either.
    expect(capacity.reserve).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql.includes('DELETE FROM instance WHERE id'))).toBe(false);
  });

  it('rolls the row back when no pipeline is registered for the kind', async () => {
    const { pipelines, capacity, db, service } = setup();
    pipelines.stepsFor.mockReturnValue([]);

    await expect(service.deploy(deployInput())).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'Job kind "deploy" has no registered pipeline.',
    });
    expect(capacity.release).toHaveBeenCalledWith('inst-new');
    expect(db.calls.some((call) => call.sql.includes('DELETE FROM instance WHERE id'))).toBe(true);
  });

  it('rolls the row back when the audit chain refuses, and rethrows that failure', async () => {
    const { audit, capacity, service } = setup();
    audit.append.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.deploy(deployInput())).rejects.toThrow('audit unavailable');
    expect(capacity.release).toHaveBeenCalledWith('inst-new');
  });

  it('reports the original failure even when the rollback itself fails', async () => {
    const { audit, db, service } = setup([
      ['DELETE FROM instance WHERE id', () => Promise.reject(new Error('delete refused'))],
    ]);
    audit.append.mockRejectedValue(new Error('audit unavailable'));

    // The caller must see the reason the deploy failed, not the reason the cleanup did.
    await expect(service.deploy(deployInput())).rejects.toThrow('audit unavailable');
    expect(db.calls.some((call) => call.sql.includes('DELETE FROM instance WHERE id'))).toBe(true);
  });

  it('reports a rollback failure that is not an Error', async () => {
    const { audit, service } = setup([
      ['DELETE FROM instance WHERE id', () => Promise.reject('driver gone')],
    ]);
    audit.append.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.deploy(deployInput())).rejects.toThrow('audit unavailable');
  });

  it('does not warn about a rollback that removed nothing', async () => {
    const { audit, service } = setup([
      ['DELETE FROM instance WHERE id', { rows: [], rowCount: 0 }],
    ]);
    audit.append.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.deploy(deployInput())).rejects.toThrow('audit unavailable');
  });

  it('survives a driver that reports no row count for the rollback', async () => {
    const { audit, service } = setup([
      ['DELETE FROM instance WHERE id', { rows: [], rowCount: null }],
    ]);
    audit.append.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.deploy(deployInput())).rejects.toThrow('audit unavailable');
  });

  it('projects the instance payload from the catalog document, falling back field by field', async () => {
    const { db, service } = setup([
      [
        'FROM catalog_entry WHERE key',
        [
          {
            key: 'D01-01',
            packaging: 'compose',
            payload: {
              product: 7,
              description: 'CRM',
              domain: 'sales',
              imageRef: 'repo/crm:1.2',
              imageDigest: 'sha256:abc',
              httpPort: 8080,
              guaranteeClass: 'fa_header',
              licenseId: 'AGPL',
              owner: { id: 'u1', name: 'Team CRM' },
            },
          },
        ],
      ],
    ]);

    await service.deploy(deployInput());

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO instance (entry_key'));
    // The payload is the last value: the columns before it are positional identity and must not
    // make this assertion depend on their number.
    const payload = JSON.parse(String(insert?.params.at(-1))) as Record<string, unknown>;
    expect(payload).toEqual({
      product: 'D01-01',
      description: 'CRM',
      domain: 'sales',
      imageRef: 'repo/crm:1.2',
      imageDigest: 'sha256:abc',
      httpPort: 8080,
      resources: { cpu: 1, memoryMb: 1_024, diskMb: 2_048 },
      route: {
        host: 'crm.seamnex.local',
        pathPrefix: null,
        publishModel: 'subdomain',
        tlsMode: 'acme',
        authMode: 'fa_header',
      },
      owner: { id: 'u1', name: 'Team CRM' },
      licenseId: 'AGPL',
    });
  });

  it('defaults every payload field for an entry that declares none', async () => {
    const { db, service } = setup([
      ['FROM catalog_entry WHERE key', [{ key: 'X9', packaging: 'compose', payload: {} }]],
    ]);

    await service.deploy(deployInput({ entryKey: 'X9', slug: 'other' }));

    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO instance (entry_key'));
    // The payload is the last value: the columns before it are positional identity and must not
    // make this assertion depend on their number.
    const payload = JSON.parse(String(insert?.params.at(-1))) as Record<string, unknown>;
    expect(payload).toMatchObject({
      product: 'X9',
      description: '',
      domain: '',
      imageRef: '',
      imageDigest: '',
      httpPort: 80,
      owner: { id: 'alice', name: 'alice' },
      licenseId: 'unreviewed',
      route: expect.objectContaining({ authMode: 'native' }),
    });
  });

  it('uses the requested resources over the declared ones, rounding CPU to milli-cores', async () => {
    const { db, capacity, service } = setup();

    await service.deploy(deployInput({ resources: { cpu: 1.5, memoryMb: 3_072, diskMb: 4_096 } }));

    expect(capacity.admit).toHaveBeenCalledWith({
      resources: { cpuMilli: 1_500, memoryMb: 3_072, diskMb: 4_096 },
    });
    const insert = db.calls.find((call) => call.sql.includes('INSERT INTO instance (entry_key'));
    // The payload is the last value: the columns before it are positional identity and must not
    // make this assertion depend on their number.
    const payload = JSON.parse(String(insert?.params.at(-1))) as Record<string, unknown>;
    expect(payload.resources).toEqual({ cpu: 1.5, memoryMb: 3_072, diskMb: 4_096 });
  });
});

describe('lifecycle', () => {
  it('creates the job for the action and audits the request', async () => {
    const { audit, jobs, pipelines, service } = setup();

    const result = await service.lifecycle({
      instanceId: 'inst-1',
      action: 'stop',
      actorId: 'alice',
      justification: 'maintenance',
    } as never);

    expect(result).toEqual({ jobId: 'job-1', kind: 'stop' });
    expect(pipelines.stepsFor).toHaveBeenCalledWith('stop');
    expect(jobs.create).toHaveBeenCalledWith({
      kind: 'stop',
      instanceId: 'inst-1',
      requestedBy: 'alice',
      payload: { action: 'stop', justification: 'maintenance' },
      steps: ['prepare', 'apply'],
    });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.stop.requested',
        detail: { jobId: 'job-1', dataRetention: null },
      }),
    );
  });

  it('carries the backup, the retention and the rollback target into the job payload', async () => {
    const { jobs, service } = setup();

    await service.lifecycle({
      instanceId: 'inst-1',
      action: 'upgrade',
      actorId: 'alice',
      backupJobId: 'job-backup',
      dataRetention: 'export',
      renderSetId: 'rs-9',
    } as never);

    expect(jobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          action: 'upgrade',
          dataRetention: 'export',
          backupJobId: 'job-backup',
          renderSetId: 'rs-9',
        },
      }),
    );
  });

  it('refuses an action the domain does not define', async () => {
    const { jobs, service } = setup();

    await expect(
      service.lifecycle({ instanceId: 'inst-1', action: 'explode', actorId: 'alice' } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'Unknown lifecycle action "explode".',
      remediation: expect.stringContaining('start, stop, restart'),
    });
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('answers 404 for an instance that is gone', async () => {
    const { service } = setup([['SELECT id, slug, state FROM instance', []]]);

    await expect(
      service.lifecycle({ instanceId: 'inst-1', action: 'stop', actorId: 'alice' } as never),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', detail: 'No instance inst-1.' });
  });

  it('refuses an upgrade that was not preceded by a backup', async () => {
    const { jobs, service } = setup();

    await expect(
      service.lifecycle({ instanceId: 'inst-1', action: 'upgrade', actorId: 'alice' } as never),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: 'An upgrade must be preceded by a backup; no backup job was supplied.',
    });
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('refuses a delete that does not say what happens to the data', async () => {
    const { jobs, service } = setup();

    await expect(
      service.lifecycle({ instanceId: 'inst-1', action: 'delete', actorId: 'alice' } as never),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'A delete must state what happens to the data.',
    });
    expect(jobs.create).not.toHaveBeenCalled();
  });

  it('accepts a delete that states its retention', async () => {
    const { audit, service } = setup();

    await expect(
      service.lifecycle({
        instanceId: 'inst-1',
        action: 'delete',
        actorId: 'alice',
        dataRetention: 'delete',
      } as never),
    ).resolves.toEqual({ jobId: 'job-1', kind: 'delete' });
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { jobId: 'job-1', dataRetention: 'delete' } }),
    );
  });

  it('refuses when the kind has no registered pipeline', async () => {
    const { pipelines, service } = setup();
    pipelines.stepsFor.mockReturnValue([]);

    await expect(
      service.lifecycle({ instanceId: 'inst-1', action: 'start', actorId: 'alice' } as never),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: 'Job kind "start" has no registered pipeline.',
    });
  });
});

describe('preview', () => {
  it('reports the admission verdict, the route and no warnings for a deployable entry', async () => {
    const { renderer, capacity, service } = setup();

    const result = await service.preview({ entryKey: 'D01-01', slug: 'crm' } as never);

    expect(result).toMatchObject({
      admissible: true,
      headline: 'fits on this host',
      detail: '12 vCPU free',
      capacitySource: 'measured',
      routeHost: 'crm.seamnex.local',
      slugAvailable: true,
      policyVerdict: 'allowed',
      warnings: [],
    });
    expect(capacity.admit).toHaveBeenCalledWith({
      resources: { cpuMilli: 1_000, memoryMb: 2_048, diskMb: 2_048 },
    });
    expect(renderer.plan).not.toHaveBeenCalled();
    expect(typeof result.evaluatedAt).toBe('string');
  });

  it('makes the slug conflict the headline and the warning when the route is taken', async () => {
    const { service } = setup([
      [
        'SELECT entry_key, state, domain_route',
        [
          {
            entry_key: 'D01-01',
            state: 'ready',
            domain_route: 'crm.seamnex.local',
            deleted_at: null,
            reserved_until: null,
          },
        ],
      ],
    ]);

    const result = await service.preview({ entryKey: 'D01-01', slug: 'crm' } as never);

    expect(result.admissible).toBe(false);
    expect(result.slugAvailable).toBe(false);
    // The capacity verdict stays in `detail`; the refusal the operator reads is the route's.
    expect(result.headline).toContain('already published by D01-01');
    expect(result.warnings).toEqual([expect.stringContaining('A live deployment owns this route')]);
  });

  it('warns about a missing definition when the entry has no scaffold either', async () => {
    const { service } = setup([
      ['FROM catalog_entry WHERE key', [{ key: 'X9', packaging: 'none', payload: {} }]],
      ['scaffold_artefact', [{ present: false }]],
    ]);

    const result = await service.preview({ entryKey: 'X9', slug: 'other' } as never);

    expect(result.warnings).toEqual([expect.stringContaining('no Compose file or Dockerfile')]);
  });

  it('stays quiet when the scaffold was approved', async () => {
    const { service } = setup([
      ['FROM catalog_entry WHERE key', [{ key: 'X9', packaging: 'none', payload: {} }]],
      ['scaffold_artefact', [{ present: true }]],
    ]);

    const result = await service.preview({ entryKey: 'X9', slug: 'other' } as never);

    expect(result.warnings).toEqual([]);
  });

  it('treats a scaffold query that returns no row as unapproved', async () => {
    const { service } = setup([
      ['FROM catalog_entry WHERE key', [{ key: 'X9', packaging: 'none', payload: {} }]],
      ['scaffold_artefact', []],
    ]);

    const result = await service.preview({ entryKey: 'X9', slug: 'other' } as never);

    expect(result.warnings).toHaveLength(1);
  });

  it('answers 404 for an entry that is not in the catalog', async () => {
    const { service } = setup([['FROM catalog_entry WHERE key', []]]);

    await expect(
      service.preview({ entryKey: 'D01-01', slug: 'crm' } as never),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('prefetch', () => {
  it('creates a platform-level prepull job', async () => {
    const { jobs, service } = setup();

    await expect(service.prefetch('D01-01', 'alice')).resolves.toEqual({ jobId: 'job-1' });
    // No instance is involved, so the job carries no instance id at all.
    expect(jobs.create).toHaveBeenCalledWith({
      kind: 'prepull',
      requestedBy: 'alice',
      payload: { entryKey: 'D01-01' },
      steps: ['prepare', 'apply'],
    });
  });

  it('refuses to pre-pull an entry that does not exist', async () => {
    const { jobs, service } = setup([['FROM catalog_entry WHERE key', []]]);

    await expect(service.prefetch('D01-01', 'alice')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(jobs.create).not.toHaveBeenCalled();
  });
});

describe('abandonDeployment', () => {
  it('removes a requested instance and records why', async () => {
    const { db, audit, capacity, service } = setup();

    await service.abandonDeployment('inst-new', 'alice', 'definition never committed');

    expect(capacity.release).toHaveBeenCalledWith('inst-new');
    const remove = db.calls.find((call) => call.sql.includes('DELETE FROM instance WHERE id'));
    // Restricted to `requested`: a row something else advanced is never dropped.
    expect(remove?.sql).toContain("state = 'requested'");
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.deploy.abandoned',
        actorId: 'alice',
        outcome: 'failure',
        detail: { reason: 'definition never committed' },
      }),
    );
  });

  it('swallows an audit failure: the compensation already happened', async () => {
    const { audit, service } = setup();
    audit.append.mockRejectedValue(new Error('audit unavailable'));

    await expect(service.abandonDeployment('inst-new', 'alice', 'reason')).resolves.toBeUndefined();
  });

  it('swallows an audit failure that is not an Error', async () => {
    const { audit, service } = setup();
    audit.append.mockRejectedValue('audit unavailable');

    await expect(service.abandonDeployment('inst-new', 'alice', 'reason')).resolves.toBeUndefined();
  });
});

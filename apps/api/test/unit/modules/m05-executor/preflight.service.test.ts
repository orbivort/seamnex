import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { PreflightService } from '../../../../src/modules/m05-executor/preflight.service';

/**
 * FR-1.11 / FR-1.23 / AC-07 — the pre-flight that can refuse.
 *
 * Before this service existed the preview answered capacity, slug and scaffold and then hard-coded
 * `policyVerdict: 'allowed'`; the pin, the variables, the secrets and the policy were only discovered
 * inside the job, after an instance row existed. Every check below is asserted for two properties:
 * the blocker names the fact that failed, and it names the field or the step that can fix it.
 */

const ENTRY = {
  key: 'D01-01',
  packaging: 'compose',
  payload: {
    imageRef: 'registry.example.test/espocrm:9.2.1',
    repoUrl: 'https://git.example.test/espocrm.git',
    resources: { cpu: 1, memoryMb: 2_048, diskMb: 2_048 },
  },
};

function entryRoute(overrides: Record<string, unknown> = {}): Route {
  return ['SELECT key, packaging, payload FROM catalog_entry', [{ ...ENTRY, ...overrides }]];
}

const DEFAULTS: readonly Route[] = [
  entryRoute(),
  ['SELECT repo_url FROM catalog_entry', [{ repo_url: '' }]],
  ['SELECT entry_key, state, domain_route', []],
  ['scaffold_artefact', [{ present: false }]],
];

function policy(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'allowed',
    violations: [],
    evaluatedAt: '2026-02-01T10:00:00.000Z',
    source: 'local_evaluation',
    reason: null,
    ...overrides,
  };
}

function setup(
  routes: readonly Route[] = [],
  options: { plan?: unknown; secrets?: unknown; policy?: unknown } = {},
) {
  const db = fakeDb([...routes, ...DEFAULTS]);
  const renderer = {
    plan: vi.fn(async () => options.plan ?? plan()),
    unresolvedSecrets: vi.fn(async () => options.secrets ?? []),
  };
  const capacity = {
    admit: vi.fn(async () => decision()),
  };
  const sources = {
    previewPolicy: vi.fn(async () => options.policy ?? policy()),
  };
  const config = {
    SEAMNEX_INGRESS_DOMAIN: 'seamnex.local',
  } as unknown as AppConfig;
  const service = new PreflightService(
    db.pool,
    config,
    renderer as never,
    capacity as never,
    sources as never,
  );
  return { db, renderer, capacity, sources, service };
}

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

function input(overrides: Record<string, unknown> = {}) {
  return { entryKey: 'D01-01', slug: 'crm', ...overrides } as never;
}

/** The blockers with a given code, in the order the service produced them. */
function blockersOf(
  result: {
    blockers: readonly {
      code: string;
      field: string | null;
      message: string;
      blocking: boolean;
    }[];
  },
  code: string,
) {
  return result.blockers.filter((blocker) => blocker.code === code);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admission', () => {
  it('admits a fully checked request and reports the policy evidence', async () => {
    const { capacity, service } = setup();

    const result = await service.run(input());

    expect(result.admissible).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.headline).toBe('Ready to deploy');
    expect(result.policyVerdict).toBe('allowed');
    expect(result.policyEvaluatedAt).toBe('2026-02-01T10:00:00.000Z');
    expect(result.policySource).toBe('local_evaluation');
    expect(result.routeHost).toBe('crm.seamnex.local');
    expect(capacity.admit).toHaveBeenCalledWith({
      resources: { cpuMilli: 1_000, memoryMb: 2_048, diskMb: 2_048 },
    });
  });

  it('names the first blocker in the headline and detail, so a refused preview is readable', async () => {
    const { service } = setup([entryRoute({ payload: { ...ENTRY.payload, imageRef: 'crm' } })]);

    const result = await service.run(input());

    expect(result.admissible).toBe(false);
    expect(result.headline).toBe('1 blocker must be fixed first');
    expect(result.detail).toContain('floating reference');
  });

  it('counts the blockers rather than describing them in the plural for one', async () => {
    const { service } = setup([
      entryRoute({ payload: { ...ENTRY.payload, imageRef: 'crm', repoUrl: '' } }),
    ]);

    const result = await service.run(input());

    expect(result.headline).toBe('2 blockers must be fixed first');
  });

  it('stops at an unknown entry: nothing else can be checked', async () => {
    const { capacity, renderer, service } = setup([
      ['SELECT key, packaging, payload FROM catalog_entry', []],
    ]);

    const result = await service.run(input());

    expect(result.admissible).toBe(false);
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'unknown_entry', field: 'entryKey', blocking: true }),
    ]);
    expect(result.capacitySource).toBe('unknown');
    expect(result.policyVerdict).toBe('unknown');
    expect(result.policySource).toBe('none');
    expect(capacity.admit).not.toHaveBeenCalled();
    expect(renderer.plan).not.toHaveBeenCalled();
  });
});

describe('pinned images', () => {
  it('refuses a floating tag', async () => {
    const { service } = setup([
      entryRoute({ payload: { ...ENTRY.payload, imageRef: 'espocrm:latest' } }),
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'image_unpinned')).toEqual([
      expect.objectContaining({ field: 'entryKey', blocking: true }),
    ]);
    expect(result.admissible).toBe(false);
  });

  it('accepts a digest-pinned image', async () => {
    const digest = `registry.example.test/espocrm@sha256:${'a'.repeat(64)}`;
    const { service } = setup([entryRoute({ payload: { ...ENTRY.payload, imageRef: digest } })]);

    const result = await service.run(input());

    expect(blockersOf(result, 'image_unpinned')).toEqual([]);
    expect(result.admissible).toBe(true);
  });

  it('refuses a digest that is not a sha256 digest', async () => {
    const { service } = setup([
      entryRoute({ payload: { ...ENTRY.payload, imageDigest: 'sha256:short' } }),
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'image_unpinned')).toEqual([
      expect.objectContaining({ message: expect.stringContaining('not a sha256 digest') }),
    ]);
  });

  it('does not ask for a pinned image when the entry is a scaffold', async () => {
    const { service } = setup([
      entryRoute({ packaging: 'none', payload: { ...ENTRY.payload, imageRef: 'crm' } }),
      ['scaffold_artefact', [{ present: true }]],
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'image_unpinned')).toEqual([]);
  });
});

describe('deployment source', () => {
  it('refuses an entry that declares packaging but no repository', async () => {
    const { service } = setup([
      entryRoute({ payload: { ...ENTRY.payload, repoUrl: '' } }),
      ['SELECT repo_url FROM catalog_entry', [{ repo_url: '' }]],
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'source_unresolved')).toEqual([
      expect.objectContaining({ field: 'entryKey', blocking: true }),
    ]);
  });

  it('accepts a repository URL recorded on the entry row rather than the payload', async () => {
    const { service } = setup([
      entryRoute({ payload: { ...ENTRY.payload, repoUrl: '' } }),
      ['SELECT repo_url FROM catalog_entry', [{ repo_url: 'https://git.example.test/x.git' }]],
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'source_unresolved')).toEqual([]);
  });

  it('refuses a scaffold entry whose scaffold was never approved', async () => {
    const { service } = setup([
      entryRoute({ packaging: 'none', payload: {} }),
      ['scaffold_artefact', [{ present: false }]],
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'scaffold_unapproved')).toEqual([
      expect.objectContaining({ blocking: true }),
    ]);
    expect(result.admissible).toBe(false);
  });

  it('treats a scaffold query that returns no row as unapproved', async () => {
    const { service } = setup([
      entryRoute({ packaging: 'none', payload: {} }),
      ['scaffold_artefact', []],
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'scaffold_unapproved')).toHaveLength(1);
  });

  it('stays quiet when the scaffold was approved', async () => {
    const { service } = setup([
      entryRoute({ packaging: 'none', payload: {} }),
      ['scaffold_artefact', [{ present: true }]],
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'scaffold_unapproved')).toEqual([]);
    expect(result.admissible).toBe(true);
  });
});

describe('variables and secrets', () => {
  it('turns every field error from the same resolution the deploy uses into a blocker', async () => {
    const { renderer, service } = setup([], {
      plan: plan({
        fieldErrors: [
          { field: 'A', code: 'required', message: 'A is required.' },
          { field: 'B', code: 'above_ceiling', message: 'B is not overridable.' },
        ],
      }),
    });

    const result = await service.run(input({ profileKey: 'prod', envOverrides: { A: '1' } }));

    expect(renderer.plan).toHaveBeenCalledWith({
      entryKey: 'D01-01',
      profileKey: 'prod',
      overrides: { A: '1' },
    });
    expect(blockersOf(result, 'env_invalid')).toEqual([
      expect.objectContaining({ field: 'A', message: 'A is required.', blocking: true }),
      expect.objectContaining({ field: 'B', blocking: true }),
    ]);
    expect(result.admissible).toBe(false);
  });

  it('anchors an unknown profile on the profile field', async () => {
    const { renderer, service } = setup();
    renderer.plan.mockRejectedValue(new Error('No environment profile "nope".'));

    const result = await service.run(input({ profileKey: 'nope' }));

    expect(blockersOf(result, 'env_invalid')).toEqual([
      expect.objectContaining({ field: 'profileKey', message: 'No environment profile "nope".' }),
    ]);
  });

  it('reports every secret reference that no longer resolves, against its variable', async () => {
    const { service } = setup([], {
      secrets: [
        { varName: 'DB_PASSWORD', secretName: 'prod/db', reason: 'the secret was deleted' },
      ],
    });

    const result = await service.run(input({ profileKey: 'prod' }));

    expect(blockersOf(result, 'secret_unresolved')).toEqual([
      expect.objectContaining({
        field: 'DB_PASSWORD',
        message: 'DB_PASSWORD: the secret was deleted',
        blocking: true,
      }),
    ]);
  });

  it('reports a secret lookup that fails outright instead of admitting the deployment', async () => {
    const { renderer, service } = setup();
    renderer.unresolvedSecrets.mockRejectedValue(new Error('secret store unreachable'));

    const result = await service.run(input());

    expect(blockersOf(result, 'secret_unresolved')).toEqual([
      expect.objectContaining({ field: 'profileKey', blocking: true }),
    ]);
    expect(result.admissible).toBe(false);
  });
});

describe('capacity and routes', () => {
  it('refuses when the host has no room, carrying the shortfall', async () => {
    const { capacity, service } = setup();
    capacity.admit.mockResolvedValue(
      decision({
        admissible: false,
        headline: 'no room',
        detail: 'need 2 vCPU',
        shortfall: { cpuMilli: 2_000, memoryMb: 0, diskMb: 0 },
      }),
    );

    const result = await service.run(input());

    expect(blockersOf(result, 'capacity')).toEqual([
      expect.objectContaining({ field: 'resources', message: 'no room need 2 vCPU' }),
    ]);
    expect(result.shortfall).toEqual({ cpuMilli: 2_000, memoryMb: 0, diskMb: 0 });
    expect(result.admissible).toBe(false);
  });

  it('refuses declared volume quotas larger than the disk reservation', async () => {
    const { service } = setup([
      entryRoute({
        key: 'V1',
        payload: {
          ...ENTRY.payload,
          volumes: [
            { name: 'a', mountPath: '/a', quotaMb: 1_024 },
            { name: 'b', mountPath: '/b', quotaMb: 2_048 },
          ],
        },
      }),
    ]);

    const result = await service.run(input({ entryKey: 'V1' }));

    expect(blockersOf(result, 'capacity')).toEqual([
      expect.objectContaining({
        field: 'resources',
        message: expect.stringContaining('3072 MB'),
      }),
    ]);
  });

  it('makes a live route a blocker and explains the two causes differently', async () => {
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

    const result = await service.run(input());

    expect(result.slugAvailable).toBe(false);
    expect(blockersOf(result, 'route_conflict')).toEqual([
      expect.objectContaining({
        field: 'slug',
        message: expect.stringContaining('already published by D01-01'),
      }),
    ]);
    expect(result.warnings).toEqual([expect.stringContaining('A live deployment owns this route')]);
  });

  it('names the date a slug held by a deletion lapses', async () => {
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

    const result = await service.run(input());

    expect(blockersOf(result, 'route_conflict')[0]?.message).toContain('reserved until 2026-02-04');
    expect(result.warnings).toEqual([expect.stringContaining('held by a deletion')]);
  });
});

describe('policy verdict', () => {
  it('is never assumed: a blocked policy is a blocker naming the rules', async () => {
    const { sources, service } = setup();
    sources.previewPolicy.mockResolvedValue(
      policy({
        verdict: 'blocked',
        violations: [
          { rule: 'privileged', service: 'crm' },
          { rule: 'privileged', service: 'worker' },
          { rule: 'host-network', service: 'crm' },
        ],
      }),
    );

    const result = await service.run(input());

    expect(result.policyVerdict).toBe('blocked');
    expect(blockersOf(result, 'policy_blocked')).toEqual([
      expect.objectContaining({
        field: 'entryKey',
        message: 'The source policy would block this deployment: privileged, host-network.',
      }),
    ]);
    expect(result.admissible).toBe(false);
  });

  it('reports an un-evaluable policy as advisory, not as permission', async () => {
    const { sources, service } = setup();
    sources.previewPolicy.mockResolvedValue(
      policy({
        verdict: 'unknown',
        evaluatedAt: null,
        source: 'none',
        reason: 'Nothing is vendored for D01-01; the source is fetched at deployment time.',
      }),
    );

    const result = await service.run(input());

    expect(result.policyVerdict).toBe('unknown');
    expect(result.policyEvaluatedAt).toBeNull();
    expect(result.blockers).toEqual([
      expect.objectContaining({
        code: 'policy_unknown',
        field: null,
        blocking: false,
        message: expect.stringContaining('Nothing is vendored'),
      }),
    ]);
    // The job evaluates the policy before applying anything, so the normal fetched-source path is
    // still deployable; what it must not be is silently "allowed".
    expect(result.admissible).toBe(true);
  });

  it('never reports a policy that could not be read as allowed', async () => {
    const { sources, service } = setup();
    sources.previewPolicy.mockRejectedValue(new Error('catalogue is not mounted'));

    const result = await service.run(input());

    expect(result.policyVerdict).toBe('unknown');
    expect(result.policySource).toBe('none');
    expect(result.blockers).toEqual([
      expect.objectContaining({ code: 'policy_unknown', blocking: false }),
    ]);
    expect(result.admissible).toBe(true);
  });

  it('reports a policy that passes with waivers as its own verdict', async () => {
    const { sources, service } = setup();
    sources.previewPolicy.mockResolvedValue(policy({ verdict: 'unsafe_approved' }));

    const result = await service.run(input());

    expect(result.policyVerdict).toBe('unsafe_approved');
    expect(result.admissible).toBe(true);
  });
});

describe('resources', () => {
  it('checks the resources the wizard asked for, not only the declared ones', async () => {
    const { capacity, service } = setup();

    await service.run(input({ resources: { cpu: 1.5, memoryMb: 3_072, diskMb: 4_096 } }));

    expect(capacity.admit).toHaveBeenCalledWith({
      resources: { cpuMilli: 1_500, memoryMb: 3_072, diskMb: 4_096 },
    });
  });

  it('falls back to the declared shape for an entry that declares nothing', async () => {
    const { capacity, service } = setup([entryRoute({ key: 'X9', payload: {} })]);

    await service.run(input({ entryKey: 'X9' }));

    expect(capacity.admit).toHaveBeenCalledWith({
      resources: { cpuMilli: 1_000, memoryMb: 1_024, diskMb: 2_048 },
    });
  });

  it('does not count volume rows that are not a named quota', async () => {
    const { service } = setup([
      entryRoute({
        payload: {
          ...ENTRY.payload,
          volumes: [
            null,
            'data',
            { name: '' },
            { name: 'logs', quotaMb: 0 },
            { name: 'data', quotaMb: 4_096 },
          ],
        },
      }),
    ]);

    const result = await service.run(input());

    // Only the well-formed row counts; the malformed ones would otherwise inflate the shortfall.
    expect(blockersOf(result, 'capacity').map((blocker) => blocker.message)).toEqual([
      expect.stringContaining('Volume quotas total 4096 MB'),
    ]);
    expect(result.admissible).toBe(false);
  });
});

describe('readable refusals', () => {
  it('treats a catalogue row with no repository URL as no source at all', async () => {
    const { service } = setup([
      entryRoute({ payload: { imageRef: ENTRY.payload.imageRef } }),
      ['SELECT repo_url FROM catalog_entry', [{}]],
    ]);

    const result = await service.run(input());

    expect(blockersOf(result, 'source_unresolved')).toHaveLength(1);
  });

  it('names the reservation instead of a date it does not have', async () => {
    const { service } = setup([
      [
        'SELECT entry_key, state, domain_route',
        [
          {
            entry_key: 'D01-02',
            state: 'deleted',
            domain_route: 'crm.seamnex.local',
            deleted_at: new Date('2026-01-01T00:00:00.000Z'),
            reserved_until: null,
          },
        ],
      ],
    ]);

    const result = await service.run(input());

    expect(result.slugAvailable).toBe(false);
    expect(result.detail).toContain('the reservation lapses');
  });

  it('reports an unknown verdict as advisory even when the evaluator gave no reason', async () => {
    const { service } = setup([], { policy: policy({ verdict: 'unknown', reason: null }) });

    const result = await service.run(input());

    const blocker = blockersOf(result, 'policy_unknown')[0];
    expect(blocker?.blocking).toBe(false);
    expect(blocker?.message).toBe('The source policy could not be evaluated before admission.');
    // Advisory means admissible: the job still evaluates the policy before applying anything.
    expect(result.admissible).toBe(true);
  });

  it('turns a thrown non-Error into a blocker instead of losing the check', async () => {
    const { renderer, sources, service } = setup();
    renderer.plan.mockRejectedValue('plan exploded');
    renderer.unresolvedSecrets.mockRejectedValue('secret store exploded');
    sources.previewPolicy.mockRejectedValue('resolver exploded');

    const result = await service.run(input());

    expect(blockersOf(result, 'env_invalid')[0]?.message).toBe('plan exploded');
    expect(blockersOf(result, 'secret_unresolved')[0]?.message).toBe('secret store exploded');
    expect(blockersOf(result, 'policy_unknown')[0]?.message).toBe(
      'The source policy could not be evaluated: resolver exploded',
    );
  });
});

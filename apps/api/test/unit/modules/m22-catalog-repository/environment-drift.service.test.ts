import { describe, expect, it, vi } from 'vitest';
import type { EnvValue } from '@seamnex/domain';
import { fakeDb } from '../../../support/fakes';
import { PostgresEnvironmentDriftService } from '../../../../src/modules/m22-catalog-repository/environment-drift.service';

/**
 * FR-1.29 — the producer.
 *
 * The properties asserted here are the ones that decide whether the panel can be trusted: a real
 * comparison against the running container, a direction derived from evidence, one open row per
 * variable that heals, and "unobserved" instead of "clean" whenever the daemon cannot be asked.
 */
const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const CREATED = '2026-03-01T00:00:00.000Z';

const ROUTES: Parameters<typeof fakeDb>[0] = [
  ['FROM instance WHERE id', [{ id: INSTANCE_ID }]],
  ['FROM drift_record', []],
  ['INSERT INTO drift_record', []],
  ['UPDATE drift_record SET direction', []],
  ['UPDATE drift_record SET resolved_at', []],
];

function envValue(overrides: Partial<EnvValue> & { name: string }): EnvValue {
  return {
    purpose: overrides.name,
    type: 'string',
    secret: false,
    value: null,
    masked: false,
    source: 'default',
    overrideCeiling: 'profile_and_instance',
    appliedAt: CREATED,
    requiresRecreate: false,
    drift: false,
    ...overrides,
  };
}

type Fixture = {
  routes?: Parameters<typeof fakeDb>[0];
  declared?: EnvValue[];
  /** `platform.env` of the applied render set; null means no render set is recorded. */
  baseline?: string | null;
  containers?: { id: string; service: string }[];
  /** Container id → `Config.Env`; a thrown Error simulates an inspect that failed. */
  inspect?: Record<string, string[] | Error>;
  appliedThrows?: boolean;
  /** An instance that was never applied: no render set row to read. */
  noRenderSet?: boolean;
  /** A render set that exists but holds no `platform.env`. */
  withoutEnvFile?: boolean;
  /** Containers whose inspect carries no `Created`, which makes the secret direction undecidable. */
  createdMissing?: boolean;
  /** A `Created` stamp the daemon reported that no parser accepts. */
  createdAt?: string;
  /** A daemon that failed with a string rather than an `Error`, as a socket error can. */
  throwString?: boolean;
  /** A container whose inspect carries no `Config` at all. */
  configMissing?: boolean;
  containersThrow?: boolean;
  write?: () => Promise<{ path: string; contentHash: string }>;
};

function setup(fixture: Fixture = {}) {
  const db = fakeDb(fixture.routes ?? ROUTES);
  const containers = fixture.containers ?? [{ id: 'c1', service: 'app' }];
  const inspect = fixture.inspect ?? { c1: ['MAIL_HOST=smtp'] };

  const renderer = {
    instanceEnv: vi.fn(async () => fixture.declared ?? []),
    applied: vi.fn(async () => {
      if (fixture.appliedThrows === true) {
        throw fixture.throwString === true ? 'render set unreadable' : new Error('unreadable');
      }
      if (fixture.noRenderSet === true || fixture.baseline === null) return null;
      return {
        id: 'rs-1',
        instanceId: INSTANCE_ID,
        contentHash: 'h',
        directory: '/tmp',
        composeProject: 'seamnex-x',
        imageRefs: [],
        publishedPorts: 0,
        files:
          fixture.withoutEnvFile === true
            ? [{ path: 'compose.yaml', sha256: 'h', content: 'services: {}\n' }]
            : [{ path: 'platform.env', sha256: 'h', content: fixture.baseline ?? '' }],
      };
    }),
  };
  const docker = {
    containers: vi.fn(async () => {
      if (fixture.containersThrow === true) {
        throw fixture.throwString === true ? 'daemon unreachable' : new Error('unreachable');
      }
      return containers.map((container) => ({
        ...container,
        name: container.id,
        image: 'img',
        state: 'running',
        status: 'Up',
        labels: {},
      }));
    }),
    inspect: vi.fn(async (id: string) => {
      const env = inspect[id];
      if (env instanceof Error) throw env;
      if (fixture.configMissing === true) return {};
      if (fixture.createdMissing === true) return { Config: { Env: env ?? [] } };
      return { Config: { Env: env ?? [] }, Created: fixture.createdAt ?? CREATED };
    }),
  };
  const params = { write: vi.fn(fixture.write ?? (async () => ({ path: 'p', contentHash: 'c' }))) };

  const service = new PostgresEnvironmentDriftService(
    db.pool,
    renderer as never,
    docker as never,
    params as never,
  );
  return { db, renderer, docker, params, service };
}

function calls(db: ReturnType<typeof fakeDb>, fragment: string) {
  return db.calls.filter((call) => call.sql.includes(fragment));
}

describe('scan', () => {
  it('refuses a path parameter that cannot address a row', async () => {
    const { service } = setup();
    await expect(service.scan('not-a-uuid')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuses an instance that does not exist', async () => {
    const { service } = setup({ routes: [['FROM instance WHERE id', []]] });
    await expect(service.scan(INSTANCE_ID)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('records a declared value the container does not carry, as runtime ahead when it was applied', async () => {
    const { db, service } = setup({
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      baseline: 'MAIL_HOST=smtp\n',
      inspect: { c1: ['PATH=/usr/bin'] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.observed).toBe(true);
    expect(result.detected).toEqual([
      {
        instanceId: INSTANCE_ID,
        varName: 'MAIL_HOST',
        kind: 'missing',
        direction: 'runtime_ahead',
      },
    ]);
    expect(result.created).toEqual(['MAIL_HOST']);
    const insert = calls(db, 'INSERT INTO drift_record')[0];
    expect(insert?.params.slice(0, 2)).toEqual([INSTANCE_ID, 'runtime_ahead']);
    const detail = JSON.parse(String(insert?.params[2])) as Record<string, unknown>;
    expect(detail).toMatchObject({
      varName: 'MAIL_HOST',
      kind: 'missing',
      source: 'env-scan',
      declared: 'smtp',
      observed: null,
    });
  });

  it('records a value the container disagrees with, and names the declaration as ahead', async () => {
    const { db, service } = setup({
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp.example.test' })],
      baseline: 'MAIL_HOST=smtp\n',
      inspect: { c1: ['MAIL_HOST=smtp'] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([
      {
        instanceId: INSTANCE_ID,
        varName: 'MAIL_HOST',
        kind: 'mismatch',
        direction: 'repo_ahead',
      },
    ]);
    const detail = JSON.parse(
      String(calls(db, 'INSERT INTO drift_record')[0]?.params[2]),
    ) as Record<string, unknown>;
    expect(detail).toMatchObject({
      service: 'app',
      declared: 'smtp.example.test',
      observed: 'smtp',
    });
  });

  it('accepts agreement in any one service of a multi-container instance', async () => {
    const { db, service } = setup({
      declared: [envValue({ name: 'DB_HOST', value: 'db' })],
      baseline: 'DB_HOST=db\n',
      containers: [
        { id: 'c1', service: 'app' },
        { id: 'c2', service: 'db' },
      ],
      inspect: { c1: ['DB_HOST=db'], c2: ['DB_HOST=localhost'] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([]);
    expect(calls(db, 'INSERT INTO drift_record')).toHaveLength(0);
  });

  it('reports a variable the product namespace carries but the declaration does not', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'PAPERLESS_OCR_LANGUAGE', value: 'deu+eng' })],
      baseline: 'PAPERLESS_OCR_LANGUAGE=deu+eng\n',
      inspect: {
        c1: [
          'PAPERLESS_OCR_LANGUAGE=deu+eng',
          'PAPERLESS_ADMIN_USER=paperless-admin',
          'PATH=/usr/bin',
          'HOSTNAME=abc',
          'OTHER_SETTING=1',
        ],
      },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([
      {
        instanceId: INSTANCE_ID,
        varName: 'PAPERLESS_ADMIN_USER',
        kind: 'undeclared',
        direction: 'runtime_ahead',
      },
    ]);
  });

  it('reports a stale secret by presence only, never by value', async () => {
    const { db, service } = setup({
      declared: [
        envValue({
          name: 'DB_PASSWORD',
          secret: true,
          masked: true,
          source: 'secret',
          appliedAt: '2026-03-02T00:00:00.000Z',
        }),
      ],
      baseline: '',
      inspect: { c1: ['PATH=/usr/bin'] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([
      { instanceId: INSTANCE_ID, varName: 'DB_PASSWORD', kind: 'missing', direction: 'repo_ahead' },
    ]);
    const detail = JSON.parse(
      String(calls(db, 'INSERT INTO drift_record')[0]?.params[2]),
    ) as Record<string, unknown>;
    expect(detail).toMatchObject({ secret: true, declared: '<secret>', observed: null });
  });

  it('leaves a secret with no stored value undecided rather than repairable', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'API_TOKEN', secret: true, masked: true })],
      baseline: '',
      inspect: { c1: [] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([
      { instanceId: INSTANCE_ID, varName: 'API_TOKEN', kind: 'missing', direction: 'unknown' },
    ]);
  });

  it('treats an unreachable daemon as unobserved and writes nothing', async () => {
    const { db, service } = setup({
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      containersThrow: true,
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result).toEqual({ observed: false, detected: [], created: [], resolved: 0 });
    expect(calls(db, 'INSERT INTO drift_record')).toHaveLength(0);
    expect(calls(db, 'UPDATE drift_record')).toHaveLength(0);
  });

  it('treats an instance with no containers as unobserved', async () => {
    const { service } = setup({ containers: [] });
    await expect(service.scan(INSTANCE_ID)).resolves.toMatchObject({ observed: false });
  });

  it('treats every failed inspect as unobserved', async () => {
    const { service } = setup({ inspect: { c1: new Error('gone') } });
    await expect(service.scan(INSTANCE_ID)).resolves.toMatchObject({ observed: false });
  });

  it('never reports absence it could not prove when one container failed to inspect', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      baseline: 'MAIL_HOST=smtp\n',
      containers: [
        { id: 'c1', service: 'app' },
        { id: 'c2', service: 'worker' },
      ],
      inspect: { c1: [], c2: new Error('gone') },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.observed).toBe(true);
    expect(result.detected).toEqual([]);
  });

  it('reports an unknown direction when the applied render set cannot be read', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      appliedThrows: true,
      inspect: { c1: [] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected[0]?.direction).toBe('unknown');
  });

  it('refreshes an open row instead of inserting a second one', async () => {
    const { db, service } = setup({
      routes: [
        ['FROM instance WHERE id', [{ id: INSTANCE_ID }]],
        [
          'FROM drift_record',
          [
            { id: 'drift-1', var_name: 'MAIL_HOST' },
            // Two schedulers racing could have written the same variable twice; the spare is closed.
            { id: 'drift-4', var_name: 'MAIL_HOST' },
            // A row whose detail carries no variable name can still be closed by its id.
            { id: 'drift-3', var_name: null },
          ],
        ],
        ['INSERT INTO drift_record', []],
        ['UPDATE drift_record SET direction', []],
        ['UPDATE drift_record SET resolved_at', []],
      ],
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      baseline: 'MAIL_HOST=smtp\n',
      inspect: { c1: [] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.created).toEqual([]);
    expect(result.resolved).toBe(2);
    expect(calls(db, 'INSERT INTO drift_record')).toHaveLength(0);
    const refresh = calls(db, 'UPDATE drift_record SET direction')[0];
    expect(refresh?.params[0]).toBe('drift-1');
    expect(refresh?.params[1]).toBe('runtime_ahead');
  });

  it('closes the rows whose variable no longer drifts', async () => {
    const { db, service } = setup({
      routes: [
        ['FROM instance WHERE id', [{ id: INSTANCE_ID }]],
        [
          'FROM drift_record',
          [
            { id: 'drift-1', var_name: 'MAIL_HOST' },
            { id: 'drift-2', var_name: 'REMOVED_VAR' },
          ],
        ],
        ['UPDATE drift_record SET direction', []],
        ['UPDATE drift_record SET resolved_at', []],
      ],
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      baseline: 'MAIL_HOST=smtp\n',
      inspect: { c1: ['MAIL_HOST=other'] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.resolved).toBe(1);
    const resolve = calls(db, 'UPDATE drift_record SET resolved_at')[0];
    expect(resolve?.params[1]).toEqual(['drift-2']);
  });

  it('bounds the report so a noisy image cannot produce an unreadable one', async () => {
    const noisy = Array.from({ length: 230 }, (_, index) => `APP_VAR_${index}=1`);
    const { service } = setup({
      declared: [envValue({ name: 'APP_MODE', value: 'production' })],
      baseline: 'APP_MODE=production\n',
      inspect: { c1: ['APP_MODE=production', ...noisy] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toHaveLength(200);
  });

  it('decodes a quoted platform.env value before comparing it', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'MAIL_FROM', value: 'a b' })],
      baseline: '# Generated by the platform.\nMAIL_FROM="a b"\nBROKEN="a"b"\nno-separator\n\n',
      inspect: { c1: ['MAIL_FROM=a b'] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([]);
  });

  it('leaves the direction unknown when the instance was never applied', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      noRenderSet: true,
      inspect: { c1: [] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected[0]?.direction).toBe('unknown');
  });

  it('leaves a secret direction unknown when the container carries no creation time', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'DB_PASSWORD', secret: true, masked: true, source: 'secret' })],
      baseline: '',
      createdMissing: true,
      inspect: { c1: [] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected[0]?.direction).toBe('unknown');
  });

  it('reports a repeated undeclared name once across services', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'PAPERLESS_OCR_LANGUAGE', value: 'deu' })],
      baseline: 'PAPERLESS_OCR_LANGUAGE=deu\n',
      containers: [
        { id: 'c1', service: 'app' },
        { id: 'c2', service: 'worker' },
      ],
      inspect: {
        c1: ['PAPERLESS_OCR_LANGUAGE=deu', 'PAPERLESS_ADMIN_USER=admin', 'NOEQUALS'],
        c2: ['PAPERLESS_ADMIN_USER=admin'],
      },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([
      {
        instanceId: INSTANCE_ID,
        varName: 'PAPERLESS_ADMIN_USER',
        kind: 'undeclared',
        direction: 'runtime_ahead',
      },
    ]);
  });

  it('does not report a secret absence it could not prove', async () => {
    const { service } = setup({
      declared: [
        envValue({ name: 'DB_PASSWORD', secret: true, masked: true }),
        envValue({ name: 'API_TOKEN', secret: true, masked: true }),
      ],
      baseline: '',
      containers: [
        { id: 'c1', service: 'app' },
        { id: 'c2', service: 'worker' },
      ],
      inspect: { c1: ['DB_PASSWORD=secret'], c2: new Error('gone') },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([]);
  });

  it('says nothing about a secret the container already carries', async () => {
    const { db, service } = setup({
      declared: [envValue({ name: 'DB_PASSWORD', secret: true, masked: true })],
      baseline: '',
      inspect: { c1: ['DB_PASSWORD=from-secret-store'] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([]);
    expect(calls(db, 'INSERT INTO drift_record')).toHaveLength(0);
  });

  it('stops classifying at the cap even when the declaration is longer', async () => {
    const declared = Array.from({ length: 205 }, (_, index) =>
      envValue({ name: `APP_VAR_${index}`, value: 'set' }),
    );
    const { service } = setup({ declared, baseline: '', inspect: { c1: [] } });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toHaveLength(200);
  });

  it('survives a daemon that rejected with a string instead of an Error', async () => {
    const { service } = setup({ containersThrow: true, throwString: true });
    await expect(service.scan(INSTANCE_ID)).resolves.toMatchObject({ observed: false });
  });

  it('reports the direction as unknown when the render set has no environment file', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      baseline: '',
      withoutEnvFile: true,
      inspect: { c1: [] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected[0]?.direction).toBe('unknown');
  });

  it('reads a container whose inspect carries no Config as carrying nothing', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'MAIL_HOST', value: 'smtp' })],
      baseline: 'MAIL_HOST=smtp\n',
      configMissing: true,
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected).toEqual([
      {
        instanceId: INSTANCE_ID,
        varName: 'MAIL_HOST',
        kind: 'missing',
        direction: 'runtime_ahead',
      },
    ]);
  });

  it('reports a secret rotated before the container started as runtime ahead', async () => {
    const { service } = setup({
      declared: [
        envValue({
          name: 'DB_PASSWORD',
          secret: true,
          masked: true,
          source: 'secret',
          appliedAt: '2026-02-01T00:00:00.000Z',
        }),
      ],
      baseline: '',
      inspect: { c1: [] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected[0]?.direction).toBe('runtime_ahead');
  });

  it('treats an unparseable creation stamp as no evidence either way', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'DB_PASSWORD', secret: true, masked: true, source: 'secret' })],
      baseline: '',
      createdAt: 'not-a-date',
      inspect: { c1: [] },
    });

    const result = await service.scan(INSTANCE_ID);

    expect(result.detected[0]?.direction).toBe('unknown');
  });

  it('reports no undeclared variable when the entry declares no namespace', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'MODE', value: 'production' })],
      baseline: 'MODE=production\n',
      inspect: { c1: ['MODE=production', 'SOMETHING_ELSE=1'] },
    });

    await expect(service.scan(INSTANCE_ID)).resolves.toMatchObject({ detected: [] });
  });

  it('ignores a declaration that carries no value, because plan() owns that error', async () => {
    const { service } = setup({
      declared: [envValue({ name: 'OPTIONAL_SETTING', value: null })],
      baseline: '',
      inspect: { c1: [] },
    });

    await expect(service.scan(INSTANCE_ID)).resolves.toMatchObject({ detected: [] });
  });
});

describe('scannable', () => {
  it('lists the applied instances the daemon may be asked about', async () => {
    const { db, service } = setup({
      routes: [['FROM instance i', [{ id: INSTANCE_ID }]]],
    });

    await expect(service.scannable()).resolves.toEqual([INSTANCE_ID]);
    expect(db.calls[0]?.sql).toContain(`state IN ('ready', 'degraded')`);
  });

  it('lists the instances carrying the definition flag', async () => {
    const { service } = setup({ routes: [['ORDER BY id', [{ id: INSTANCE_ID }]]] });
    await expect(service.definitionDrift()).resolves.toEqual([INSTANCE_ID]);
  });
});

describe('openVarNames', () => {
  it('returns the variable names of the open rows only', async () => {
    const { db, service } = setup({
      routes: [
        ['FROM drift_record', [{ var_name: 'MAIL_HOST' }, { var_name: null }, { var_name: '' }]],
      ],
    });

    await expect(service.openVarNames(INSTANCE_ID)).resolves.toEqual(new Set(['MAIL_HOST']));
    expect(db.calls[0]?.sql).toContain('resolved_at IS NULL');
  });

  it('answers an empty set for a path that is not an instance id', async () => {
    const { db, service } = setup();
    await expect(service.openVarNames('nope')).resolves.toEqual(new Set());
    expect(db.calls).toHaveLength(0);
  });
});

describe('reconcileDefinition', () => {
  it('does nothing for a path that is not an instance id', async () => {
    const { params, service } = setup();
    await expect(service.reconcileDefinition('nope', 'system')).resolves.toBeNull();
    expect(params.write).not.toHaveBeenCalled();
  });

  it('does nothing when the instance carries no definition drift', async () => {
    const { db, params, service } = setup({
      routes: [['AS drifted', [{ drifted: false }]]],
    });

    await expect(service.reconcileDefinition(INSTANCE_ID, 'system')).resolves.toBeNull();
    expect(params.write).not.toHaveBeenCalled();
    expect(db.calls).toHaveLength(1);
  });

  it('re-commits the projection, clears the flag and closes the finding', async () => {
    const { db, params, service } = setup({
      routes: [
        ['AS drifted', [{ drifted: true }]],
        ['UPDATE instance SET payload = payload -', []],
        ['UPDATE drift_record SET resolved_at', []],
      ],
      write: async () => ({ path: 'instances/shop/instance.yaml', contentHash: 'abc' }),
    });

    await expect(service.reconcileDefinition(INSTANCE_ID, 'system')).resolves.toEqual({
      path: 'instances/shop/instance.yaml',
      contentHash: 'abc',
    });
    expect(params.write).toHaveBeenCalledWith(INSTANCE_ID, 'system', { actorType: 'system' });
    expect(calls(db, 'payload -')).toHaveLength(1);
    expect(calls(db, 'UPDATE drift_record SET resolved_at')).toHaveLength(1);
  });
});

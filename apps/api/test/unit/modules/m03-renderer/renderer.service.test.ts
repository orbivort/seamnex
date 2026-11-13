import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EnvSchemaFile, EnvSchemaVar } from '@seamnex/domain';
import { fakeDb, type Route } from '../../../support/fakes';
import { PostgresRendererService } from '../../../../src/modules/m03-renderer/renderer.service';
import type {
  RenderInput,
  RenderSet,
} from '../../../../src/modules/m03-renderer/renderer.contract';

/**
 * M03's environment authority — resolution *without* rendering.
 *
 * Every assertion below is a rule the module states in prose and that a deployment once paid for:
 * a ceiling of `none` refuses a value from anywhere but the schema, `profile_only` refuses an
 * instance answer, the enforceable `rule` is applied to the value that resolved (never to the
 * masked projection of it), a value that came from nowhere renders as "not set" rather than as a
 * configured credential, a schema file that would break a live instance is refused whole, and a
 * reload that changed nothing writes no audit record. Refusals are per field rather than exceptions,
 * so the tests read the way the wizard does: one entry per offending variable.
 */

type Row = Record<string, unknown>;

const ACTOR = 'alice';
const ENTRY = 'D01-01';

function varRow(overrides: Row & { name: string }): Row {
  return {
    type: 'string',
    required: false,
    default_value: null,
    constraint_text: null,
    conditional: null,
    secret: false,
    override_ceiling: 'profile_and_instance',
    purpose: 'Purpose',
    options: null,
    validation_rule: null,
    ...overrides,
  };
}

/** The declaration side of a file, as `catalog/env/<KEY>.json` would produce it. */
function declared(overrides: Partial<EnvSchemaVar> & { name: string }): EnvSchemaVar {
  return {
    purpose: 'Purpose',
    type: 'string',
    required: false,
    defaultValue: null,
    constraint: null,
    conditional: null,
    secret: false,
    overrideCeiling: 'profile_and_instance',
    ...overrides,
  };
}

function envFile(variables: readonly EnvSchemaVar[], entryKey = ENTRY): EnvSchemaFile {
  return { format: 'env-schema/v1', entryKey, variables: [...variables] };
}

function renderSetFor(instanceId: string): RenderSet {
  return {
    id: 'rs-1',
    instanceId,
    contentHash: 'hash-1',
    directory: '/data/rs-1',
    files: [],
    composeProject: 'seamnex-crm',
    imageRefs: [],
    publishedPorts: 0,
  };
}

function setup(routes: readonly Route[] = []) {
  const db = fakeDb(routes);
  const audit = {
    lockChain: vi.fn(async (_tx: unknown) => undefined),
    append: vi.fn(async (_entry: unknown, _tx?: unknown) => ({ seq: '1', hash: 'h' })),
  };
  const secrets = { put: vi.fn(async () => ({ id: 'sec-1' })) };
  const renderSets = {
    render: vi.fn(async (input: RenderInput) => renderSetFor(input.instanceId)),
    applied: vi.fn(async (instanceId: string) => renderSetFor(instanceId)),
    load: vi.fn(async () => renderSetFor('inst-1')),
  };
  const service = new PostgresRendererService(
    db.pool,
    audit as never,
    secrets as never,
    renderSets as never,
  );
  return { db, audit, secrets, renderSets, service };
}

/** The five fields a screen actually renders, in a shape a table assertion can read. */
type Shown = {
  readonly name: string;
  readonly value: string | null;
  readonly source: string;
  readonly masked: boolean;
  readonly requiresRecreate: boolean;
};

/** `[name, value, source, masked, requiresRecreate]` */
function shown(values: readonly Shown[]): unknown[][] {
  return values.map((value) => [
    value.name,
    value.value,
    value.source,
    value.masked,
    value.requiresRecreate,
  ]);
}

const INPUT: RenderInput = {
  instanceId: 'inst-1',
  entryKey: ENTRY,
  slug: 'crm',
  action: 'deploy',
  profileKey: 'default',
  httpPort: 80,
  resources: { cpuMilli: 1_000, memoryMb: 512, diskMb: 1_024 },
  route: {
    host: 'crm.example.test',
    pathPrefix: null,
    publishModel: 'subdomain',
    tlsMode: 'acme',
    authMode: 'fa_header',
  },
  source: {
    path: 'scaffold',
    directory: '/srv/source/crm',
    composeFile: null,
    dockerfilePath: null,
    imageRef: null,
    policy: {
      verdict: 'allowed',
      violations: [],
      waived: [],
      document: {},
      patch: [],
      publishedPorts: 0,
      services: [],
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('render set delegation', () => {
  it('hands render, applied and load to the render set service, so M03 has one entry point', async () => {
    const { renderSets, service } = setup();

    await expect(service.render(INPUT)).resolves.toMatchObject({
      id: 'rs-1',
      instanceId: 'inst-1',
    });
    await expect(service.applied('inst-2')).resolves.toMatchObject({ instanceId: 'inst-2' });
    await expect(service.load('rs-1')).resolves.toMatchObject({ id: 'rs-1' });

    expect(renderSets.render).toHaveBeenCalledWith(INPUT);
    expect(renderSets.applied).toHaveBeenCalledWith('inst-2');
    expect(renderSets.load).toHaveBeenCalledWith('rs-1');
  });
});

describe('schema', () => {
  it('serves the projection with the file revision on every row and omits fields nobody declared', async () => {
    const { db, service } = setup([
      [
        'ORDER BY name',
        [
          varRow({
            name: 'DB_HOST',
            purpose: 'Database host',
            options: ['a', 'b'],
            validation_rule: { minLength: 3 },
          }),
          varRow({ name: 'QUIET', purpose: null }),
        ],
      ],
      ['FROM env_schema_revision', [{ git_sha: 'sha-9' }]],
    ]);

    const vars = await service.schema(ENTRY);

    expect(vars[0]).toMatchObject({
      name: 'DB_HOST',
      purpose: 'Database host',
      revision: 'sha-9',
      options: ['a', 'b'],
      rule: { minLength: 3 },
    });
    // No options and no rule is `undefined`, not `[]` and not `{}`: a rule that constrains nothing
    // would claim an enforceable constraint exists.
    expect(vars[1]).toMatchObject({ purpose: 'QUIET', revision: 'sha-9' });
    expect(vars[1]).not.toHaveProperty('options');
    expect(vars[1]).not.toHaveProperty('rule');
    expect(db.calls.find((call) => call.sql.includes('FROM env_schema_var'))?.params).toEqual([
      ENTRY,
    ]);
  });

  it('answers an empty projection for an entry that declares nothing, with no revision yet', async () => {
    const { db, service } = setup([
      ['ORDER BY name', []],
      ['FROM catalog_entry', { rows: [], rowCount: 1 }],
      ['FROM env_schema_revision', []],
    ]);

    await expect(service.schema(ENTRY)).resolves.toEqual([]);
    // The revision lookup still happens so the screen can say "never reloaded" versus "no revision".
    expect(db.calls.some((call) => call.sql.includes('FROM env_schema_revision'))).toBe(true);
  });

  it('refuses an entry that has neither variables nor a catalogue row', async () => {
    const { service } = setup([
      ['ORDER BY name', []],
      ['FROM catalog_entry', []],
    ]);

    await expect(service.schema(ENTRY)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: `No environment definition for ${ENTRY}.`,
    });
  });
});

describe('profiles', () => {
  it('groups the stored values under their profile and names an absent author "system"', async () => {
    const { service } = setup([
      [
        'FROM env_profile ORDER BY key',
        [
          {
            key: 'production',
            target: 'production',
            updated_by: null,
            updated_at: new Date('2026-01-02T03:04:05.000Z'),
          },
          {
            key: 'staging',
            target: 'staging',
            updated_by: 'bob',
            updated_at: new Date('2026-02-03T00:00:00.000Z'),
          },
        ],
      ],
      [
        'FROM env_profile_value',
        [
          {
            profile_key: 'production',
            var_name: 'DB_HOST',
            value_enc: Buffer.from('db'),
            secret_ref: null,
          },
          { profile_key: 'production', var_name: 'TOKEN', value_enc: null, secret_ref: 'sec-1' },
          { profile_key: 'staging', var_name: 'DB_HOST', value_enc: null, secret_ref: null },
        ],
      ],
    ]);

    const profiles = await service.profiles();

    expect(profiles.map((profile) => profile.key)).toEqual(['production', 'staging']);
    expect(profiles[0]).toMatchObject({
      name: 'production',
      target: 'production',
      updatedBy: 'system',
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(profiles[0]?.values).toEqual([
      { varName: 'DB_HOST', value: 'db', secretRef: null },
      { varName: 'TOKEN', value: null, secretRef: 'sec-1' },
    ]);
    expect(profiles[1]?.values).toEqual([{ varName: 'DB_HOST', value: null, secretRef: null }]);
  });

  it('answers an empty list when the host has no profile at all', async () => {
    const { service } = setup([
      ['FROM env_profile ORDER BY key', []],
      ['FROM env_profile_value', []],
    ]);

    await expect(service.profiles()).resolves.toEqual([]);
  });
});

describe('plan', () => {
  it('resolves default → profile → instance and reports the profile it actually used', async () => {
    const { service } = setup([
      [
        'ORDER BY name',
        [
          varRow({ name: 'DB_HOST', required: true }),
          varRow({ name: 'PORT', default_value: '80' }),
        ],
      ],
      ['SELECT 1 FROM env_profile WHERE key', [{ present: true }]],
      [
        'FROM env_profile_value WHERE profile_key',
        [{ var_name: 'DB_HOST', value_enc: Buffer.from('db.profile'), secret_ref: null }],
      ],
    ]);

    const plan = await service.plan({
      entryKey: ENTRY,
      profileKey: 'production',
      overrides: { PORT: '8080' },
    });

    expect(shown(plan.values)).toEqual([
      ['DB_HOST', 'db.profile', 'profile', false, false],
      ['PORT', '8080', 'instance', false, false],
    ]);
    expect(plan).toMatchObject({
      entryKey: ENTRY,
      profileKey: 'production',
      fieldErrors: [],
      requiresRecreate: false,
    });
    expect(Date.parse(plan.resolvedAt)).not.toBeNaN();
  });

  it('refuses a value the ceiling forbids, per field, and keeps the schema default', async () => {
    const { service } = setup([
      [
        'ORDER BY name',
        [
          varRow({ name: 'LOCKED', override_ceiling: 'none', default_value: 'fixed' }),
          varRow({
            name: 'PROFILE_ONLY',
            override_ceiling: 'profile_only',
            default_value: 'schema',
          }),
        ],
      ],
      ['SELECT key FROM env_profile ORDER BY key LIMIT 1', [{ key: 'default' }]],
      ['FROM env_profile_value WHERE profile_key', []],
    ]);

    const plan = await service.plan({
      entryKey: ENTRY,
      overrides: { LOCKED: 'mine', PROFILE_ONLY: 'mine' },
    });

    expect(plan.fieldErrors).toEqual([
      { field: 'LOCKED', code: 'ceiling', message: 'This variable cannot be overridden.' },
      { field: 'PROFILE_ONLY', code: 'ceiling', message: 'Only a profile may set this variable.' },
    ]);
    // A refused override falls back to the schema, not to whatever the operator typed.
    expect(shown(plan.values)).toEqual([
      ['LOCKED', 'fixed', 'default', false, false],
      ['PROFILE_ONLY', 'schema', 'default', false, false],
    ]);
    expect(plan.profileKey).toBe('default');
  });

  it('reports a required variable that resolved to nothing and one that resolved to an empty string', async () => {
    const { service } = setup([
      [
        'ORDER BY name',
        [
          varRow({ name: 'MISSING', required: true }),
          varRow({ name: 'EMPTY', required: true, default_value: '' }),
        ],
      ],
      ['SELECT key FROM env_profile ORDER BY key LIMIT 1', []],
      ['FROM env_profile_value WHERE profile_key', []],
    ]);

    const plan = await service.plan({ entryKey: ENTRY, overrides: {} });

    expect(plan.fieldErrors).toEqual([
      { field: 'MISSING', code: 'required', message: 'A value is required.' },
      { field: 'EMPTY', code: 'required', message: 'A value is required.' },
    ]);
    // An unknown host with no profiles still resolves, to the documented fallback key.
    expect(plan.profileKey).toBe('default');
  });

  it('enforces the declared rule against the resolved value and describes it in words', async () => {
    const { service } = setup([
      [
        'ORDER BY name',
        [
          varRow({
            name: 'SALT',
            validation_rule: { pattern: '^[0-9a-f]{64}$', patternDescription: '64 hex characters' },
          }),
          varRow({ name: 'SHORT', validation_rule: { minLength: 8 } }),
        ],
      ],
      ['SELECT key FROM env_profile ORDER BY key LIMIT 1', [{ key: 'default' }]],
      ['FROM env_profile_value WHERE profile_key', []],
    ]);

    const plan = await service.plan({ entryKey: ENTRY, overrides: { SALT: 'abc', SHORT: 'abc' } });

    expect(plan.fieldErrors).toEqual([
      {
        field: 'SALT',
        code: 'pattern',
        message: 'Does not match the declared format: 64 hex characters.',
      },
      {
        field: 'SHORT',
        code: 'min_length',
        message: 'At least 8 characters are required; this value has 3.',
      },
    ]);
    // The value is flagged, not swallowed: the operator sees what they typed beside the reason.
    expect(shown(plan.values)[0]).toEqual(['SALT', 'abc', 'instance', false, false]);
  });

  it('masks only a value that resolved from somewhere, and leaves an unset secret visible as unset', async () => {
    const { service } = setup([
      [
        'ORDER BY name',
        [
          varRow({ name: 'SESSION_KEY', secret: true }),
          varRow({ name: 'SECRET_REF', secret: true }),
          varRow({ name: 'NULLVAL' }),
          varRow({ name: 'PLAIN_TOKEN', secret: true }),
        ],
      ],
      ['SELECT key FROM env_profile ORDER BY key LIMIT 1', [{ key: 'default' }]],
      [
        'FROM env_profile_value WHERE profile_key',
        [
          { var_name: 'SESSION_KEY', value_enc: Buffer.from('s3cr3t'), secret_ref: null },
          { var_name: 'SECRET_REF', value_enc: null, secret_ref: 'sec-1' },
          { var_name: 'NULLVAL', value_enc: null, secret_ref: null },
        ],
      ],
    ]);

    const plan = await service.plan({ entryKey: ENTRY, overrides: {} });

    expect(shown(plan.values)).toEqual([
      ['SESSION_KEY', null, 'profile', true, false],
      ['SECRET_REF', null, 'secret', true, false],
      ['NULLVAL', null, 'profile', false, false],
      // A secret nothing resolved must not render as "configured": masked false, value null.
      ['PLAIN_TOKEN', null, 'default', false, false],
    ]);
  });

  it('flags a recreate-only change, and never for a variable the ceiling locks out', async () => {
    const { service } = setup([
      [
        'ORDER BY name',
        [
          varRow({ name: 'PUBLIC_URL', default_value: 'http://a' }),
          varRow({ name: 'REDIS_URL', override_ceiling: 'none', default_value: 'redis://a' }),
        ],
      ],
      ['SELECT key FROM env_profile ORDER BY key LIMIT 1', [{ key: 'default' }]],
      [
        'FROM env_profile_value WHERE profile_key',
        [{ var_name: 'REDIS_URL', value_enc: Buffer.from('redis://p'), secret_ref: null }],
      ],
    ]);

    const plan = await service.plan({ entryKey: ENTRY, overrides: { PUBLIC_URL: 'http://new' } });

    expect(shown(plan.values)).toEqual([
      ['PUBLIC_URL', 'http://new', 'instance', false, true],
      ['REDIS_URL', 'redis://p', 'profile', false, false],
    ]);
    expect(plan.requiresRecreate).toBe(true);
  });

  it('answers an empty plan — not a missing one — for an entry that declares no variables', async () => {
    const { db, service } = setup([
      ['ORDER BY name', []],
      ['FROM catalog_entry', { rows: [], rowCount: 1 }],
      ['SELECT key FROM env_profile ORDER BY key LIMIT 1', [{ key: 'staging' }]],
    ]);

    const plan = await service.plan({ entryKey: ENTRY, overrides: {} });

    expect(plan).toMatchObject({
      entryKey: ENTRY,
      profileKey: 'staging',
      values: [],
      fieldErrors: [],
      requiresRecreate: false,
    });
    // No profile values are read when there is nothing to resolve them against.
    expect(db.calls.some((call) => call.sql.includes('FROM env_profile_value'))).toBe(false);
  });

  it('refuses a plan for an entry that is not projected', async () => {
    const { service } = setup([
      ['ORDER BY name', []],
      ['FROM catalog_entry', []],
      ['SELECT key FROM env_profile ORDER BY key LIMIT 1', [{ key: 'default' }]],
    ]);

    await expect(service.plan({ entryKey: 'X9', overrides: {} })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No environment definition for X9.',
      remediation: 'Reload the catalog repository and check the entry key.',
    });
  });

  it('falls back to the host default when the named profile does not exist', async () => {
    const { db, service } = setup([
      ['ORDER BY name', [varRow({ name: 'DB_HOST', default_value: 'db' })]],
      ['SELECT 1 FROM env_profile WHERE key', []],
      ['SELECT key FROM env_profile ORDER BY key LIMIT 1', [{ key: 'staging' }]],
      ['FROM env_profile_value WHERE profile_key', []],
    ]);

    const plan = await service.plan({ entryKey: ENTRY, profileKey: 'ghost', overrides: {} });

    expect(plan.profileKey).toBe('staging');
    // The values were read for the profile that was actually used, never for the one asked for.
    expect(db.calls.find((call) => call.sql.includes('WHERE profile_key = $1'))?.params).toEqual([
      'staging',
    ]);
  });
});

describe('importEnv', () => {
  const CONTENT = [
    '# a comment is not a value',
    '',
    'DB_HOST=db.internal',
    'QUOTED="a b"',
    "SINGLE='x y'",
    'EQUALS=postgres://user:pw@db/app?a=1&b=2',
    '- LISTED=from-compose',
    '- NOT_A_PAIR',
    'NO_EQUALS',
    'STRANGER=1',
  ].join('\n');

  const DECLARED = [
    varRow({ name: 'DB_HOST' }),
    varRow({ name: 'QUOTED' }),
    varRow({ name: 'SINGLE', secret: true }),
    varRow({ name: 'EQUALS' }),
    varRow({ name: 'LISTED' }),
  ];

  it('maps what the declaration knows, quotes stripped, and refuses to import a secret value', async () => {
    const { service } = setup([['ORDER BY name', DECLARED]]);

    const result = await service.importEnv(
      { entryKey: ENTRY, source: 'dotenv', content: CONTENT },
      ACTOR,
    );

    expect(result.parsed).toBe(6);
    expect(result.mapped.map((entry) => [entry.name, entry.value, entry.secret])).toEqual([
      ['DB_HOST', 'db.internal', false],
      ['QUOTED', 'a b', false],
      // A secret is reported as known-but-not-imported: its value never leaves the file.
      ['SINGLE', null, true],
      ['EQUALS', 'postgres://user:pw@db/app?a=1&b=2', false],
      ['LISTED', 'from-compose', false],
    ]);
    expect(result.mapped.map((entry) => entry.reason === null)).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
    expect(result.unmapped).toEqual(['STRANGER']);
    expect(result).toMatchObject({ entryKey: ENTRY, source: 'dotenv', fieldErrors: [] });
    expect(Date.parse(result.importedAt)).not.toBeNaN();
  });

  it('records the import on the audit chain inside one transaction, naming the counts', async () => {
    const { audit, db, service } = setup([['ORDER BY name', DECLARED]]);

    await service.importEnv({ entryKey: ENTRY, source: 'compose', content: CONTENT }, ACTOR);

    expect(audit.lockChain).toHaveBeenCalledTimes(1);
    expect(audit.append).toHaveBeenCalledWith(
      {
        action: 'catalog.env.imported',
        actorType: 'user',
        actorId: ACTOR,
        targetType: 'catalog_entry',
        targetId: ENTRY,
        outcome: 'success',
        detail: { source: 'compose', parsed: 6, mapped: 5, unmapped: 1 },
      },
      expect.anything(),
    );
    expect(db.calls.map((call) => call.sql.trim())).toEqual(
      expect.arrayContaining(['BEGIN', 'COMMIT']),
    );
  });

  it('answers an empty import for empty content rather than failing', async () => {
    const { service } = setup([['ORDER BY name', DECLARED]]);

    const result = await service.importEnv(
      { entryKey: ENTRY, source: 'dotenv', content: '\n\n' },
      ACTOR,
    );

    expect(result).toMatchObject({ parsed: 0, mapped: [], unmapped: [] });
  });
});

describe('instanceEnv', () => {
  it('shows the stored value, its source and its age, and marks drift when the value is gone', async () => {
    const resolvedAt = new Date('2026-03-04T05:06:07.000Z');
    const { service } = setup([
      [
        'FROM instance WHERE id = $1 AND deleted_at IS NULL',
        [{ entry_key: ENTRY, profile_key: 'default' }],
      ],
      [
        'ORDER BY name',
        [
          varRow({ name: 'DB_HOST', purpose: 'Database host', default_value: 'db' }),
          varRow({ name: 'TOKEN', purpose: null, secret: true }),
          varRow({ name: 'PUBLIC_URL', default_value: 'http://x' }),
          varRow({ name: 'DRIFTED', default_value: 'fallback' }),
          varRow({ name: 'UNSTORED', default_value: 'never-set' }),
        ],
      ],
      [
        'var_name, source, value_enc',
        [
          {
            var_name: 'DB_HOST',
            source: 'instance',
            value_enc: Buffer.from('db.internal'),
            secret_ref: null,
            resolved_at: resolvedAt,
          },
          {
            var_name: 'TOKEN',
            source: 'secret',
            value_enc: null,
            secret_ref: 'sec-1',
            resolved_at: resolvedAt,
          },
          {
            var_name: 'PUBLIC_URL',
            source: 'profile',
            value_enc: Buffer.from('http://prod'),
            secret_ref: null,
            resolved_at: resolvedAt,
          },
          // A cleared value: the row exists, holds nothing, and the schema still declares a default.
          {
            var_name: 'DRIFTED',
            source: 'instance',
            value_enc: null,
            secret_ref: null,
            resolved_at: resolvedAt,
          },
        ],
      ],
    ]);

    const values = await service.instanceEnv('inst-1');

    expect(
      values.map((value) => [
        value.name,
        value.value,
        value.source,
        value.masked,
        value.requiresRecreate,
        value.drift,
      ]),
    ).toEqual([
      ['DB_HOST', 'db.internal', 'instance', false, false, false],
      ['TOKEN', null, 'secret', true, false, false],
      ['PUBLIC_URL', 'http://prod', 'profile', false, true, false],
      ['DRIFTED', 'fallback', 'instance', false, false, true],
      // Nothing stored is "not set", and the screen must not imply a credential is configured.
      ['UNSTORED', null, 'default', true, false, false],
    ]);
    expect(values[0]).toMatchObject({
      purpose: 'Database host',
      appliedAt: '2026-03-04T05:06:07.000Z',
      type: 'string',
    });
    // A variable with no purpose falls back to its own name.
    expect(values[1]?.purpose).toBe('TOKEN');
    expect(Date.parse(values[4]?.appliedAt ?? '')).not.toBeNaN();
  });

  it('refuses an instance that does not exist instead of answering an empty environment', async () => {
    const { service } = setup([['FROM instance WHERE id = $1 AND deleted_at IS NULL', []]]);

    await expect(service.instanceEnv('inst-missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      detail: 'No environment definition for inst-missing.',
    });
  });
});

describe('updateInstanceEnv', () => {
  const VARS = [
    varRow({ name: 'DB_HOST' }),
    varRow({ name: 'SESSION_KEY', secret: true }),
    varRow({ name: 'PUBLIC_URL' }),
    varRow({ name: 'MAIL_HOST' }),
    varRow({ name: 'LEGACY' }),
  ];

  const PREVIOUS: Record<string, unknown[]> = {
    DB_HOST: [{ value_enc: Buffer.from('db.old') }],
    PUBLIC_URL: [{ value_enc: Buffer.from('http://same') }],
    MAIL_HOST: [{ value_enc: null }],
  };

  it('validates the whole request before writing anything, one error per offending field', async () => {
    const { db, service } = setup([
      ['SELECT entry_key FROM instance WHERE id = $1', [{ entry_key: ENTRY }]],
      [
        'ORDER BY name',
        [
          varRow({ name: 'LOCKED', override_ceiling: 'none' }),
          varRow({ name: 'SALT', validation_rule: { minLength: 8 } }),
        ],
      ],
    ]);

    await expect(
      service.updateInstanceEnv('inst-1', { NOT_DECLARED: 'x', LOCKED: 'y', SALT: 'short' }, ACTOR),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `The environment change was refused by the declaration for ${ENTRY}.`,
      remediation: 'Fix the flagged variables; nothing was stored.',
      fieldErrors: [
        {
          field: 'NOT_DECLARED',
          code: 'unrecognized_key',
          message: 'Not declared in the environment schema.',
        },
        { field: 'LOCKED', code: 'ceiling', message: 'The override ceiling is none.' },
        {
          field: 'SALT',
          code: 'min_length',
          message: 'At least 8 characters are required; this value has 5.',
        },
      ],
    });
    // Half an environment is worse than none: the refusal leaves no transaction behind.
    expect(db.calls.some((call) => call.sql.trim() === 'BEGIN')).toBe(false);
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO instance_env_value'))).toBe(
      false,
    );
  });

  it('stores non-secret values inline and secrets through M15, reporting only what moved', async () => {
    const { audit, db, secrets, service } = setup([
      ['SELECT entry_key FROM instance WHERE id = $1', [{ entry_key: ENTRY }]],
      ['ORDER BY name', VARS],
      [
        'SELECT value_enc FROM instance_env_value',
        (_sql: string, params: readonly unknown[]) => PREVIOUS[String(params[1])] ?? [],
      ],
      ['INSERT INTO instance_env_value', []],
    ]);

    const result = await service.updateInstanceEnv(
      'inst-1',
      {
        DB_HOST: 'db.new',
        SESSION_KEY: 'sekret',
        PUBLIC_URL: 'http://same',
        MAIL_HOST: 'smtp.new',
        LEGACY: 'now-set',
      },
      ACTOR,
    );

    expect(result.diff).toEqual([
      { name: 'DB_HOST', from: 'db.old', to: 'db.new', requiresRecreate: false },
      // A secret's new value is never echoed back in the diff.
      { name: 'SESSION_KEY', from: null, to: null, requiresRecreate: false },
      { name: 'MAIL_HOST', from: null, to: 'smtp.new', requiresRecreate: true },
      { name: 'LEGACY', from: null, to: 'now-set', requiresRecreate: false },
    ]);
    expect(result).toMatchObject({ requiresRecreate: true, applied: false });
    expect(result.note).toContain('Render and apply run in Phase 4A');

    expect(secrets.put).toHaveBeenCalledWith(
      'instance',
      'inst-1',
      'SESSION_KEY',
      'sekret',
      expect.anything(),
    );
    const upserts = db.calls.filter((call) => call.sql.includes('INSERT INTO instance_env_value'));
    expect(upserts.find((call) => call.params[1] === 'SESSION_KEY')?.params).toEqual([
      'inst-1',
      'SESSION_KEY',
      'secret',
      null,
      'sec-1',
    ]);
    expect(upserts.find((call) => call.params[1] === 'DB_HOST')?.params).toEqual([
      'inst-1',
      'DB_HOST',
      'instance',
      Buffer.from('db.new', 'utf8'),
      null,
    ]);
    // An unchanged value is still rewritten (idempotent) but never reported as a change.
    expect(upserts.some((call) => call.params[1] === 'PUBLIC_URL')).toBe(true);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'instance.env.updated',
        actorId: ACTOR,
        targetType: 'instance',
        targetId: 'inst-1',
        detail: {
          changed: ['DB_HOST', 'SESSION_KEY', 'MAIL_HOST', 'LEGACY'],
          requiresRecreate: true,
        },
      }),
      expect.anything(),
    );
  });

  it('writes nothing but the audit record when the request carries no values', async () => {
    const { audit, db, service } = setup([
      ['SELECT entry_key FROM instance WHERE id = $1', [{ entry_key: ENTRY }]],
      ['ORDER BY name', VARS],
    ]);

    const result = await service.updateInstanceEnv('inst-1', {}, ACTOR);

    expect(result).toMatchObject({ diff: [], requiresRecreate: false, applied: false });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO instance_env_value'))).toBe(
      false,
    );
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({ detail: { changed: [], requiresRecreate: false } }),
      expect.anything(),
    );
  });

  it('refuses an instance that does not exist before reading the declaration', async () => {
    const { db, service } = setup([['SELECT entry_key FROM instance WHERE id = $1', []]]);

    await expect(service.updateInstanceEnv('inst-missing', {}, ACTOR)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(db.calls.some((call) => call.sql.includes('FROM env_schema_var'))).toBe(false);
  });
});

describe('applySchemas', () => {
  /** Everything a reload needs except the statements the case is about; those go first. */
  const BASE: readonly Route[] = [
    ['FROM catalog_entry', [{ present: true }]],
    ['AND content_hash', []],
    ['INSERT INTO env_schema_revision', [{ id: 'rev-1' }]],
    ['INSERT INTO env_schema_var', []],
    ['DELETE FROM env_schema_var', { rows: [], rowCount: 1 }],
  ];

  function applySetup(routes: readonly Route[] = []) {
    return setup([...routes, ...BASE]);
  }

  it('refuses a file whose catalog entry is not projected, and writes nothing for it', async () => {
    const { audit, db, service } = applySetup([['FROM catalog_entry', []]]);

    const result = await service.applySchemas({
      schemas: [envFile([declared({ name: 'DB_HOST' })])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(result).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
      refused: [
        {
          key: ENTRY,
          name: null,
          reason: `no catalog entry "${ENTRY}" is projected; repair catalog/${ENTRY}.json first`,
        },
      ],
      applied: [],
    });
    expect(db.calls.some((call) => call.sql.includes('FROM env_schema_var'))).toBe(false);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses to remove a variable that a live instance still stores a value for, naming each instance', async () => {
    const { audit, service } = applySetup([
      ['ORDER BY name', [varRow({ name: 'GONE' })]],
      [
        'var_name = ANY',
        [
          { var_name: 'GONE', slug: 'crm' },
          { var_name: 'GONE', slug: 'erp' },
        ],
      ],
    ]);

    const result = await service.applySchemas({
      schemas: [envFile([])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(result.refused).toEqual([
      {
        key: ENTRY,
        name: 'GONE',
        reason:
          'instance crm stores a value for this variable; clear it before the declaration is removed',
      },
      {
        key: ENTRY,
        name: 'GONE',
        reason:
          'instance erp stores a value for this variable; clear it before the declaration is removed',
      },
    ]);
    expect(result.applied).toEqual([]);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('refuses to lower a ceiling under a value set at the level being removed', async () => {
    const { db, service } = applySetup([
      ['ORDER BY name', [varRow({ name: 'DB_HOST', override_ceiling: 'profile_and_instance' })]],
      ['iv.source IN', [{ slug: 'crm' }, { slug: 'erp' }]],
    ]);

    const result = await service.applySchemas({
      schemas: [envFile([declared({ name: 'DB_HOST', overrideCeiling: 'profile_only' })])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(result.refused).toEqual([
      {
        key: ENTRY,
        name: 'DB_HOST',
        reason: 'instances crm, erp set this variable above the new ceiling "profile_only"',
      },
    ]);
    expect(db.calls.find((call) => call.sql.includes('iv.source IN'))?.params).toEqual([
      ENTRY,
      'DB_HOST',
    ]);
  });

  it('applies a ceiling change nobody has exercised, and one that only widens', async () => {
    const narrow = applySetup([
      ['ORDER BY name', [varRow({ name: 'DB_HOST', override_ceiling: 'profile_only' })]],
      ['iv.source IN', []],
    ]);

    const narrowed = await narrow.service.applySchemas({
      schemas: [envFile([declared({ name: 'DB_HOST', overrideCeiling: 'none' })])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(narrowed).toMatchObject({ refused: [], changed: 1 });
    expect(narrowed.applied).toEqual([{ key: ENTRY, added: 0, changed: 1, removed: 0 }]);

    // A ceiling of `none` is already the tightest, so a wider declaration is not questionable.
    const wide = applySetup([
      ['ORDER BY name', [varRow({ name: 'DB_HOST', override_ceiling: 'none' })]],
    ]);

    const widened = await wide.service.applySchemas({
      schemas: [envFile([declared({ name: 'DB_HOST', overrideCeiling: 'profile_only' })])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(widened).toMatchObject({ refused: [], changed: 1 });
    expect(wide.db.calls.some((call) => call.sql.includes('iv.source IN'))).toBe(false);
  });

  it('refuses a new rule under a stored value it would reject, and ignores one it accepts', async () => {
    const { service } = applySetup([
      ['ORDER BY name', [varRow({ name: 'SALT' })]],
      [
        'convert_from',
        [
          { slug: 'crm', value: 'short' },
          { slug: 'erp', value: 'longenough' },
        ],
      ],
    ]);

    const result = await service.applySchemas({
      schemas: [envFile([declared({ name: 'SALT', rule: { minLength: 8 } })])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    // Only the instance whose value the rule refuses is named; the compliant one is not.
    expect(result.refused).toEqual([
      {
        key: ENTRY,
        name: 'SALT',
        reason:
          'instance crm stores a value the new rule refuses (min_length); clear the value or relax the rule',
      },
    ]);
    expect(result.applied).toEqual([]);
  });

  it('records the delta, projects every variable and deletes what the file dropped', async () => {
    const { audit, db, service } = applySetup([
      [
        'ORDER BY name',
        [
          varRow({ name: 'KEEP', purpose: 'Keep', default_value: 'x' }),
          varRow({ name: 'CHANGE', purpose: 'Change' }),
          varRow({ name: 'DROP' }),
        ],
      ],
      ['var_name = ANY', []],
    ]);

    const result = await service.applySchemas({
      schemas: [
        envFile([
          declared({ name: 'KEEP', purpose: 'Keep', defaultValue: 'x' }),
          declared({ name: 'CHANGE', purpose: 'Change', defaultValue: 'y' }),
          declared({ name: 'NEW' }),
        ]),
      ],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(result).toMatchObject({ added: 1, changed: 1, removed: 1, refused: [] });
    expect(result.applied).toEqual([{ key: ENTRY, added: 1, changed: 1, removed: 1 }]);
    expect(
      db.calls.find((call) => call.sql.includes('DELETE FROM env_schema_var'))?.params,
    ).toEqual([ENTRY, ['DROP']]);
    expect(audit.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'catalog.env.schema.applied',
        targetId: ENTRY,
        detail: expect.objectContaining({
          added: 1,
          changed: 1,
          removed: 1,
          revision: 'sha-1',
          removedNames: ['DROP'],
        }),
      }),
      expect.anything(),
    );
  });

  it('skips the write and the audit record when a known declaration re-reads unchanged', async () => {
    const { audit, db, service } = applySetup([
      ['ORDER BY name', [varRow({ name: 'DB_HOST', purpose: 'Host', default_value: 'db' })]],
      ['AND content_hash', [{ present: true }]],
    ]);

    const result = await service.applySchemas({
      schemas: [envFile([declared({ name: 'DB_HOST', purpose: 'Host', defaultValue: 'db' })])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(result).toEqual({ added: 0, changed: 0, removed: 0, refused: [], applied: [] });
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO env_schema_revision'))).toBe(
      false,
    );
    expect(audit.append).not.toHaveBeenCalled();
  });

  it('re-projects a known declaration with no delta, because an out-of-band edit needs repairing', async () => {
    const { db, service } = applySetup([
      ['ORDER BY name', [varRow({ name: 'DB_HOST', purpose: 'Host', default_value: 'db' })]],
      ['AND content_hash', { rows: [] }],
    ]);

    const result = await service.applySchemas({
      schemas: [envFile([declared({ name: 'DB_HOST', purpose: 'Host', defaultValue: 'db' })])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(result.applied).toEqual([]);
    expect(db.calls.some((call) => call.sql.includes('INSERT INTO env_schema_revision'))).toBe(
      true,
    );
  });

  it('refuses the reload when the revision row cannot be read back', async () => {
    const { service } = applySetup([
      ['ORDER BY name', []],
      ['INSERT INTO env_schema_revision', []],
    ]);

    await expect(
      service.applySchemas({ schemas: [envFile([])], revision: 'sha-1', actorId: ACTOR }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      detail: `The environment schema revision for ${ENTRY} could not be recorded.`,
      remediation: 'Retry the reload; the projection was not changed by this attempt.',
    });
  });

  it('projects options and the rule as JSONB, and null when the declaration states neither', async () => {
    const { db, service } = applySetup([
      ['ORDER BY name', []],
      ['convert_from', []],
    ]);

    await service.applySchemas({
      schemas: [
        envFile([
          declared({ name: 'A_VAR', options: ['b', 'a'], rule: { minLength: 3 } }),
          declared({ name: 'B_VAR' }),
        ]),
      ],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    const inserts = db.calls.filter((call) => call.sql.includes('INSERT INTO env_schema_var'));
    const a = inserts.find((call) => call.params[1] === 'A_VAR');
    const b = inserts.find((call) => call.params[1] === 'B_VAR');
    expect(a?.params[10]).toEqual(['b', 'a']);
    expect(a?.params[12]).toBe(JSON.stringify({ minLength: 3 }));
    expect(b?.params[10]).toBeNull();
    expect(b?.params[12]).toBeNull();
  });

  it('answers an empty receipt for an empty batch, without touching the database', async () => {
    const { db, service } = setup();

    const result = await service.applySchemas({ schemas: [], revision: 'sha-1', actorId: ACTOR });

    expect(result).toEqual({ added: 0, changed: 0, removed: 0, refused: [], applied: [] });
    expect(db.calls).toHaveLength(0);
  });

  /**
   * `differs` decides whether a file changed anything, and each field it compares is a separate
   * reason a reload must not report "nothing moved". One row per field, plus the cases that must
   * *not* count as a change: identical declarations, option order and rule key order.
   */
  const BASE_CURRENT = varRow({ name: 'DB_HOST', purpose: 'Host', default_value: 'db' });
  const BASE_FILE = declared({ name: 'DB_HOST', purpose: 'Host', defaultValue: 'db' });

  type DiffCase = {
    readonly field: string;
    readonly current?: Row;
    readonly file?: Partial<EnvSchemaVar>;
    readonly changed: 0 | 1;
  };

  const DIFF_CASES: readonly DiffCase[] = [
    { field: 'an identical declaration', changed: 0 },
    { field: 'type', file: { type: 'integer' }, changed: 1 },
    { field: 'required', file: { required: true }, changed: 1 },
    { field: 'default value', file: { defaultValue: 'other' }, changed: 1 },
    { field: 'constraint', file: { constraint: 'eight characters' }, changed: 1 },
    { field: 'conditional', file: { conditional: 'when MODE=prod' }, changed: 1 },
    { field: 'secret', file: { secret: true, type: 'secret' }, changed: 1 },
    { field: 'ceiling', file: { overrideCeiling: 'profile_only' }, changed: 1 },
    { field: 'purpose', file: { purpose: 'Other' }, changed: 1 },
    { field: 'options', file: { options: ['b', 'a'] }, changed: 1 },
    { field: 'rule', file: { rule: { minLength: 3 } }, changed: 1 },
    {
      field: 'a purpose the projection never stored',
      current: varRow({ name: 'DB_HOST', purpose: null, default_value: 'db' }),
      file: { purpose: 'DB_HOST' },
      changed: 1,
    },
    {
      field: 'option order',
      current: varRow({
        name: 'DB_HOST',
        purpose: 'Host',
        default_value: 'db',
        options: ['a', 'b'],
      }),
      file: { options: ['b', 'a'] },
      changed: 0,
    },
    {
      field: 'rule key order',
      current: varRow({
        name: 'DB_HOST',
        purpose: 'Host',
        default_value: 'db',
        validation_rule: { minLength: 3 },
      }),
      file: { rule: { minLength: 3 } },
      changed: 0,
    },
  ];

  it.each(DIFF_CASES)('reports $field as changed=$changed', async ({ current, file, changed }) => {
    const { service } = applySetup([
      ['ORDER BY name', [current ?? BASE_CURRENT]],
      ['convert_from', []],
      ['iv.source IN', []],
    ]);

    const result = await service.applySchemas({
      schemas: [envFile([{ ...BASE_FILE, ...file }])],
      revision: 'sha-1',
      actorId: ACTOR,
    });

    expect(result).toMatchObject({ added: 0, changed, removed: 0, refused: [] });
    expect(result.applied).toEqual(
      changed === 0 ? [] : [{ key: ENTRY, added: 0, changed: 1, removed: 0 }],
    );
  });
});

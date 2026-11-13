import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fakeDb } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { RenderSetService } from '../../../../src/modules/m03-renderer/render.service';
import type { RenderInput } from '../../../../src/modules/m03-renderer/renderer.contract';

/**
 * A render set is the complete, immutable description of what should run. The properties asserted
 * here are the ones that failed in the field: the applied document must contain zero published
 * ports (invariant 9 counts what survived normalisation, not how many were rewritten), a relative
 * build context must point at the resolved source tree, the service that answers on the product
 * port must carry the slug alias, and a catalogue `httpPort` no service exposes is refused before
 * anything is applied.
 */
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(routes: Parameters<typeof fakeDb>[0] = []) {
  const root = mkdtempSync(join(tmpdir(), 'seamnex-render-'));
  dirs.push(root);
  const db = fakeDb(routes);
  const service = new RenderSetService(db.pool, {
    SEAMNEX_INSTANCE_DATA_DIR: root,
  } as unknown as AppConfig);
  return { db, root, service };
}

function policy(document: Record<string, unknown>): RenderInput['source']['policy'] {
  return {
    verdict: 'allowed',
    violations: [],
    waived: [],
    document,
    patch: [],
    publishedPorts: 0,
    services: Object.keys((document.services as Record<string, unknown>) ?? {}),
  };
}

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return {
    instanceId: 'inst-1',
    entryKey: 'D01-01',
    slug: 'crm',
    action: 'deploy',
    profileKey: 'default',
    httpPort: 80,
    resources: { cpuMilli: 1_500, memoryMb: 1_024, diskMb: 2_048 },
    route: {
      host: 'crm.example.test',
      pathPrefix: null,
      publishModel: 'subdomain',
      tlsMode: 'acme',
      authMode: 'fa_header',
    },
    labels: { 'seamnex.owner': 'team-core' },
    source: {
      path: 'compose',
      directory: '/srv/source/crm',
      composeFile: '/srv/source/crm/docker-compose.yml',
      dockerfilePath: null,
      imageRef: null,
      policy: policy({
        version: '3.9',
        services: {
          app: { image: 'espocrm/espocrm:8.0.0', expose: ['80'], build: { context: './app' } },
          db: { image: 'postgres:16', expose: [] },
        },
      }),
    },
    ...overrides,
  };
}

const RENDER_ROW = {
  id: 'rs-1',
  instance_id: 'inst-1',
  content_hash: 'hash-1',
  files: { composeProject: 'seamnex-crm', imageRefs: ['espocrm/espocrm:8.0.0'], publishedPorts: 0 },
  applied_at: null,
};

const ENV_ROUTES: Parameters<typeof fakeDb>[0] = [
  [
    'FROM env_schema_var',
    [
      { name: 'DB_HOST', default_value: 'db' },
      { name: 'QUOTED', default_value: 'a b' },
    ],
  ],
  [
    'FROM instance_env_value',
    [{ var_name: 'DB_HOST', value_enc: Buffer.from('db.internal', 'utf8') }],
  ],
];

describe('render', () => {
  it('writes the platform documents, the environment and the route intent to disk', async () => {
    const { root, service } = setup([
      ...ENV_ROUTES,
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(input());

    expect(set).toMatchObject({
      id: 'rs-1',
      instanceId: 'inst-1',
      contentHash: 'hash-1',
      composeProject: 'seamnex-crm',
      // Every service that names an image is inventoried, not only the one that answers HTTP.
      imageRefs: ['espocrm/espocrm:8.0.0', 'postgres:16'],
      publishedPorts: 0,
      directory: join(root, 'inst-1', 'render', 'rs-1'),
    });
    expect(set.files.map((file) => file.path)).toEqual([
      'docker-compose.platform.yml',
      'docker-compose.override.yml',
      'platform.env',
      'route.json',
    ]);

    const env = readFileSync(join(set.directory, 'platform.env'), 'utf8');
    // A stored value wins over the catalogue default; a value with a space is quoted.
    expect(env).toContain('DB_HOST=db.internal');
    expect(env).toContain('QUOTED="a b"');
    expect(env).toContain('secrets are injected at apply time');

    const route = JSON.parse(readFileSync(join(set.directory, 'route.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(route).toEqual({
      project: 'seamnex-crm',
      host: 'crm.example.test',
      pathPrefix: null,
      publishModel: 'subdomain',
      tlsMode: 'acme',
      authMode: 'fa_header',
      containerPort: 80,
    });
  });

  it('normalises the platform copy: no published ports, absolute build context, slug alias', async () => {
    const { service } = setup([
      ...ENV_ROUTES,
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(input());
    const platform = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.platform.yml'), 'utf8'),
    ) as {
      name: string;
      services: Record<
        string,
        { build?: { context?: string }; ports?: unknown[]; expose?: string[] }
      >;
      networks: Record<string, { name: string }>;
    };

    expect(platform.name).toBe('seamnex-crm');
    expect(platform.services.app?.ports).toBeUndefined();
    // A relative context resolved against the render directory would not exist.
    expect(platform.services.app?.build?.context).toBe(join('/srv/source/crm', 'app'));
    expect(platform.networks.default?.name).toBe('seamnex-inst-crm');
    expect(set.publishedPorts).toBe(0);
  });

  it('injects resource ceilings, restart policy, labels and log rotation in the override', async () => {
    const { service } = setup([
      ...ENV_ROUTES,
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(input());
    const override = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.override.yml'), 'utf8'),
    ) as {
      services: Record<
        string,
        {
          restart: string;
          labels: Record<string, string>;
          environment?: Record<string, string>;
          deploy: {
            resources: {
              limits: { cpus: string; memory: string };
              reservations: { memory: string };
            };
          };
          logging: { options: Record<string, string> };
          security_opt: string[];
          networks?: { default: { aliases: string[] } };
        }
      >;
    };

    const app = override.services.app;
    expect(app?.restart).toBe('unless-stopped');
    expect(app?.labels).toMatchObject({
      'seamnex.instance': 'inst-1',
      'seamnex.entry': 'D01-01',
      'seamnex.project': 'seamnex-crm',
      'seamnex.owner': 'team-core',
    });
    expect(app?.environment).toEqual({ DB_HOST: 'db.internal', QUOTED: 'a b' });
    expect(app?.deploy.resources.limits).toEqual({ cpus: '1.50', memory: '1024M' });
    expect(app?.deploy.resources.reservations.memory).toBe('512M');
    expect(app?.logging).toEqual({
      driver: 'json-file',
      options: { 'max-size': '10m', 'max-file': '3' },
    });
    expect(app?.security_opt).toEqual(['no-new-privileges:true']);
    // The alias belongs to the service that answers on the product port, never to the database.
    expect(app?.networks).toEqual({ default: { aliases: ['crm'] } });
    expect(override.services.db?.networks).toBeUndefined();
  });

  it('omits the injected environment entirely when nothing is declared', async () => {
    const { service } = setup([
      ['FROM env_schema_var', []],
      ['FROM instance_env_value', []],
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(input());
    const override = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.override.yml'), 'utf8'),
    ) as { services: Record<string, { environment?: unknown }> };

    expect(override.services.app?.environment).toBeUndefined();
    expect(readFileSync(join(set.directory, 'platform.env'), 'utf8')).not.toContain('=');
  });

  it('renders a dockerfile source with the platform image tag', async () => {
    const { service } = setup([
      ['FROM env_schema_var', []],
      ['FROM instance_env_value', []],
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(
      input({
        source: {
          path: 'dockerfile',
          directory: '/srv/source/crm',
          composeFile: null,
          dockerfilePath: 'docker/Dockerfile.prod',
          imageRef: null,
          policy: policy({}),
        },
      }),
    );

    const platform = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.platform.yml'), 'utf8'),
    ) as {
      services: Record<
        string,
        { image: string; build: { dockerfile: string; context: string }; expose: string[] }
      >;
    };

    expect(platform.services.app).toMatchObject({
      image: 'seamnex/instance-inst-1:latest',
      build: { dockerfile: 'docker/Dockerfile.prod', context: '/srv/source/crm' },
      expose: ['80'],
    });
    expect(set.imageRefs).toEqual([]);
  });

  it('renders a scaffold when the entry carries no compose document', async () => {
    const { service } = setup([
      ['FROM env_schema_var', []],
      ['FROM instance_env_value', []],
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(
      input({
        source: {
          path: 'scaffold',
          directory: '/srv/source/crm',
          composeFile: null,
          dockerfilePath: null,
          imageRef: 'seamnex/crm:1.0.0',
          policy: policy({}),
        },
      }),
    );

    const platform = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.platform.yml'), 'utf8'),
    ) as { services: Record<string, { image: string }> };

    expect(platform.services.app?.image).toBe('seamnex/crm:1.0.0');
    expect(set.imageRefs).toEqual(['seamnex/crm:1.0.0']);
  });

  it('reuses the stored set when the same content is rendered again', async () => {
    const { db, service } = setup([
      ...ENV_ROUTES,
      ['INSERT INTO render_set', []],
      ['WHERE instance_id = $1 AND content_hash = $2', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(input());

    expect(set.id).toBe('rs-1');
    expect(
      db.calls.some((call) => call.sql.includes('WHERE instance_id = $1 AND content_hash = $2')),
    ).toBe(true);
  });

  it('refuses when the set cannot be persisted at all', async () => {
    const { service } = setup([
      ...ENV_ROUTES,
      ['INSERT INTO render_set', []],
      ['WHERE instance_id = $1 AND content_hash = $2', []],
    ]);

    await expect(service.render(input())).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('refuses a catalogue httpPort that no service exposes, naming what each one does expose', async () => {
    const { service } = setup([...ENV_ROUTES]);

    await expect(
      service.render(
        input({
          httpPort: 8080,
          source: {
            path: 'compose',
            directory: '/srv/source/crm',
            composeFile: '/srv/source/crm/docker-compose.yml',
            dockerfilePath: null,
            imageRef: null,
            policy: policy({
              services: {
                app: { image: 'espocrm/espocrm:8.0.0', expose: ['80'] },
                worker: { image: 'espocrm/espocrm:8.0.0' },
              },
            }),
          },
        }),
      ),
    ).rejects.toThrow(/httpPort 8080.*app exposes 80.*worker exposes nothing/s);
  });
});

describe('service selection and build contexts', () => {
  function singleServiceCompose(service: Record<string, unknown>): RenderInput {
    return input({
      source: {
        path: 'compose',
        directory: '/srv/source/crm',
        composeFile: '/srv/source/crm/docker-compose.yml',
        dockerfilePath: null,
        imageRef: null,
        policy: policy({ services: { app: service } }),
      },
    });
  }

  it('aliases the slug on the only service of a single-service project that declares no expose', async () => {
    const { service } = setup([
      ['FROM env_schema_var', []],
      ['FROM instance_env_value', []],
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(singleServiceCompose({ image: 'seamnex/crm:1.0.0' }));
    const override = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.override.yml'), 'utf8'),
    ) as { services: Record<string, { networks: { default: { aliases: string[] } } }> };

    expect(override.services.app?.networks.default.aliases).toEqual(['crm']);
  });

  it('resolves a build without a declared context to the source directory itself', async () => {
    const { service } = setup([
      ['FROM env_schema_var', []],
      ['FROM instance_env_value', []],
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(singleServiceCompose({ build: { dockerfile: 'Dockerfile' } }));
    const platform = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.platform.yml'), 'utf8'),
    ) as { services: Record<string, { build: { context: string } }> };

    expect(platform.services.app?.build.context).toBe(join('/srv/source/crm', '.'));
  });

  it('leaves an absolute build context alone', async () => {
    const { service } = setup([
      ['FROM env_schema_var', []],
      ['FROM instance_env_value', []],
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(
      singleServiceCompose({ build: { context: '/srv/shared/base' } }),
    );
    const platform = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.platform.yml'), 'utf8'),
    ) as { services: Record<string, { build: { context: string } }> };

    expect(platform.services.app?.build.context).toBe('/srv/shared/base');
  });

  it('lists only the services that name an image', async () => {
    const { service } = setup([
      ['FROM env_schema_var', []],
      ['FROM instance_env_value', []],
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(
      input({
        source: {
          path: 'compose',
          directory: '/srv/source/crm',
          composeFile: '/srv/source/crm/docker-compose.yml',
          dockerfilePath: null,
          imageRef: null,
          policy: policy({
            services: {
              app: { image: 'espocrm/espocrm:8.0.0', expose: [80] },
              built: { build: { context: '.' } },
            },
          }),
        },
      }),
    );

    // A service with no image is not an image reference; it is built from its own context.
    expect(set.imageRefs).toEqual(['espocrm/espocrm:8.0.0']);
  });

  it('reads an empty stored value as an empty string rather than dropping the variable', async () => {
    const { service } = setup([
      ['FROM env_schema_var', [{ name: 'EMPTY', default_value: null }]],
      ['FROM instance_env_value', [{ var_name: 'EMPTY', value_enc: null }]],
      ['INSERT INTO render_set', [RENDER_ROW]],
      ['INSERT INTO render_file', []],
    ]);

    const set = await service.render(input());

    expect(readFileSync(join(set.directory, 'platform.env'), 'utf8')).toContain('EMPTY=');
  });

  it('falls back to the instance id for a stored row with no manifest', async () => {
    const { service } = setup([
      ['JOIN render_set r ON', [{ ...RENDER_ROW, files: null }]],
      [
        'FROM render_file WHERE render_set_id',
        [
          {
            path: 'docker-compose.platform.yml',
            sha256: 'a'.repeat(64),
            content: 'services: {}\n',
          },
        ],
      ],
    ]);

    const set = await service.applied('inst-1');

    expect(set?.composeProject).toContain('inst-1');
    expect(set?.imageRefs).toEqual([]);
    expect(set?.publishedPorts).toBe(0);
  });
});

describe('applied', () => {
  it('answers with the set the instance names as active', async () => {
    const { service } = setup([
      ['JOIN render_set r ON', [RENDER_ROW]],
      ['FROM render_file WHERE render_set_id', RENDER_ROW.files && []],
    ]);

    const set = await service.applied('inst-1');

    expect(set).toMatchObject({ id: 'rs-1', composeProject: 'seamnex-crm' });
  });

  it('falls back to the newest applied set for a row written before the pointer existed', async () => {
    const { service } = setup([
      ['JOIN render_set r ON', []],
      ['applied_at IS NOT NULL', [{ ...RENDER_ROW, applied_at: new Date('2026-01-01T00:00:00Z') }]],
      ['FROM render_file WHERE render_set_id', []],
    ]);

    await expect(service.applied('inst-1')).resolves.toMatchObject({ id: 'rs-1' });
  });

  it('answers null before the first deploy', async () => {
    const { service } = setup([
      ['JOIN render_set r ON', []],
      ['applied_at IS NOT NULL', []],
    ]);

    await expect(service.applied('inst-1')).resolves.toBeNull();
  });
});

describe('load', () => {
  it('re-materialises the stored files and re-counts the published ports from them', async () => {
    const { root, service } = setup([
      ['FROM render_set WHERE id = $1', [{ ...RENDER_ROW, files: {} }]],
      [
        'FROM render_file WHERE render_set_id',
        [
          {
            path: 'docker-compose.platform.yml',
            sha256: 'a'.repeat(64),
            content: 'services:\n  app:\n    ports:\n      - "8080:80"\n',
          },
          { path: 'platform.env', sha256: 'b'.repeat(64), content: 'A=b\n' },
        ],
      ],
    ]);

    const set = await service.load('rs-1');

    expect(set.directory).toBe(join(root, 'inst-1', 'render', 'rs-1'));
    // The manifest is absent, so the project name falls back to the instance id and the ports are
    // counted from the stored document rather than trusted from the manifest.
    expect(set.composeProject).toBe('seamnex-inst-1');
    expect(set.publishedPorts).toBe(1);
    expect(readFileSync(join(set.directory, 'platform.env'), 'utf8')).toBe('A=b\n');
  });

  it('reports a missing set as not found rather than starting a restore without it', async () => {
    const { service } = setup([['FROM render_set WHERE id = $1', []]]);

    await expect(service.load('rs-missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('treats an unparseable stored document as zero published ports', async () => {
    const { service } = setup([
      ['FROM render_set WHERE id = $1', [RENDER_ROW]],
      [
        'FROM render_file WHERE render_set_id',
        [{ path: 'docker-compose.platform.yml', sha256: 'a'.repeat(64), content: 'services: [' }],
      ],
    ]);

    await expect(service.load('rs-1')).resolves.toMatchObject({ publishedPorts: 0 });
  });
});

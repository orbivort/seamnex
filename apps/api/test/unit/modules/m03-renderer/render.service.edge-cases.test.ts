import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { fakeDb, type Route } from '../../../support/fakes';
import type { AppConfig } from '../../../../src/config/config';
import { RenderSetService } from '../../../../src/modules/m03-renderer/render.service';
import type { RenderInput } from '../../../../src/modules/m03-renderer/renderer.contract';

/**
 * The render-side fallbacks and refusals that `render.service.test.ts` does not reach: the defaults a
 * source that names nothing still has to produce (`Dockerfile`, the scaffold image tag), a document
 * with no services at all — refused with the port it failed to find rather than rendered without an
 * alias — two services competing for the product port, an `expose` written as a scalar, a port the
 * normalisation did not rewrite, and a stored document whose ports are counted from content that is
 * not a mapping. Each of these is a shape the catalogue or a hand-edited render set can produce.
 */
const dirs: string[] = [];

const RENDER_ROW = {
  id: 'rs-1',
  instance_id: 'inst-1',
  content_hash: 'hash-1',
  files: { composeProject: 'seamnex-crm', imageRefs: [], publishedPorts: 0 },
  applied_at: null,
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'seamnex-render-edge-'));
  dirs.push(directory);
  return directory;
}

const RENDER_ROUTES: readonly Route[] = [
  ['FROM env_schema_var', []],
  ['FROM instance_env_value', []],
  ['INSERT INTO render_set', [RENDER_ROW]],
  ['INSERT INTO render_file', []],
  ['FROM render_set WHERE id = $1', [{ ...RENDER_ROW, files: {} }]],
  ['FROM render_file WHERE render_set_id', []],
];

function setup(routes: readonly Route[] = RENDER_ROUTES) {
  const db = fakeDb(routes);
  const service = new RenderSetService(db.pool, {
    SEAMNEX_INSTANCE_DATA_DIR: root(),
  } as unknown as AppConfig);
  return { db, service };
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
    resources: { cpuMilli: 1_000, memoryMb: 512, diskMb: 1_024 },
    route: {
      host: 'crm.example.test',
      pathPrefix: null,
      publishModel: 'subdomain',
      tlsMode: 'acme',
      authMode: 'fa_header',
    },
    source: {
      path: 'compose',
      directory: '/srv/source/crm',
      composeFile: '/srv/source/crm/docker-compose.yml',
      dockerfilePath: null,
      imageRef: null,
      policy: policy({}),
    },
    ...overrides,
  };
}

function composeWith(
  document: Record<string, unknown>,
  overrides: Partial<RenderInput> = {},
): RenderInput {
  return input({
    ...overrides,
    source: {
      path: 'compose',
      directory: '/srv/source/crm',
      composeFile: '/srv/source/crm/docker-compose.yml',
      dockerfilePath: null,
      imageRef: null,
      policy: policy(document),
    },
  });
}

describe('documents a source that names nothing still has to produce', () => {
  it('falls back to a Dockerfile at the root of the source tree', async () => {
    const { service } = setup();

    const set = await service.render(
      input({
        source: {
          path: 'dockerfile',
          directory: '/srv/source/crm',
          composeFile: null,
          dockerfilePath: null,
          imageRef: null,
          policy: policy({}),
        },
      }),
    );

    const platform = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.platform.yml'), 'utf8'),
    ) as { services: Record<string, { image: string; build: { dockerfile: string } }> };

    // The upstream file has not been read at this point, so the conventional name is the only safe
    // default: a missing `dockerfilePath` must not render `build: { dockerfile: null }`.
    expect(platform.services.app?.build.dockerfile).toBe('Dockerfile');
    expect(platform.services.app?.image).toBe('seamnex/instance-inst-1:latest');
  });

  it('tags a scaffold with the instance id and inventories no image reference', async () => {
    const { service } = setup();

    const set = await service.render(
      input({
        source: {
          path: 'scaffold',
          directory: '/srv/source/crm',
          composeFile: null,
          dockerfilePath: null,
          imageRef: null,
          policy: policy({}),
        },
      }),
    );

    const platform = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.platform.yml'), 'utf8'),
    ) as { services: Record<string, { image: string }> };

    // `scaffold` and `dockerfile` differ only in the tag: nothing was pushed for either of them.
    expect(platform.services.app?.image).toBe('seamnex/instance-inst-1:scaffold');
    expect(set.imageRefs).toEqual([]);
  });

  it('inventories no image reference for a compose source that resolved without a compose file', async () => {
    const { service } = setup();

    const set = await service.render(
      input({
        source: {
          // Packaged as a compose entry, but this revision has no compose document to normalise, so
          // the scaffold path is taken and there is no service list to inventory images from.
          path: 'compose',
          directory: '/srv/source/crm',
          composeFile: null,
          dockerfilePath: null,
          imageRef: null,
          policy: policy({ version: '3.9' }),
        },
      }),
    );

    const platform = parseYaml(
      readFileSync(join(set.directory, 'docker-compose.platform.yml'), 'utf8'),
    ) as { services: Record<string, { image: string }> };

    expect(platform.services.app?.image).toBe('seamnex/instance-inst-1:scaffold');
    expect(set.imageRefs).toEqual([]);
  });
});

describe('a definition that cannot name the service answering the product port', () => {
  it('refuses a compose document that declares no services at all', async () => {
    const { service } = setup();

    await expect(service.render(composeWith({ version: '3.9' }))).rejects.toMatchObject({
      code: 'HTTP_PORT_NOT_EXPOSED',
      detail:
        'The catalogue entry declares httpPort 80, but no single service in the definition ' +
        'exposes it ().',
    });
  });

  it('refuses when two services both expose the product port, because the alias would be ambiguous', async () => {
    const { service } = setup();

    await expect(
      service.render(
        composeWith({
          services: {
            app: { image: 'seamnex/crm:1.0.0', expose: ['80'] },
            web: { image: 'seamnex/web:1.0.0', expose: ['80'] },
          },
        }),
      ),
    ).rejects.toThrow(/httpPort 80.*app exposes 80; web exposes 80/s);
  });

  it('reports a service whose expose is not a list, and one that is not a mapping, as exposing nothing', async () => {
    const { service } = setup();

    await expect(
      service.render(
        composeWith({
          services: {
            app: null,
            worker: { expose: '80' },
          },
        }),
      ),
    ).rejects.toThrow(/\(app exposes nothing; worker exposes nothing\)/);
  });
});

describe('published ports are counted from the document that is applied', () => {
  it('reports a port the normalisation did not rewrite', async () => {
    const { service } = setup();

    const set = await service.render(
      composeWith({
        services: { app: { image: 'seamnex/crm:1.0.0', expose: ['80'], ports: ['8080:80'] } },
      }),
    );

    // Invariant 9 is measured, not assumed: a document that still publishes is reported as such so
    // the pre-apply assertion can refuse it.
    expect(set.publishedPorts).toBe(1);
  });

  const STORED: readonly { readonly document: string; readonly ports: number }[] = [
    { document: 'just-a-scalar\n', ports: 0 },
    { document: 'version: "3.9"\n', ports: 0 },
    {
      document: 'services:\n  app:\n    ports:\n      - "8080:80"\n  worker:\n    image: x:1\n',
      ports: 1,
    },
    { document: 'services: [\n', ports: 0 },
  ];

  it.each(STORED)(
    'counts $ports published ports from the stored document content',
    async ({ document, ports }) => {
      const { service } = setup([
        ['FROM render_set WHERE id = $1', [{ ...RENDER_ROW, files: {} }]],
        [
          'FROM render_file WHERE render_set_id',
          [{ path: 'docker-compose.platform.yml', sha256: 'a'.repeat(64), content: document }],
        ],
      ]);

      await expect(service.load('rs-1')).resolves.toMatchObject({ publishedPorts: ports });
    },
  );
});

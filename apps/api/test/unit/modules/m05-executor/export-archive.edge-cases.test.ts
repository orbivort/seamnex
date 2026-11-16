import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  writeExportArchive,
  type ExportOptions,
  type ExportSubject,
} from '../../../../src/modules/m05-executor/export-archive';
import { readExportRecord } from '../../../../src/modules/m05-executor/instance-exports';

/**
 * FR-1.13 / AC-20 — the arms the capture takes when it cannot include something.
 *
 * The happy path is covered end to end through the pipeline; this suite is about the negative
 * space, which is where a manifest stops describing its archive: the definition gone from disk, a
 * helper that exits without a message, a dump that fails with something that is not an `Error`, and
 * a volume whose name is not safe as a file name.
 */
const DATA_DIR = join('temp', 'm05-export-archive-tests');
const SNAPSHOT = join(DATA_DIR, 'snapshot');
const INSTANCE_ID = '22222222-2222-4222-8222-222222222222';

/** The mount a `-v` argument names, spelled `[host]:[container]` — Windows drive letters included. */
const MOUNT = /^(.*):(\/[^:]*)(?::ro)?$/;

function mountsOf(args: readonly string[]): { host: string; target: string }[] {
  const mounts: { host: string; target: string }[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-v') continue;
    const match = MOUNT.exec(args[index + 1] ?? '');
    if (match?.[1] !== undefined && match[2] !== undefined) {
      mounts.push({ host: match[1], target: match[2] });
    }
  }
  return mounts;
}

function hostPathOf(args: readonly string[], containerPath: string): string | null {
  for (const mount of mountsOf(args)) {
    if (containerPath === mount.target) return mount.host;
    if (containerPath.startsWith(`${mount.target}/`)) {
      return join(mount.host, containerPath.slice(mount.target.length + 1));
    }
  }
  return null;
}

type FakeDocker = {
  readonly runCli: ReturnType<typeof vi.fn>;
  readonly volumeExists: ReturnType<typeof vi.fn>;
};

/**
 * What the helper containers do on a host: write the dump, pack the staging tree into the archive,
 * and — because the staging tree is removed by then — snapshot it for the README assertions.
 */
function fakeDocker(
  behaviour: { tarFails?: boolean; dumpThrows?: string; volumeHeld?: boolean } = {},
): FakeDocker {
  const runCli = vi.fn(async (_file: string, args: readonly string[]) => {
    const dumpTarget = /--file=(\S+)/.exec(args.join(' '));
    if (dumpTarget?.[1] !== undefined) {
      if (behaviour.dumpThrows !== undefined) throw behaviour.dumpThrows;
      const target = hostPathOf(args, dumpTarget[1]);
      if (target !== null) writeFileSync(target, 'CREATE TABLE crm (id integer);\n');
    }

    const tarIndex = args.indexOf('-czf');
    if (tarIndex !== -1) {
      if (behaviour.tarFails === true) {
        return { code: 1, stdout: '', stderr: '', truncated: false };
      }
      const source = hostPathOf(args, args[args.indexOf('-C') + 1] ?? '/src');
      if (source !== null && existsSync(source)) {
        rmSync(SNAPSHOT, { recursive: true, force: true });
        cpSync(source, SNAPSHOT, { recursive: true });
      }
      const target = hostPathOf(args, args[tarIndex + 1] ?? '');
      if (target !== null) writeFileSync(target, 'tar-bytes');
    }
    return { code: 0, stdout: '', stderr: '', truncated: false };
  });
  const volumeExists = vi.fn(async () => behaviour.volumeHeld ?? true);
  return { runCli, volumeExists };
}

function subject(overrides: Partial<ExportSubject> = {}): ExportSubject {
  return {
    instance: { id: INSTANCE_ID, slug: 'crm', entryKey: 'D01-01', state: 'ready' },
    renderSet: null,
    services: [],
    volumes: [],
    envRows: [],
    ...overrides,
  };
}

function options(docker: FakeDocker): ExportOptions {
  return { dataDir: DATA_DIR, pathMap: '', docker: docker as never };
}

function readme(): string {
  return readFileSync(join(SNAPSHOT, 'README.txt'), 'utf8');
}

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe('what the capture could not include', () => {
  it('names the definition and the volumes it left out, and says so in the read-me', async () => {
    const docker = fakeDocker();

    const artefact = await writeExportArchive(options(docker), subject());

    expect(artefact.includes).toEqual(['environment']);
    expect(artefact.excluded).toEqual([
      {
        item: 'volumes',
        reason:
          'the applied definition declares no named data volume, so there is no file data to capture',
      },
      { item: 'definition', reason: 'no render set has been applied for this instance' },
    ]);
    // The sidecar repeats the manifest and carries the numbers only the tar could know.
    await expect(
      readExportRecord(join(DATA_DIR, INSTANCE_ID, 'exports'), artefact.exportId),
    ).resolves.toMatchObject({ renderSet: null, includes: ['environment'] });

    const text = readme();
    expect(text).toContain('Render set: none');
    expect(text).toContain('Captured: environment (0 database dump(s), 0 volume(s))');
    expect(text).toContain('Deliberately not captured');
    expect(text).toContain('none declared');
  });

  it('names a render set whose directory is no longer on disk', async () => {
    const docker = fakeDocker();

    const artefact = await writeExportArchive(
      options(docker),
      subject({
        renderSet: {
          id: 'rs-000000000001',
          contentHash: 'hash-1',
          directory: join(DATA_DIR, 'render-set-that-was-pruned'),
          applied: false,
        },
      }),
    );

    expect(artefact.excluded).toEqual(
      expect.arrayContaining([
        {
          item: 'definition',
          reason: expect.stringContaining('is no longer on disk'),
        },
      ]),
    );
    expect(artefact.includes).not.toContain('definition');
    // The read-me must not imply the definition is what the product ran.
    expect(readme()).toContain('NOT applied');
  });
});

describe('what the capture includes', () => {
  it('packs the definition, one dump per database service and one archive per volume', async () => {
    const docker = fakeDocker();
    const renderDirectory = join(DATA_DIR, 'render', 'rs-000000000001');
    mkdirSync(renderDirectory, { recursive: true });
    writeFileSync(join(renderDirectory, 'docker-compose.platform.yml'), 'services: {}\n');

    const artefact = await writeExportArchive(
      options(docker),
      subject({
        renderSet: {
          id: 'rs-000000000001',
          contentHash: 'hash-1',
          directory: renderDirectory,
          applied: true,
        },
        // A product image is not a database: it must contribute no dump.
        services: [
          { service: 'db main', imageRef: 'postgres:16-alpine' },
          { service: 'web', imageRef: 'repo/crm:7.4' },
        ],
        // A name the daemon accepts but a file name does not is sanitised, not refused.
        volumes: ['seamnex-crm-db-data', 'vol 1!'],
      }),
    );

    expect(artefact.includes).toEqual(['database', 'volumes', 'definition', 'environment']);
    expect(artefact.excluded).toEqual([]);
    expect(docker.runCli.mock.calls.map((call) => call[1] as string[])).toEqual(
      expect.arrayContaining([
        expect.arrayContaining(['sh', '-c', expect.stringContaining('/backup/db_main.sql')]),
        expect.arrayContaining([expect.stringContaining('/out/seamnex-crm-db-data.tar.gz')]),
        expect.arrayContaining([expect.stringContaining('/out/vol_1_.tar.gz')]),
      ]),
    );
    expect(docker.volumeExists.mock.calls).toEqual([['seamnex-crm-db-data'], ['vol 1!']]);

    const text = readme();
    expect(text).toContain('Render set: rs-000000000001 (hash-1) — applied');
    expect(text).toContain('Captured: database, volumes, definition, environment');
    expect(text).not.toContain('Deliberately not captured');
  });
});

describe('a helper that fails', () => {
  it('reports an exit with no message as "no output" rather than an empty cause', async () => {
    const docker = fakeDocker({ tarFails: true });

    await expect(writeExportArchive(options(docker), subject())).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: 'The export helper exited with 1: no output',
    });
  });

  it('reports a dump that failed with something that is not an Error', async () => {
    const docker = fakeDocker({ dumpThrows: 'the socket closed' });

    await expect(
      writeExportArchive(
        options(docker),
        subject({ services: [{ service: 'db', imageRef: 'postgres:16-alpine' }] }),
      ),
    ).rejects.toMatchObject({
      code: 'STATE_CONFLICT',
      detail: expect.stringContaining('the socket closed'),
    });
  });
});

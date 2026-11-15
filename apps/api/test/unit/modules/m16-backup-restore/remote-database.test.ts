import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dumpRemoteDatabase,
  remoteDatabase,
  restoreRemoteDatabase,
  type RemoteDatabaseInput,
} from '../../../../src/modules/m16-backup-restore/remote-database';

/**
 * The dump/restore helper is the one place a database password could leak: into `docker run -e`, into
 * a process argument, or into a log line. Every test here is about the mechanism rather than the SQL —
 * where the credential travels, which mount the daemon is given, and that the file is gone whether the
 * command worked or not. `runOrThrow` is stubbed because spawning Docker is not the subject.
 */
const state = vi.hoisted(() => ({ runOrThrow: vi.fn() }));

vi.mock('../../../../src/common/exec/exec', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, runOrThrow: state.runOrThrow };
});

const SCRATCH = mkdtempSync(join(tmpdir(), 'seamnex-remote-db-'));

function input(overrides: Partial<RemoteDatabaseInput> = {}): RemoteDatabaseInput {
  return {
    what: 'the platform database',
    setting: 'SEAMNEX_PLATFORM_DB_URL',
    url: 'postgres://owner:p%40ss@127.0.0.1:5432/seamnex_platform',
    directory: join(SCRATCH, 'restore'),
    passFileName: '.pgpass',
    dumpFileName: 'platform.dump',
    dockerHost: 'unix:///var/run/docker.sock',
    pathMap: '',
    ...overrides,
  };
}

function argv(): string[] {
  return (state.runOrThrow.mock.calls[0]?.[1] ?? []) as string[];
}

beforeEach(() => {
  state.runOrThrow.mockReset();
  state.runOrThrow.mockResolvedValue({ code: 0, stdout: '', stderr: '', truncated: false });
  rmSync(join(SCRATCH, 'restore'), { recursive: true, force: true });
  rmSync(join(SCRATCH, 'mapped'), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('remoteDatabase', () => {
  it('splits the URL, decoding the credential it will write to the password file', () => {
    expect(remoteDatabase('postgres://user:p%40ss@db.example:6543/app')).toEqual({
      host: 'db.example',
      port: '6543',
      database: 'app',
      user: 'user',
      password: 'p@ss',
    });
  });

  it('falls back to the default port and database', () => {
    expect(remoteDatabase('postgres://user:pass@127.0.0.1')).toMatchObject({
      port: '5432',
      database: 'postgres',
    });
  });
});

describe('dumpRemoteDatabase', () => {
  it('writes a 0600 password file, passes it by reference and removes it afterwards', async () => {
    const directory = join(SCRATCH, 'restore');
    const target = input({ directory });

    await dumpRemoteDatabase(target);

    expect(argv()).toEqual(
      expect.arrayContaining([
        'pg_dump',
        '--format=custom',
        '--file=/backup/platform.dump',
        '-e',
        'PGPASSFILE=/backup/.pgpass',
        '-e',
        'PGHOST=127.0.0.1',
        '-e',
        'PGDATABASE=seamnex_platform',
      ]),
    );
    // The file existed while the command ran and is gone now — including on the failure path below.
    expect(existsSync(join(directory, '.pgpass'))).toBe(false);
  });

  it('never puts the password in the argv or the container environment', async () => {
    await dumpRemoteDatabase(input({ directory: join(SCRATCH, 'restore') }));

    const flat = argv().join(' ');
    expect(flat).not.toContain('p@ss');
    expect(flat).not.toContain('p%40ss');
    // Only the reference travels; the value stays in the mounted file.
    expect(argv().filter((argument) => argument.startsWith('PGPASSWORD'))).toEqual([]);
  });

  it('removes the password file when the dump fails', async () => {
    const directory = join(SCRATCH, 'restore');
    state.runOrThrow.mockRejectedValueOnce(new Error('pg_dump exited 1'));

    await expect(dumpRemoteDatabase(input({ directory }))).rejects.toThrow('pg_dump exited 1');

    expect(existsSync(join(directory, '.pgpass'))).toBe(false);
  });

  it('refuses an address the host network cannot resolve, naming the setting', async () => {
    await expect(
      dumpRemoteDatabase(input({ url: 'postgres://owner:pw@postgres:5432/platform' })),
    ).rejects.toMatchObject({
      code: 'ADAPTER_UNAVAILABLE',
      detail: expect.stringContaining('SEAMNEX_PLATFORM_DB_URL'),
      remediation: expect.stringContaining('127.0.0.1'),
    });
    expect(state.runOrThrow).not.toHaveBeenCalled();
  });

  it('mounts the host spelling of the scratch directory', async () => {
    const directory = join(SCRATCH, 'restore');
    await dumpRemoteDatabase(
      input({ directory, pathMap: `${directory}=${join(SCRATCH, 'mapped')}` }),
    );

    expect(argv()).toContain(`${join(SCRATCH, 'mapped')}:/backup`);
  });

  it('writes the password file with owner-only permissions', async () => {
    const directory = join(SCRATCH, 'restore');
    let mode = -1;
    state.runOrThrow.mockImplementation(async () => {
      mode = statSync(join(directory, '.pgpass')).mode & 0o777;
      return { code: 0, stdout: '', stderr: '', truncated: false };
    });

    await dumpRemoteDatabase(input({ directory }));

    // A Windows filesystem reports 0666 for everything; POSIX is where the check has meaning.
    if (process.platform !== 'win32') expect(mode).toBe(0o600);
    expect(state.runOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe('restoreRemoteDatabase', () => {
  it('restores with --clean --if-exists in one transaction, keeping privileges', async () => {
    await restoreRemoteDatabase(
      input({
        url: 'postgres://seamnex_owner:pw@127.0.0.1:5432/plat',
        setting: 'SEAMNEX_PLATFORM_RESTORE_DB_URL',
        dumpFileName: 'platform.dump',
      }),
    );

    expect(argv()).toEqual(
      expect.arrayContaining([
        'pg_restore',
        '--clean',
        '--if-exists',
        '--single-transaction',
        'postgres:18-alpine',
      ]),
    );
    // `--no-privileges` would drop the grants the application role needs to read its own tables.
    expect(argv()).not.toContain('--no-privileges');
    expect(argv()).not.toContain('--no-acl');
  });

  it('names the target database and passes the archive positionally', async () => {
    await restoreRemoteDatabase(
      input({ url: 'postgres://owner:pw@127.0.0.1:5432/plat', dumpFileName: 'platform.dump' }),
    );

    const args = argv();
    // `pg_restore --dbname=/backup/platform.dump` with no file argument read the archive from
    // stdin, which is empty under `docker run`: the restore failed with "input file is too short
    // (read 0, expected 5)" on a set that had captured perfectly. The database is named because
    // `pg_restore`, unlike `psql`, does not take its target from `PGDATABASE`.
    expect(args[args.length - 1]).toBe('/backup/platform.dump');
    expect(args[args.indexOf('--dbname') + 1]).toBe('plat');
    expect(args.some((arg) => arg.startsWith('--dbname='))).toBe(false);
  });

  it('runs on the host network so the password file can be mounted', async () => {
    await restoreRemoteDatabase(input());

    expect(argv()).toEqual(expect.arrayContaining(['--network', 'host']));
  });
});

import { join } from 'node:path';
import { ensureDir, removeQuietly, writeFileAtomic } from '../../common/fs/files';
import { runOrThrow } from '../../common/exec/exec';
import { dockerMountSource } from '../../common/docker/mount';
import { AppError } from '../../common/problem/app-error';

/**
 * Platform-owned PostgreSQL databases, dumped and restored through ephemeral helper containers.
 *
 * The credential never travels in `docker run -e`: that would put a database password into the
 * container's Config.Env, readable by anything that can talk to the shared daemon, and a process
 * argument is worse — it is visible in `ps` to every user on the host. A 0600 password file in the
 * mounted scratch directory is the mechanism psql already uses; it is removed as soon as the call
 * returns, including when the call fails.
 *
 * Both directions live in one file because they must agree: a dump the restore cannot load is not a
 * backup, and the two disagreeing about the mount, the encoding or the credential is a failure that
 * only shows up during a disaster.
 */

export type RemoteDatabaseInput = {
  /** The sentence a refusal uses: "the platform database", "the identity-provider database". */
  readonly what: string;
  /** The setting the address came from, so the operator knows what to correct. */
  readonly setting: string;
  readonly url: string;
  /** Scratch directory mounted at `/backup` inside the helper. */
  readonly directory: string;
  /** File name of the 0600 password file, e.g. `.pgpass`. */
  readonly passFileName: string;
  /** File name of the dump inside `directory`, e.g. `platform.dump`. */
  readonly dumpFileName: string;
  readonly dockerHost: string;
  /** `SEAMNEX_DOCKER_PATH_MAP`: the host spelling of the scratch directory. */
  readonly pathMap: string;
};

/** A database address the helper can reach from the host network. */
const HOST_REACHABLE_DATABASE_HOSTS = ['127.0.0.1', 'localhost', '::1', 'host.docker.internal'];

/**
 * `pg_dump --format=custom` into `<directory>/<dumpFileName>`.
 *
 * The address comes from a platform setting rather than `DATABASE_URL` for the identity provider:
 * Keycloak has its own role and database, and a derived URL would dump the wrong database under the
 * right label.
 */
export async function dumpRemoteDatabase(input: RemoteDatabaseInput): Promise<void> {
  await runWithPasswordFile(input, () => [
    'pg_dump',
    '--format=custom',
    `--file=/backup/${input.dumpFileName}`,
  ]);
}

/**
 * `pg_restore --clean --if-exists` from `<directory>/<dumpFileName>`.
 *
 * `--clean --if-exists` makes the restore converge on the dump rather than fail on the objects the
 * target already has, and `--single-transaction` means a failure leaves the previous contents
 * instead of half of each. `--no-owner` is deliberate: the restore is run with an owner credential
 * that may be named differently on the target host, and "role seamnex_owner does not exist" would
 * abort an otherwise valid set. Privileges are **kept**: the dump carries the grants the application
 * role needs, and a restore that dropped them would leave a platform that cannot read its own tables.
 *
 * Two argument facts, both learned the hard way against a live set. The archive is **positional**:
 * `--dbname` takes a database or a connection string, not a file, and handing it the dump path made
 * `pg_restore` read the archive from stdin — which is empty under `docker run` — and fail with
 * "input file is too short (read 0, expected 5)" on a set that had captured perfectly. And
 * `--dbname` is **required**: unlike `psql`, `pg_restore` does not take its target from `PGDATABASE`,
 * so without it the same command fails with "one of -d/--dbname and -f/--file must be specified".
 * The database name is not a secret; the password stays in the 0600 file.
 *
 * It needs an owner role. The application role has no DDL rights and cannot write `audit_event`
 * (migration `0010_grants`), so `SEAMNEX_PLATFORM_RESTORE_DB_URL` is the only setting that may be
 * passed here.
 */
export async function restoreRemoteDatabase(input: RemoteDatabaseInput): Promise<void> {
  await runWithPasswordFile(input, (target) => [
    'pg_restore',
    '--clean',
    '--if-exists',
    '--no-owner',
    '--single-transaction',
    '--dbname',
    target.database,
    `/backup/${input.dumpFileName}`,
  ]);
}

/**
 * The shared shell: refuse an unreachable address, write the credential, run, and always remove it.
 *
 * The reachability guard exists because a compose service name (`postgres`) does not resolve on the
 * host network. Without it the operator reads a psql error raised inside a helper container, which
 * names neither the setting nor the fix.
 */
async function runWithPasswordFile(
  input: RemoteDatabaseInput,
  command: (target: { readonly database: string }) => string[],
): Promise<void> {
  const connection = remoteDatabase(input.url);
  if (!HOST_REACHABLE_DATABASE_HOSTS.includes(connection.host)) {
    throw new AppError({
      code: 'ADAPTER_UNAVAILABLE',
      detail: `A platform backup or restore needs a host-reachable database address; ${input.setting} points at "${connection.host}".`,
      remediation: `Use the published localhost address (for example postgres://…@127.0.0.1:5432/…) for ${input.what}, or mount the password another way.`,
    });
  }
  const environment: Record<string, string> = {
    PGPASSFILE: `/backup/${input.passFileName}`,
    PGHOST: connection.host,
    PGPORT: connection.port,
    PGDATABASE: connection.database,
    PGUSER: connection.user,
  };
  // The scratch tree may not exist yet on a restored host; creating it here means the credential
  // cannot fail to be written for a reason the caller would have to know about.
  ensureDir(input.directory);
  const passFile = join(input.directory, input.passFileName);
  writeFileAtomic(
    passFile,
    `${connection.host}:${connection.port}:${connection.database}:${connection.user}:${connection.password}\n`,
    0o600,
  );
  try {
    await runOrThrow(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '-v',
        `${dockerMountSource(input.directory, input.pathMap)}:/backup`,
        ...Object.entries(environment).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        'postgres:18-alpine',
        ...command(connection),
      ],
      {
        env: { PATH: process.env.PATH ?? '', DOCKER_HOST: input.dockerHost },
        timeoutMs: 900_000,
      },
    );
  } finally {
    removeQuietly(passFile);
  }
}

/**
 * A platform-owned database as pg_dump needs it. A URL with credentials in the userinfo is split
 * here so the password can go to a 0600 file instead of a process argument or container env.
 */
export function remoteDatabase(url: string): {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port.length === 0 ? '5432' : parsed.port,
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

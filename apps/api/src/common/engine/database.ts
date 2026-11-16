/**
 * What the platform knows about a product's database engine, in one place.
 *
 * Two callers need the same four answers — which engine an image runs, how to dump it, how to load
 * that dump back, and which environment a client needs to reach it: the backup runner (M16, whose
 * dump has to be restorable) and the export writer (M05, FR-1.13, whose dump has to be *readable*
 * outside the platform). They are two modules, and M05 may not import M16 (`module-boundaries.json`),
 * so the knowledge lives here rather than being copied. A copy is how "the dump no longer matches
 * the restore" becomes a defect nobody owns.
 *
 * Everything here is pure: a caller supplies rows it already read.
 */

export type DatabaseEngine = 'postgres' | 'mysql' | 'mariadb';

/**
 * The engine a service image runs, from its reference.
 *
 * The image is the authority: the service name is a compose key the entry author chose (`db`,
 * `database`, `mariadb`), while the image is what will answer on the port.
 */
export function engineOf(imageRef: string): DatabaseEngine | null {
  if (/postgres/i.test(imageRef)) return 'postgres';
  if (/mariadb/i.test(imageRef)) return 'mariadb';
  if (/mysql/i.test(imageRef)) return 'mysql';
  return null;
}

/**
 * `custom` is the restorable form (`pg_restore`); `plain` is the portable one — SQL text a recipient
 * can read, diff and load with `psql` without this platform's tooling. A backup is custom because
 * only the platform loads it again; an export is plain because leaving the platform is the point.
 */
export type DumpFormat = 'custom' | 'plain';

export function dumpCommand(
  engine: DatabaseEngine,
  target: string,
  format: DumpFormat = 'custom',
): string[] {
  if (engine === 'postgres') {
    return format === 'plain'
      ? ['sh', '-c', `pg_dump --no-owner --no-privileges --dbname="$PGURL" --file=${target}`]
      : ['sh', '-c', `pg_dump --format=custom --dbname="$PGURL" --file=${target}`];
  }
  return [
    'sh',
    '-c',
    `mysqldump --single-transaction --all-databases -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" > ${target}`,
  ];
}

/** The suffix a dump of this format carries; also what the export manifest records. */
export function dumpExtension(format: DumpFormat): string {
  return format === 'plain' ? 'sql' : 'dump';
}

/**
 * The inverse of `dumpCommand` — the other half of "a dump the restore cannot load is not a backup".
 *
 * PostgreSQL is restored with `--clean --if-exists`, so the dump converges on the instance's database
 * instead of failing on the tables the installer already created, and with `--no-owner` because the
 * dump names the role that took it, which does not exist on a restored host. MySQL's all-databases
 * dump carries its own `CREATE DATABASE`/`USE` statements, so it is fed back through the client
 * unchanged.
 */
export function restoreCommand(engine: DatabaseEngine, target: string): string[] {
  if (engine === 'postgres') {
    return ['sh', '-c', `pg_restore --clean --if-exists --no-owner --dbname="$PGURL" ${target}`];
  }
  return ['sh', '-c', `mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" < ${target}`];
}

export type ConnectionRow = {
  readonly var_name: string;
  readonly value_enc: Buffer | null;
};

/**
 * The environment a database client inside a helper container needs, from the instance's stored
 * values.
 *
 * Non-secret rows only: the caller's query excludes `source = 'secret'`, because a secret's value is
 * not in `value_enc` and a mask cannot open a connection. PostgreSQL gets `PGURL`; MySQL and MariaDB
 * keep their own `MYSQL_*`/`MARIADB_*` names because `mysqldump` reads them.
 */
export function connectionEnvFrom(
  rows: readonly ConnectionRow[],
  engine: DatabaseEngine,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const row of rows) {
    const value = row.value_enc?.toString('utf8') ?? '';
    if (row.var_name === 'DATABASE_URL' && value.length > 0) env.PGURL = value;
    if (engine !== 'postgres' && /^MYSQL_|^MARIADB_/.test(row.var_name))
      env[row.var_name] = value;
  }
  if (engine === 'postgres' && env.PGURL === undefined) {
    // The catalog's own convention for a product database reached from its compose network: the
    // service is named `db`, the superuser is `postgres`, and the product has no password of its own.
    env.PGURL = 'postgres://postgres@db:5432/postgres';
  }
  return env;
}

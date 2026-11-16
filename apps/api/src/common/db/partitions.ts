import type { Pool } from 'pg';

/**
 * Partition upkeep for the two partitioned log tables (design §7.2).
 *
 * It lives here rather than in the scheduler because a restore replaces the platform database: the
 * dump carries the partitions that existed when it was taken, so a set older than the lookahead
 * window comes back without today's `job_log` partition, and every log append — and every audited
 * mutation, through `audit_event` — then fails closed. The restore stage has to re-run exactly this
 * upkeep after `pg_restore`, and two copies of the naming rule would eventually disagree about a
 * partition name, which no gate would catch.
 *
 * Creation goes through the `SECURITY DEFINER` function `seamnex_ensure_partition`: the application
 * role holds no DDL rights, and must not be granted any just to keep the log writable.
 */
export async function ensurePlatformPartitions(pool: Pool, lookaheadDays: number): Promise<void> {
  const today = utcDayStart(new Date());

  for (let offset = 0; offset <= lookaheadDays; offset += 1) {
    const from = addDays(today, offset);
    // The casts are required: an untyped parameter cannot resolve the function overload.
    await pool.query(
      'SELECT seamnex_ensure_partition($1::text, $2::text, $3::timestamptz, $4::timestamptz)',
      ['job_log', `job_log_p${formatDay(from)}`, from, addDays(today, offset + 1)],
    );
  }

  // Audit partitions are monthly; three months of lookahead is the design's floor.
  for (let offset = 0; offset <= 2; offset += 1) {
    const from = addMonths(today, offset);
    await pool.query(
      'SELECT seamnex_ensure_partition($1::text, $2::text, $3::timestamptz, $4::timestamptz)',
      [
        'audit_event',
        `audit_event_p${from.getUTCFullYear()}${String(from.getUTCMonth() + 1).padStart(2, '0')}`,
        from,
        addMonths(today, offset + 1),
      ],
    );
  }
}

/**
 * Drops `job_log` partitions past the retention window and returns their names.
 *
 * The caller logs them: a retention pass that silently removes a day is indistinguishable from one
 * that never ran, and the setting has no other consumer. Dropped through the definer function
 * because the API role does not own the partition.
 */
export async function dropExpiredJobLogPartitions(
  pool: Pool,
  retentionDays: number,
): Promise<string[]> {
  const result = await pool.query<{ partition: string }>(
    `SELECT child.relname AS partition
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE parent.relname = 'job_log'`,
  );

  const cutoff = addDays(utcDayStart(new Date()), -retentionDays);
  const dropped: string[] = [];

  for (const { partition } of result.rows) {
    const match = /^job_log_p(\d{4})(\d{2})(\d{2})$/.exec(partition);
    if (match === null) continue;
    const [, year, month, day] = match;
    const partitionDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
    if (partitionDate >= cutoff) continue;
    await pool.query('SELECT seamnex_drop_partition($1::text, $2::text)', ['job_log', partition]);
    dropped.push(partition);
  }

  return dropped;
}

/**
 * NFR-4.10 — "retained ≥ 12 months", as a floor rather than a default.
 *
 * It is enforced twice on purpose: the settings schema refuses a shorter period at write time, and
 * the drop refuses to run below it, because a value that reached the table another way (a restore, a
 * seed, a migration) must not be able to delete evidence the requirement says must exist.
 */
export const AUDIT_RETENTION_FLOOR_DAYS = 365;

/**
 * Drops whole `audit_event` months past the retention window and returns their names.
 *
 * The monthly sibling of the job-log pass, and the consumer `audit_retention_days` never had: the
 * setting was displayed in the console and read by nobody while audit partitions accumulated
 * forever. The caller audits the returned names — a retention pass that silently removes a month is
 * indistinguishable from one that never ran, which is the reason the job-log pass returns them too.
 *
 * A partition goes only when *every* instant it can hold is older than the cutoff: comparing the
 * month's start would drop the month containing the cutoff, which is a 30-day over-deletion.
 * Dropped through the definer function because the API role does not own the partition, and
 * `audit_anchor` rows are never touched — an anchor is the evidence that the month existed.
 */
export async function dropExpiredAuditEventPartitions(
  pool: Pool,
  retentionDays: number,
): Promise<string[]> {
  if (retentionDays < AUDIT_RETENTION_FLOOR_DAYS) {
    throw new RangeError(
      `refusing to apply an audit retention of ${retentionDays} days; NFR-4.10 requires at least ${AUDIT_RETENTION_FLOOR_DAYS}`,
    );
  }

  const result = await pool.query<{ partition: string }>(
    `SELECT child.relname AS partition
       FROM pg_inherits
       JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
       JOIN pg_class child ON child.oid = pg_inherits.inhrelid
      WHERE parent.relname = 'audit_event'`,
  );

  const cutoff = addDays(utcDayStart(new Date()), -retentionDays);
  const dropped: string[] = [];

  for (const { partition } of result.rows) {
    const match = /^audit_event_p(\d{4})(\d{2})$/.exec(partition);
    if (match === null) continue;
    const start = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
    if (addMonths(start, 1) > cutoff) continue;
    await pool.query('SELECT seamnex_drop_partition($1::text, $2::text)', [
      'audit_event',
      partition,
    ]);
    dropped.push(partition);
  }

  return dropped;
}

function utcDayStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function addMonths(date: Date, months: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatDay(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
}

import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  useCreateBackup,
  useInstanceBackups,
  useJob,
  useRestoreBackup,
  useUpdateBackupSchedule,
  useVerifyBackup,
} from '@seamnex/api-client';
import type { Backup, InstanceDetail } from '@seamnex/domain';
import { can, canMutate } from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  Callout,
  Checkbox,
  DataTable,
  Drawer,
  EmptyState,
  Field,
  InlineNote,
  Input,
  Panel,
  PanelHeader,
  SkeletonLines,
  defineColumns,
  type Column,
} from '@seamnex/ui';
import { formatBytes, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { useSession } from '../../../session';

const backupRowKey = (row: Backup) => row.id;

/**
 * Backup sets are read-only rows: the two controls that act on a row live in their own column,
 * because they close over this panel's mutations. Everything hoisted here reads only its row.
 */
const backupColumns = defineColumns<Backup>([
  {
    id: 'id',
    header: 'Backup set',
    mono: true,
    cell: (row) => <span className="text-micro text-text">{row.id}</span>,
  },
  {
    id: 'state',
    header: 'State',
    cell: (row) => (
      <Badge
        tone={row.state === 'succeeded' ? 'positive' : row.state === 'failed' ? 'danger' : 'info'}
        size="sm"
      >
        {row.state}
      </Badge>
    ),
  },
  {
    id: 'size',
    header: 'Size',
    hideBelow: 'md',
    cell: (row) => (
      <span className="font-mono text-micro text-muted">{formatBytes(row.sizeBytes)}</span>
    ),
  },
  {
    id: 'created',
    header: 'Started',
    hideBelow: 'lg',
    cell: (row) => <span className="text-micro text-muted">{formatRelative(row.startedAt)}</span>,
  },
  {
    id: 'verified',
    header: 'Verified restore',
    hideBelow: 'md',
    cell: (row) =>
      row.verifiedAt ? (
        <span className="text-micro text-success">{formatRelative(row.verifiedAt)}</span>
      ) : (
        <span className="text-micro text-warning-strong">not verified</span>
      ),
  },
]);

export function BackupsTab({ instance }: { instance: InstanceDetail }) {
  const { session } = useSession();
  const backups = useInstanceBackups(instance.id);
  const create = useCreateBackup(instance.id);
  const verify = useVerifyBackup(instance.id);
  const restore = useRestoreBackup(instance.id);
  const scheduleUpdate = useUpdateBackupSchedule(instance.id);
  const canBackup = can(session.role, 'instance.backup');
  const canRestore = canMutate(session.role, 'instance.backup');
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [schedule, setSchedule] = useState(instance.backup.schedule);
  const [timezone, setTimezone] = useState(instance.backup.scheduleTimezone);
  const [scheduleEnabled, setScheduleEnabled] = useState(instance.backup.scheduleEnabled);

  // Verify and restore are 202 job hand-offs: the row state only changes when the job is done, so
  // the table is refreshed on the terminal state rather than optimistically.
  const verifyJob = useJob(verify.data?.jobId ?? '');
  const restoreJob = useJob(restore.data?.jobId ?? '');
  const verifyState = verifyJob.data?.state ?? null;
  const restoreState = restoreJob.data?.state ?? null;
  const refetchBackups = backups.refetch;

  useEffect(() => {
    if (verifyState === null || verifyState === 'queued' || verifyState === 'running') return;
    void refetchBackups();
  }, [verifyState, refetchBackups]);

  useEffect(() => {
    if (restoreState === null || restoreState === 'queued' || restoreState === 'running') return;
    void refetchBackups();
  }, [restoreState, refetchBackups]);

  /**
   * The two callbacks and their pending flags are read out of the mutation results because they are
   * the only stable parts of them: a mutation result is a fresh object on every render, so putting
   * `verify`/`restore` in the dependency list would rebuild this array anyway.
   */
  const { mutate: verifyBackup, isPending: verifying } = verify;
  const { mutate: restoreBackup, isPending: restoring } = restore;

  // R2: the actions column drives two mutations and their pending flags, so the array stays in a
  // memo with the exact fields it reads rather than being hoisted with a stale copy of them.
  const columns = useMemo<Column<Backup>[]>(
    () => [
      ...backupColumns,
      {
        id: 'actions',
        header: '',
        align: 'right',
        cell: (row) =>
          canRestore ? (
            <div className="flex justify-end gap-1">
              <Button
                size="sm"
                variant="quiet"
                disabled={verifying}
                onClick={() => verifyBackup(row.id)}
              >
                Verify
              </Button>
              <Button
                size="sm"
                variant="quiet"
                disabled={restoring}
                onClick={() => restoreBackup(row.id)}
              >
                Restore
              </Button>
            </div>
          ) : (
            <span className="text-micro text-faint">admin only</span>
          ),
      },
    ],
    [canRestore, restoring, restoreBackup, verifying, verifyBackup],
  );

  // Undefined while loading: the header keeps its primary then, so the panel does not lose and
  // regain it around the first read.
  const showHeaderBackup = backups.data === undefined || backups.data.length > 0;

  return (
    <Panel>
      {/* FR-1.12 · FR-2.7 — requirement ids, developer-only; they used to be the panel eyebrow. */}
      <PanelHeader
        title="Backup and restore"
        description="Database-consistent dumps plus volume capture, encrypted and stored off-host. Restores are verified on a scratch stack."
        actions={
          <>
            <span className="mr-2 hidden font-mono text-micro text-faint sm:inline">
              {instance.backup.schedule} · {instance.backup.scheduleTimezone}
              {instance.backup.scheduleEnabled ? '' : '· disabled'}
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={!canRestore}
              title={
                canRestore
                  ? 'Change the scheduled cadence'
                  : 'Only a platform administrator can change the schedule'
              }
              onClick={() => setScheduleOpen(true)}
            >
              Schedule
            </Button>
            {/* The empty state carries this same primary below. Two identical CTAs 400px apart
                for the one action on the panel is a choice, not a shortcut: it stays in the
                header once there is a table to act on, and the empty state owns it until then. */}
            {canBackup && showHeaderBackup ? (
              <Button
                size="sm"
                variant="primary"
                icon={<Plus />}
                disabled={create.isPending}
                onClick={() => create.mutate()}
              >
                Back up now
              </Button>
            ) : null}
          </>
        }
      />
      {create.isError ? (
        <div className="p-3">
          <QueryError error={create.error} compact />
        </div>
      ) : null}
      {create.data ? (
        <div className="px-3 pt-3">
          <Alert tone="positive" title={`Backup job ${create.data.jobId} accepted`}>
            A database-consistent dump plus volume capture is queued; the set appears in the table
            when it completes.
          </Alert>
        </div>
      ) : null}
      {verify.isError ? (
        <div className="p-3">
          <QueryError error={verify.error} compact />
        </div>
      ) : null}
      {restore.isError ? (
        <div className="p-3">
          <QueryError error={restore.error} compact />
        </div>
      ) : null}
      {verify.data ? (
        <div className="px-3 pt-3">
          <Callout tone="positive" title={`Verification job ${verify.data.jobId} accepted`}>
            The scratch-stack restore runs as a job. The verified timestamp appears on the backup
            set when it finishes; follow the job for the step-by-step log.
          </Callout>
        </div>
      ) : null}
      {restore.data ? (
        <div className="px-3 pt-3">
          <Callout tone="info" title={`Restore job ${restore.data.jobId} accepted`}>
            The identity provider restores first and products last. Routes stay unpublished until an
            administrative login succeeds; the job log records each step.
          </Callout>
        </div>
      ) : null}
      <AsyncPanel
        query={backups}
        loading={
          <div className="p-4">
            <SkeletonLines lines={5} />
          </div>
        }
        loadingLabel="Loading the backup sets"
        renderError={(error, retry) => (
          <div className="p-4">
            <QueryError error={error} onRetry={retry} />
          </div>
        )}
        empty={(rows) =>
          rows.length === 0 && (
            <div className="p-4">
              {/* FR-1.12: the empty copy used to read "FR-1.12 requires a scheduled and an
                  on-demand backup. …" */}
              <EmptyState
                title="No backup set yet"
                description="A scheduled and an on-demand backup are required. Take the first one now, or wait for the next scheduled run."
                action={
                  canBackup ? (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => create.mutate()}
                      disabled={create.isPending}
                    >
                      Back up now
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )
        }
      >
        {(rows) => <DataTable columns={columns} rows={rows} rowKey={backupRowKey} dense />}
      </AsyncPanel>

      <Drawer
        open={scheduleOpen}
        onOpenChange={(open) => (open ? undefined : setScheduleOpen(false))}
        title="Scheduled backups"
        description="The cadence is stored in UTC and expressed in the chosen IANA zone. A change is audited."
        footer={
          <>
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={scheduleUpdate.isPending || schedule.trim().length < 3}
              onClick={() => {
                scheduleUpdate.mutate(
                  {
                    schedule: schedule.trim(),
                    timezone: timezone.trim(),
                    enabled: scheduleEnabled,
                  },
                  { onSuccess: () => setScheduleOpen(false) },
                );
              }}
            >
              {scheduleUpdate.isPending ? 'Saving…' : 'Save schedule'}
            </Button>
          </>
        }
      >
        {scheduleUpdate.isError ? <QueryError error={scheduleUpdate.error} compact /> : null}
        <div className="space-y-4">
          <Field
            label="Cadence"
            htmlFor="backup-schedule"
            hint="A human-readable cadence, e.g. Daily 02:00."
          >
            <Input
              id="backup-schedule"
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
            />
          </Field>
          <Field
            label="Timezone"
            htmlFor="backup-timezone"
            hint="IANA zone. Times are stored in UTC and rendered in this zone."
          >
            <Input
              id="backup-timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
            />
          </Field>
          <Checkbox
            id="backup-enabled"
            label="Schedule is active"
            description="When disabled, only on-demand backups run."
            checked={scheduleEnabled}
            onChange={(event) => setScheduleEnabled(event.target.checked)}
          />
          <InlineNote>
            Last successful backup{' '}
            {instance.backup.lastSuccessAt
              ? formatRelative(instance.backup.lastSuccessAt)
              : 'never'}
            ; last verified restore {instance.backup.verified ? 'recorded' : 'missing'}.
          </InlineNote>
        </div>
      </Drawer>
    </Panel>
  );
}

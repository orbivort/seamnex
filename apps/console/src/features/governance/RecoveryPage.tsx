import { useEffect, useMemo, useState } from 'react';
import { ArchiveRestore, CheckCircle2, CircleDashed, Loader2, Plus, XCircle } from 'lucide-react';
import {
  toProblem,
  useCreatePlatformBackup,
  useInstances,
  useJob,
  useRecovery,
  useRestoreStatus,
  useScheduleDrill,
  useStartPlatformRestore,
} from '@seamnex/api-client';
import type { Backup, PlatformRestoreRun, RestorePhaseStatus } from '@seamnex/domain';
import { canMutate } from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  Callout,
  DataTable,
  DefinitionList,
  Dialog,
  EmptyState,
  Field,
  InlineNote,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  SkeletonLines,
  SplitLayout,
  StatusPill,
  Tag,
  Textarea,
  defineColumns,
} from '@seamnex/ui';
import { formatBytes, formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { useSession } from '../../session';

/** A job that has stopped moving. `null` means no job has been accepted yet, which is not settled. */
function jobSettled(state: string | null): boolean {
  return state !== null && state !== 'queued' && state !== 'running';
}

const backupRowKey = (row: Backup): string => row.id;

function PhaseIcon({ state }: { state: RestorePhaseStatus['state'] }) {
  if (state === 'succeeded') return <CheckCircle2 className="size-3.5 text-success" aria-hidden />;
  if (state === 'failed') return <XCircle className="size-3.5 text-danger" aria-hidden />;
  if (state === 'running')
    return <Loader2 className="size-3.5 animate-spin text-primary" aria-hidden />;
  return <CircleDashed className="size-3.5 text-faint" aria-hidden />;
}

function PhaseCell({ phase, index }: { phase: RestorePhaseStatus; index: number }) {
  return (
    <li className="rounded-sm border border-line bg-panel-soft p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-faint label-caps">
          {String(index + 1).padStart(2, '0')}
        </span>
        <PhaseIcon state={phase.state} />
      </div>
      <p className="mt-1 text-meta leading-snug font-semibold text-text">{phase.label}</p>
      <p className="mt-0.5 text-micro leading-snug text-faint">
        {phase.state === 'pending'
          ? 'waiting'
          : phase.state === 'running'
            ? 'running'
            : phase.finishedAt
              ? formatRelative(phase.finishedAt)
              : phase.state === 'failed'
                ? 'failed'
                : phase.state === 'skipped'
                  ? 'skipped'
                  : 'done'}
      </p>
      <p className="mt-1 text-micro leading-snug text-muted">{phase.detail}</p>
    </li>
  );
}

function Timeline({ run }: { run: PlatformRestoreRun | null }) {
  if (!run) {
    return (
      <EmptyState
        compact
        icon={<ArchiveRestore className="size-5" />}
        title="No platform restore has run"
        description="A platform restore follows the fixed order: identity provider, control plane, administrative login, then products in parallel."
      />
    );
  }
  return (
    <div className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          tone={run.state === 'succeeded' ? 'positive' : run.state === 'failed' ? 'danger' : 'info'}
          label={run.state}
          pulse={run.state === 'running'}
        />
        <Tag mono>{run.id}</Tag>
        <Tag mono>backup {run.backupId}</Tag>
        <Badge tone="neutral" size="sm">
          {run.concurrency} parallel
        </Badge>
        <span className="ml-auto text-micro text-faint">
          started {formatRelative(run.startedAt)}
        </span>
      </div>

      {run.phases.length === 0 ? (
        <InlineNote>
          This run has no phase record yet. The fixed order is: identity provider, control plane,
          administrative login, products, verification.
        </InlineNote>
      ) : (
        <ol
          className="grid grid-cols-2 gap-2 xl:grid-cols-4"
          aria-label="Restore phases in fixed order"
        >
          {run.phases.map((phase, index) => (
            <PhaseCell key={phase.phase} phase={phase} index={index} />
          ))}
        </ol>
      )}

      <DefinitionList
        columns={2}
        items={[
          { label: 'Justification', value: run.justification },
          { label: 'Requested by', value: run.requestedBy },
          {
            label: 'Administrative login verified',
            value: run.loginVerifiedAt ? formatDateTime(run.loginVerifiedAt) : 'not yet',
          },
          {
            label: 'Finished',
            value: run.finishedAt ? formatDateTime(run.finishedAt) : 'in progress',
          },
        ]}
      />

      {run.state === 'failed' ? (
        <Alert tone="danger" title="Reported as failed, not completed">
          {run.failedReason ?? 'The run did not complete; product routes stay unpublished.'}
        </Alert>
      ) : null}
      {run.state === 'running' ? (
        <InlineNote>
          Product routes remain unpublished until the administrative login succeeds, then instances
          are restored in parallel at the configured concurrency.
        </InlineNote>
      ) : null}
    </div>
  );
}

export function RecoveryPage() {
  const { session } = useSession();
  const recovery = useRecovery();
  const refetchRecovery = recovery.refetch;
  const instances = useInstances();
  const createBackup = useCreatePlatformBackup();
  const startRestore = useStartPlatformRestore();
  const scheduleDrill = useScheduleDrill();

  const [restoreOpen, setRestoreOpen] = useState(false);
  const [drillOpen, setDrillOpen] = useState(false);
  const [selectedBackupId, setSelectedBackupId] = useState('');
  const [justification, setJustification] = useState('');
  const [instanceId, setInstanceId] = useState('');

  const data = recovery.data;
  const runs = data?.runs ?? [];
  const activeRun = runs[0] ?? null;
  const running = activeRun?.state === 'running';
  const canManage = canMutate(session.role, 'recovery.manage');
  // A restore can only start from a capture that finished. The register used to accept a `running`
  // or `failed` row, which took the gate down for an artefact that does not exist.
  const restorable = (data?.backups ?? []).filter((backup) => backup.state === 'succeeded');
  /**
   * The form's backup, derived. An effect used to write the first restorable id into state and
   * rewrite it whenever the selection vanished, which is a derivation expressed as a side effect:
   * it ran one render late and could clobber a choice the operator had just made.
   */
  const backupId = restorable.some((backup) => backup.id === selectedBackupId)
    ? selectedBackupId
    : (restorable[0]?.id ?? '');

  // CL-20: poll the gate, not the whole overview. The overview is refetched when the phase or the
  // gate actually moves, plus a slow fallback in case the polling surface stalls.
  const status = useRestoreStatus({ enabled: running, pollMs: 2_000 });
  const phase = status.data?.run?.phase ?? null;
  const gateOpen = status.data?.gate.routesPublished ?? null;
  // Prefer the polled run while it is the one on screen: its phases move every two seconds, the
  // overview only when the phase changes.
  const liveRun = running && status.data?.run?.id === activeRun?.id ? status.data.run : null;
  const timelineRun = liveRun ?? activeRun;

  useEffect(() => {
    if (phase === null) return;
    // The restore gate moved, and the overview is the only surface that can say what that means.
    // Polling while a restore runs is `useRecovery`'s own `refetchInterval`, not a timer here.
    void refetchRecovery();
  }, [phase, gateOpen, refetchRecovery]);

  // The writes answer 202: follow the accepted job and refresh the register when it terminates,
  // so the table does not keep showing a backup or restore that already finished.
  const backupJob = useJob(createBackup.data?.jobId ?? '');
  const restoreJob = useJob(startRestore.data?.jobId ?? '');
  const backupJobState = backupJob.data?.state ?? null;
  const restoreJobState = restoreJob.data?.state ?? null;

  /**
   * Both accepted writes are followed by a job, and whichever terminates first changes the
   * register. One effect settles both, instead of two effects racing the same refetch.
   */
  useEffect(() => {
    if (!jobSettled(backupJobState) && !jobSettled(restoreJobState)) return;
    void refetchRecovery();
  }, [backupJobState, restoreJobState, refetchRecovery]);

  const restoreProblem = startRestore.error ? toProblem(startRestore.error) : null;
  const backupProblem = createBackup.error ? toProblem(createBackup.error) : null;
  const drillProblem = scheduleDrill.error ? toProblem(scheduleDrill.error) : null;

  /**
   * Kept at screen scope in `useMemo` rather than hoisted to the module: every cell is pure today,
   * but a backup row is the natural place for a per-row action (verify, restore from this set), and
   * that action will close over page state. The memo keeps one array per mount either way.
   *
   * No column is `primary`: the register has no per-backup page, so the row has no link target.
   */
  const backupColumns = useMemo(
    () =>
      defineColumns<Backup>([
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
              tone={
                row.state === 'succeeded' ? 'positive' : row.state === 'failed' ? 'danger' : 'info'
              }
              size="sm"
            >
              {row.state}
            </Badge>
          ),
        },
        {
          id: 'started',
          header: 'Started',
          hideBelow: 'sm',
          cell: (row) => (
            <span className="text-micro text-muted">{formatDateTime(row.startedAt)}</span>
          ),
        },
        {
          id: 'size',
          header: 'Size',
          align: 'right',
          hideBelow: 'md',
          mono: true,
          cell: (row) => (
            <span className="text-micro text-muted">{formatBytes(row.sizeBytes)}</span>
          ),
        },
        {
          id: 'contents',
          header: 'Contents',
          align: 'right',
          hideBelow: 'lg',
          cell: (row) => <span className="text-micro text-muted">{row.includes.length} items</span>,
        },
        {
          id: 'verified',
          header: 'Drill',
          align: 'right',
          hideBelow: 'md',
          cell: (row) =>
            row.verifiedAt ? (
              <span className="text-micro text-success">{formatRelative(row.verifiedAt)}</span>
            ) : (
              <span className="text-micro text-warning-strong">not verified</span>
            ),
        },
      ]),
    [],
  );

  return (
    <Page>
      {/* FR-1.35 · FR-1.36 · NFR-3.5 — requirement ids, developer-only; they used to be the page
          eyebrow and are not part of the rendered interface. */}
      <PageHeader
        title="Recovery"
        description="Platform state — including the identity provider — is a separate recovery domain from any product. A restore follows a fixed order and publishes nothing until an administrative login succeeds."
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus />}
              disabled={!canManage || createBackup.isPending}
              onClick={() => createBackup.mutate()}
            >
              {createBackup.isPending ? 'Capturing…' : 'Back up platform state'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<ArchiveRestore />}
              disabled={!canManage || restorable.length === 0 || running}
              onClick={() => setRestoreOpen(true)}
            >
              Start restore
            </Button>
          </>
        }
        meta={
          data ? (
            <>
              <Badge tone={data.gate.routesPublished ? 'positive' : 'caution'} size="sm">
                {data.gate.routesPublished ? 'routes published' : 'routes unpublished'}
              </Badge>
              <span className="text-micro text-muted">
                last backup {data.lastBackupAt ? formatRelative(data.lastBackupAt) : 'never'}
              </span>
              <span className="text-micro text-muted">
                last verified restore{' '}
                {data.lastVerifiedRestoreAt ? formatRelative(data.lastVerifiedRestoreAt) : 'never'}
              </span>
            </>
          ) : null
        }
      />

      {!canManage ? (
        <Callout tone="info" title="Read-only recovery view" className="mb-3">
          R2 can inspect backup contents, restore evidence and the route gate, but cannot start a
          restore or a drill.
        </Callout>
      ) : null}

      {/*
        One region for one read. The gate banner, the timeline, the register and the drills are all
        derived from the same payload, so a failed *refetch* keeps them on screen behind the
        caution banner rather than replacing the recovery evidence with a problem panel (ERR-04);
        a first failure still replaces the region, because there is no evidence to keep.
      */}
      <AsyncPanel
        query={recovery}
        loading={
          <Panel inset>
            <SkeletonLines lines={8} />
          </Panel>
        }
        loadingLabel="Loading recovery evidence"
      >
        {() =>
          data ? (
            <div className="space-y-3">
              {/* FR-1.36: the alert body used to read "This is the FR-1.36 gate, not an
                  outage." */}
              {!data.gate.routesPublished ? (
                <Alert tone="caution" title={data.gate.detail}>
                  The portal shows every product as unavailable while the restore is in flight. This
                  is the restore gate, not an outage.
                </Alert>
              ) : null}
              {backupProblem ? <QueryError error={createBackup.error} compact /> : null}
              {backupJobState === 'failed' ? (
                <Alert tone="danger" title="The platform capture failed">
                  {backupJob.data?.errorMessage ??
                    'The job stopped before it uploaded anything; the register shows the set as failed.'}
                </Alert>
              ) : null}
              {createBackup.data && backupJobState !== 'failed' ? (
                <Alert
                  tone={backupJobState === 'succeeded' ? 'positive' : 'info'}
                  title={
                    backupJobState === 'succeeded'
                      ? 'Platform backup captured'
                      : `Platform backup job ${createBackup.data.jobId} accepted`
                  }
                >
                  {backupJobState === 'succeeded'
                    ? 'The set is now in the register with its size and contents. A restore can only start from it once it has finished.'
                    : 'The capture including the identity-provider realm runs as a job; the set appears in the register when it finishes. The audit record names the actor.'}
                </Alert>
              ) : null}
              {restoreJobState === 'failed' ? (
                <Alert tone="danger" title="The platform restore failed">
                  {restoreJob.data?.errorMessage ??
                    'The run stopped; the gate stays closed until a restore completes.'}
                </Alert>
              ) : null}
              {startRestore.data && restoreJobState !== 'failed' ? (
                <Alert
                  tone="info"
                  title={`Restore job ${startRestore.data.jobId} ${
                    restoreJobState === 'succeeded' ? 'finished' : 'queued'
                  }`}
                >
                  Routes stay unpublished until the identity provider, the control plane and an
                  administrative login have succeeded. The timeline below follows the gate.
                </Alert>
              ) : null}

              <SplitLayout ratio="content">
                <Panel>
                  {/* FR-1.36 — requirement id, developer-only; the eyebrow keeps its "fixed
                      order" copy and no longer prints the id. */}
                  <PanelHeader
                    eyebrow="fixed order"
                    title={timelineRun ? `Restore ${timelineRun.id}` : 'Restore timeline'}
                    description="Identity provider first, then the control plane, then an administrative login, then products in parallel."
                  />
                  <Timeline run={timelineRun} />
                </Panel>

                <div className="space-y-3">
                  <Panel>
                    <PanelHeader eyebrow="Gate" title="Route publication" />
                    <div className="space-y-2 p-4">
                      <DefinitionList
                        columns={1}
                        items={[
                          {
                            label: 'Routes published',
                            value: data.gate.routesPublished ? 'Yes' : 'No',
                          },
                          {
                            label: 'Login verified',
                            value: data.gate.loginVerifiedAt
                              ? formatDateTime(data.gate.loginVerifiedAt)
                              : 'not yet',
                          },
                        ]}
                      />
                      <p className="text-meta leading-relaxed text-muted">{data.gate.detail}</p>
                    </div>
                  </Panel>

                  <Panel>
                    {/* FR-1.35 — requirement id, developer-only; the panel header used to carry
                        it as its eyebrow. */}
                    <PanelHeader title="What the backup contains" />
                    <ul className="divide-y divide-line">
                      {data.contents.map((item) => (
                        <li key={item.label} className="flex items-start gap-2 px-4 py-2">
                          <Badge tone={item.included ? 'positive' : 'neutral'} size="sm">
                            {item.included ? 'in' : 'ref'}
                          </Badge>
                          <span className="min-w-0">
                            <span className="block text-meta font-medium text-text">
                              {item.label}
                            </span>
                            <span className="mt-0.5 block text-micro leading-snug text-faint">
                              {item.detail}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Panel>
                </div>
              </SplitLayout>

              <Panel>
                <PanelHeader
                  eyebrow="Register"
                  title="Platform-state backups"
                  description="Separate from product backups; the catalogue repository stays authoritative for declarative data."
                />
                <DataTable
                  columns={backupColumns}
                  rows={data.backups}
                  rowKey={backupRowKey}
                  caption="Platform-state backups, separate from product backups"
                  dense
                />
              </Panel>

              <Panel>
                {/* NFR-3.5 — requirement id, developer-only; the panel header used to carry it
                    as its eyebrow. */}
                <PanelHeader
                  title="Restore drills"
                  description="Verified restore per stateful deployment, at least quarterly, with evidence."
                  actions={
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Plus />}
                      disabled={!canManage || scheduleDrill.isPending}
                      onClick={() => setDrillOpen(true)}
                    >
                      Schedule drill
                    </Button>
                  }
                />
                {scheduleDrill.data ? (
                  <div className="p-3">
                    {/* The drill row exists before the job runs, so `passed: false` with a queued
                      smoke test is "started", not "failed" — and definitely not "passed". */}
                    <Alert
                      tone={
                        scheduleDrill.data.passed
                          ? 'positive'
                          : scheduleDrill.data.smokeTest === 'queued'
                            ? 'info'
                            : 'danger'
                      }
                      title={
                        scheduleDrill.data.passed
                          ? `Drill ${scheduleDrill.data.id} passed`
                          : scheduleDrill.data.smokeTest === 'queued'
                            ? `Drill ${scheduleDrill.data.id} queued`
                            : `Drill ${scheduleDrill.data.id} did not pass`
                      }
                    >
                      {scheduleDrill.data.smokeTest}. Evidence: {scheduleDrill.data.evidenceUrl}
                    </Alert>
                  </div>
                ) : null}
                <ul className="divide-y divide-line">
                  {data.drills.slice(0, 8).map((drill) => (
                    <li
                      key={drill.id}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                    >
                      <div className="min-w-0">
                        <p className="text-meta font-medium text-text">{drill.instanceLabel}</p>
                        <p className="mt-0.5 text-micro text-faint">
                          {formatRelative(drill.performedAt)} · {drill.smokeTest}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge tone={drill.passed ? 'positive' : 'danger'} size="sm">
                          {drill.passed ? 'passed' : 'failed'}
                        </Badge>
                        <a
                          href={drill.evidenceUrl}
                          className="text-micro font-semibold text-link underline-offset-2 hover:underline"
                        >
                          Evidence
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
                {data.drills.length === 0 ? (
                  <div className="p-4">
                    {/* NFR-3.5: the empty copy used to read "NFR-3.5 requires a verified restore
                        per stateful deployment, at least quarterly. …" */}
                    <EmptyState
                      title="No restore drill recorded"
                      description="A verified restore is required per stateful deployment, at least quarterly. An untested backup is an assumption, not evidence."
                      action={
                        canManage ? (
                          <Button size="sm" variant="primary" onClick={() => setDrillOpen(true)}>
                            Schedule a drill
                          </Button>
                        ) : undefined
                      }
                    />
                  </div>
                ) : null}
              </Panel>
            </div>
          ) : null
        }
      </AsyncPanel>

      <Dialog
        open={restoreOpen}
        onOpenChange={setRestoreOpen}
        title="Start a platform-state restore"
        description="Routes are unpublished for the whole run and only return after an administrative login succeeds."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRestoreOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<ArchiveRestore />}
              disabled={
                startRestore.isPending || justification.trim().length < 20 || backupId === ''
              }
              onClick={() =>
                startRestore.mutate(
                  { backupId, justification },
                  {
                    onSuccess: () => {
                      setRestoreOpen(false);
                      setJustification('');
                    },
                  },
                )
              }
            >
              {startRestore.isPending ? 'Starting…' : 'Start restore'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {restoreProblem ? <QueryError error={startRestore.error} compact /> : null}
          <Field label="Platform-state backup" required htmlFor="restore-backup">
            <Select
              id="restore-backup"
              value={backupId}
              onChange={(event) => setSelectedBackupId(event.target.value)}
            >
              {restorable.map((backup) => (
                <option key={backup.id} value={backup.id}>
                  {backup.id} · {formatDateTime(backup.startedAt)} · {formatBytes(backup.sizeBytes)}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Justification"
            required
            htmlFor="restore-justification"
            hint="At least 20 characters. Recorded in the audit trail with the restore id."
            error={
              justification.length > 0 && justification.trim().length < 20
                ? 'Add more detail.'
                : undefined
            }
          >
            <Textarea
              id="restore-justification"
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
              placeholder="Describe the incident, the scope and the expected outcome."
            />
          </Field>
          <Callout tone="caution" title="Product routes go dark for the duration">
            Every instance route is unpublished until the administrative login is verified; the
            portal then reports products as unavailable, which is the truthful state.
          </Callout>
        </div>
      </Dialog>

      <Dialog
        open={drillOpen}
        onOpenChange={setDrillOpen}
        title="Schedule a restore drill"
        description="A drill restores one instance on a scratch stack and records the smoke-test result as evidence."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDrillOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={scheduleDrill.isPending || instanceId === ''}
              onClick={() =>
                scheduleDrill.mutate(
                  { instanceId },
                  {
                    onSuccess: () => {
                      setDrillOpen(false);
                      setInstanceId('');
                    },
                  },
                )
              }
            >
              {scheduleDrill.isPending ? 'Running drill…' : 'Run drill'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {/* The refusal belongs next to the control that caused it, not behind the modal. */}
          {drillProblem ? (
            <Callout tone="danger" title={drillProblem.title}>
              {drillProblem.detail}
            </Callout>
          ) : null}
          <Field
            label="Instance"
            required
            htmlFor="drill-instance"
            hint="A drill restores the instance's most recent successful backup; an instance without one is refused."
          >
            <Select
              id="drill-instance"
              value={instanceId}
              onChange={(event) => setInstanceId(event.target.value)}
            >
              <option value="">Choose an instance…</option>
              {(instances.data ?? []).map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instance.entryKey} · {instance.product} ({instance.slug})
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>
    </Page>
  );
}

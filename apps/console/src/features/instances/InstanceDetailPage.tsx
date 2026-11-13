import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  ArrowLeft,
  CirclePlay,
  CircleStop,
  Download,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  toProblem,
  useInstance,
  useInstancePlan,
  useInstanceStatus,
  useLifecycleAction,
  useRefreshInstanceStatus,
} from '@seamnex/api-client';
import type { InstancePlan, LifecycleAction } from '@seamnex/domain';
import { can, INSTANCE_STATE_LABELS, lifecycleAvailability } from '@seamnex/domain';
import { usePageCrumb } from '../../page-crumb';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  DefinitionList,
  Dialog,
  InlineNote,
  Page,
  PageHeader,
  Panel,
  SkeletonLines,
  StatusPill,
  TabPanel,
  Tabs,
  Tag,
  Tooltip,
  defineColumns,
} from '@seamnex/ui';
import { cn, formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { useSession } from '../../session';
import { BackupsTab } from './tabs/BackupsTab';
import { ContainersTab } from './tabs/ContainersTab';
import { DriftTab } from './tabs/DriftTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { IntegrationTab } from './tabs/IntegrationTab';
import { JobsTab } from './tabs/JobsTab';
import { OverviewTab } from './tabs/OverviewTab';

type DialogKind = LifecycleAction | null;

const DIALOG_COPY: Record<
  Exclude<LifecycleAction, 'upgrade' | 'delete'>,
  { title: string; description: string; confirm: string }
> = {
  start: {
    title: 'Start instance?',
    description: 'Services will start and the route will be published after readiness.',
    confirm: 'Start',
  },
  stop: {
    title: 'Stop instance?',
    description: 'The route is unpublished and data is retained. Users lose access immediately.',
    confirm: 'Stop',
  },
  restart: {
    title: 'Restart instance?',
    description: 'A rolling restart is applied. Readiness is re-checked afterwards.',
    confirm: 'Restart',
  },
  reconfigure: {
    title: 'Reconfigure instance?',
    description:
      'The definition is re-rendered from the current environment and re-applied: changed values reach the containers and the identity client and route are re-checked. Data volumes are kept.',
    confirm: 'Reconfigure',
  },
  rollback: {
    title: 'Roll back?',
    description:
      'The previously running render set is restored. A failed readiness check can be retried.',
    confirm: 'Roll back',
  },
  export: {
    title: 'Export data?',
    description:
      'A portable archive is produced so the business can leave the platform without data loss.',
    confirm: 'Export',
  },
};

/**
 * The upgrade dialog's diff table. It used to be a literal inside the JSX, which rebuilt the array
 * on every render of the page — including once per keystroke in any filter above it.
 */
const PLAN_CHANGE_COLUMNS = defineColumns<InstancePlan['changes'][number]>([
  { id: 'field', header: 'Field', mono: true, cell: (row) => row.field },
  { id: 'from', header: 'Current', mono: true, cell: (row) => row.from },
  { id: 'to', header: 'Target', mono: true, cell: (row) => row.to },
]);

const planChangeKey = (row: InstancePlan['changes'][number]) => row.field;

/**
 * The hairline between lifecycle groups. Hidden below `sm`, where the action row wraps anyway
 * and a divider would land at the end of a line with nothing to separate.
 */
function ActionGap() {
  return <span aria-hidden className="hidden h-5 w-px shrink-0 bg-line sm:block" />;
}

export function InstanceDetailPage() {
  const { id = '' } = useParams();
  const { session } = useSession();
  const navigate = useNavigate();
  const instance = useInstance(id);
  // The route id is a UUID, so the chrome names the record instead of the path.
  usePageCrumb(instance.data?.product);
  const status = useInstanceStatus(id);
  const refresh = useRefreshInstanceStatus();
  const lifecycle = useLifecycleAction();
  const [tab, setTab] = useState('overview');
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [retention, setRetention] = useState<'keep' | 'export' | 'delete'>('keep');
  const plan = useInstancePlan(id, dialog === 'upgrade' ? 'upgrade' : null);
  /**
   * The environment is one capability (`instance.env`) for reading the resolved values and for
   * editing them. Read it once, so the tab, its force-mounted panel and the edit affordance cannot
   * disagree — and so no role without the grant ever mounts the panel's query.
   */
  const canReadEnv = can(session.role, 'instance.env');

  /**
   * A whole-screen gate, not a region — but only when there is nothing to render. `isError` is also
   * true for a failed *refetch*, and returning the error panel then threw away a detail surface that
   * was still in the cache and still the last thing the API said (ERR-04). The degraded case keeps
   * the data and shows the banner below instead.
   */
  if (!instance.data) {
    return instance.isPending ? (
      <Panel inset>
        <SkeletonLines lines={10} />
      </Panel>
    ) : (
      <QueryError error={instance.error} onRetry={() => void instance.refetch()} />
    );
  }

  const data = instance.data;
  const availability = lifecycleAvailability(data.state);
  const stateLabel = INSTANCE_STATE_LABELS[data.state];
  // FR-4.2: the affordance follows the capability, so a read-only role never sees a live control.
  const canLifecycle = can(session.role, 'instance.lifecycle');
  /**
   * An upgrade needs somewhere to go. The state machine only knows "running", so an instance already
   * on the catalog's pinned version used to offer the action anyway; pressing it opened a dialog
   * whose "version" fields were render-set hashes, and confirming re-deployed the same version with
   * a mandatory backup in front of it.
   */
  const upgradeTarget =
    data.availableVersion !== null && data.availableVersion !== data.currentVersion
      ? data.availableVersion
      : null;

  const run = (action: LifecycleAction) => {
    lifecycle.mutate(
      { id: data.id, action, ...(action === 'delete' ? { dataRetention: retention } : {}) },
      { onSuccess: (accepted) => navigate(`/jobs/${accepted.jobId}`) },
    );
  };

  const actionButton = (
    action: LifecycleAction,
    label: string,
    icon: ReactNode,
    blocked?: string,
  ) => {
    const offered = availability[action] && blocked === undefined;
    const button = (
      <Button
        size="sm"
        // `danger-quiet`, not `danger`: this row is a toolbar, and a filled red beside a filled
        // green made Delete the loudest control on a screen whose routine action is "Refresh
        // status". The filled variant is still what the confirmation offers.
        variant={
          action === 'delete' ? 'danger-quiet' : action === 'upgrade' ? 'primary' : 'secondary'
        }
        icon={icon}
        disabled={!offered || !canLifecycle || lifecycle.isPending}
        onClick={() => setDialog(action)}
      >
        {label}
      </Button>
    );
    return offered ? (
      button
    ) : (
      <Tooltip content={blocked ?? `Not available from ${data.state}`}>{button}</Tooltip>
    );
  };

  return (
    <Page>
      <Link
        to="/instances"
        className="mb-3 inline-flex items-center gap-1.5 text-meta font-medium text-muted hover:text-link"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Instances
      </Link>

      <PageHeader
        eyebrow={
          <>
            <span className="rounded-xs border border-line bg-paper-deep px-1.5 py-0.5 font-mono text-micro font-semibold text-muted">
              {data.entryKey}
            </span>
            <span className="font-mono text-faint label-caps">{data.domain}</span>
            <StatusPill tone={stateLabel.tone} label={stateLabel.label} size="sm" />
            <Badge tone={data.ready ? 'positive' : 'caution'} size="sm">
              {data.ready ? 'ready' : 'not ready'}
            </Badge>
            {data.maintenance?.active ? (
              <Badge tone="info" size="sm">
                maintenance
              </Badge>
            ) : null}
          </>
        }
        title={data.product}
        description={data.stateReason ?? data.description}
        actions={
          canLifecycle ? (
            /*
             * Four groups instead of eight peers. As one flat row, `Delete` sat 12px from
             * `Export` — an irreversible action next to a harmless one, at the same weight — and
             * nothing said which of the eight the screen existed for. The groups are named for
             * assistive technology and separated by a hairline from `sm` up; below it the row
             * wraps, and the tighter gap inside a group carries the same structure.
             */
            <>
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Lifecycle"
              >
                {actionButton('start', 'Start', <CirclePlay />)}
                {actionButton('stop', 'Stop', <CircleStop />)}
                {actionButton('restart', 'Restart', <RefreshCw />)}
                {/* FR-1.28: a stored environment change is only real once it is applied. */}
                {actionButton('reconfigure', 'Reconfigure', <SlidersHorizontal />)}
              </div>
              <ActionGap />
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Version"
              >
                {actionButton(
                  'upgrade',
                  'Upgrade',
                  <Upload />,
                  upgradeTarget === null ? 'Already on the latest version' : undefined,
                )}
                {actionButton('rollback', 'Roll back', <RotateCcw />)}
              </div>
              <ActionGap />
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Evidence"
              >
                {actionButton('export', 'Export', <Download />)}
              </div>
              <ActionGap />
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Destructive"
              >
                {actionButton('delete', 'Delete', <Trash2 />)}
              </div>
            </>
          ) : (
            <Badge tone="neutral" size="sm">
              read-only lifecycle
            </Badge>
          )
        }
        meta={
          <>
            <span className="font-mono text-micro text-muted">{data.domainRoute}</span>
            <span className="text-micro text-faint">
              observed {formatRelative(status.data?.observedAt ?? data.observedAt)} · source{' '}
              {status.data?.source ?? data.statusSource}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw />}
              onClick={() => refresh.mutate(data.id)}
              disabled={refresh.isPending}
            >
              Refresh status
            </Button>
          </>
        }
      />

      {/* The degraded branch of the screen gate above: the instance is on screen, its last read
          failed, and the operator needs to know which of the two they are looking at. */}
      {instance.isError ? (
        <Alert
          tone="caution"
          title="Showing the last data that loaded"
          className="mb-3"
          action={
            <Button
              size="sm"
              variant="secondary"
              icon={<RefreshCw />}
              onClick={() => void instance.refetch()}
            >
              Retry
            </Button>
          }
        >
          {toProblem(instance.error).detail}
        </Alert>
      ) : null}

      {/*
        ERR-05 rule, applied here: a mutation's failure is rendered exactly once, next to the control
        that caused it — for this screen, the header slot that owns both the lifecycle buttons and
        "Refresh status". The two mutations fail independently so they get one block each, and
        neither needs its own retry action: the header still shows the button that caused the
        failure, and pressing it again is the retry. The lifecycle failure used to be printed twice
        (here and again below the tabs), so a single failed action produced two identical panels.
      */}
      {lifecycle.isError ? <QueryError error={lifecycle.error} compact /> : null}
      {refresh.isError ? <QueryError error={refresh.error} compact /> : null}

      {/* Two-up from the narrowest width: four stacked cards cost ~400px of a phone screen
          before the tabs begin, for four short values. */}
      <div className="mb-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Panel inset>
          <DefinitionList
            columns={1}
            items={[
              { label: 'Current version', value: data.currentVersion, mono: true },
              { label: 'Available', value: data.availableVersion ?? 'Up to date', mono: true },
            ]}
          />
        </Panel>
        <Panel inset>
          <DefinitionList
            columns={1}
            items={[
              {
                label: 'Containers',
                value: `${status.data?.containersRunning ?? '—'} / ${status.data?.containersTotal ?? '—'} running`,
              },
              { label: 'Plain-language status', value: status.data?.plainStatus ?? '—' },
            ]}
          />
        </Panel>
        <Panel inset>
          <DefinitionList
            columns={1}
            items={[
              {
                label: 'Last backup',
                value: data.backup.lastSuccessAt
                  ? formatRelative(data.backup.lastSuccessAt)
                  : 'Never',
              },
              {
                label: 'Verified restore',
                value: data.backup.lastVerifiedRestoreAt
                  ? formatRelative(data.backup.lastVerifiedRestoreAt)
                  : 'Not verified',
              },
            ]}
          />
        </Panel>
        <Panel inset>
          <DefinitionList
            columns={1}
            items={[
              { label: 'Route published', value: data.route.published ? 'Yes' : 'No' },
              { label: 'Auth mode', value: data.route.authMode },
            ]}
          />
        </Panel>
      </div>

      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'overview', label: 'Overview' },
          { value: 'containers', label: 'Containers' },
          ...(canReadEnv ? [{ value: 'env', label: 'Environment' }] : []),
          { value: 'drift', label: 'Drift' },
          { value: 'backups', label: 'Backups' },
          { value: 'jobs', label: 'Jobs' },
          { value: 'integration', label: 'Integration' },
        ]}
      >
        <TabPanel value="overview" className="pt-3">
          <OverviewTab instance={data} />
        </TabPanel>
        <TabPanel value="containers" className="pt-3">
          <ContainersTab instance={data} />
        </TabPanel>
        {/*
          `keepMounted` on this panel only: it is the one tab that holds typed-but-unapplied input.
          Radix otherwise unmounts it on switch, which is why the draft had to be rescued into a
          module map; keeping it mounted means the ordinary unmount path no longer loses it either.
          The other tabs stay unmounted — force-mounting them would run every tab's query at once.

          The panel is also rendered only for a role that may read the environment. `keepMounted`
          mounts it even when it is not selected, so an auditor opening any instance used to fire
          `GET /instances/:id/env`, take a 403 and append an `access.denied` audit row just by
          reading the overview.
        */}
        {canReadEnv ? (
          <TabPanel value="env" className="pt-3" keepMounted>
            {/* Keyed by instance: the tab body survives a tab switch on purpose (it keeps an
                unapplied override), but it must not follow the operator to a different instance. */}
            <EnvironmentTab key={data.id} instance={data} canEdit={canReadEnv} />
          </TabPanel>
        ) : null}
        <TabPanel value="drift" className="pt-3">
          <DriftTab instance={data} />
        </TabPanel>
        <TabPanel value="backups" className="pt-3">
          <BackupsTab instance={data} />
        </TabPanel>
        <TabPanel value="jobs" className="pt-3">
          <JobsTab instance={data} />
        </TabPanel>
        <TabPanel value="integration" className="pt-3">
          <IntegrationTab instance={data} />
        </TabPanel>
      </Tabs>

      {dialog && dialog !== 'upgrade' && dialog !== 'delete' ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          title={DIALOG_COPY[dialog].title}
          description={DIALOG_COPY[dialog].description}
          confirmLabel={DIALOG_COPY[dialog].confirm}
          tone={dialog === 'rollback' ? 'danger' : 'primary'}
          busy={lifecycle.isPending}
          onConfirm={() => {
            run(dialog);
            setDialog(null);
          }}
        />
      ) : null}

      {dialog === 'upgrade' ? (
        <Dialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          title="Upgrade instance"
          description="A pre-upgrade backup is taken automatically. A failed readiness check surfaces a one-step rollback."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!plan.data?.capacityVerdict.admissible || lifecycle.isPending}
                onClick={() => {
                  run('upgrade');
                  setDialog(null);
                }}
              >
                {lifecycle.isPending ? 'Starting…' : 'Run upgrade'}
              </Button>
            </>
          }
        >
          {/* Mounted only inside the dialog that enables the query: `useInstancePlan` is created with
              `enabled` tied to this dialog, and a panel mounted unconditionally would show its
              loading branch forever. */}
          <AsyncPanel
            query={plan}
            loading={<SkeletonLines lines={5} />}
            loadingLabel="Loading the upgrade plan"
            renderError={(error, retry) => <QueryError error={error} onRetry={retry} />}
          >
            {(planData) => (
              <div className="space-y-3">
                {/* The plan's `from`/`to` are render-set hashes. Printing them where a version
                    belongs told the operator they were upgrading "322263417de0 → pending
                    render". */}
                <div className="flex flex-wrap items-center gap-2">
                  <Tag mono>{data.currentVersion}</Tag>
                  <span aria-hidden>→</span>
                  <Tag mono>{upgradeTarget ?? data.currentVersion}</Tag>
                  <Badge tone="caution" size="sm">
                    pre-upgrade backup
                  </Badge>
                </div>
                <p className="font-mono text-micro text-faint">
                  render {planData.from} → {planData.to}
                </p>
                {planData.changes.length > 0 ? (
                  <DataTable
                    columns={PLAN_CHANGE_COLUMNS}
                    rows={planData.changes}
                    rowKey={planChangeKey}
                    dense
                  />
                ) : (
                  <InlineNote>
                    No file differences were planned for this action; the render sets are identical.
                  </InlineNote>
                )}
                <Alert
                  tone={planData.capacityVerdict.admissible ? 'positive' : 'danger'}
                  title={planData.capacityVerdict.headline}
                >
                  {planData.capacityVerdict.detail}
                </Alert>
                <InlineNote>
                  A failed readiness check leaves the instance failed; one-step rollback restores
                  the previous render set and is recorded in the audit log.
                </InlineNote>
              </div>
            )}
          </AsyncPanel>
        </Dialog>
      ) : null}

      {dialog === 'delete' ? (
        <Dialog
          open
          onOpenChange={(open) => (open ? undefined : setDialog(null))}
          title="Delete instance"
          description="Deletion is irreversible. Choose explicitly what happens to the data."
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={lifecycle.isPending}
                onClick={() => {
                  run('delete');
                  setDialog(null);
                }}
              >
                Delete instance
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            <fieldset className="space-y-2">
              <legend className="mb-1.5 text-muted label-caps-sans">
                What happens to the data
              </legend>
              {[
                {
                  value: 'keep',
                  label: 'Keep volumes',
                  detail: 'Containers and route are removed; volumes remain for 30 days.',
                },
                {
                  value: 'export',
                  label: 'Export then delete',
                  detail: 'A portable archive is produced before resources are removed.',
                },
                {
                  value: 'delete',
                  label: 'Delete everything',
                  detail: 'Volumes and database are destroyed with the instance.',
                },
              ].map((option) => (
                <label
                  key={option.value}
                  className={cn(
                    'flex cursor-pointer items-start gap-2 rounded-sm border px-3 py-2',
                    retention === option.value
                      ? 'border-primary bg-primary-soft/50'
                      : 'border-line',
                  )}
                >
                  <input
                    type="radio"
                    name="retention"
                    value={option.value}
                    checked={retention === option.value}
                    onChange={() => setRetention(option.value as typeof retention)}
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    <span className="block text-body font-medium text-text">{option.label}</span>
                    <span className="mt-0.5 block text-meta text-muted">{option.detail}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="rounded-sm border border-line bg-panel-soft p-3">
              <p className="text-meta text-muted">
                The slug <span className="font-mono text-text">{data.slug}</span> stays reserved for
                30 days after deletion, so bookmarks and old backups cannot silently re-bind.
              </p>
            </div>
          </div>
        </Dialog>
      ) : null}

      <p className="mt-4 font-mono text-micro text-faint">
        last observed {formatDateTime(status.data?.observedAt ?? data.observedAt)} ·{' '}
        {status.data?.containersRunning ?? 0} running containers
      </p>
    </Page>
  );
}

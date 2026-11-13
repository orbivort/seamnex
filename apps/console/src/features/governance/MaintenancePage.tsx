import { useState } from 'react';
import { Plus } from 'lucide-react';
import {
  toProblem,
  useCancelMaintenanceWindow,
  useCreateMaintenanceWindow,
  useDecidePolicyException,
  useInstances,
  useMaintenanceWindows,
  usePolicyExceptions,
} from '@seamnex/api-client';
import type { MaintenanceWindow } from '@seamnex/domain';
import { can, canMutate } from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Field,
  InlineNote,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  SkeletonLines,
  StatusPill,
  useNow,
} from '@seamnex/ui';
import { formatDateTime } from '@seamnex/utils';
import { AsyncPanel } from '@seamnex/shell';
import { useSession } from '../../session';
import { localInputToIso, toLocalInputValue, windowStateLabel } from './maintenance-time';

/** A window is defined by two instants, so a list that never re-reads the clock goes stale. */
const WINDOW_TICK_MS = 30_000;
const SCHEDULE_LEAD_MS = 30 * 60 * 1_000;
const DEFAULT_LENGTH_MS = 60 * 60 * 1_000;

export function MaintenancePage() {
  const { session } = useSession();
  const now = useNow(WINDOW_TICK_MS);
  /*
   * Two panels, two authorities. Reading windows is `settings.view`, scheduling them is
   * `maintenance.configure`; exceptions are read and decided with `exception.decide`. The page used
   * to admit any of `maintenance.configure`, `settings.view` or `metadata.manage` and then ask for
   * the window list, which is `settings.view` only: a domain owner (R3) got a 403 problem panel
   * with a Retry button that could never succeed. Each panel now states the rule instead of
   * issuing a request it knows is refused.
   */
  const canReadWindows = can(session.role, 'settings.view');
  const canConfigure = canMutate(session.role, 'maintenance.configure');
  const canReadExceptions = can(session.role, 'exception.decide');
  const canDecide = canMutate(session.role, 'exception.decide');

  const windows = useMaintenanceWindows({
    enabled: canReadWindows,
    refetchIntervalMs: WINDOW_TICK_MS,
  });
  const exceptions = usePolicyExceptions({ enabled: canReadExceptions });
  const decide = useDecidePolicyException();
  const create = useCreateMaintenanceWindow();
  const cancel = useCancelMaintenanceWindow();
  const decideProblem = decide.error ? toProblem(decide.error) : null;
  const createProblem = create.error ? toProblem(create.error) : null;
  const cancelProblem = cancel.error ? toProblem(cancel.error) : null;

  const rows = windows.data ?? [];
  const activeCount = rows.filter((entry) => entry.state === 'active').length;
  const pendingCount = (exceptions.data ?? []).filter(
    (entry) => entry.state === 'requested',
  ).length;

  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [cancelTarget, setCancelTarget] = useState<MaintenanceWindow | null>(null);

  /* Only the role that may schedule a window needs the instance list, and only while the form is
     open: the platform-wide list is refused to a scoped grant. */
  const instances = useInstances({}, { enabled: open && canConfigure });

  const startIso = localInputToIso(startsAt);
  const endIso = localInputToIso(endsAt);
  const orderProblem =
    startIso !== null && endIso !== null && Date.parse(endIso) <= Date.parse(startIso)
      ? 'The window must end after it starts.'
      : undefined;
  const canSubmit =
    !create.isPending &&
    scope.trim().length > 0 &&
    startIso !== null &&
    endIso !== null &&
    orderProblem === undefined;
  const fieldError = (name: string) =>
    createProblem?.fieldErrors.find((issue) => issue.field === name)?.message;

  const openSchedule = () => {
    const start = new Date(Date.now() + SCHEDULE_LEAD_MS);
    start.setSeconds(0, 0);
    setScope('');
    setInstanceId('');
    setStartsAt(toLocalInputValue(start));
    setEndsAt(toLocalInputValue(new Date(start.getTime() + DEFAULT_LENGTH_MS)));
    create.reset();
    setOpen(true);
  };

  const closeSchedule = () => {
    setOpen(false);
    create.reset();
  };

  return (
    <Page>
      {/* FR-4.9 · NFR-4.15 — requirement ids, developer-only; they used to be the page eyebrow and
          are not part of the rendered interface. */}
      <PageHeader
        title="Maintenance and policy exceptions"
        description="A maintenance window suppresses alerts and surfaces the maintenance state in the portal. Policy exceptions are time-boxed, justified and two-party approved."
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus />}
            disabled={!canConfigure}
            title={
              canConfigure ? undefined : 'Scheduling a window needs maintenance.configure (R1).'
            }
            onClick={openSchedule}
          >
            Schedule window
          </Button>
        }
        meta={
          <>
            {/* Counts are withheld until a real answer exists: "0 active" from a refused list
                reads as a healthy silence. */}
            <Badge tone="caution" size="sm">
              {windows.isSuccess && canReadWindows ? activeCount : '—'} active
            </Badge>
            <Badge tone="info" size="sm">
              {exceptions.isSuccess && canReadExceptions ? pendingCount : '—'} awaiting approval
            </Badge>
            <span className="font-mono text-micro text-faint">
              suppression is recorded, not just applied
            </span>
          </>
        }
      />

      {!canReadWindows ? (
        <Callout tone="info" title="The maintenance window register is not readable for your role">
          Reading windows needs <code className="font-mono">settings.view</code>; scheduling them
          needs <code className="font-mono">maintenance.configure</code>. Your role holds neither,
          so nothing below is a refusal — the list is simply not requested.
        </Callout>
      ) : null}

      {cancelProblem !== null ? (
        <Callout tone="danger" title={cancelProblem.title}>
          {cancelProblem.detail} {cancelProblem.remediation}
        </Callout>
      ) : null}

      {canReadWindows ? (
        <Panel className="mb-3">
          <PanelHeader
            eyebrow="Windows"
            title="Scheduled and active windows"
            description="An active window suppresses alert delivery for its whole span; a cancelled one stops suppressing at once and stays in the record."
          />
          {/*
            The register is an async region, and a failed *refetch* must not delete windows that are
            still suppressing alerts: `AsyncPanel` keeps them and says the list is stale (ERR-04).
          */}
          <AsyncPanel
            query={windows}
            loading={
              <div className="p-4">
                <SkeletonLines lines={4} />
              </div>
            }
            loadingLabel="Loading maintenance windows"
            empty={(data) =>
              data.length === 0 && (
                <div className="p-4">
                  <EmptyState
                    title="No maintenance windows"
                    description="Nothing is planned. A window suppresses alert delivery and shows the maintenance state in the portal for its whole span."
                    action={
                      canConfigure ? (
                        <Button size="sm" variant="primary" icon={<Plus />} onClick={openSchedule}>
                          Schedule window
                        </Button>
                      ) : undefined
                    }
                  />
                </div>
              )
            }
          >
            {(data) => (
              <ul className="divide-y divide-line">
                {data.map((entry) => {
                  const label = windowStateLabel(entry, now);
                  return (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-body font-semibold text-text">{entry.title}</p>
                        {/* A platform-wide window has no product to add; repeating its scope as a
                            second line said nothing. */}
                        {entry.scopeLabel === entry.title ? null : (
                          <p className="mt-0.5 text-meta text-muted">{entry.scopeLabel}</p>
                        )}
                        <p className="mt-0.5 font-mono text-micro text-faint">
                          {formatDateTime(entry.startsAt)} → {formatDateTime(entry.endsAt)}
                        </p>
                        <p className="mt-0.5 text-micro text-faint">
                          scheduled by {entry.createdBy}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {/* Suppression is claimed only while it is true: a finished or cancelled row
                            used to carry an "alerts suppressed" chip. */}
                        {entry.state === 'active' && entry.suppressAlerts ? (
                          <Badge tone="info" size="sm">
                            alerts suppressed
                          </Badge>
                        ) : null}
                        <StatusPill tone={label.tone} label={label.label} size="sm" />
                        {entry.state !== 'completed' && canConfigure ? (
                          <Button
                            size="sm"
                            variant="quiet"
                            disabled={cancel.isPending && cancelTarget?.id === entry.id}
                            onClick={() => setCancelTarget(entry)}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </AsyncPanel>
        </Panel>
      ) : null}

      {canReadExceptions ? (
        <Panel>
          <PanelHeader
            eyebrow="Exceptions"
            title="Compose policy exceptions"
            description="Rejected by default: published ports, host networking, privileged mode, host bind mounts, unpinned images."
          />
          {/* Mutation feedback belongs to the control that caused it, so it stays outside the async
              region: the decision is already made whether or not the list has reloaded yet. */}
          {decideProblem ? (
            <div className="p-3">
              <Callout
                tone={decideProblem.code === 'STATE_CONFLICT' ? 'caution' : 'danger'}
                title={decideProblem.title}
              >
                {decideProblem.detail} {decideProblem.remediation}
              </Callout>
            </div>
          ) : null}
          {decide.data ? (
            <div className="p-3">
              <Alert
                tone={decide.data.state === 'approved' ? 'positive' : 'caution'}
                title={`${decide.data.rule} · ${decide.data.state}`}
                action={
                  <Button size="sm" variant="quiet" onClick={() => decide.reset()}>
                    Dismiss
                  </Button>
                }
              >
                Decided by {decide.data.approver}; the patch diff and expiry are kept in the audit
                record.
              </Alert>
            </div>
          ) : null}
          <AsyncPanel
            query={exceptions}
            loading={
              <div className="p-4">
                <SkeletonLines lines={4} />
              </div>
            }
            loadingLabel="Loading policy exceptions"
            empty={(data) =>
              data.length === 0 && (
                <div className="p-4">
                  <EmptyState
                    title="No compose policy exceptions"
                    description="Every ingested Compose file passes the policy. An exception needs a second party, a justification and an expiry date."
                  />
                </div>
              )
            }
          >
            {(data) => (
              <ul className="divide-y divide-line">
                {data.map((exception) => {
                  const expired = Date.parse(exception.expiresAt) <= now;
                  return (
                    <li key={exception.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="text-body font-semibold text-text">
                            {exception.rule} ·{' '}
                            <span className="font-mono text-micro">{exception.scope}</span>
                          </p>
                          <p className="mt-0.5 max-w-2xl text-meta leading-snug text-muted">
                            {exception.justification}
                          </p>
                          {/* The decider must be a second party, so both names belong on the row. */}
                          <p className="mt-1 text-micro text-faint">
                            requested by {exception.requester}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {exception.approver !== null ? (
                            <span className="text-micro text-faint">
                              {exception.state === 'rejected' ? 'rejected by' : 'approved by'}{' '}
                              {exception.approver}
                            </span>
                          ) : expired ? (
                            <span className="text-micro text-warning-strong">
                              expired undecided
                            </span>
                          ) : (
                            <span className="text-micro text-warning-strong">
                              awaiting second party
                            </span>
                          )}
                          <Badge
                            tone={
                              exception.state === 'approved'
                                ? 'caution'
                                : exception.state === 'requested'
                                  ? expired
                                    ? 'danger'
                                    : 'info'
                                  : 'neutral'
                            }
                            size="sm"
                          >
                            {exception.state}
                          </Badge>
                        </div>
                      </div>
                      <pre className="print-unclip mt-2 overflow-x-auto rounded-xs bg-paper-deep px-2 py-1.5 font-mono text-micro text-muted">
                        {exception.patchDiff}
                      </pre>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <p className="font-mono text-micro text-faint">
                          expires {formatDateTime(exception.expiresAt)}
                        </p>
                        {exception.state === 'requested' && !expired && canDecide ? (
                          <span className="ml-auto flex items-center gap-1.5">
                            <Button
                              size="sm"
                              variant="quiet"
                              disabled={decide.isPending}
                              onClick={() =>
                                decide.mutate({ id: exception.id, decision: 'reject' })
                              }
                            >
                              Reject
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={decide.isPending}
                              onClick={() =>
                                decide.mutate({ id: exception.id, decision: 'approve' })
                              }
                            >
                              Approve
                            </Button>
                          </span>
                        ) : null}
                        {exception.state === 'requested' && expired ? (
                          <span className="ml-auto text-micro text-faint">
                            Past its expiry, so the API refuses a late decision; request a new
                            exception.
                          </span>
                        ) : null}
                        {exception.state === 'requested' && !expired && !canDecide ? (
                          <span className="ml-auto text-micro text-faint">
                            The domain owner approves; the requester never can.
                          </span>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </AsyncPanel>
        </Panel>
      ) : (
        <Callout tone="info" title="Policy exceptions are not readable for your role">
          Reading and deciding an exception needs{' '}
          <code className="font-mono">exception.decide</code>, held by the platform administrator
          and the domain owner. Nothing is being hidden from you silently: the queue is not
          requested at all.
        </Callout>
      )}

      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : closeSchedule())}
        title="Schedule a maintenance window"
        description="Alert delivery is suppressed for the whole span and the suppression is written to the notification record. The window is shown in the portal while it is active."
        footer={
          <>
            <Button variant="ghost" onClick={closeSchedule}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<Plus />}
              disabled={!canSubmit}
              title={
                canSubmit
                  ? undefined
                  : scope.trim().length === 0
                    ? 'Name the work this window covers.'
                    : startIso === null || endIso === null
                      ? 'Both ends of the window are required.'
                      : orderProblem
              }
              onClick={() => {
                if (startIso === null || endIso === null) return;
                create.mutate(
                  {
                    scope: scope.trim(),
                    instanceId: instanceId === '' ? null : instanceId,
                    startsAt: startIso,
                    endsAt: endIso,
                  },
                  { onSuccess: closeSchedule },
                );
              }}
            >
              {create.isPending ? 'Scheduling…' : 'Schedule window'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createProblem !== null ? (
            <Callout tone="danger" title={createProblem.title}>
              {createProblem.detail} {createProblem.remediation}
            </Callout>
          ) : null}
          <Field
            label="Scope"
            required
            htmlFor="mw-scope"
            error={fieldError('scope')}
            hint="What the window covers. It names a platform-wide window; an instance-scoped one is labelled with its product."
          >
            <Input
              id="mw-scope"
              value={scope}
              maxLength={120}
              onChange={(event) => setScope(event.target.value)}
              placeholder="Quarterly database maintenance"
            />
          </Field>
          <Field
            label="Instance"
            htmlFor="mw-instance"
            error={fieldError('instanceId')}
            hint="Leave empty for a platform-wide window."
          >
            <Select
              id="mw-instance"
              value={instanceId}
              disabled={instances.isPending || instances.isError}
              onChange={(event) => setInstanceId(event.target.value)}
            >
              <option value="">
                {instances.isError ? 'Instance list unavailable' : 'Platform-wide'}
              </option>
              {(instances.data ?? []).map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instance.entryKey} · {instance.product} ({instance.slug})
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Starts"
              required
              htmlFor="mw-starts"
              error={fieldError('startsAt')}
              hint={`Local time · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}
            >
              <Input
                id="mw-starts"
                type="datetime-local"
                value={startsAt}
                onChange={(event) => setStartsAt(event.target.value)}
              />
            </Field>
            <Field
              label="Ends"
              required
              htmlFor="mw-ends"
              error={fieldError('endsAt') ?? orderProblem}
              hint="The window stops suppressing alerts the moment it ends."
            >
              <Input
                id="mw-ends"
                type="datetime-local"
                value={endsAt}
                onChange={(event) => setEndsAt(event.target.value)}
              />
            </Field>
          </div>
          <Alert tone="caution" title="A window silences alerts, including the ones you want">
            Only schedule one for work you are performing. An incident inside the window is held and
            recorded as suppressed, not delivered.
          </Alert>
          <InlineNote>
            The times are sent as UTC instants; the window is evaluated against the platform clock,
            not this browser.
          </InlineNote>
        </div>
      </Dialog>

      <ConfirmDialog
        open={cancelTarget !== null}
        onOpenChange={(next) => (next ? undefined : setCancelTarget(null))}
        title="Cancel this maintenance window?"
        description="Alert delivery resumes immediately. The window stays in the record as cancelled, with its scope and times, so a suppression that already happened remains explainable."
        confirmLabel="Cancel window"
        tone="danger"
        busy={cancel.isPending}
        consequence={
          cancelTarget === null ? undefined : (
            <div className="space-y-1">
              <p className="text-body text-text">{cancelTarget.title}</p>
              {cancelTarget.scopeLabel === cancelTarget.title ? null : (
                <p className="text-meta text-muted">{cancelTarget.scopeLabel}</p>
              )}
              <p className="font-mono text-micro text-faint">
                {formatDateTime(cancelTarget.startsAt)} → {formatDateTime(cancelTarget.endsAt)}
              </p>
            </div>
          )
        }
        onConfirm={() => {
          const target = cancelTarget;
          if (target === null) return;
          cancel.mutate(target.id, { onSuccess: () => setCancelTarget(null) });
        }}
      />
    </Page>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, KeyRound, Plus, ShieldOff } from 'lucide-react';
import {
  toProblem,
  useBreakGlassAction,
  useBreakGlassSessions,
  useCreateBreakGlass,
  useInstances,
  useRevealBreakGlass,
} from '@seamnex/api-client';
import type { BreakGlassSession } from '@seamnex/domain';
import {
  ACCESS_MODE_LABELS,
  BREAK_GLASS_STATE_LABELS,
  accessFor,
  breakGlassStateAt,
  can,
  canMutate,
} from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  Callout,
  DataTable,
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
  StatusPill,
  Textarea,
  defineColumns,
  useNow,
} from '@seamnex/ui';
import { formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel } from '@seamnex/shell';
import { useSession } from '../../session';

/** Grid size of the request form's written reason; the API enforces the same minimum. */
const MIN_JUSTIFICATION = 20;
/** The server stores the deadline; the clock is what decides whether a grant is still live. */
const LIST_TICK_MS = 30_000;

const rowKey = (row: BreakGlassSession): string => row.id;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  // "Copied" is a confirmation, not a state: it used to stay on screen for the rest of the
  // session, so a second copy looked like it had not happened.
  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  return (
    <Button
      size="sm"
      variant="quiet"
      onClick={() => {
        // A clipboard that is unavailable is not an error worth blocking on: the value is visible.
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
            resetTimer.current = window.setTimeout(() => setCopied(false), 1_500);
          },
          () => setCopied(false),
        );
      }}
    >
      {copied ? 'Copied' : `Copy ${label}`}
    </Button>
  );
}

/**
 * The deadline, and the authority it implies, rendered as a leaf.
 *
 * The page used to hold a one-second clock so this cell could count down, which re-rendered the
 * whole register — every column rebuilt, every row re-rendered — once per second. The clock now
 * lives here, so a tick costs one text node.
 */
function BreakGlassExpiry({ session }: { session: BreakGlassSession }) {
  const now = useNow(1_000);
  if (!session.expiresAt) return <span className="text-micro text-faint">—</span>;
  const state = breakGlassStateAt(session.state, session.expiresAt, now);
  const minutesLeft = (Date.parse(session.expiresAt) - now) / 60_000;
  // The absolute time stays in the title: "in 28 min" is useless in a screenshot or a report.
  return (
    <span
      title={formatDateTime(session.expiresAt)}
      className={
        state === 'active' && minutesLeft <= 5
          ? 'text-micro font-medium text-warning-strong'
          : 'text-micro text-muted'
      }
    >
      {state === 'active'
        ? formatRelative(session.expiresAt, new Date(now))
        : formatDateTime(session.expiresAt)}
    </span>
  );
}

export function BreakGlassPage() {
  const { session } = useSession();
  const [revealTarget, setRevealTarget] = useState<BreakGlassSession | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<BreakGlassSession | null>(null);
  /**
   * Page granularity only. It decides the counts, the status pills and which actions are
   * offered — all of which also move when the list is refetched at the same cadence. The
   * per-second countdown lives in `BreakGlassExpiry`, so this tick never re-renders the table.
   */
  const now = useNow(LIST_TICK_MS);

  /*
   * Each authority is read from the matrix rather than inferred from another one. The old screen
   * showed Revoke to whoever could *request* an elevation, which is R1 — and R1 is also the only
   * role that holds `breakglass.revoke`. The two happened to line up; nothing kept them lined up.
   */
  const canRequest = can(session.role, 'breakglass.request');
  const approveAccess = accessFor(session.role, 'breakglass.approve');
  const canApprove = approveAccess !== 'none';
  const canRevoke = canMutate(session.role, 'breakglass.revoke');
  const canReveal = can(session.role, 'breakglass.request');
  const hasAnyRight = canRequest || canApprove || canRevoke;

  const sessions = useBreakGlassSessions({
    enabled: hasAnyRight,
    // A time box that runs out while the operator is watching must close on screen too.
    refetchIntervalMs: LIST_TICK_MS,
  });
  const instances = useInstances();
  const create = useCreateBreakGlass();
  const action = useBreakGlassAction();
  const reveal = useRevealBreakGlass();
  const [open, setOpen] = useState(false);
  const [instanceId, setInstanceId] = useState('');
  const [mode, setMode] = useState<'read_only' | 'read_write'>('read_only');
  const [justification, setJustification] = useState('');

  const rows = sessions.data ?? [];
  /**
   * The mutation methods are the only stable part of a mutation result, so they are named once and
   * the callbacks below depend on them instead of on the object that is recreated every render.
   */
  const { mutate: runAction } = action;
  const { mutate: revealCredential, reset: resetReveal } = reveal;
  /**
   * `stateOf` is derived from the list clock, so it is only as stable as `now` — which ticks every
   * 30 s, the cadence the register itself refetches at.
   */
  const stateOf = useCallback(
    (row: BreakGlassSession) => breakGlassStateAt(row.state, row.expiresAt, now),
    [now],
  );
  const actionProblem = action.error ? toProblem(action.error) : null;
  const createProblem = create.error ? toProblem(create.error) : null;
  const revealProblem = reveal.error ? toProblem(reveal.error) : null;
  const actingId = action.isPending ? action.variables?.id : undefined;
  const actingAction = action.isPending ? action.variables?.action : undefined;
  const revealPendingId = reveal.isPending ? revealTarget?.id : undefined;
  const justified = justification.trim().length >= MIN_JUSTIFICATION;
  const canSubmit = !create.isPending && instanceId !== '' && justified;
  /** Field-level refusals from the API belong under the field, not only in a page-level banner. */
  const fieldError = (name: string) =>
    createProblem?.fieldErrors.find((issue) => issue.field === name)?.message;

  const resetForm = () => {
    setInstanceId('');
    setMode('read_only');
    setJustification('');
    create.reset();
  };

  const closeRequest = () => {
    setOpen(false);
    resetForm();
  };

  const openReveal = useCallback(
    (row: BreakGlassSession) => {
      resetReveal();
      setRevealTarget(row);
      revealCredential(row.id);
    },
    [resetReveal, revealCredential],
  );

  const closeReveal = () => {
    setRevealTarget(null);
    // The password must not outlive the dialog: clearing the mutation drops the only copy.
    resetReveal();
  };

  const decide = useCallback(
    (row: BreakGlassSession, decision: 'approve' | 'reject') => {
      runAction({ id: row.id, action: decision });
    },
    [runAction],
  );

  /**
   * A scoped approver (R2) may decide read-only elevations only. An enabled button that always
   * answers 403 taught the operator nothing; the affordance states the rule instead.
   */
  const mayDecide = useCallback(
    (row: BreakGlassSession): boolean =>
      canApprove && !(row.accessMode === 'read_write' && approveAccess === 'scoped'),
    [canApprove, approveAccess],
  );

  /**
   * Memoised, never hoisted: the cells read the list clock, the pending action, the authority
   * matrix and the reveal dialog, so this array closes over page state. Every input is either a
   * primitive or one of the `useCallback`s above, which is what makes the memo hold — as an inline
   * array it was rebuilt on every tick, every refetch and every keystroke in the request form.
   *
   * No column is `primary`: an elevation has no page of its own, so a row has no link target. The
   * per-row buttons stay its keyboard path.
   */
  const columns = useMemo(
    () =>
      defineColumns<BreakGlassSession>([
        {
          id: 'id',
          header: 'Session',
          width: '84px',
          mono: true,
          cell: (row) => <span className="text-micro text-faint">{row.id}</span>,
        },
        {
          id: 'product',
          header: 'Target',
          cell: (row) => (
            <div>
              <span className="block text-meta font-medium text-text">{row.product}</span>
              <span className="block text-micro text-faint">{row.domainOwner}</span>
            </div>
          ),
        },
        {
          // An approver decides on a person and a reason; the requester was missing from the table.
          id: 'requester',
          header: 'Requester',
          hideBelow: 'lg',
          cell: (row) => (
            <div>
              <span className="block text-meta text-text">{row.requester.name}</span>
              <span className="block text-micro text-faint">
                {formatRelative(row.requestedAt, new Date(now))}
              </span>
            </div>
          ),
        },
        {
          id: 'mode',
          header: 'Access mode',
          cell: (row) => (
            <Badge tone={row.accessMode === 'read_write' ? 'caution' : 'info'} size="sm">
              {ACCESS_MODE_LABELS[row.accessMode].label}
            </Badge>
          ),
        },
        {
          id: 'state',
          header: 'State',
          cell: (row) => {
            const state = stateOf(row);
            const label = BREAK_GLASS_STATE_LABELS[state];
            return <StatusPill tone={label.tone} label={label.label} size="sm" />;
          },
        },
        {
          id: 'justification',
          header: 'Justification',
          hideBelow: 'xl',
          cell: (row) => (
            <p className="max-w-sm text-micro leading-snug text-muted">{row.justification}</p>
          ),
        },
        {
          id: 'expiry',
          header: 'Expires',
          hideBelow: 'md',
          cell: (row) => <BreakGlassExpiry session={row} />,
        },
        {
          id: 'approver',
          header: 'Approver',
          hideBelow: 'lg',
          cell: (row) => (
            <span className="text-micro text-muted">
              {row.approver ?? 'pending'}
              {row.selfApproved ? ' (self)' : ''}
            </span>
          ),
        },
        {
          id: 'actions',
          header: '',
          align: 'right',
          cell: (row) => {
            const state = stateOf(row);
            const pending = actingId === row.id;
            const live = state === 'active';
            return (
              <div className="flex justify-end gap-1">
                {state === 'requested' && canApprove ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending || !mayDecide(row)}
                      title={
                        mayDecide(row)
                          ? undefined
                          : 'Read-write elevation requires the domain owner of the affected domain.'
                      }
                      onClick={() => decide(row, 'approve')}
                    >
                      {pending && actingAction === 'approve' ? 'Approving…' : 'Approve'}
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      disabled={pending || !mayDecide(row)}
                      onClick={() => decide(row, 'reject')}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
                {live && canRevoke ? (
                  <Button
                    size="sm"
                    variant="quiet"
                    disabled={pending}
                    onClick={() => setRevokeTarget(row)}
                  >
                    Revoke
                  </Button>
                ) : null}
                {live && canReveal ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Eye />}
                    disabled={revealPendingId === row.id}
                    onClick={() => openReveal(row)}
                  >
                    Credential
                  </Button>
                ) : null}
              </div>
            );
          },
        },
      ]),
    [
      now,
      stateOf,
      actingId,
      actingAction,
      canApprove,
      canRevoke,
      canReveal,
      revealPendingId,
      mayDecide,
      decide,
      openReveal,
    ],
  );

  return (
    <Page>
      {/* FR-4.11 — requirement id, developer-only; it used to be the page eyebrow and is not part
          of the rendered interface. */}
      <PageHeader
        title="Break-glass sessions"
        description="Time-boxed elevation into a business product. Access mode is immutable after approval, the duration cannot be extended in-session, and expiry revokes automatically."
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus />}
            disabled={!canRequest}
            onClick={() => setOpen(true)}
          >
            Request elevation
          </Button>
        }
        meta={
          <>
            {/*
              Counts are withheld until a real answer exists. `rows` is empty while the query is
              pending or refused, and "0 active" from a failed request reads as a healthy silence.
            */}
            <Badge tone="caution" size="sm">
              {sessions.isSuccess ? rows.filter((row) => stateOf(row) === 'active').length : '—'}{' '}
              active
            </Badge>
            <Badge tone="neutral" size="sm">
              {sessions.isSuccess ? rows.filter((row) => stateOf(row) === 'requested').length : '—'}{' '}
              awaiting approval
            </Badge>
            <span className="font-mono text-micro text-faint">
              default 60 min · second-party approval
            </span>
          </>
        }
      />

      {!hasAnyRight ? (
        <Callout tone="info" title="Your role has no break-glass rights">
          R1 may request elevation; R3 approves for their own domain; R2 approves read-only
          sessions. R4 and R5 hold no elevation rights. The register is not queried for a role that
          cannot read it, so nothing on this page is a refusal.
        </Callout>
      ) : null}

      {actionProblem !== null ? (
        <Callout
          tone="danger"
          title={
            actionProblem.code === 'MFA_REQUIRED'
              ? 'Ending an elevation needs a second factor'
              : actionProblem.title
          }
        >
          {actionProblem.code === 'MFA_REQUIRED'
            ? 'This session was established without a satisfied second factor. Sign in again with your second factor, then retry. The refusal was audited.'
            : actionProblem.detail}
        </Callout>
      ) : null}

      {/*
        The register is only requested for a role that may read it, so it is only rendered for one
        too: a disabled query is pending forever, and a permanent skeleton reads as a broken screen.
      */}
      {hasAnyRight ? (
        <Panel>
          <PanelHeader
            eyebrow="Sessions"
            title="Elevation history"
            description="Approval of a read-write session requires the domain owner. Auditors may approve read-only sessions only."
          />
          {/*
            A failed *refetch* keeps the register on screen behind the caution banner: the deadlines
            and approvers below are the last thing the API said, and an operator mid-elevation must
            not lose them to a background error (ERR-04).
          */}
          <AsyncPanel
            query={sessions}
            loading={
              <div className="p-4">
                <SkeletonLines lines={6} />
              </div>
            }
            loadingLabel="Loading break-glass sessions"
          >
            {(data) => (
              <DataTable
                columns={columns}
                rows={data}
                rowKey={rowKey}
                dense
                empty={
                  <EmptyState
                    title="No break-glass sessions"
                    description="Elevation is requested per task, justified in writing and approved by a second party. It is never standing access."
                    action={
                      canRequest ? (
                        <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
                          Request break-glass
                        </Button>
                      ) : undefined
                    }
                  />
                }
              />
            )}
          </AsyncPanel>
        </Panel>
      ) : null}

      <Dialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : closeRequest())}
        title="Request break-glass elevation"
        description="A written justification is required. Approval by a second party is mandatory where one exists."
        footer={
          <>
            <Button variant="ghost" onClick={closeRequest}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<KeyRound />}
              disabled={!canSubmit}
              // The dead button used to be the only explanation; the hint under it says which
              // requirement is outstanding, so a keyboard or screen-reader user is not guessing.
              title={
                canSubmit
                  ? undefined
                  : instanceId === ''
                    ? 'Choose the target instance first.'
                    : `Write at least ${MIN_JUSTIFICATION} characters of justification.`
              }
              onClick={() => {
                create.mutate(
                  { instanceId, accessMode: mode, justification: justification.trim() },
                  { onSuccess: closeRequest },
                );
              }}
            >
              {create.isPending ? 'Submitting…' : 'Submit request'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {createProblem !== null ? (
            <Callout tone="danger" title={createProblem.title}>
              {createProblem.detail}
            </Callout>
          ) : null}
          {instances.isError ? (
            <Callout tone="danger" title="The instance list could not be loaded">
              Without it no target can be chosen. Retry before submitting; a stale list would let a
              request be filed against a deployment that is gone.
              <span className="mt-2 block">
                <Button size="sm" variant="secondary" onClick={() => void instances.refetch()}>
                  Retry
                </Button>
              </span>
            </Callout>
          ) : null}
          <Field
            label="Target instance"
            required
            htmlFor="bg-instance"
            error={fieldError('instanceId')}
            hint={
              instances.isPending
                ? 'Loading deployed instances…'
                : 'The elevation is bound to this deployment.'
            }
          >
            <Select
              id="bg-instance"
              value={instanceId}
              disabled={instances.isPending || instances.isError}
              onChange={(event) => setInstanceId(event.target.value)}
            >
              <option value="">
                {instances.isError ? 'Instance list unavailable' : 'Choose an instance…'}
              </option>
              {(instances.data ?? []).map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {instance.entryKey} · {instance.product} ({instance.slug}) · {instance.state}
                </option>
              ))}
            </Select>
          </Field>

          <fieldset>
            <legend className="mb-1.5 text-muted label-caps-sans">Access mode</legend>
            <div className="space-y-2">
              {(['read_only', 'read_write'] as const).map((option) => (
                <label
                  key={option}
                  className={
                    mode === option
                      ? 'flex cursor-pointer items-start gap-2 rounded-sm border border-primary bg-primary-soft/50 px-3 py-2'
                      : 'flex cursor-pointer items-start gap-2 rounded-sm border border-line px-3 py-2'
                  }
                >
                  <input
                    type="radio"
                    name="access-mode"
                    checked={mode === option}
                    onChange={() => setMode(option)}
                    className="mt-0.5 accent-primary"
                  />
                  <span>
                    <span className="block text-body font-medium text-text">
                      {ACCESS_MODE_LABELS[option].label}
                    </span>
                    <span className="mt-0.5 block text-meta text-muted">
                      {ACCESS_MODE_LABELS[option].description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <Field
            label="Justification"
            required
            htmlFor="bg-justification"
            hint={`At least ${MIN_JUSTIFICATION} characters. Recorded in the audit log and shared with the domain owner.`}
            error={
              fieldError('justification') ??
              (justification.length > 0 && !justified ? 'Add more detail.' : undefined)
            }
          >
            <Textarea
              id="bg-justification"
              value={justification}
              onChange={(event) => setJustification(event.target.value)}
              placeholder="Why is standing platform authority insufficient for this task?"
            />
          </Field>
          <p
            aria-live="polite"
            className={
              justified
                ? 'font-mono text-micro text-faint'
                : 'font-mono text-micro text-warning-strong'
            }
          >
            {justification.trim().length}/{MIN_JUSTIFICATION} characters
            {justified ? '' : ' — the approver decides on this text alone'}
          </p>

          <Alert tone="caution" title="The mode cannot be escalated after approval">
            If read-write turns out to be necessary, the session must be revoked and a new request
            approved.
          </Alert>
          <InlineNote>
            Accounts created inside the product are either removed at revocation or retained with a
            recorded reason.
          </InlineNote>
        </div>
      </Dialog>

      {/*
        CL-12: the credential exists in the API and had no screen, so an approved elevation could
        not actually be used. It is shown once, for seconds, and dropped when the dialog closes —
        never held in a query cache or a toast.
      */}
      <Dialog
        open={revealTarget !== null}
        onOpenChange={(next) => (next ? undefined : closeReveal())}
        title="Elevation credential"
        description="Single use and short-lived. It is recorded in the audit trail and is not shown again once this window closes."
        footer={
          <Button variant="ghost" onClick={closeReveal}>
            Close
          </Button>
        }
      >
        <div className="space-y-3">
          {reveal.isPending ? <SkeletonLines lines={4} /> : null}
          {revealProblem !== null ? (
            <Callout
              tone={revealProblem.code === 'STATE_CONFLICT' ? 'caution' : 'danger'}
              title={revealProblem.title}
            >
              {revealProblem.detail} {revealProblem.remediation}
            </Callout>
          ) : null}
          {reveal.data ? (
            <>
              <dl className="grid gap-2">
                <div>
                  <dt className="text-muted label-caps-sans">In-product account</dt>
                  <dd className="mt-1 flex items-center gap-2">
                    <code className="font-mono text-body text-text">{reveal.data.username}</code>
                    <CopyButton value={reveal.data.username} label="account" />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted label-caps-sans">Password</dt>
                  <dd className="mt-1 flex flex-wrap items-center gap-2">
                    <code className="break-all font-mono text-body text-text">
                      {reveal.data.password}
                    </code>
                    <CopyButton value={reveal.data.password} label="password" />
                  </dd>
                </div>
              </dl>
              <p className="text-meta leading-relaxed text-muted">{reveal.data.methodNote}</p>
              <Alert
                tone={
                  Math.max(0, Math.ceil((Date.parse(reveal.data.expiresAt) - now) / 1_000)) === 0
                    ? 'danger'
                    : 'caution'
                }
                title={
                  Math.max(0, Math.ceil((Date.parse(reveal.data.expiresAt) - now) / 1_000)) === 0
                    ? 'This credential has expired'
                    : `Valid for ${Math.max(0, Math.ceil((Date.parse(reveal.data.expiresAt) - now) / 1_000))} seconds`
                }
              >
                The account is removed when the elevation is revoked, or at expiry. A second reveal
                is refused while this one is still valid.
              </Alert>
            </>
          ) : null}
        </div>
      </Dialog>

      {/*
        Revoke is destructive and permanent: it ends a live grant. It asks first, and the question
        names the elevation so a mis-click in a dense table cannot end the wrong session.
      */}
      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(next) => (next ? undefined : setRevokeTarget(null))}
        title="Revoke this elevation?"
        description="Access ends immediately, the in-product account is revoked and the reason is written to the audit trail. A new request would need a new approval."
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevokeTarget(null)}>
              Keep it active
            </Button>
            <Button
              variant="danger"
              icon={<ShieldOff />}
              disabled={action.isPending}
              onClick={() => {
                const target = revokeTarget;
                if (target === null) return;
                action.mutate(
                  { id: target.id, action: 'revoke' },
                  { onSuccess: () => setRevokeTarget(null) },
                );
              }}
            >
              {action.isPending ? 'Revoking…' : 'Revoke now'}
            </Button>
          </>
        }
      >
        {revokeTarget === null ? null : (
          <div className="space-y-2">
            <p className="text-body text-text">
              <span className="font-mono text-micro text-faint">{revokeTarget.id}</span> ·{' '}
              {revokeTarget.product} · {ACCESS_MODE_LABELS[revokeTarget.accessMode].label}
            </p>
            <p className="text-meta leading-relaxed text-muted">{revokeTarget.justification}</p>
            {revokeTarget.expiresAt ? (
              <InlineNote>
                It would otherwise end on its own{' '}
                {formatRelative(revokeTarget.expiresAt, new Date(now))}.
              </InlineNote>
            ) : null}
          </div>
        )}
      </Dialog>
    </Page>
  );
}

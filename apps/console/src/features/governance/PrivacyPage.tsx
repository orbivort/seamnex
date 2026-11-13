import { useMemo, useState } from 'react';
import { FileLock2, Plus } from 'lucide-react';
import {
  toProblem,
  useAdvancePrivacyRequest,
  useCreatePrivacyRequest,
  usePrivacyRequests,
} from '@seamnex/api-client';
import type { PrivacyRequest } from '@seamnex/domain';
import { canMutate } from '@seamnex/domain';
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
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  SkeletonLines,
  SplitLayout,
  StatusPill,
  Tag,
  defineColumns,
} from '@seamnex/ui';
import { cn, formatDate, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';
import { useSession } from '../../session';

const STATE_TONE = {
  open: 'caution',
  running: 'info',
  complete: 'positive',
  failed: 'danger',
} as const;

const SCOPE_TONE = {
  pending: 'neutral',
  running: 'info',
  complete: 'positive',
  failed: 'danger',
} as const;

const rowKey = (row: PrivacyRequest): string => row.id;

/**
 * A 64-character HMAC reference never fits a column or a panel header. The full value stays in the
 * tooltip and in the detail body, so shortening the label never hides an identifier an operator
 * has to check.
 */
function shortRef(reference: string): string {
  return reference.length <= 14 ? reference : `${reference.slice(0, 8)}…${reference.slice(-4)}`;
}

function completedScopes(request: PrivacyRequest): number {
  return request.scopes.filter((scope) => scope.state === 'complete').length;
}

function Scopes({ request }: { request: PrivacyRequest }) {
  if (request.scopes.length === 0) {
    return (
      <span className="text-micro text-faint" title="No scope recorded for this request">
        —
      </span>
    );
  }
  const done = completedScopes(request);
  return (
    <span
      className="font-mono text-micro text-muted"
      title={`${done} of ${request.scopes.length} scopes complete`}
    >
      {done}/{request.scopes.length}
    </span>
  );
}

export function PrivacyPage() {
  const { session } = useSession();
  const queue = usePrivacyRequests();
  const createRequest = useCreatePrivacyRequest();
  const advance = useAdvancePrivacyRequest();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'export' | 'delete'>('export');
  const [subjectRef, setSubjectRef] = useState('');

  const requests = queue.data?.requests ?? [];
  const selected = requests.find((item) => item.id === selectedId) ?? requests[0] ?? null;
  const canManage = canMutate(session.role, 'privacy.manage');
  const createProblem = createRequest.error ? toProblem(createRequest.error) : null;
  const advanceProblem = advance.error ? toProblem(advance.error) : null;
  const subjectError = createProblem?.fieldErrors?.find(
    (item) => item.field === 'subjectRef',
  )?.message;
  /** Advancing is only meaningful while a scope is still outstanding. */
  const advanceable =
    selected !== null &&
    selected.state !== 'complete' &&
    selected.scopes.some((scope) => scope.state !== 'complete');
  /** The confirmation belongs to the request that was advanced, not to whatever is selected next. */
  const advanced =
    advance.data && selected && advance.data.id === selected.id ? advance.data : null;

  /**
   * Memoised, never hoisted: the Inspect cell selects a row in the detail panel beside the table, so
   * the array closes over `setSelectedId`. `[]` is still honest — a setter cannot change identity.
   *
   * No column is `primary` on purpose: this table selects, it does not navigate. A data-subject
   * request has no page of its own, so there is no href to give the identity cell, and pretending
   * otherwise would put a link on the row that goes nowhere. `onRowActivate` (pointer) plus the
   * Inspect button (keyboard) stay as they are — see A11Y-04's "selection row" exception.
   */
  const columns = useMemo(
    () =>
      defineColumns<PrivacyRequest>([
        {
          id: 'id',
          header: 'Request',
          mono: true,
          cell: (row) => (
            // A UUID wraps into three lines in a narrow column; the short handle is enough to pick
            // the row, and the full id is in the detail header and the tooltip.
            <span className="whitespace-nowrap text-micro text-text" title={row.id}>
              {row.id.slice(0, 8)}
            </span>
          ),
        },
        {
          id: 'kind',
          header: 'Kind',
          cell: (row) => (
            <Badge tone={row.kind === 'delete' ? 'danger' : 'info'} size="sm">
              {row.kind}
            </Badge>
          ),
        },
        {
          id: 'subject',
          header: 'Subject',
          hideBelow: 'sm',
          cell: (row) => (
            <Tag mono>
              <span title={row.subjectRef}>{shortRef(row.subjectRef)}</span>
            </Tag>
          ),
        },
        {
          id: 'state',
          header: 'State',
          cell: (row) => <StatusPill tone={STATE_TONE[row.state]} label={row.state} size="sm" />,
        },
        {
          id: 'scopes',
          header: 'Scopes',
          align: 'right',
          hideBelow: 'md',
          cell: (row) => <Scopes request={row} />,
        },
        {
          id: 'due',
          header: 'Due',
          align: 'right',
          hideBelow: 'lg',
          cell: (row) => {
            // NFR-4.13: the 30-day window is a legal deadline, so a missed one is not just a date.
            // eslint-disable-next-line react-hooks/purity -- a statutory deadline is compared with the wall clock, not with a render input
            const overdue = row.state !== 'complete' && Date.parse(row.dueAt) < Date.now();
            return (
              <span
                className={cn(
                  'whitespace-nowrap text-micro',
                  overdue ? 'font-semibold text-danger' : 'text-muted',
                )}
                title={overdue ? 'Past the statutory deadline' : undefined}
              >
                {formatDate(row.dueAt)}
              </span>
            );
          },
        },
        {
          id: 'inspect',
          header: '',
          align: 'right',
          cell: (row) => (
            <Button size="sm" variant="quiet" onClick={() => setSelectedId(row.id)}>
              Inspect
            </Button>
          ),
        },
      ]),
    [],
  );

  return (
    <Page>
      {/* NFR-4.13 · FR-4.3 — requirement ids, developer-only; they used to be the page eyebrow and
          are not part of the rendered interface. */}
      <PageHeader
        title="Privacy requests"
        description="Export and erasure requests are addressed by the pseudonymous subject reference. Platform-tier scopes are always included, because a subject's data is not only inside products."
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={<Plus />}
            disabled={!canManage}
            onClick={() => setOpen(true)}
          >
            Open request
          </Button>
        }
        meta={
          queue.data ? (
            <>
              <span className="text-micro text-muted">{requests.length} requests</span>
              <span className="text-micro text-muted">
                {requests.filter((item) => item.state !== 'complete').length} open
              </span>
              <span className="text-micro text-muted">30-day statutory window</span>
            </>
          ) : null
        }
      />

      {!canManage ? (
        <Callout tone="info" title="Read-only privacy queue" className="mb-3">
          R2 can inspect scope progress and evidence; opening and advancing a request needs the
          platform administrator.
        </Callout>
      ) : null}

      {/*
        The queue and the detail panel are two views of one read, so they share one async region: a
        skeleton while the queue loads, a problem panel only when there is no queue at all, and the
        last queue behind a caution banner when a refetch fails (ERR-03/ERR-04).
      */}
      <AsyncPanel
        query={queue}
        loading={
          <Panel inset>
            <SkeletonLines lines={6} />
          </Panel>
        }
        loadingLabel="Loading the privacy queue"
      >
        {() => (
          <SplitLayout ratio="content">
            <Panel>
              <PanelHeader
                eyebrow="Queue"
                title="Data-subject requests"
                description="Every scope is executed through the brokered credential; the audit chain stores only the opaque reference."
              />
              <DataTable
                columns={columns}
                rows={requests}
                rowKey={rowKey}
                {...(selected ? { selectedKey: selected.id } : {})}
                onRowActivate={(row) => setSelectedId(row.id)}
                caption="Data-subject requests, addressed by pseudonymous reference"
                empty={
                  <EmptyState
                    compact
                    icon={<FileLock2 className="size-5" />}
                    title="No privacy requests"
                    description="Open a request with the subject reference from the identity-provider export."
                  />
                }
              />
            </Panel>

            <div className="space-y-3">
              <Panel>
                <PanelHeader
                  eyebrow={selected ? selected.id : 'Detail'}
                  title={
                    selected ? `Scopes for ${shortRef(selected.subjectRef)}` : 'Select a request'
                  }
                  description={
                    selected && selected.scopes.length > 0
                      ? `${completedScopes(selected)} of ${selected.scopes.length} scopes complete · due ${formatDate(selected.dueAt)}`
                      : undefined
                  }
                  actions={
                    selected && canManage && advanceable ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={advance.isPending}
                        onClick={() => advance.mutate(selected.id)}
                      >
                        {advance.isPending ? 'Advancing…' : 'Advance scope'}
                      </Button>
                    ) : null
                  }
                />
                {selected ? (
                  <div className="space-y-3 p-4">
                    {advanceProblem ? <QueryError error={advance.error} compact /> : null}
                    {advanced ? (
                      <Alert tone="positive" title={`${advanced.id} advanced`}>
                        {completedScopes(advanced)} of {advanced.scopes.length} scopes complete.
                      </Alert>
                    ) : null}
                    <div className="min-w-0">
                      <p className="mb-1 text-faint label-caps-sans">Subject reference</p>
                      <p className="font-mono text-micro break-all text-text">
                        {selected.subjectRef}
                      </p>
                    </div>
                    {selected.state === 'complete' &&
                    completedScopes(selected) < selected.scopes.length ? (
                      <Callout tone="caution" title="Closed with scopes still outstanding">
                        {selected.scopes.length - completedScopes(selected)} scope
                        {selected.scopes.length - completedScopes(selected) === 1 ? '' : 's'} never
                        reported completion. A request opened now snapshots its scope list and
                        closes only when every scope is complete; this record predates that.
                      </Callout>
                    ) : null}
                    <ul className="space-y-2">
                      {selected.scopes.map((scope) => (
                        <li
                          key={scope.scopeId}
                          className="rounded-sm border border-line bg-panel-soft p-2.5"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-meta font-medium text-text">{scope.label}</p>
                              <p className="mt-0.5 text-micro leading-snug text-faint">
                                {scope.detail}
                              </p>
                            </div>
                            <StatusPill
                              tone={SCOPE_TONE[scope.state]}
                              label={scope.state}
                              size="sm"
                            />
                          </div>
                          <p className="mt-1 font-mono text-faint label-caps">
                            {scope.scopeType} · {scope.scopeId}
                          </p>
                        </li>
                      ))}
                    </ul>
                    {selected.scopes.length === 0 ? (
                      <InlineNote>
                        No scope is recorded for this request, so there is nothing to advance. The
                        scope list is taken from the personal-data map when a request is opened.
                      </InlineNote>
                    ) : null}
                    <div>
                      <p className="mb-1 text-faint label-caps-sans">Evidence</p>
                      {selected.evidence.length === 0 ? (
                        <p className="text-micro text-faint">No step recorded yet.</p>
                      ) : (
                        <ul className="space-y-1">
                          {selected.evidence.map((item) => (
                            <li key={item} className="text-micro text-muted">
                              · {item}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <InlineNote>
                      Opened {formatRelative(selected.openedAt)} by {selected.openedBy}. The audit
                      chain keeps only the pseudonymous reference after erasure.
                    </InlineNote>
                  </div>
                ) : (
                  <div className="p-4">
                    <EmptyState
                      compact
                      icon={<FileLock2 className="size-5" />}
                      title="Nothing selected"
                      description="Choose a request in the queue to see per-scope progress."
                    />
                  </div>
                )}
              </Panel>
            </div>
          </SplitLayout>
        )}
      </AsyncPanel>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Open a privacy request"
        description="Address the request by subject reference; the scope list is snapshotted from the personal-data map when the request opens."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={createRequest.isPending || subjectRef.trim() === ''}
              onClick={() =>
                createRequest.mutate(
                  { subjectRef: subjectRef.trim(), kind },
                  {
                    onSuccess: (created) => {
                      setOpen(false);
                      setSubjectRef('');
                      // The new request is the one the operator wants to work through next.
                      setSelectedId(created.id);
                    },
                  },
                )
              }
            >
              {createRequest.isPending ? 'Opening…' : 'Open request'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {createProblem ? <QueryError error={createRequest.error} compact /> : null}
          <Field label="Request kind" required htmlFor="privacy-kind">
            <Select
              id="privacy-kind"
              value={kind}
              onChange={(event) => setKind(event.target.value === 'delete' ? 'delete' : 'export')}
            >
              <option value="export">Export — subject access</option>
              <option value="delete">Delete — erasure</option>
            </Select>
          </Field>
          <Field
            label="Subject reference"
            required
            htmlFor="privacy-subject"
            hint="The HMAC reference from the identity-provider export; never a name or email address."
            {...(subjectError ? { error: subjectError } : {})}
          >
            <Input
              id="privacy-subject"
              value={subjectRef}
              onChange={(event) => setSubjectRef(event.target.value)}
              placeholder="sub_44c1"
              maxLength={64}
              className="font-mono"
              autoComplete="off"
            />
          </Field>
          <Callout tone="info" title="Platform scopes are mandatory">
            Entitlements, identity record, audit events, job logs and notifications are always in
            scope. Product scopes come from the personal-data map and are executed one scope at a
            time, so progress is visible before the request closes.
          </Callout>
        </div>
      </Dialog>
    </Page>
  );
}

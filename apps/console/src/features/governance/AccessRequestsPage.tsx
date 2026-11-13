import { useDeferredValue, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys, useAccessRequests, useDecideAccessRequest, useMe } from '@seamnex/api-client';
import type { AccessRequest } from '@seamnex/domain';
import { ACCESS_REQUEST_KIND_LABELS, ACCESS_REQUEST_STATE_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChip,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  defineColumns,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

type DecisionScope = 'open' | 'decided' | 'all';

/** A queue opens on the work still to do; decided rows stay one chip away, not in the default view. */
const DECISION_SCOPES: { id: DecisionScope; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'decided', label: 'Decided' },
  { id: 'all', label: 'All' },
];

/** A UUID does not fit a dense cell; the short handle keeps the row on one line, the title carries the whole id. */
function shortId(id: string): string {
  return id.slice(0, 8);
}

const rowKey = (row: AccessRequest): string => row.id;

/**
 * The decision, applied to the list before the round trip answers.
 *
 * Approval is a single-row state flip with a deterministic local effect, so waiting two hundred
 * milliseconds of simulated latency for a spinner is the wrong trade: under the demo's latency knob
 * the buttons looked inert. The guess is deliberately narrow — state, decider and timestamp, the
 * three fields the row prints — and it is never treated as the record: the mutation's own response
 * replaces it, and a refusal restores the snapshot taken here.
 */
function decideOptimistically(
  list: AccessRequest[] | undefined,
  id: string,
  decision: 'approve' | 'reject',
  decider: string,
): AccessRequest[] | undefined {
  if (list === undefined) return undefined;
  return list.map((item) =>
    item.id === id
      ? {
          ...item,
          state: decision === 'approve' ? 'approved' : 'rejected',
          decidedBy: decider,
          decidedAt: new Date().toISOString(),
        }
      : item,
  );
}

export function AccessRequestsPage() {
  const requests = useAccessRequests();
  const decide = useDecideAccessRequest();
  // The only stable part of a mutation result; the column memo depends on it, not on the object
  // that is recreated on every render.
  const { reset: resetDecision } = decide;
  const client = useQueryClient();
  // The optimistic row has to name a decider and the layout already holds this query, so the read
  // is served from the cache rather than being a second request.
  const me = useMe();
  const deciderName = me.data?.displayName;
  const [scope, setScope] = useState<DecisionScope>('open');
  const [query, setQuery] = useState('');
  /**
   * Approval grants access and this screen cannot undo it, so a click only arms the decision and
   * the dialog sends it. It also removes the double submit the bare buttons allowed: two clicks
   * fired two decisions, and the second landed on a row the operator had just approved.
   */
  const [pending, setPending] = useState<{
    row: AccessRequest;
    decision: 'approve' | 'reject';
  } | null>(null);

  const rows = useMemo(() => requests.data ?? [], [requests.data]);
  const openCount = rows.filter((row) => row.state === 'open').length;

  /**
   * The filter runs over a list already in memory, so it does not need a debounce: it needs to
   * stop competing with the keystroke. `useDeferredValue` lets the input repaint immediately and
   * the queue catch up in a lower-priority render. `useDebouncedValue` remains the tool for the
   * filters that reach the network.
   */
  const deferredQuery = useDeferredValue(query);

  const visible = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    return rows.filter((row) => {
      if (scope === 'open' && row.state !== 'open') return false;
      if (scope === 'decided' && row.state === 'open') return false;
      if (needle.length === 0) return true;
      return [row.id, row.requester.name, row.target, row.justification, row.domain].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [rows, scope, deferredQuery]);

  /**
   * Memoised, never hoisted: the decision cell arms the confirmation dialog, so the array closes
   * over `setPending` and the mutation's own `reset`. Both are stable, which is what makes the memo
   * worth having (the previous empty dependency list rebuilt every cell on every render).
   *
   * No column is `primary`: a request has no page of its own, so a row has no href to link to, and
   * the Approve/Reject buttons are the row's keyboard path.
   */
  const columns = useMemo(
    () =>
      defineColumns<AccessRequest>([
        {
          id: 'id',
          header: 'Request',
          width: '110px',
          mono: true,
          cell: (row) => (
            <span className="text-micro text-faint" title={row.id}>
              {shortId(row.id)}
            </span>
          ),
        },
        {
          id: 'requester',
          header: 'Requester',
          cell: (row) => (
            <div>
              <span className="block text-meta font-medium text-text">{row.requester.name}</span>
              <span className="block text-micro text-faint">{formatRelative(row.createdAt)}</span>
            </div>
          ),
        },
        {
          id: 'kind',
          header: 'Kind',
          cell: (row) => {
            const spec = ACCESS_REQUEST_KIND_LABELS[row.kind];
            return (
              <Badge tone={spec.tone} size="sm">
                {spec.label}
              </Badge>
            );
          },
        },
        {
          id: 'target',
          header: 'Target',
          cell: (row) => <span className="text-meta text-text">{row.target}</span>,
        },
        {
          id: 'justification',
          header: 'Justification',
          hideBelow: 'lg',
          cell: (row) => (
            <p className="max-w-sm text-micro leading-snug text-muted">{row.justification}</p>
          ),
        },
        {
          id: 'state',
          header: 'State',
          cell: (row) => {
            const spec = ACCESS_REQUEST_STATE_LABELS[row.state];
            return (
              <Badge tone={spec.tone} size="sm">
                {spec.label}
              </Badge>
            );
          },
        },
        {
          id: 'decision',
          header: 'Decision',
          align: 'right',
          cell: (row) =>
            row.state === 'open' ? (
              <div className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`Approve request ${shortId(row.id)} from ${row.requester.name}`}
                  onClick={() => {
                    resetDecision();
                    setPending({ row, decision: 'approve' });
                  }}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="quiet"
                  aria-label={`Reject request ${shortId(row.id)} from ${row.requester.name}`}
                  onClick={() => {
                    resetDecision();
                    setPending({ row, decision: 'reject' });
                  }}
                >
                  Reject
                </Button>
              </div>
            ) : (
              <div>
                <span className="block text-meta text-muted">
                  {row.decidedBy ?? 'Unknown decider'}
                </span>
                {row.decidedAt === null ? null : (
                  <span className="block text-micro text-faint">
                    {formatRelative(row.decidedAt)}
                  </span>
                )}
              </div>
            ),
        },
      ]),
    [resetDecision],
  );

  /**
   * Snapshot, apply the guess, send the decision. The server's answer then overwrites the guess
   * before the invalidated list refetches, so what stays on screen is the record — not the
   * prediction.
   */
  const decideNow = (row: AccessRequest, decision: 'approve' | 'reject') => {
    const snapshot = client.getQueryData<AccessRequest[]>(queryKeys.accessRequests);
    /*
     * The row prints the decider's name, so a guess without the identity on hand would put a wrong
     * name on screen. `me` is already cached by the layout in practice; when it is not, the row
     * simply waits for the server's answer the way it used to, which is the honest fallback.
     */
    if (deciderName !== undefined) {
      client.setQueryData<AccessRequest[]>(queryKeys.accessRequests, (current) =>
        decideOptimistically(current, row.id, decision, deciderName),
      );
    }
    decide.mutate(
      { id: row.id, decision },
      {
        onSuccess: (decided) => {
          // Decided state, decider and timestamp are audit-relevant: the response is authoritative.
          client.setQueryData<AccessRequest[]>(queryKeys.accessRequests, (current) =>
            current?.map((item) => (item.id === decided.id ? decided : item)),
          );
          setPending(null);
        },
        onError: () => {
          // A refused decision keeps the dialog open (the problem is read there), and the row must
          // not be left looking decided behind it.
          if (snapshot !== undefined) {
            client.setQueryData<AccessRequest[]>(queryKeys.accessRequests, snapshot);
          }
        },
      },
    );
  };

  return (
    <Page>
      {/* FR-3.13 · FR-4.4 — requirement ids, developer-only; they used to be the page eyebrow and
          are not part of the rendered interface. */}
      <PageHeader
        title="Access requests"
        description="A second party decides every request: the requester cannot approve their own. Approving an entitlement grants the product role on the target instance, and the decision, its justification and the decider stay in the audit chain."
        meta={
          requests.data ? (
            <>
              <span className="text-micro text-muted">{rows.length} requests</span>
              <span className="text-micro text-muted">{openCount} awaiting a decision</span>
            </>
          ) : null
        }
      />
      <Panel>
        <PanelHeader
          eyebrow="Queue"
          title="Open and decided requests"
          description="Newest first. The scope chips narrow the list; the search matches requester, target, justification or id."
        />
        <FilterBar
          search={query}
          onSearch={setQuery}
          searchLabel="Search access requests"
          placeholder="Requester, target or justification"
          trailing={`${visible.length} shown`}
        >
          {DECISION_SCOPES.map((item) => (
            <FilterChip key={item.id} active={scope === item.id} onClick={() => setScope(item.id)}>
              {item.id === 'open' ? `${item.label} · ${openCount}` : item.label}
            </FilterChip>
          ))}
        </FilterBar>
        {/*
          The queue is one async region. A failed refetch keeps the rows an operator was reading
          behind the caution banner, and the loading branch announces itself (ERR-03, ERR-04).
        */}
        <AsyncPanel
          query={requests}
          loading={
            <div className="p-4">
              <SkeletonLines lines={5} />
            </div>
          }
          loadingLabel="Loading access requests"
        >
          {() => (
            <DataTable
              columns={columns}
              rows={visible}
              rowKey={rowKey}
              dense
              caption="Access requests, newest first"
              empty={
                rows.length === 0 ? (
                  <EmptyState
                    title="No access requests yet"
                    description="End users raise requests from the portal. An approval grants the product role and is recorded against the decider."
                  />
                ) : (
                  <EmptyState
                    title={
                      scope === 'open'
                        ? 'Nothing is waiting for a decision'
                        : 'No request matches this view'
                    }
                    description={`${rows.length} ${
                      rows.length === 1 ? 'request exists' : 'requests exist'
                    }; none match the current scope and search.`}
                    action={
                      <Button
                        size="sm"
                        variant="quiet"
                        onClick={() => {
                          setQuery('');
                          setScope('all');
                        }}
                      >
                        Show all requests
                      </Button>
                    }
                  />
                )
              }
            />
          )}
        </AsyncPanel>
      </Panel>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        title={pending?.decision === 'reject' ? 'Reject this request?' : 'Approve this request?'}
        description={
          pending?.decision === 'reject'
            ? 'The decision is recorded against your name and nothing is granted.'
            : 'Approving grants the requested access now. The decision and the justification stay in the audit chain.'
        }
        confirmLabel={pending?.decision === 'reject' ? 'Reject request' : 'Approve and grant'}
        tone={pending?.decision === 'reject' ? 'danger' : 'primary'}
        busy={decide.isPending}
        consequence={
          pending === null ? null : (
            <div className="flex flex-col gap-3">
              <p className="text-body text-text">
                <span className="font-mono text-micro text-faint">{shortId(pending.row.id)}</span> ·{' '}
                {ACCESS_REQUEST_KIND_LABELS[pending.row.kind].label} · {pending.row.target}
              </p>
              <p className="text-meta text-muted">
                Requested by {pending.row.requester.name} {formatRelative(pending.row.createdAt)}.
              </p>
              <p className="text-meta leading-relaxed text-muted">{pending.row.justification}</p>
              {decide.isError ? <QueryError error={decide.error} compact /> : null}
            </div>
          )
        }
        onConfirm={() => {
          if (pending === null) return;
          decideNow(pending.row, pending.decision);
        }}
      />
    </Page>
  );
}

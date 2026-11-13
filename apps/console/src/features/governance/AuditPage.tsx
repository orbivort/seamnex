import { useMemo, useState } from 'react';
import { Download, FileCheck2, Fingerprint } from 'lucide-react';
import type { AuditFilters } from '@seamnex/api-client';
import { useAuditPages, useAuditProof, useExportAudit } from '@seamnex/api-client';
import type { AuditEvent } from '@seamnex/domain';
import {
  Badge,
  Button,
  DataTable,
  DefinitionList,
  Drawer,
  EmptyState,
  Input,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  Select,
  SkeletonLines,
  Tag,
  defineColumns,
} from '@seamnex/ui';
import { downloadJson, formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError, useDebouncedValue } from '@seamnex/shell';

/*
 * The options are the dotted namespaces the platform actually writes (`auth.session.created`,
 * `instance.deploy.succeeded`, …), and the server matches them as a prefix. The previous list
 * offered five namespaces nothing ever writes (`entitlement`, `audit`, `user`, `metadata`,
 * `policy`) and omitted the largest ones, so every choice filtered the trail to nothing.
 */
const ACTIONS = [
  { value: '', label: 'All actions' },
  { value: 'access', label: 'Access control' },
  { value: 'access_request', label: 'Access requests' },
  { value: 'auth', label: 'Authentication' },
  { value: 'breakglass', label: 'Break-glass' },
  { value: 'catalog', label: 'Catalog' },
  { value: 'identity', label: 'Identity sync' },
  { value: 'instance', label: 'Instance lifecycle' },
  { value: 'job', label: 'Jobs' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'platform', label: 'Platform' },
  { value: 'policy_exception', label: 'Policy exceptions' },
  { value: 'privacy', label: 'Privacy' },
  { value: 'secret', label: 'Secrets' },
  { value: 'settings', label: 'Settings' },
  { value: 'workflow', label: 'Workflow' },
];

/**
 * Row identity at module scope: `DataTable` no longer compares props, so a `rowKey` created during
 * render would be one more closure per render for no benefit.
 */
const rowKey = (row: AuditEvent): string => row.id;

export function AuditPage() {
  const [action, setAction] = useState('');
  const [outcome, setOutcome] = useState('');
  const [actor, setActor] = useState('');
  const [proofSeq, setProofSeq] = useState<number | null>(null);
  const debouncedActor = useDebouncedValue(actor);

  // The actor box is debounced before it becomes part of the query key, so typing does
  // not issue one request per keystroke.
  const filters = useMemo<AuditFilters>(() => {
    const next: AuditFilters = {};
    if (action) next.action = action;
    if (outcome) next.outcome = outcome;
    if (debouncedActor.trim()) next.actor = debouncedActor.trim();
    return next;
  }, [action, outcome, debouncedActor]);

  const events = useAuditPages(filters);
  const proof = useAuditProof(proofSeq ?? 0, proofSeq !== null);
  const exporter = useExportAudit();

  const rows = useMemo(() => events.data?.pages.flatMap((page) => page.items) ?? [], [events.data]);
  const total = events.data?.pages[0]?.total ?? 0;

  /**
   * Memoised rather than hoisted: the proof column arms the drawer below, so the array closes over
   * `setProofSeq`. That setter is stable, which is why `[]` is the honest dependency list — the
   * array (and every cell closure in it) is created once per mount instead of once per render.
   *
   * No column is `primary`: an audit event is append-only and has no page of its own, so the row
   * has no link target. The per-row Proof button stays the keyboard path to the evidence.
   */
  const columns = useMemo(
    () =>
      defineColumns<AuditEvent>([
        {
          id: 'seq',
          header: 'Seq',
          width: '56px',
          mono: true,
          nowrap: true,
          cell: (row) => <span className="text-micro text-faint">{row.seq}</span>,
        },
        {
          /*
           * The timestamp was the worst cell on the console: with no width it was given 65px and
           * "12 Nov 2026, 13:47" broke into six stacked fragments. It gets the width its content
           * needs, and both lines refuse to wrap.
           */
          id: 'ts',
          header: 'When',
          width: '150px',
          cell: (row) => (
            <div className="min-w-0">
              <span className="block whitespace-nowrap text-meta text-text">
                {formatRelative(row.ts)}
              </span>
              <span className="block whitespace-nowrap font-mono text-micro text-faint">
                {formatDateTime(row.ts)}
              </span>
            </div>
          ),
        },
        {
          /*
           * Both lines are identifiers — a service name, then `type · subject-uuid`. Unconstrained
           * they took 316px and broke the UUID mid-token; truncated they take 192 and the full
           * value is the `title`, with the record itself one click away in the proof drawer.
           */
          id: 'actor',
          header: 'Actor',
          hideBelow: 'md',
          cell: (row) => (
            <div className="min-w-0 max-w-48">
              <span className="block truncate text-meta text-text" title={row.actorName}>
                {row.actorName}
              </span>
              <span
                className="block truncate font-mono text-micro text-faint"
                title={`${row.actorType} · ${row.subjectRef}`}
              >
                {row.actorType} · {row.subjectRef}
              </span>
            </div>
          ),
        },
        {
          id: 'action',
          header: 'Action',
          mono: true,
          nowrap: true,
          width: '12rem',
          cell: (row) => <span className="text-micro text-text">{row.action}</span>,
        },
        {
          id: 'target',
          header: 'Target',
          hideBelow: 'lg',
          cell: (row) => (
            <div className="min-w-0 max-w-52">
              <span className="block truncate text-meta text-muted" title={row.targetLabel}>
                {row.targetLabel}
              </span>
              <span
                className="block truncate font-mono text-micro text-faint"
                title={`${row.targetType}:${row.targetId}`}
              >
                {row.targetType}:{row.targetId}
              </span>
            </div>
          ),
        },
        {
          id: 'outcome',
          header: 'Outcome',
          cell: (row) => (
            <Badge
              tone={
                row.outcome === 'success'
                  ? 'positive'
                  : row.outcome === 'denied'
                    ? 'danger'
                    : 'caution'
              }
              size="sm"
            >
              {row.outcome}
            </Badge>
          ),
        },
        {
          id: 'proof',
          header: '',
          align: 'right',
          cell: (row) => (
            <Button
              size="sm"
              variant="quiet"
              icon={<Fingerprint />}
              onClick={() => setProofSeq(row.seq)}
            >
              Proof
            </Button>
          ),
        },
      ]),
    [],
  );

  return (
    <Page>
      {/* FR-4.3 · NFR-4.10 — requirement ids, developer-only; they used to be the page eyebrow and
          are not part of the rendered interface. */}
      <PageHeader
        title="Audit trail"
        description="Append-only, hash-chained events with actor, timestamp, target and outcome. No update or delete path exists for the application role."
        actions={
          <>
            <Button
              size="sm"
              variant="secondary"
              icon={<FileCheck2 />}
              // The proof query is disabled until a sequence is chosen, and a disabled query
              // reports `isPending`, so the button gates on the row it needs instead.
              disabled={rows.length === 0}
              onClick={() => setProofSeq(rows[0]?.seq ?? 1)}
            >
              Verify chain
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon={<Download />}
              disabled={exporter.isPending}
              onClick={() => {
                // FR-4.3: an export covers an explicit range; the loaded page defines it.
                const oldest = rows.at(-1)?.ts ?? rows[0]?.ts;
                const newest = rows[0]?.ts;
                if (oldest === undefined || newest === undefined) return;
                exporter.mutate(
                  { from: oldest, to: newest },
                  {
                    // The range's own rows, not the page on screen: `count` and `sha256` describe
                    // what the server verified, so the file must carry exactly those events.
                    onSuccess: (meta) =>
                      downloadJson(meta.downloadName, {
                        exportedAt: meta.exportedAt,
                        count: meta.count,
                        from: meta.from,
                        to: meta.to,
                        chainValid: meta.chainValid,
                        sha256: meta.sha256,
                        events: meta.events,
                      }),
                  },
                );
              }}
            >
              Export
            </Button>
          </>
        }
        meta={
          <>
            <Badge tone="accent" size="sm">
              {total} events
            </Badge>
            <Tag mono>hash chain: SHA-256</Tag>
            <span className="text-micro text-faint">daily external anchor</span>
          </>
        }
      />

      {/* A refused export used to do nothing at all: the range is verified server-side before the
          file is produced, so the refusal carries the reason the operator needs. */}
      {exporter.isError ? (
        <div className="mb-3">
          <QueryError error={exporter.error} compact />
        </div>
      ) : null}

      <Panel>
        <PanelHeader
          eyebrow="Filter"
          title="Event log"
          description="Cursor pagination, newest first. Filters are applied server-side."
        />
        <div className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-2">
          <label htmlFor="audit-action" className="flex flex-col gap-1">
            <span className="text-faint label-caps-sans">Action</span>
            <Select
              id="audit-action"
              value={action}
              onChange={(event) => setAction(event.target.value)}
              className="h-8 w-44"
            >
              {ACTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <label htmlFor="audit-outcome" className="flex flex-col gap-1">
            <span className="text-faint label-caps-sans">Outcome</span>
            <Select
              id="audit-outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              className="h-8 w-36"
            >
              <option value="">Any</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="denied">Denied</option>
            </Select>
          </label>
          <label htmlFor="audit-actor" className="flex min-w-[180px] flex-1 flex-col gap-1">
            <span className="text-faint label-caps-sans">Actor</span>
            <Input
              id="audit-actor"
              value={actor}
              onChange={(event) => setActor(event.target.value)}
              placeholder="Name or user id"
              className="h-8"
            />
          </label>
          <span className="ml-auto font-mono text-micro text-faint">
            {rows.length} of {total} shown
          </span>
        </div>

        {/*
          The cursor pagination button is part of the same region: it belongs to the page of events
          the panel is showing, so a failure must take (or degrade) both together rather than leave
          a "Load more" under a problem panel.
        */}
        <AsyncPanel
          query={events}
          loading={
            <div className="p-4">
              <SkeletonLines lines={8} />
            </div>
          }
          loadingLabel="Loading the audit trail"
        >
          {() => (
            <>
              <DataTable
                columns={columns}
                rows={rows}
                rowKey={rowKey}
                dense
                empty={
                  <EmptyState
                    title="No audit events match these filters"
                    description="Every mutation and every denied request appends a record. Clear the filters to see the full chain."
                  />
                }
              />
              {events.hasNextPage ? (
                <div className="flex justify-center border-t border-line px-3 py-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void events.fetchNextPage()}
                    disabled={events.isFetchingNextPage}
                  >
                    {events.isFetchingNextPage ? 'Loading…' : `Load ${total - rows.length} more`}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </AsyncPanel>
      </Panel>

      <Drawer
        open={proofSeq !== null}
        onOpenChange={(open) => (open ? undefined : setProofSeq(null))}
        title={proofSeq ? `Chain proof · sequence ${proofSeq}` : 'Chain proof'}
        description="The proof path links the event to its predecessor and to the daily anchored checkpoint."
      >
        {/*
          The proof read is disabled until a sequence is armed, and the drawer is only rendered
          while one is: the empty branch of `AsyncPanel` is what the closed drawer sees.
        */}
        <AsyncPanel
          query={proof}
          loading={<SkeletonLines lines={5} />}
          loadingLabel="Loading the chain proof"
        >
          {(chain) => (
            <div className="space-y-4">
              <DefinitionList
                columns={1}
                items={[
                  { label: 'Algorithm', value: chain.algorithm },
                  { label: 'Event hash', value: chain.hash, mono: true },
                  { label: 'Previous hash', value: chain.prevHash, mono: true },
                  { label: 'Chain valid', value: chain.chainValid ? 'Yes' : 'No' },
                  { label: 'Anchor day', value: chain.anchoredDay },
                  { label: 'Anchor signature', value: chain.anchorSignature, mono: true },
                  { label: 'Verified at', value: formatDateTime(chain.verifiedAt) },
                ]}
              />
              <div>
                <p className="mb-1 font-mono text-faint label-caps">Proof path</p>
                <ol className="space-y-1">
                  {chain.path.map((step) => (
                    <li
                      key={step.seq}
                      className="rounded-xs border border-line bg-panel-soft px-2 py-1.5"
                    >
                      <span className="font-mono text-micro text-text">#{step.seq}</span>
                      <span className="ml-2 font-mono text-micro break-all text-faint">
                        {step.hash}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              <p className="text-meta leading-relaxed text-muted">
                Erasure stays compatible with the immutable chain: the mapping from subject to{' '}
                <code>subject_ref</code> is deleted, so the subject can no longer be re-identified
                while the chain remains verifiable.
              </p>
            </div>
          )}
        </AsyncPanel>
      </Drawer>
    </Page>
  );
}

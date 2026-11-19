import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Boxes, RefreshCw } from 'lucide-react';
import type { InstanceFilters } from '@seamnex/api-client';
import { useInstances } from '@seamnex/api-client';
import type { Instance } from '@seamnex/domain';
import { INSTANCE_STATE_LABELS, plainStatusFor } from '@seamnex/domain';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChip,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
  buttonVariants,
  defineColumns,
} from '@seamnex/ui';
import { cn, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

const STATE_FILTERS = ['all', 'ready', 'degraded', 'stopped', 'failed', 'upgrading'] as const;
type StateFilter = (typeof STATE_FILTERS)[number];

/** Typing settles before it reaches the request and the address bar; clearing does not wait. */
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The address bar is the record of the view. A filter held in component state alone could not be
 * bookmarked, shared with a colleague or restored by the back button, which is the whole point of a
 * fleet screen an operator links into an incident channel.
 */
function parseState(value: string | null): StateFilter {
  return STATE_FILTERS.includes(value as StateFilter) ? (value as StateFilter) : 'all';
}

/**
 * Module scope on purpose: `DataTable` no longer compares props, so a `Column[]` rebuilt during
 * render would rebuild every cell closure with it and hand every row new props. Every cell below
 * reads only its own row, which is what makes hoisting safe.
 *
 * `product` is the row's identity — it carries the link (`renderRowLink` below) and is the only
 * keyboard stop in the row, so it must not carry `hideBelow`.
 */
const INSTANCE_COLUMNS = defineColumns<Instance>([
  {
    id: 'key',
    header: 'Key',
    nowrap: true,
    cell: (row) => (
      <span className="font-mono text-micro font-semibold text-muted">{row.entryKey}</span>
    ),
  },
  {
    id: 'product',
    header: 'Instance',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <span className="block font-medium text-text">{row.product}</span>
        <span className="mt-0.5 block font-mono text-micro text-faint">{row.domainRoute}</span>
      </div>
    ),
  },
  {
    id: 'state',
    header: 'State',
    cell: (row) => {
      const label = INSTANCE_STATE_LABELS[row.state];
      return (
        <StatusPill
          tone={label.tone}
          label={label.label}
          size="sm"
          pulse={row.state === 'upgrading'}
        />
      );
    },
  },
  {
    id: 'ready',
    header: 'Ready',
    hideBelow: 'md',
    cell: (row) => (
      <Badge tone={row.ready ? 'positive' : 'caution'} size="sm">
        {row.ready ? 'ready' : 'not ready'}
      </Badge>
    ),
  },
  {
    id: 'portal',
    header: 'Portal',
    hideBelow: 'lg',
    cell: (row) => {
      const status = plainStatusFor(row.state, row.ready);
      return (
        <span
          className={cn(
            'text-meta',
            status === 'available'
              ? 'text-success'
              : status === 'degraded'
                ? 'text-warning-strong'
                : 'text-danger',
          )}
        >
          {status}
        </span>
      );
    },
  },
  {
    id: 'version',
    header: 'Version',
    hideBelow: 'lg',
    mono: true,
    cell: (row) => (
      <span>
        {row.currentVersion}
        {row.availableVersion && row.availableVersion !== row.currentVersion ? (
          <span className="ml-1 text-warning-strong">→ {row.availableVersion}</span>
        ) : null}
      </span>
    ),
  },
  {
    id: 'resources',
    header: 'Resources',
    hideBelow: 'xl',
    cell: (row) => (
      <span className="font-mono text-micro text-muted">
        {row.resources.cpu} vCPU · {(row.resources.memoryMb / 1024).toFixed(1)} GB
      </span>
    ),
  },
  {
    id: 'backup',
    header: 'Last backup',
    hideBelow: 'xl',
    cell: (row) =>
      row.backup.lastSuccessAt ? (
        <span className="text-meta text-muted">{formatRelative(row.backup.lastSuccessAt)}</span>
      ) : (
        <span className="text-meta text-warning-strong">never</span>
      ),
  },
  {
    id: 'owner',
    header: 'Owner',
    hideBelow: 'xl',
    cell: (row) => <span className="text-meta text-muted">{row.domainOwner.name}</span>,
  },
]);

const instanceRowKey = (row: Instance) => row.id;

/**
 * The row link is a real anchor, so modifier-click and "open in new tab" work and the row costs one
 * tab stop instead of an entire `tabIndex` per row.
 */
const instanceRowLink = (row: Instance, className: string, children: ReactNode) => (
  <Link to={`/instances/${row.id}`} className={className}>
    {children}
  </Link>
);

export function InstancesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseState(searchParams.get('state'));
  const urlQuery = searchParams.get('q') ?? '';
  // Typed value stays local so a keystroke repaints immediately; the settled copy is what reaches
  // both the API and the address bar.
  const [query, setQuery] = useState(urlQuery);
  /** What the request and the address bar carry: the typed text, once it has settled. */
  const [appliedQuery, setAppliedQuery] = useState(urlQuery);
  /**
   * The last query string this component wrote. An address bar that differs from it came from a
   * navigation (back, forward, a pasted link) and is adopted; one that matches is our own echo and
   * must not be written back over what is being typed.
   */
  const writtenUrl = useRef<string | null>(null);
  /**
   * The query string this component last rendered against. `setSearchParams` does not land in the
   * same render as the call, so one render still sees the address the user is leaving; comparing
   * against this ref is what stops that stale render from being mistaken for a navigation and
   * adopted back.
   */
  const renderedUrl = useRef(searchParams.toString());

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0 || trimmed === appliedQuery) return;
    const timer = setTimeout(() => setAppliedQuery(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, appliedQuery]);

  /**
   * A clear is not a keystroke: an emptied box must empty the list and the address bar at once.
   * Waiting for the debounce let the pending value be written back over the clear a moment later,
   * which made "Clear filters" look inert on a filtered fleet.
   */
  const search = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) setAppliedQuery('');
  };

  useEffect(() => {
    if (appliedQuery === urlQuery) return;
    const next = new URLSearchParams(searchParams);
    if (appliedQuery.length > 0) next.set('q', appliedQuery);
    else next.delete('q');
    writtenUrl.current = next.toString();
    setSearchParams(next, { replace: true });
  }, [appliedQuery, urlQuery, searchParams, setSearchParams]);

  useEffect(() => {
    const current = searchParams.toString();
    if (current === renderedUrl.current) return;
    renderedUrl.current = current;
    if (current === writtenUrl.current) return;
    setQuery(urlQuery);
    setAppliedQuery(urlQuery);
  }, [searchParams, urlQuery]);

  const selectState = (option: StateFilter) => {
    const next = new URLSearchParams(searchParams);
    if (option === 'all') next.delete('state');
    else next.set('state', option);
    writtenUrl.current = next.toString();
    setSearchParams(next, { replace: true });
  };

  const clearFilters = () => {
    setQuery('');
    setAppliedQuery('');
    writtenUrl.current = '';
    setSearchParams(new URLSearchParams(), { replace: true });
  };

  const filters = useMemo<InstanceFilters>(() => {
    const next: InstanceFilters = {};
    if (state !== 'all') next.state = state;
    if (appliedQuery.length > 0) next.q = appliedQuery;
    return next;
  }, [state, appliedQuery]);

  const instances = useInstances(filters);
  const rows = useMemo(() => instances.data ?? [], [instances.data]);
  const filtered = Object.keys(filters).length > 0;
  // One pass for both header counts; three `filter` calls walked the fleet three times.
  const counts = useMemo(() => {
    let ready = 0;
    let degraded = 0;
    for (const row of rows) {
      if (row.ready) ready += 1;
      if (row.state === 'degraded') degraded += 1;
    }
    return { ready, degraded };
  }, [rows]);

  return (
    <Page>
      <PageHeader
        eyebrow="Deployments"
        title="Instances"
        description="Every deployed copy, its derived state and the evidence behind it. Container detail stays one click away."
        actions={
          <Link to="/catalog" className={buttonVariants({ variant: 'primary', size: 'sm' })}>
            Deploy a product
          </Link>
        }
        meta={
          <>
            <Badge tone="accent" size="sm">
              {rows.length} {filtered ? 'matching' : 'deployments'}
            </Badge>
            <Badge tone="positive" size="sm">
              {counts.ready} ready
            </Badge>
            <Badge tone="caution" size="sm">
              {counts.degraded} degraded
            </Badge>
          </>
        }
      />

      <Panel>
        <PanelHeader
          eyebrow="Fleet"
          title="Deployment inventory"
          description="One row per deployment; entries that share a deployment (D05-01 and D06-01 on ERPNext) appear once."
        />
        <FilterBar
          search={query}
          onSearch={search}
          searchLabel="Search instances"
          placeholder="Search product, domain, slug or key"
          trailing={`${rows.length} shown`}
        >
          {STATE_FILTERS.map((option) => (
            <FilterChip key={option} active={state === option} onClick={() => selectState(option)}>
              <span className="capitalize">{option}</span>
            </FilterChip>
          ))}
          {/* Ghost, not `quiet`: inside a row of bordered chips a `quiet` button draws the same
              border and reads as a seventh state. A command is not a filter.

              Disabled while a read is in flight: an enabled button with no feedback invited a
              second click, which queued a redundant request behind the first. */}
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw className={cn(instances.isFetching && 'motion-safe:animate-spin')} />}
            onClick={() => void instances.refetch()}
            disabled={instances.isFetching}
            aria-busy={instances.isFetching}
          >
            Refresh
          </Button>
        </FilterBar>

        {/*
          One async region instead of three hand-rolled branches: a failed background refresh keeps
          the fleet on screen behind a caution banner rather than replacing it with an error panel
          (ERR-04), and the loading branch is announced (ERR-03).
        */}
        <AsyncPanel
          query={instances}
          loading={
            <div className="p-4">
              <SkeletonLines lines={8} />
            </div>
          }
          loadingLabel="Loading the deployment inventory"
          renderError={(error, retry) => (
            <div className="p-4">
              <QueryError error={error} onRetry={retry} />
            </div>
          )}
        >
          {() => (
            <DataTable
              columns={INSTANCE_COLUMNS}
              rows={rows}
              rowKey={instanceRowKey}
              renderRowLink={instanceRowLink}
              empty={
                <EmptyState
                  compact
                  icon={<Boxes className="size-5" />}
                  title={filtered ? 'No instance matches this filter' : 'No deployments yet'}
                  description={
                    filtered
                      ? 'Clear the state or search filter to see the rest of the fleet.'
                      : 'Deploy the first product from the catalog; the platform renders compose, health checks, volumes and the route.'
                  }
                  action={
                    filtered ? (
                      // The copy above told the operator to clear the filter but handed them no
                      // control to do it, so the only way out was to find the chip again.
                      <Button size="sm" variant="secondary" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : (
                      <Link
                        to="/catalog"
                        className={buttonVariants({ variant: 'primary', size: 'sm' })}
                      >
                        Browse the catalog
                      </Link>
                    )
                  }
                />
              }
            />
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
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
import { AsyncPanel, QueryError, useDebouncedValue } from '@seamnex/shell';

const STATE_FILTERS = ['all', 'ready', 'degraded', 'stopped', 'failed', 'upgrading'] as const;

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
  const [state, setState] = useState<(typeof STATE_FILTERS)[number]>('all');
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query);

  const filters = useMemo<InstanceFilters>(() => {
    const next: InstanceFilters = {};
    if (state !== 'all') next.state = state;
    if (debouncedQuery.trim().length > 0) next.q = debouncedQuery.trim();
    return next;
  }, [state, debouncedQuery]);

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
          onSearch={setQuery}
          searchLabel="Search instances"
          placeholder="Search product, domain, slug or key"
          trailing={`${rows.length} shown`}
        >
          {STATE_FILTERS.map((option) => (
            <FilterChip key={option} active={state === option} onClick={() => setState(option)}>
              <span className="capitalize">{option}</span>
            </FilterChip>
          ))}
          {/* Ghost, not `quiet`: inside a row of bordered chips a `quiet` button draws the same
              border and reads as a seventh state. A command is not a filter. */}
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw />}
            onClick={() => void instances.refetch()}
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
                    filtered ? null : (
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

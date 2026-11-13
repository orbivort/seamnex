import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import type { CatalogFilters } from '@seamnex/api-client';
import { useCatalog, useReloadCatalog } from '@seamnex/api-client';
import type { CatalogEntry } from '@seamnex/domain';
import {
  canMutate,
  DOMAIN_CLUSTERS,
  GUARANTEE_CLASS_LABELS,
  PACKAGING_LABELS,
  guaranteeShort,
} from '@seamnex/domain';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  FilterBar,
  FilterChip,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
  defineColumns,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError, useDebouncedValue } from '@seamnex/shell';
import { useSession } from '../../session';

const PACKAGING_FILTERS = [
  { value: 'all', label: 'All packaging' },
  { value: 'compose', label: 'Compose' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'none', label: 'Scaffolded' },
] as const;

/**
 * Module scope: every cell reads only its row, so the array and its closures can be built once.
 *
 * `product` carries the row link and is the row's only keyboard stop. The trailing "Open" cell is a
 * second, explicit affordance to the same destination; it lives in a different cell, so the two
 * anchors are siblings and never nested.
 */
const CATALOG_COLUMNS = defineColumns<CatalogEntry>([
  {
    id: 'key',
    header: 'Key',
    nowrap: true,
    cell: (row) => <span className="font-mono text-micro font-semibold text-muted">{row.key}</span>,
  },
  {
    id: 'product',
    header: 'Product',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <span className="block font-medium text-text">{row.product}</span>
        <span className="mt-0.5 block text-micro text-faint">{row.domain}</span>
      </div>
    ),
  },
  {
    id: 'stack',
    header: 'Stack',
    hideBelow: 'lg',
    cell: (row) => <span className="text-meta text-muted">{row.stack}</span>,
  },
  {
    id: 'packaging',
    header: 'Packaging',
    hideBelow: 'md',
    cell: (row) => (
      <Badge tone={row.packaging === 'none' ? 'caution' : 'neutral'} size="sm">
        {PACKAGING_LABELS[row.packaging]}
      </Badge>
    ),
  },
  {
    id: 'auth',
    header: 'Authentication',
    cell: (row) => {
      const label = GUARANTEE_CLASS_LABELS[row.guaranteeClass];
      return <StatusPill tone={label.tone} label={guaranteeShort(row.guaranteeClass)} size="sm" />;
    },
  },
  {
    id: 'metadata',
    header: 'Metadata',
    hideBelow: 'xl',
    cell: (row) =>
      row.integration.stale ? (
        <Badge tone="caution" size="sm">
          review overdue
        </Badge>
      ) : (
        <span className="text-meta text-muted">
          verified {formatRelative(row.integration.verifiedAt)}
        </span>
      ),
  },
  {
    id: 'license',
    header: 'License',
    hideBelow: 'xl',
    cell: (row) => <span className="font-mono text-micro text-faint">{row.licenseId}</span>,
  },
  {
    id: 'action',
    header: '',
    align: 'right',
    cell: (row) => (
      <Link
        to={`/catalog/${row.key}`}
        className="inline-flex items-center gap-1 text-meta font-semibold text-link hover:underline"
      >
        Open <ArrowRight className="size-3" aria-hidden />
      </Link>
    ),
  },
]);

const catalogRowKey = (row: CatalogEntry) => row.key;

const catalogRowLink = (row: CatalogEntry, className: string, children: ReactNode) => (
  <Link to={`/catalog/${row.key}`} className={className}>
    {children}
  </Link>
);

export function CatalogPage() {
  const { session } = useSession();
  const reload = useReloadCatalog();
  const canReload = canMutate(session.role, 'metadata.manage');
  const [query, setQuery] = useState('');
  const [packaging, setPackaging] = useState<(typeof PACKAGING_FILTERS)[number]['value']>('all');
  const [cluster, setCluster] = useState<string>('all');
  const debouncedQuery = useDebouncedValue(query);

  // Filtering is the server's job: the query key carries the filter set, so paging and
  // counts stay correct once the catalog outgrows one page. The input stays debounced because each
  // keystroke would otherwise be a request; `useDeferredValue` is for the client-side lists.
  const filters = useMemo<CatalogFilters>(() => {
    const next: CatalogFilters = {};
    if (debouncedQuery.trim().length > 0) next.q = debouncedQuery.trim();
    if (packaging !== 'all') next.packaging = packaging;
    if (cluster !== 'all') next.cluster = cluster;
    return next;
  }, [debouncedQuery, packaging, cluster]);

  const catalog = useCatalog(filters);
  const entries = useMemo(() => catalog.data ?? [], [catalog.data]);

  // Deployments are derived, not asserted: D5 and D6 share one instance, so the count is
  // the number of distinct deployments behind the visible entries.
  const deploymentCount = useMemo(
    () => new Set(entries.map((entry) => entry.primaryInstanceId ?? `entry:${entry.key}`)).size,
    [entries],
  );

  // The delta is the point of a reload: the counts alone cannot tell an operator what moved, and
  // "13 reconciled" reads the same whether nothing changed or a pinned image was re-pointed.
  const reconciledChanges = useMemo(
    () => (reload.data?.reconciled ?? []).filter((item) => item.change !== 'unchanged'),
    [reload.data],
  );

  /**
   * A reload that refused an environment file, or skipped one it could not parse, is **not** a
   * success — those are the two outcomes that can leave a deployable product refusing to deploy.
   * The receipt says so instead of painting both as "repository reloaded".
   */
  const environment = reload.data?.environment;
  const refused = environment?.refused ?? [];
  const invalid = reload.data?.invalid ?? [];
  const partial = refused.length > 0 || invalid.length > 0;
  const envChanges = environment?.applied ?? [];
  const nothingMoved = reconciledChanges.length === 0 && envChanges.length === 0 && !partial;

  return (
    <Page>
      <PageHeader
        eyebrow="Catalog · declarative source of truth"
        title="Domain catalog"
        description="One entry per business domain, each carrying pinned images, packaging availability, authentication guarantee class and verified integration metadata."
        actions={
          <Button
            size="sm"
            variant="secondary"
            disabled={!canReload || reload.isPending}
            title={
              canReload
                ? 'Re-read catalog entries and environment schemas. A change a running instance depends on is refused, not applied.'
                : 'R1 reloads the catalog repository'
            }
            onClick={() => reload.mutate()}
          >
            {reload.isPending ? 'Reloading…' : 'Reload from repository'}
          </Button>
        }
        meta={
          <>
            <Badge tone="accent" size="sm">
              {entries.length} entries
            </Badge>
            <Badge tone="neutral" size="sm">
              {entries.filter((entry) => entry.packaging === 'compose').length} compose
            </Badge>
            <Badge tone="neutral" size="sm">
              {entries.filter((entry) => entry.packaging === 'dockerfile').length} dockerfile
            </Badge>
            <Badge tone="caution" size="sm">
              {entries.filter((entry) => entry.packaging === 'none').length} scaffolded
            </Badge>
          </>
        }
      />

      {reload.isError ? (
        <div className="mb-3">
          <QueryError error={reload.error} compact />
        </div>
      ) : null}
      {reload.data ? (
        <div className="mb-3">
          <Alert
            tone={partial ? 'caution' : 'positive'}
            title={
              partial
                ? `Repository reloaded at revision ${reload.data.revision}, with changes refused`
                : `Repository reloaded at revision ${reload.data.revision}`
            }
          >
            <span className="block">
              {reload.data.entries} entries reconciled: {reload.data.added} added,{' '}
              {reload.data.changed} changed, {reload.data.removed} removed.
              {environment === undefined
                ? null
                : ` Environment: ${environment.added} added, ${environment.changed} changed, ${environment.removed} removed.`}{' '}
              The repository remains authoritative over the control-plane projection.
            </span>

            {refused.length > 0 ? (
              <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
                {refused.map((item) => (
                  <li key={`${item.key}:${item.name ?? '*'}`} className="text-meta">
                    <span className="font-mono font-medium">{item.key}</span>
                    {item.name === null ? null : <span className="font-mono"> · {item.name}</span>}
                    <span className="block leading-snug">
                      File skipped, nothing was written: {item.reason}.
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {invalid.length > 0 ? (
              <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
                {invalid.map((item) => (
                  <li key={item.path} className="text-meta">
                    <span className="font-mono font-medium">{item.path}</span>
                    <span className="block leading-snug">
                      Not applied, left as projected: {item.reason}.
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            {nothingMoved ? (
              <span className="mt-1 block text-meta">
                No drift: every entry and environment schema already matched this revision.
              </span>
            ) : (
              <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
                {reconciledChanges.map((item) => (
                  <li key={item.key} className="flex items-start justify-between gap-3 text-meta">
                    <span className="font-mono font-medium">{item.key}</span>
                    <span className="min-w-0 flex-1 text-right">{item.detail}</span>
                    <span className="shrink-0 font-mono label-caps">{item.change}</span>
                  </li>
                ))}
                {envChanges.map((item) => (
                  <li
                    key={`env:${item.key}`}
                    className="flex items-start justify-between gap-3 text-meta"
                  >
                    <span className="font-mono font-medium">{item.key}</span>
                    <span className="min-w-0 flex-1 text-right">
                      environment: {item.added} added, {item.changed} changed, {item.removed}{' '}
                      removed
                    </span>
                    <span className="shrink-0 font-mono label-caps">env</span>
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      ) : null}

      <Panel>
        <PanelHeader
          eyebrow="Entries"
          title={`${entries.length} domain entries, ${deploymentCount} deployments`}
          description="Entries can share a deployment (D05-01 and D06-01 share one ERPNext instance). Guarantee class is mandatory: no entry may be unclassified."
        />
        <FilterBar
          search={query}
          onSearch={setQuery}
          searchLabel="Search catalog"
          placeholder="Search product, domain or key"
          trailing={`${entries.length} shown`}
        >
          {PACKAGING_FILTERS.map((option) => (
            <FilterChip
              key={option.value}
              active={packaging === option.value}
              onClick={() => setPackaging(option.value)}
            >
              {option.label}
            </FilterChip>
          ))}
          <select
            value={cluster}
            onChange={(event) => setCluster(event.target.value)}
            aria-label="Filter by domain cluster"
            className="h-8 cursor-pointer rounded-xs border border-line-strong bg-panel px-2 text-meta text-text"
          >
            <option value="all">All clusters</option>
            {DOMAIN_CLUSTERS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </FilterBar>

        <AsyncPanel
          query={catalog}
          loading={
            <div className="p-4">
              <SkeletonLines lines={8} />
            </div>
          }
          loadingLabel="Loading the domain catalog"
          renderError={(error, retry) => (
            <div className="p-4">
              <QueryError error={error} onRetry={retry} />
            </div>
          )}
        >
          {() => (
            <DataTable
              columns={CATALOG_COLUMNS}
              rows={entries}
              rowKey={catalogRowKey}
              renderRowLink={catalogRowLink}
              empty={
                <div className="p-8 text-center text-body text-muted">
                  No entry matches this filter. Clear the filters to see the full catalog.
                </div>
              }
            />
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}

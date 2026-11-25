import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowRight } from 'lucide-react';
import type { CatalogFilters } from '@seamnex/api-client';
import {
  useCatalog,
  useCatalogRepository,
  useReloadCatalog,
  useSyncCatalog,
} from '@seamnex/api-client';
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
import { CatalogReceipt } from './CatalogReceipt';
import { SyncCatalogDialog } from './SyncCatalogDialog';

const PACKAGING_FILTERS = [
  { value: 'all', label: 'All packaging' },
  { value: 'compose', label: 'Compose' },
  { value: 'dockerfile', label: 'Dockerfile' },
  { value: 'none', label: 'Scaffolded' },
] as const;

type PackagingFilter = (typeof PACKAGING_FILTERS)[number]['value'];

/** The filter set lives in the URL (`?q=&packaging=&cluster=`), so it is validated on the way in. */
const isPackagingFilter = (value: string | null): value is PackagingFilter =>
  PACKAGING_FILTERS.some((option) => option.value === value);

const clusterFrom = (value: string | null): string =>
  value !== null && (DOMAIN_CLUSTERS as readonly string[]).includes(value) ? value : 'all';

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
        // The visible word is the same in every row, so the accessible name has to carry the
        // product: six links announced as "Open" do not say where any of them goes.
        aria-label={`Open ${row.product} (${row.key})`}
        className="inline-flex items-center gap-1 text-meta font-semibold text-link hover:underline"
      >
        Open <ArrowRight className="size-3" aria-hidden />
      </Link>
    ),
  },
]);

const catalogRowKey = (row: CatalogEntry) => row.key;

/**
 * A narrowed filter legitimately leaves one entry, and "1 domain entries, 1 deployments" is how the
 * count reads as a rendering bug rather than as an answer. Five counts on this screen need it.
 */
const counted = (count: number, singular: string, plural = `${singular}s`) =>
  `${count} ${count === 1 ? singular : plural}`;

const catalogRowLink = (row: CatalogEntry, className: string, children: ReactNode) => (
  <Link to={`/catalog/${row.key}`} className={className}>
    {children}
  </Link>
);

export function CatalogPage() {
  const { session } = useSession();
  const reload = useReloadCatalog();
  // ADR-BE-42: the checkout, and the fetch that rewrites it. The read model is what lets the action
  // be disabled with an explanation instead of failing at request time (AC-22).
  const repository = useCatalogRepository();
  const sync = useSyncCatalog();
  const [syncOpen, setSyncOpen] = useState(false);
  const [lastAction, setLastAction] = useState<'reload' | 'sync'>('reload');
  const canReload = canMutate(session.role, 'metadata.manage');
  const sourceConfigured = repository.data?.source.configured ?? false;
  const [params, setParams] = useSearchParams();
  // The URL is the initial value on every mount, so a shared or bookmarked filter arrives applied
  // and a back step from an entry restores the narrowed list instead of the whole catalog.
  const [query, setQuery] = useState(() => params.get('q') ?? '');
  const [packaging, setPackaging] = useState<PackagingFilter>(() => {
    const fromUrl = params.get('packaging');
    return isPackagingFilter(fromUrl) ? fromUrl : 'all';
  });
  const [cluster, setCluster] = useState<string>(() => clusterFrom(params.get('cluster')));
  const debouncedQuery = useDebouncedValue(query);

  /**
   * Mirror the applied filter set into the URL. `replace` because typing is not navigation: a
   * history entry per keystroke would make the browser's Back button useless on this screen. The
   * debounced query is the one the API key carries, so the address never claims a filter that is
   * still in flight.
   */
  useEffect(() => {
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        const q = debouncedQuery.trim();
        if (q.length > 0) next.set('q', q);
        else next.delete('q');
        if (packaging === 'all') next.delete('packaging');
        else next.set('packaging', packaging);
        if (cluster === 'all') next.delete('cluster');
        else next.set('cluster', cluster);
        return next.toString() === previous.toString() ? previous : next;
      },
      { replace: true },
    );
  }, [debouncedQuery, packaging, cluster, setParams]);

  const clearFilters = () => {
    setQuery('');
    setPackaging('all');
    setCluster('all');
  };

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

  /*
   * One receipt, two ways to produce it: a sync returns the reload receipt plus the provenance of
   * the tree it read. `lastAction` decides which one is on screen, so a later reload does not leave
   * a stale sync receipt describing a tree the platform may no longer be serving.
   */
  const receipt = lastAction === 'sync' ? sync.data : reload.data;
  const receiptSource = lastAction === 'sync' ? sync.data?.source : undefined;
  // A mixed tree is a standing condition reported by the read model, not only a result of the last
  // action: it survives a page reload until the next successful sync repairs it (AC-18).
  const staged = repository.data?.staged ?? null;

  return (
    <Page>
      <PageHeader
        eyebrow="Catalog · declarative source of truth"
        title="Domain catalog"
        description="One entry per business domain, each carrying pinned images, packaging availability, authentication guarantee class and verified integration metadata."
        actions={
          <>
            {/*
              ADR-BE-42 §10.4 — a second action, not a replacement. Reload is read-only and
              idempotent; sync writes to the host. Merging them would give the cheap, frequent
              action the risk profile of the rare one.
            */}
            <Button
              size="sm"
              variant="secondary"
              disabled={!canReload || !sourceConfigured || sync.isPending}
              title={
                !canReload
                  ? 'R1 syncs the catalogue source'
                  : !sourceConfigured
                    ? 'No catalogue source is configured. Run `catalog:sync --ref <tag>` from a host after placing a clone, or set SEAMNEX_CATALOG_SOURCE_URL.'
                    : 'Fetch a tagged revision, swap it into the working tree and reconcile the projection. A sync can remove entries.'
              }
              onClick={() => setSyncOpen(true)}
            >
              Sync from source
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!canReload || reload.isPending}
              title={
                canReload
                  ? 'Re-read catalog entries and environment schemas. A change a running instance depends on is refused, not applied.'
                  : 'R1 reloads the catalog repository'
              }
              onClick={() => {
                setLastAction('reload');
                reload.mutate();
              }}
            >
              {reload.isPending ? 'Reloading…' : 'Reload from repository'}
            </Button>
          </>
        }
        meta={
          <>
            <Badge tone="accent" size="sm">
              {counted(entries.length, 'entry', 'entries')}
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
      {/*
        ADR-BE-42 §10.2 rule 8 — a swap that stopped between renames is a standing condition, not a
        result: it survives a page reload until the next successful sync repairs it, so it is read
        from the repository view rather than from the last action's receipt.
      */}
      {staged === null ? null : (
        <div className="mb-3">
          <Alert tone="caution" title="The catalogue tree is mixed">
            <span className="block">
              These still hold their previous content:{' '}
              <span className="font-mono">{staged.pending.join(', ')}</span>. Re-run the sync at the
              same ref — the next successful swap repairs the tree, and nothing is reported as a
              success until then.
            </span>
          </Alert>
        </div>
      )}
      {receipt ? (
        <div className="mb-3">
          <CatalogReceipt
            data={receipt}
            mode={lastAction === 'sync' ? 'sync' : 'reload'}
            {...(receiptSource === undefined ? {} : { source: receiptSource })}
          />
        </div>
      ) : null}

      {repository.data === undefined ? null : (
        <SyncCatalogDialog
          open={syncOpen}
          onOpenChange={setSyncOpen}
          repository={repository.data}
          sync={sync}
          onSynced={() => setLastAction('sync')}
        />
      )}

      <Panel>
        <PanelHeader
          eyebrow="Entries"
          title={`${counted(entries.length, 'domain entry', 'domain entries')}, ${counted(deploymentCount, 'deployment', 'deployments')}`}
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
                <div className="p-8 text-center">
                  <p className="text-body text-muted">
                    No entry matches this filter. Clear the filters to see the full catalog.
                  </p>
                  {/* The empty state used to instruct the operator to clear three controls by
                      hand; the action is the instruction. */}
                  <Button size="sm" variant="secondary" className="mt-3" onClick={clearFilters}>
                    Clear filters
                  </Button>
                </div>
              }
            />
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}

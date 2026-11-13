import { useMemo, useState } from 'react';
import { ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { useLauncher, useMe } from '@seamnex/api-client';
import type { LauncherTile, PlainStatus } from '@seamnex/domain';
import { can, compareEntryKeys } from '@seamnex/domain';
import { Alert, Button, EmptyState, Page, SearchField, Skeleton } from '@seamnex/ui';
import { cn } from '@seamnex/utils';
import { AsyncPanel } from '@seamnex/shell';
import { useSession } from '../../session';
import { ProductTile } from '../../components/ProductTile';
import { LaunchDialog } from '../../components/LaunchDialog';
import { RequestAccessButton } from '../access/RequestAccessDialog';

const FILTERS: { value: 'all' | PlainStatus; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'available', label: 'Available' },
  { value: 'degraded', label: 'Degraded' },
  { value: 'unavailable', label: 'Unavailable' },
  { value: 'maintenance', label: 'Maintenance' },
];

function TileSkeleton() {
  return (
    <div className="rounded-md border border-line bg-panel p-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-20" />
      </div>
      <Skeleton className="mt-4 h-5 w-40" />
      <Skeleton className="mt-2 h-3 w-full" />
      <Skeleton className="mt-1.5 h-3 w-4/5" />
      <div className="mt-5 flex items-center justify-between">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-7 w-16" />
      </div>
    </div>
  );
}

export function LauncherPage() {
  const { session } = useSession();
  const me = useMe();
  const launcher = useLauncher();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | PlainStatus>('all');
  const [launching, setLaunching] = useState<LauncherTile | null>(null);

  const tiles = useMemo(() => launcher.data?.tiles ?? [], [launcher.data]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (
      tiles
        .filter((tile) => filter === 'all' || tile.plainStatus === filter)
        .filter(
          (tile) =>
            needle === '' ||
            tile.product.toLowerCase().includes(needle) ||
            tile.domain.toLowerCase().includes(needle) ||
            // The deployment address is the only thing distinguishing three instances of one
            // product, so searching for it has to find them.
            tile.slug.toLowerCase().includes(needle) ||
            (tile.version !== null && tile.version.toLowerCase().includes(needle)) ||
            tile.entryKey.toLowerCase() === needle,
        )
        .slice()
        // Catalog code, then product, then deployment. Code first keeps the grid in the catalog's own
        // sequence (D01-01, D01-02, D07-01) instead of alphabetical product order, and it compares
        // the ordinals as numbers — plain text order puts D10 above D9. Sibling deployments of one
        // entry share a code, so product and address still break that tie and stop a status write
        // upstream from reshuffling the grid.
        .sort(
          (a, b) =>
            compareEntryKeys(a.entryKey, b.entryKey) ||
            a.product.localeCompare(b.product, undefined, { numeric: true, sensitivity: 'base' }) ||
            a.slug.localeCompare(b.slug, undefined, { numeric: true }),
        )
    );
  }, [tiles, filter, query]);

  const counts = launcher.data?.counts;
  const firstName = me.data?.displayName.split(' ')[0] ?? 'there';
  const readOnly = !can(session.role, 'portal.launch');
  // Derived from the payload's clock, not the browser's, so the label is stable and honest.
  const generatedLabel = launcher.data
    ? new Intl.DateTimeFormat('en-GB', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(launcher.data.generatedAt))
    : '—';

  return (
    <Page>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-4">
        <div className="min-w-0">
          {/*
            The environment is what the API says this listing describes. `window.location.host` was
            printed here instead, so a portal served from a dev server announced "localhost:5173"
            as its environment and two environments looked identical.
          */}
          <p
            className="flex flex-wrap items-center gap-2 font-mono text-faint label-caps"
            title={`Served by ${window.location.host}`}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="size-1.5 rounded-full bg-primary" aria-hidden />
              {launcher.data?.environment ?? 'environment unknown'}
            </span>
            {/* The separator travels with the date: left on its own it was stranded at the end of
                the first line whenever the date wrapped under a narrow page header. */}
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              {/* Below `sm` the two facts stack, and a separator at the start of the second
                  line reads as a stray bullet rather than punctuation. */}
              <span aria-hidden className="hidden sm:inline">
                ·
              </span>
              {generatedLabel}
            </span>
          </p>
          <h1 className="mt-1.5 font-display text-display font-semibold tracking-tight text-text">
            Welcome back, {firstName}.
          </h1>
          <p className="mt-1.5 max-w-2xl text-body leading-relaxed text-muted">
            {counts
              ? `${counts.total} applications are entitled to your role. You are signed in once, with one identity and one audit trail.`
              : 'Loading your entitled applications.'}
          </p>
        </div>

        {/*
          Below `sm` the five metrics used to sit in a horizontally scrolling strip, which hid
          "Maintenance" behind a scroll gesture nothing advertised. They wrap instead: three on the
          first row, two on the second (2 + 2 + 2, then 3 + 3 of six columns), separated by the same
          hairline the desktop strip draws. From `sm` up it is one row again.

          The `dl` is the grid itself. A wrapper inside it would have produced `dl > div > div > dt`,
          which the content model does not allow — a `dl` may group a `div` that holds nothing but
          `dt`/`dd` pairs.
        */}
        <dl className="grid w-full min-w-0 max-w-full grid-cols-6 gap-px overflow-hidden rounded-md border border-line bg-line sm:flex sm:w-auto sm:items-stretch sm:gap-0 sm:divide-x sm:divide-line">
          {[
            { key: 'total', label: 'Entitled', value: counts?.total ?? 0, tone: 'text-text' },
            {
              key: 'available',
              label: 'Available',
              value: counts?.available ?? 0,
              tone: 'text-success',
            },
            {
              key: 'degraded',
              label: 'Degraded',
              value: counts?.degraded ?? 0,
              tone: 'text-warning-strong',
            },
            {
              key: 'unavailable',
              label: 'Unavailable',
              value: counts?.unavailable ?? 0,
              tone: 'text-danger',
            },
            {
              key: 'maintenance',
              label: 'Maintenance',
              value: counts?.maintenance ?? 0,
              tone: 'text-info',
            },
          ].map((stat, index) => (
            <div
              key={stat.key}
              className={cn(
                'col-span-2 bg-panel px-3 py-1.5 text-center',
                index > 2 && 'col-span-3',
              )}
            >
              <dt className="label-caps-sans whitespace-nowrap">{stat.label}</dt>
              <dd className={cn('font-display text-title font-semibold', stat.tone)}>
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>

        <RequestAccessButton />
      </header>

      {readOnly ? (
        <Alert tone="info" title="Read-only auditor view" className="mb-4">
          R2 can see availability and entitlement evidence, but cannot launch business products. Ask
          a domain owner if business access is required.
        </Alert>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchField
          value={query}
          onValueChange={setQuery}
          label="Search entitled applications"
          placeholder="Search applications, domains, deployments or keys"
          className="sm:max-w-sm"
        />
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Filter by availability"
        >
          {FILTERS.map((option) => {
            const active = filter === option.value;
            const count =
              option.value === 'all' ? (counts?.total ?? 0) : (counts?.[option.value] ?? 0);
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(option.value)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-xs border px-2 py-1 text-meta font-medium transition-colors',
                  active
                    ? 'border-primary bg-primary-soft text-link'
                    : 'border-line bg-panel text-muted hover:border-line-strong hover:text-text',
                )}
              >
                {option.label}
                <span className="font-mono text-micro text-faint">{count}</span>
              </button>
            );
          })}
        </div>
        <span className="ml-auto hidden items-center gap-1.5 font-mono text-faint sm:inline-flex label-caps">
          <SlidersHorizontal className="size-3" aria-hidden />
          {visible.length} shown
        </span>
      </div>

      {/*
        Loading, failure and the two empty states are one region now (ARCH-03). The distinction
        that matters here is inside `empty`: "you have no entitlements" is not the same statement as
        "your filter hides all of them", and neither is a filter result.
      */}
      <AsyncPanel
        query={launcher}
        loading={
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {/* A static list of placeholders: the position is the identity, so a literal key is
                honest here and keeps `key={index}` from becoming a habit. */}
            {Array.from({ length: 6 }, (_, index) => (
              <TileSkeleton key={`tile-skeleton-${index}`} />
            ))}
          </div>
        }
        loadingLabel="Loading entitled applications"
        empty={(data) =>
          data.tiles.length === 0 ? (
            <EmptyState
              title="No applications yet"
              description="Your role has no product entitlements in this environment. Ask a domain owner to add you to the relevant directory group."
              action={<Button variant="secondary">Contact your domain owner</Button>}
            />
          ) : visible.length === 0 ? (
            <EmptyState
              title="Nothing matches this filter"
              description="No entitled application matches your search and availability filter. Clear the filters to see everything."
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : null
        }
      >
        {() => (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((tile) => (
              <ProductTile key={tile.instanceId} tile={tile} onLaunch={setLaunching} />
            ))}
          </div>
        )}
      </AsyncPanel>

      <p className="mt-6 flex items-start gap-2 border-t border-line pt-3 text-meta leading-relaxed text-faint">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Availability is shown in plain language. A product that keeps its own credential is labelled
        before you open it, and the launch dialog names the sign-in path you will see.
      </p>

      <LaunchDialog
        tile={launching}
        onOpenChange={(open) => (open ? undefined : setLaunching(null))}
      />
    </Page>
  );
}

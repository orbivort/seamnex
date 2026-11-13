import { useDeferredValue, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight } from 'lucide-react';
import { useRegistry } from '@seamnex/api-client';
import type { RegistryEntry, Tone } from '@seamnex/domain';
import {
  CREDENTIAL_GRANULARITY_LABELS,
  GUARANTEE_CLASS_LABELS,
  TRIGGER_LABELS,
  guaranteeShort,
  workflowIneligibilityReason,
  writeIneligibilityReason,
} from '@seamnex/domain';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  FilterBar,
  FilterChip,
  InlineNote,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
  Tag,
  defineColumns,
  toneBox,
  toneText,
} from '@seamnex/ui';
import { cn, formatDate, formatDateTime, formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/**
 * The address printed under the product name.
 *
 * The projection does not agree with itself on this field — `registry-feed` stores the bare host,
 * while the mock fixtures store a full `https://host/` URL — so printing `route` verbatim changed
 * the shape of the cell between a demo and a production read. The column shows the host; the raw
 * value stays reachable as the cell's title.
 */
function routeHost(route: string): string {
  try {
    const parsed = new URL(route);
    return parsed.host === '' ? route : parsed.host;
  } catch {
    return route;
  }
}

/**
 * `mode` is the operation's policy attribute (C-11), so a bare total cannot answer the question the
 * registry exists to answer: does this product offer a write at all?
 */
function writeOperationCount(operations: RegistryEntry['operations']): number {
  return operations.filter((operation) => operation.mode === 'write').length;
}

type EventChip = { mode: string; labels: string[]; intervalMinutes?: number };

/**
 * One chip per event mode, carrying the floor the product imposes.
 *
 * `EventModeSchema` allows two declarations of the same mode (`poll` twice, with different labels),
 * and the previous `${mode}-${label}` key rendered them as two identical chips. The declared label
 * and `minimumIntervalMinutes` were dropped as well, so "poll" said nothing about how often a
 * workflow may read the product.
 */
function eventChips(entry: RegistryEntry): EventChip[] {
  const byMode = new Map<string, EventChip>();
  for (const event of entry.eventModes) {
    const chip = byMode.get(event.mode) ?? { mode: event.mode, labels: [] };
    chip.labels.push(event.label);
    if (event.minimumIntervalMinutes !== undefined) {
      chip.intervalMinutes =
        chip.intervalMinutes === undefined
          ? event.minimumIntervalMinutes
          : Math.min(chip.intervalMinutes, event.minimumIntervalMinutes);
    }
    byMode.set(event.mode, chip);
  }
  return [...byMode.values()];
}

type WritePosture = { tone: Tone; label: string; reason: string | null };

/**
 * The verdict's three states, named once.
 *
 * The badge and the posture strip answer the same question — can a workflow write here? — so they
 * read one predicate. Two copies of the C-11 rule drifting apart is how the strip would end up
 * counting rows the table calls something else.
 */
type PostureKey = 'writable' | 'readonly' | 'none';

function postureKey(entry: RegistryEntry): PostureKey {
  if (entry.writeEligible) return 'writable';
  return entry.workflowEligible ? 'readonly' : 'none';
}

/**
 * C-11 has three outcomes, not two: a `none` product is not "read-only", it has no brokered access
 * at all. Collapsing them told an author that a read workflow could target a product the credential
 * broker refuses to mint anything for.
 *
 * The badge carries the reason as its title: the flags say *that* a write is refused, the
 * granularity says *why*, and the domain already holds one sentence per case for the other surfaces
 * that refuse a write.
 */
function writePosture(entry: RegistryEntry): WritePosture {
  switch (postureKey(entry)) {
    case 'writable':
      return { tone: 'positive', label: 'eligible', reason: null };
    case 'readonly':
      return {
        tone: 'caution',
        label: 'read-only',
        reason: writeIneligibilityReason(entry.credentialGranularity),
      };
    case 'none':
      return {
        tone: 'danger',
        label: 'no credential',
        reason: workflowIneligibilityReason(entry.credentialGranularity),
      };
  }
}

/** Sort sentinel: an unparseable review date is "due last", never "due at the epoch". */
function reviewDue(entry: RegistryEntry): number {
  const due = Date.parse(entry.nextReviewAt);
  return Number.isFinite(due) ? due : Number.POSITIVE_INFINITY;
}

const REVIEW_TICKS = 4;

/**
 * How much of the review window has been spent: 0 at verification, 1 at the due date.
 *
 * The projection says whether metadata is stale, but not whether it is about to be, so a row
 * verified eleven days ago and a row verified eighty-nine days ago looked identical until the flag
 * flipped. The ticks are the ramp the badge cannot express.
 */
function reviewProgress(verifiedAt: string, nextReviewAt: string): number {
  const from = Date.parse(verifiedAt);
  const to = Date.parse(nextReviewAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  return Math.min(Math.max((Date.now() - from) / (to - from), 0), 1);
}

/**
 * A four-tick countdown to the next review, read left to right: spent ticks are solid, remaining
 * ticks are hairlines, and the last remaining tick turns caution before the badge does.
 *
 * `aria-hidden` is deliberate — the exact verification instant sits beside it in a `<time>`, and a
 * decorative four-pixel rhythm is not a second value for assistive technology to reconcile.
 */
function FreshnessRail({ verifiedAt, nextReviewAt }: { verifiedAt: string; nextReviewAt: string }) {
  const spent = Math.round(reviewProgress(verifiedAt, nextReviewAt) * REVIEW_TICKS);
  const remaining = REVIEW_TICKS - spent;
  return (
    <span aria-hidden className="inline-flex gap-0.5">
      {Array.from({ length: REVIEW_TICKS }, (_, tick) => (
        <span
          key={tick}
          className={cn(
            'h-1 w-1.5 rounded-xs',
            tick < spent ? 'bg-neutral-fill' : remaining <= 1 ? 'bg-warning' : 'bg-line',
          )}
        />
      ))}
    </span>
  );
}

const POSTURE_TILES: readonly { key: PostureKey; label: string; hint: string; tone: Tone }[] = [
  { key: 'writable', label: 'Writable', hint: 'operation-scoped credentials', tone: 'positive' },
  { key: 'readonly', label: 'Read-only', hint: 'account-level credentials', tone: 'caution' },
  { key: 'none', label: 'No credential', hint: 'nothing brokered', tone: 'danger' },
];

/**
 * The page's headline and its primary filter in one control.
 *
 * The verdict used to live only in a column hidden below 1280px, which is the one field the
 * registry exists for. Neutral at rest and tone-tinted only while pressed: three tinted boxes as
 * ambient decoration would recreate the wall of chips the table itself is trying to avoid.
 */
function PostureTile({
  label,
  hint,
  tone,
  count,
  active,
  onToggle,
}: {
  label: string;
  hint: string;
  tone: Tone;
  count: number | undefined;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={count === undefined}
      onClick={onToggle}
      className={cn(
        'tap-target flex min-w-0 flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors duration-150 disabled:opacity-45',
        active ? toneBox(tone) : 'border-line bg-panel hover:border-control-border-strong',
      )}
    >
      <span className="label-caps-sans text-muted">{label}</span>
      <span className={cn('num-tabular font-display text-metric font-semibold', toneText(tone))}>
        {/* A count is an assertion: until the projection settles there is no number to print. */}
        {count ?? '—'}
      </span>
      <span className="text-micro leading-snug text-muted">{hint}</span>
    </button>
  );
}

/**
 * Module scope: filtering this list is client-side and every cell reads only its row, so the array
 * and its closures are built once instead of on every keystroke.
 *
 * The `entry` cell carries the row link; the trailing "Entry" cell points at a different
 * destination (the catalog entry), so it stays a separate anchor in a separate cell rather than
 * nesting inside it.
 */
const REGISTRY_COLUMNS = defineColumns<RegistryEntry>([
  {
    // Key and product were two columns with a 52px gutter between them, which made the row's
    // identifier its least prominent element and spent a column on four characters.
    id: 'entry',
    header: 'Entry',
    primary: true,
    cell: (row) => {
      const host = routeHost(row.route);
      return (
        <div className="min-w-0">
          <span className="block font-mono text-micro text-faint">{row.entryKey}</span>
          {/* No colour class here: the row link owns the colour, so `hover:text-link` reaches the
              product name. A `text-text` on this span silently cancelled the cell's only hover
              feedback. */}
          <span className="mt-0.5 block font-medium">{row.product}</span>
          {/* The title is the raw projection only when it says something the host does not; a
              tooltip that repeats the cell text is noise. */}
          <span
            className="mt-0.5 block font-mono text-micro text-faint"
            title={host === row.route ? undefined : row.route}
          >
            {host}
            {/* Who re-verifies is the other half of the freshness story: a stale row that names
                no accountable owner is a dead end for the person reading it. */}
            <span className="hidden md:inline"> · {row.owner}</span>
          </span>
        </div>
      );
    },
  },
  {
    id: 'version',
    header: 'Version',
    hideBelow: 'md',
    mono: true,
    cell: (row) => <span className="text-micro text-muted">{row.version}</span>,
  },
  {
    // Authentication and credential scope were two columns whose relationship — account-wide
    // credentials are *why* a write is refused — lived only in a `title`. Stacked, the two facts
    // read as one sentence and the verdict column becomes the conclusion rather than a third
    // unrelated badge.
    id: 'access',
    header: 'Access',
    hideBelow: 'md',
    cell: (row) => {
      const auth = GUARANTEE_CLASS_LABELS[row.guaranteeClass];
      const scope = CREDENTIAL_GRANULARITY_LABELS[row.credentialGranularity];
      return (
        <div className="flex min-w-0 flex-col items-start gap-1">
          {/* `guaranteeShort` is the domain's own three-word form. The full label — "Sign-in
              required — proxy gate only" — is a sentence, and caps tracking at 11px turns a
              sentence into treacle. */}
          <StatusPill tone={auth.tone} label={guaranteeShort(row.guaranteeClass)} size="sm" />
          <span className="label-caps-sans text-faint" title={scope.description}>
            {scope.label}
          </span>
        </div>
      );
    },
  },
  {
    id: 'operations',
    header: 'Ops',
    align: 'right',
    hideBelow: 'md',
    mono: true,
    cell: (row) => {
      const writes = writeOperationCount(row.operations);
      // One line, not two: the row's height is set by the identity cell, and a second line here
      // only made neighbouring rows disagree about where the baseline sits.
      return (
        <span className="whitespace-nowrap">
          <span className="text-meta text-text">{row.operations.length} ops</span>
          <span className="text-faint"> · </span>
          <span className={writes === 0 ? 'text-faint' : 'text-muted'}>
            {writes === 0 ? 'no write' : `${writes} write${writes === 1 ? '' : 's'}`}
          </span>
        </span>
      );
    },
  },
  {
    id: 'events',
    header: 'Events',
    hideBelow: 'xl',
    cell: (row) => (
      <div className="flex flex-wrap gap-1">
        {eventChips(row).map((chip) => (
          <span key={chip.mode} className="inline-flex" title={chip.labels.join(' · ')}>
            <Tag mono>
              {TRIGGER_LABELS[chip.mode] ?? chip.mode}
              {chip.intervalMinutes === undefined ? null : ` ≥ ${chip.intervalMinutes} min`}
            </Tag>
          </span>
        ))}
      </div>
    ),
  },
  {
    id: 'verified',
    header: 'Freshness',
    hideBelow: 'lg',
    cell: (row) => {
      // The projection stores the epoch when metadata was never verified. Printing that as a date
      // ("1 Jan 1970") is worse than saying so, and the badge alone hid *how* old the metadata is.
      const verified = Date.parse(row.verifiedAt);
      const neverVerified = !Number.isFinite(verified) || verified === 0;
      const due = `Review due ${formatDate(row.nextReviewAt)}`;
      return (
        <div className="flex flex-col items-start gap-1">
          {row.stale ? (
            <Badge tone="caution" size="sm">
              stale
            </Badge>
          ) : null}
          {/* The rail takes the badge's slot rather than stacking above it: a stale row and a
              fresh one must not disagree about how tall this cell is. */}
          {row.stale || neverVerified ? null : (
            <FreshnessRail verifiedAt={row.verifiedAt} nextReviewAt={row.nextReviewAt} />
          )}
          {/* `<time>` so the instant is machine-readable, not only a `title` a touch device never
              shows. */}
          <time
            dateTime={row.verifiedAt}
            className="text-micro text-muted"
            title={neverVerified ? due : `Verified ${formatDateTime(row.verifiedAt)} · ${due}`}
          >
            {neverVerified ? 'never verified' : formatRelative(row.verifiedAt)}
          </time>
        </div>
      );
    },
  },
  {
    // Never hidden: "can a workflow write here?" is the question this screen answers, so the
    // verdict cannot be the first thing a 1280px viewport takes away.
    id: 'write',
    header: 'Write',
    align: 'right',
    cell: (row) => {
      const posture = writePosture(row);
      return (
        <span className="inline-flex" title={posture.reason ?? undefined}>
          <StatusPill tone={posture.tone} label={posture.label} size="sm" />
          {/* The reason used to be hover-only, which is no reason at all on a touch device. As
              hidden text it rides along with the cell for assistive technology and cell-by-cell
              reading, and the `title` above keeps the pointer path unchanged. */}
          {posture.reason === null ? null : <span className="sr-only">{posture.reason}</span>}
        </span>
      );
    },
  },
  {
    id: 'open',
    header: '',
    align: 'right',
    cell: (row) => (
      <Link
        to={`/catalog/${row.entryKey}`}
        // "Entry" repeated down the column is three identical link names in a screen reader's
        // link list; the product names the destination without widening the cell.
        aria-label={`Catalog entry for ${row.product}`}
        className="inline-flex items-center gap-1 text-meta font-semibold text-link"
      >
        Entry <ArrowUpRight className="size-3" aria-hidden />
      </Link>
    ),
  },
]);

const registryRowKey = (row: RegistryEntry) => row.instanceId;

const registryRowLink = (row: RegistryEntry, className: string, children: ReactNode) => (
  <Link to={`/instances/${row.instanceId}`} className={className}>
    {children}
  </Link>
);

export function RegistryPage() {
  const registry = useRegistry();
  const [query, setQuery] = useState('');
  const [staleOnly, setStaleOnly] = useState(false);
  const [posture, setPosture] = useState<PostureKey | null>(null);
  /**
   * This filter runs over a list that is already in memory, so it does not need a debounce — it
   * needs to stop competing with the keystroke. `useDeferredValue` lets the input repaint at once
   * and the filtered table catch up in a lower-priority render, which is the React 19 primitive for
   * exactly this; `useDebouncedValue` stays the tool for filters that hit the network (instances,
   * catalog, audit).
   */
  const deferredQuery = useDeferredValue(query);

  const rows = useMemo(() => {
    // The needle is normalized once, not once per row.
    const needle = deferredQuery.trim().toLowerCase();
    return (
      (registry.data ?? [])
        .filter((entry) => {
          // Every field the row prints is searchable: the host under the product name used to be
          // invisible to the filter, and `entryKey` was compared exactly, so a partial key returned
          // nothing while a partial product name matched.
          const matchesQuery =
            needle === '' ||
            entry.product.toLowerCase().includes(needle) ||
            entry.entryKey.toLowerCase().includes(needle) ||
            entry.slug.toLowerCase().includes(needle) ||
            entry.route.toLowerCase().includes(needle);
          // `postureKey` is the predicate the badges and the strip both read, so a filter and the
          // count that offers it cannot disagree about which rows they mean.
          const matchesPosture = posture === null || postureKey(entry) === posture;
          return matchesQuery && matchesPosture && (!staleOnly || entry.stale);
        })
        // The projection arrives ordered by slug — a field the table never shows — so the first
        // column read as unordered (D01-01, D09-01, D07-01). The register is keyed by entry key.
        //
        // The stale filter reorders instead: stale rows are a triage queue, and the review that
        // fell due first is the one to act on.
        .sort((left, right) =>
          staleOnly
            ? reviewDue(left) - reviewDue(right) || left.entryKey.localeCompare(right.entryKey)
            : left.entryKey.localeCompare(right.entryKey),
        )
    );
  }, [registry.data, deferredQuery, staleOnly, posture]);

  const entryCount = registry.data?.length;
  const staleCount = registry.data?.filter((entry) => entry.stale).length;
  const hasEntries = (entryCount ?? 0) > 0;

  const postureCounts = useMemo(() => {
    const counts: Record<PostureKey, number> = { writable: 0, readonly: 0, none: 0 };
    for (const entry of registry.data ?? []) counts[postureKey(entry)] += 1;
    return counts;
  }, [registry.data]);

  const clearFilters = () => {
    setQuery('');
    setStaleOnly(false);
    setPosture(null);
  };

  return (
    <Page>
      {/* FR-2.10 · FR-2.15 — requirement ids, developer-only; they used to be the page eyebrow and
          are not part of the rendered interface. */}
      <PageHeader
        title="Integration registry"
        description="The machine-readable inventory the workflow builder consumes: routes, authentication class, operations, events, credential scopes and metadata freshness."
        meta={
          <>
            {/* A count is an assertion: while the projection is still loading, "0 entries" is a
                claim about the platform that nobody has verified yet. */}
            {entryCount === undefined ? (
              <Badge tone="neutral" size="sm">
                loading
              </Badge>
            ) : (
              <Badge tone="accent" size="sm">
                {entryCount} entries
              </Badge>
            )}
            {staleCount === undefined ? null : (
              <Badge tone={staleCount === 0 ? 'positive' : 'caution'} size="sm">
                {staleCount} stale
              </Badge>
            )}
          </>
        }
      />

      {/* The headline the table was hiding below 1280px: the three states C-11 actually has, and
          each one is the filter for what it counts. Neutral at rest, so the page does not open on
          three tinted boxes. */}
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        {POSTURE_TILES.map((tile) => (
          <PostureTile
            key={tile.key}
            label={tile.label}
            hint={tile.hint}
            tone={tile.tone}
            count={entryCount === undefined ? undefined : postureCounts[tile.key]}
            active={posture === tile.key}
            onToggle={() => setPosture((current) => (current === tile.key ? null : tile.key))}
          />
        ))}
      </div>

      <Panel>
        {/* One title for one table. "Projection" and "Registered instances" restated the page
            heading, and the paragraph explained the API contract to the person operating it. */}
        <PanelHeader title="Integration metadata" />
        {/*
          The search state is urgent, not a transition: `useDeferredValue` above already re-renders
          the table at a lower priority, and putting the controlled input's own state in a
          transition would make the text lag behind the keystroke it came from.
        */}
        <FilterBar
          search={query}
          onSearch={setQuery}
          searchLabel="Search registry"
          placeholder="Search product, route, slug or key"
          trailing={
            entryCount === undefined ? (
              'loading'
            ) : (
              // Polite, because a filter that silently drops rows announces nothing otherwise.
              <span aria-live="polite">{rows.length} shown</span>
            )
          }
        >
          <FilterChip active={staleOnly} onClick={() => setStaleOnly((current) => !current)}>
            Stale only
          </FilterChip>
        </FilterBar>

        <AsyncPanel
          query={registry}
          loading={
            <div className="p-4">
              <SkeletonLines lines={8} />
            </div>
          }
          loadingLabel="Loading the integration registry"
          renderError={(error, retry) => (
            <div className="p-4">
              <QueryError error={error} onRetry={retry} />
            </div>
          )}
        >
          {() => (
            <DataTable
              columns={REGISTRY_COLUMNS}
              rows={rows}
              rowKey={registryRowKey}
              renderRowLink={registryRowLink}
              dense
              empty={
                <EmptyState
                  title="No registry entry matches"
                  // "Nothing is deployed" and "your filter excludes everything" are different
                  // facts, and telling an operator to deploy a product when the register is full
                  // sent them looking for a missing instance.
                  description={
                    hasEntries
                      ? `The register holds ${entryCount} entries; the search and filters exclude all of them.`
                      : 'The registry indexes deployed instances only. Deploy a product, then reload the registry to discover its operations and event modes.'
                  }
                  // The old copy told the operator to clear the filters and gave them nothing to
                  // clear them with.
                  action={
                    hasEntries ? (
                      <Button size="sm" variant="secondary" onClick={clearFilters}>
                        Clear search and filters
                      </Button>
                    ) : undefined
                  }
                  compact
                />
              }
            />
          )}
        </AsyncPanel>

        {/* No top rule: the last table row already draws one, and two adjacent hairlines read as a
            2px seam. */}
        <footer className="px-4 py-2">
          <InlineNote>
            Metadata older than one quarter is returned with stale=true. The rail counts down to the
            next review; the owner re-verifies before it empties. The flag also drives AC-41.
          </InlineNote>
        </footer>
      </Panel>
    </Page>
  );
}

import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import type { JobFilters } from '@seamnex/api-client';
import { useJobPages } from '@seamnex/api-client';
import type { Job, JobPage } from '@seamnex/domain';
import { JOB_KIND_LABELS, JOB_STATE_LABELS } from '@seamnex/domain';
import {
  Badge,
  Button,
  DataTable,
  FilterChip,
  Page,
  PageHeader,
  Panel,
  PanelHeader,
  ProgressBar,
  SkeletonLines,
  StatusPill,
  buttonVariants,
  defineColumns,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

const KINDS = ['all', 'deploy', 'upgrade', 'backup', 'restore', 'rollback', 'delete'] as const;
const STATES = ['all', 'running', 'succeeded', 'failed', 'queued'] as const;

/**
 * Module scope: no cell below reads state, so the array — and every cell closure in it — can be
 * created once instead of on each render of the page. `label` is the row's identity and therefore
 * the cell that carries the link; it must not be hidden on narrow screens.
 */
const JOB_COLUMNS = defineColumns<Job>([
  {
    id: 'id',
    header: 'Job',
    width: '9rem',
    mono: true,
    /*
     * The operation is the row's identity; the id is what you grep the logs with. Live ids are
     * 36-character UUIDs, which broke across five lines in a 110px column and pushed every row to
     * 60px — so the column truncates (the whole value is the `title`, and the job's own page) and
     * it is dropped below `sm`, where it took 40% of the table for a string nobody reads.
     */
    hideBelow: 'sm',
    cell: (row) => (
      <span className="block max-w-40 truncate text-micro text-faint" title={row.id}>
        {row.id}
      </span>
    ),
  },
  {
    id: 'label',
    header: 'Operation',
    primary: true,
    cell: (row) => (
      <div className="min-w-0">
        <span className="block font-medium text-text">{row.label}</span>
        <span className="mt-0.5 block text-micro text-faint">{JOB_KIND_LABELS[row.kind]}</span>
      </div>
    ),
  },
  {
    id: 'state',
    header: 'State',
    cell: (row) => {
      const label = JOB_STATE_LABELS[row.state];
      return (
        <StatusPill
          tone={label.tone}
          label={label.label}
          size="sm"
          pulse={row.state === 'running'}
        />
      );
    },
  },
  {
    id: 'progress',
    header: 'Progress',
    width: '140px',
    hideBelow: 'md',
    cell: (row) => (
      <ProgressBar
        value={row.progress}
        tone={row.state === 'failed' ? 'danger' : row.state === 'succeeded' ? 'positive' : 'accent'}
      />
    ),
  },
  {
    id: 'requested',
    header: 'Requested by',
    hideBelow: 'lg',
    cell: (row) => <span className="text-meta text-muted">{row.requestedBy}</span>,
  },
  {
    id: 'started',
    header: 'Started',
    hideBelow: 'sm',
    cell: (row) => <span className="text-micro text-muted">{formatRelative(row.createdAt)}</span>,
  },
  {
    id: 'error',
    header: 'Outcome',
    hideBelow: 'xl',
    cell: (row) =>
      row.errorCode ? (
        <Badge tone="danger" size="sm">
          {row.errorCode}
        </Badge>
      ) : (
        <span className="text-micro text-faint">
          {row.finishedAt ? formatRelative(row.finishedAt) : 'in flight'}
        </span>
      ),
  },
]);

const jobRowKey = (row: Job) => row.id;

const jobRowLink = (row: Job, className: string, children: ReactNode) => (
  <Link to={`/jobs/${row.id}`} className={className}>
    {children}
  </Link>
);

/**
 * One flattening rule for the header counts and the table, so the two cannot disagree about which
 * pages have loaded.
 */
const jobRows = (data: { pages: JobPage[] } | undefined): Job[] =>
  data === undefined ? [] : data.pages.flatMap((page) => page.items);

export function JobsPage() {
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all');
  const [state, setState] = useState<(typeof STATES)[number]>('all');

  // Filters and paging are server-side; `hasNextPage` follows the cursor the API returns.
  const filters = useMemo<JobFilters>(() => {
    const next: JobFilters = {};
    if (kind !== 'all') next.kind = kind;
    if (state !== 'all') next.state = state;
    return next;
  }, [kind, state]);

  const jobs = useJobPages(filters);
  const rows = useMemo(() => jobRows(jobs.data), [jobs.data]);
  const total = jobs.data?.pages[0]?.total ?? 0;

  return (
    <Page>
      <PageHeader
        eyebrow="Operations"
        title="Jobs"
        description="Deployment, upgrade, backup and restore jobs with steps and masked logs. Retained for 30 days so a failed operation is diagnosable without shell access."
        actions={
          /* A button, not a badge: on the other list screens this slot holds an action, and a
             status-shaped chip that navigates reads as "the platform is ready", not "go here". */
          <Link to="/catalog" className={buttonVariants({ variant: 'secondary', size: 'sm' })}>
            Browse catalog
            <ArrowRight className="size-4" aria-hidden />
          </Link>
        }
        meta={
          <>
            <Badge tone="neutral" size="sm">
              {total} jobs
            </Badge>
            <Badge tone="caution" size="sm">
              {rows.filter((job) => job.state === 'failed').length} failed
            </Badge>
            <Badge tone="info" size="sm">
              {rows.filter((job) => job.state === 'running').length} running
            </Badge>
          </>
        }
      />

      <Panel>
        <PanelHeader
          eyebrow="History"
          title="All jobs"
          description="Newest first. Open a job for step-level progress and log lines."
        />
        {/*
         * Two chip rows that filter different things read as one set of toggles without a label:
         * nothing on screen said that the left row is the operation and the right row its state.
         * Both groups are named, visibly and for assistive technology, and the count sits after
         * the group it describes.
         */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter by job kind"
          >
            <span className="label-caps mr-1 text-faint">Kind</span>
            {KINDS.map((option) => (
              <FilterChip key={option} active={kind === option} onClick={() => setKind(option)}>
                <span className="capitalize">{option}</span>
              </FilterChip>
            ))}
          </div>
          <div
            className="ml-auto flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter by job state"
          >
            <span className="label-caps mr-1 text-faint">State</span>
            {STATES.map((option) => (
              <FilterChip key={option} active={state === option} onClick={() => setState(option)}>
                <span className="capitalize">{option}</span>
              </FilterChip>
            ))}
          </div>
          <span className="font-mono text-micro text-faint">
            {rows.length} of {total} shown
          </span>
        </div>

        {/* `useInfiniteQuery` keeps its flattening inside the children callback: the panel hands over
            the `InfiniteData` envelope, and `rows` is the same memoised flatten the header counts. */}
        <AsyncPanel
          query={jobs}
          loading={
            <div className="p-4">
              <SkeletonLines lines={8} />
            </div>
          }
          loadingLabel="Loading the job history"
          renderError={(error, retry) => (
            <div className="p-4">
              <QueryError error={error} onRetry={retry} />
            </div>
          )}
        >
          {() => (
            <>
              <DataTable
                columns={JOB_COLUMNS}
                rows={rows}
                rowKey={jobRowKey}
                renderRowLink={jobRowLink}
                dense
                empty={
                  <div className="p-8 text-center">
                    <p className="text-body font-semibold text-text">No jobs to show</p>
                    <p className="mx-auto mt-1 max-w-sm text-meta leading-relaxed text-muted">
                      Deployments, lifecycle actions and restores record a job with steps and masked
                      logs. Clear the filter or start an action from an instance.
                    </p>
                  </div>
                }
              />
              {jobs.hasNextPage ? (
                <div className="flex justify-center border-t border-line px-3 py-3">
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void jobs.fetchNextPage()}
                    disabled={jobs.isFetchingNextPage}
                  >
                    {jobs.isFetchingNextPage ? 'Loading…' : `Load ${total - rows.length} more`}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </AsyncPanel>
      </Panel>
    </Page>
  );
}

import { Link } from 'react-router';
import { useJobs } from '@seamnex/api-client';
import type { InstanceDetail } from '@seamnex/domain';
import { JOB_KIND_LABELS } from '@seamnex/domain';
import { Badge, Panel, PanelHeader, SkeletonLines } from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

export function JobsTab({ instance }: { instance: InstanceDetail }) {
  const jobs = useJobs({ instanceId: instance.id });

  return (
    <Panel>
      {/* FR-1.10 — requirement id, developer-only; it used to be the panel eyebrow. */}
      <PanelHeader
        title="Job history"
        description="30-day retention. Every job exposes steps and masked logs."
      />
      {/* No table here, so the empty copy is the region's own branch: an `<li>` outside a `<ul>`
          would be invalid markup, which is why it is a paragraph rather than the old list row. */}
      <AsyncPanel
        query={jobs}
        loading={
          <div className="p-4">
            <SkeletonLines lines={5} />
          </div>
        }
        loadingLabel="Loading the job history"
        renderError={(error, retry) => (
          <div className="p-4">
            <QueryError error={error} onRetry={retry} />
          </div>
        )}
        empty={(page) =>
          page.items.length === 0 && (
            <p className="px-4 py-6 text-center text-meta text-muted">
              No jobs recorded for this instance.
            </p>
          )
        }
      >
        {(page) => (
          <ul className="divide-y divide-line">
            {page.items.map((job) => (
              <li key={job.id}>
                <Link
                  to={`/jobs/${job.id}`}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-paper-deep"
                >
                  <div className="min-w-0">
                    <p className="truncate text-body font-medium text-text">{job.label}</p>
                    <p className="mt-0.5 font-mono text-micro text-faint">
                      {JOB_KIND_LABELS[job.kind]} · {formatRelative(job.createdAt)} ·{' '}
                      {job.requestedBy}
                    </p>
                  </div>
                  <Badge
                    tone={
                      job.state === 'succeeded'
                        ? 'positive'
                        : job.state === 'failed'
                          ? 'danger'
                          : job.state === 'running'
                            ? 'info'
                            : 'neutral'
                    }
                    size="sm"
                  >
                    {job.state}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </AsyncPanel>
    </Panel>
  );
}

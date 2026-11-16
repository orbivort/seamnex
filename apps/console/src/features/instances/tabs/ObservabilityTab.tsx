import { useState, type FormEvent } from 'react';
import { Activity, Radio, ScrollText } from 'lucide-react';
import { useInstanceLogs, useInstanceObservability } from '@seamnex/api-client';
import type { InstanceDetail, ObservabilityReport } from '@seamnex/domain';
import {
  Badge,
  Button,
  EmptyState,
  Input,
  InlineNote,
  Panel,
  PanelHeader,
  SkeletonLines,
  StatusPill,
} from '@seamnex/ui';
import { formatRelative } from '@seamnex/utils';
import { AsyncPanel, QueryError } from '@seamnex/shell';

/**
 * FR-2.6 / AC-45 — the per-instance observability screen.
 *
 * Three blocks, each answering a question the review found unanswerable without opening Grafana:
 * *is this instance scraped*, *what does the catalogue say we watch*, and *what did it actually log*.
 * The target card deliberately says "published", never "scraped": the control plane writes the file
 * Prometheus watches, and it cannot see whether Prometheus picked it up.
 */
const TARGET_TONE = {
  published: 'positive',
  missing: 'caution',
  not_configured: 'neutral',
} as const;

const TARGET_LABEL = {
  published: 'Target published',
  missing: 'No target yet',
  not_configured: 'Stack off',
} as const;

const RANGES = [
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
  { minutes: 1440, label: '24h' },
] as const;

export function ObservabilityTab({ instance }: { instance: InstanceDetail }) {
  const report = useInstanceObservability(instance.id);
  return (
    <div className="space-y-3">
      <Panel>
        <PanelHeader
          title="Telemetry profile"
          description="What the catalogue declares we observe, and whether this instance's scrape target has been published."
          actions={
            <Button size="sm" variant="quiet" onClick={() => void report.refetch()}>
              Refresh
            </Button>
          }
        />
        <AsyncPanel
          query={report}
          loading={
            <div className="p-4">
              <SkeletonLines lines={5} />
            </div>
          }
          loadingLabel="Loading the observability profile"
          renderError={(error, retry) => (
            <div className="p-4">
              <QueryError error={error} onRetry={retry} />
            </div>
          )}
        >
          {(data) => <ProfileBody report={data} />}
        </AsyncPanel>
      </Panel>

      <LogsPanel instanceId={instance.id} report={report.data} />
    </div>
  );
}

function ProfileBody({ report }: { report: ObservabilityReport }) {
  return (
    <div className="divide-y divide-line">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Radio className="size-3.5 text-faint" aria-hidden />
            <span className="text-meta font-medium text-text">Scrape target</span>
            <StatusPill
              tone={TARGET_TONE[report.target.state]}
              label={TARGET_LABEL[report.target.state]}
              size="sm"
            />
          </div>
          <p className="mt-1 truncate font-mono text-micro text-muted">
            {report.target.address}
            {report.target.metricsPath}
          </p>
          <p className="mt-1 text-micro text-faint">{report.target.detail}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {Object.entries(report.target.labels)
            .filter(([name]) => name !== 'job')
            .map(([name, value]) => (
              <Badge key={name} tone="neutral" size="sm">
                <span className="font-mono">
                  {name}={value}
                </span>
              </Badge>
            ))}
        </div>
      </div>

      <div className="grid gap-px bg-line sm:grid-cols-2">
        <section className="bg-panel p-4">
          <h3 className="flex items-center gap-2 text-meta font-medium text-text">
            <Activity className="size-3.5 text-faint" aria-hidden />
            Dashboards
          </h3>
          <ul className="mt-2 space-y-2">
            {report.profile.dashboards.length === 0 ? (
              <li className="text-micro text-faint">
                The catalogue entry declares no dashboards for this product.
              </li>
            ) : null}
            {report.profile.dashboards.map((dashboard) => (
              <li key={dashboard.uid}>
                <p className="text-meta text-text">{dashboard.title}</p>
                <p className="mt-0.5 font-mono text-micro text-faint">
                  uid {dashboard.uid} · {dashboard.panels.join(' · ')}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="bg-panel p-4">
          <h3 className="text-meta font-medium text-text">Alert rules</h3>
          <ul className="mt-2 space-y-2">
            {report.profile.rules.length === 0 ? (
              <li className="text-micro text-faint">
                The catalogue entry declares no alert rules for this product.
              </li>
            ) : null}
            {report.profile.rules.map((rule) => (
              <li key={rule.name}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-meta text-text">{rule.name}</p>
                  <Badge
                    tone={
                      rule.severity === 'critical'
                        ? 'danger'
                        : rule.severity === 'warning'
                          ? 'caution'
                          : 'info'
                    }
                    size="sm"
                  >
                    {rule.severity}
                  </Badge>
                </div>
                <p className="mt-0.5 break-all font-mono text-micro text-faint">
                  {rule.expression} · for {rule.for}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <span className="text-micro text-faint">{report.logs.detail}</span>
        <span className="text-micro text-faint">
          retention {report.logs.retentionDays} days · profile read{' '}
          {formatRelative(report.generatedAt)}
        </span>
      </div>
    </div>
  );
}

function LogsPanel({
  instanceId,
  report,
}: {
  instanceId: string;
  report: ObservabilityReport | undefined;
}) {
  const [range, setRange] = useState<number>(15);
  const [draft, setDraft] = useState('');
  const [applied, setApplied] = useState('');
  const available = report?.logs.available ?? false;
  const logs = useInstanceLogs(
    instanceId,
    { since: range, limit: 200, filter: applied },
    { enabled: available },
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    // Applied on submit: a log query per keystroke would be a Loki round trip per character.
    setApplied(draft);
  };

  return (
    <Panel>
      <PanelHeader
        title="Instance logs"
        description="Queried from the platform log store by instance id, masked before it reaches this screen."
      />
      {/*
        The controls are part of the console, not of the panel: a range and a filter offered while
        the log store is unconfigured would be a form whose submit cannot change anything.
      */}
      {available ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <div className="flex items-center gap-1" role="group" aria-label="Time range">
            {RANGES.map((option) => (
              <Button
                key={option.minutes}
                size="sm"
                variant={range === option.minutes ? 'secondary' : 'quiet'}
                aria-pressed={range === option.minutes}
                onClick={() => setRange(option.minutes)}
              >
                {option.label}
              </Button>
            ))}
          </div>
          <form onSubmit={submit} className="flex flex-1 items-center gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Filter by literal text"
              aria-label="Log filter"
              className="h-8 max-w-sm"
            />
            <Button size="sm" type="submit" variant="secondary">
              Apply
            </Button>
            {applied.length > 0 ? (
              <Button
                size="sm"
                variant="quiet"
                onClick={() => {
                  setDraft('');
                  setApplied('');
                }}
              >
                Clear
              </Button>
            ) : null}
          </form>
        </div>
      ) : null}

      {!available ? (
        <div className="p-4">
          <InlineNote>
            {report?.logs.detail ??
              'The log store is not configured; only the live container stream on the Containers tab is available.'}
          </InlineNote>
        </div>
      ) : (
        <AsyncPanel
          query={logs}
          loading={
            <div className="p-4">
              <SkeletonLines lines={8} />
            </div>
          }
          loadingLabel="Querying the log store"
          renderError={(error, retry) => (
            <div className="p-4">
              <QueryError error={error} onRetry={retry} />
            </div>
          )}
          empty={(result) =>
            result.lines.length === 0 && (
              <EmptyState
                compact
                icon={<ScrollText className="size-5" />}
                title="No matching lines"
                description="Nothing matched in this window. A quiet product and an unconfigured collector both look like this — the target card above tells them apart."
              />
            )
          }
        >
          {(result) => (
            <div className="p-3">
              <div className="log-surface scroll-slim max-h-[45vh] overflow-auto overscroll-contain rounded-sm border border-line-ink p-3">
                {result.lines.map((line) => (
                  <p
                    key={`${line.ts}-${line.container ?? ''}-${line.line}`}
                    className="whitespace-pre-wrap"
                  >
                    <span className="mr-2 text-ink-text-faint">{line.ts.slice(11, 19)}</span>
                    <span className={line.stream === 'stderr' ? 'text-danger' : 'text-ink-text'}>
                      {line.line}
                    </span>
                  </p>
                ))}
              </div>
              <p className="mt-2 text-micro text-faint">{result.detail}</p>
            </div>
          )}
        </AsyncPanel>
      )}
    </Panel>
  );
}

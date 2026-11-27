import { http, HttpResponse } from 'msw';
import type { InstanceLogs, InstanceLogLine, ObservabilityReport } from '@seamnex/domain';
import { at } from '../fixtures/context';
import { getState } from '../store';
import { problem, requireCapability, roleOf } from './utils';

/**
 * FR-2.6 / AC-45 — the observability screens in the prototype.
 *
 * The mock answers with what the API now answers: a persisted-looking profile for the entry, a
 * published scrape target and a log store that holds history. It deliberately does **not** invent a
 * fourth state — "scraped" — because the real response cannot know it, and a prototype that is more
 * confident than the product is how a review ends up trusting a screenshot.
 */
const TARGET_FILE = (instanceId: string) => `instance-${instanceId}.json`;

function profileFor(product: string, entryKey: string): ObservabilityReport['profile'] {
  const selector = `{entry_key="${entryKey}"}`;
  return {
    dashboards: [
      {
        uid: 'instance-overview',
        title: `${product} — instance overview`,
        panels: ['Availability', 'Container CPU', 'Container memory', 'Volume disk usage'],
      },
    ],
    rules: [
      {
        name: `${product} is down`,
        expression: `seamnex_instance_up${selector} == 0`,
        severity: 'critical',
        for: '5m',
      },
      {
        name: `${product} memory pressure`,
        expression: `seamnex_instance_memory_mb${selector} / clamp_min(seamnex_instance_memory_limit_mb${selector}, 1) >= 0.9`,
        severity: 'warning',
        for: '10m',
      },
      {
        name: `${product} volume filling`,
        expression: `seamnex_instance_disk_mb${selector} / clamp_min(seamnex_instance_disk_quota_mb${selector}, 1) >= 0.85`,
        severity: 'warning',
        for: '15m',
      },
    ],
  };
}

function reportFor(instanceId: string): ObservabilityReport | null {
  const state = getState();
  const instance = state.instances.find((item) => item.id === instanceId);
  if (instance === undefined) return null;
  const labels = {
    job: 'seamnex-instance',
    instance_id: instance.id,
    instance_slug: instance.slug,
    entry_key: instance.entryKey,
    product: instance.product,
  };
  return {
    instanceId: instance.id,
    entryKey: instance.entryKey,
    product: instance.product,
    slug: instance.slug,
    profile: profileFor(instance.product, instance.entryKey),
    target: {
      state: 'published',
      metricsPath: `/api/v1/metrics/instances/${instance.id}`,
      address: 'api:8080',
      labels,
      file: TARGET_FILE(instance.id),
      detail: 'The target file exists; Prometheus scrapes it on its next cycle.',
      generatedAt: at(-1),
    },
    logs: {
      available: true,
      source: 'loki',
      retentionDays: 30,
      detail: 'Queryable per instance through the platform for 30 days.',
    },
    generatedAt: at(0),
  };
}

function logsFor(instanceId: string, limit: number, filter: string): InstanceLogs {
  const instance = getState().instances.find((item) => item.id === instanceId);
  const product = instance?.product ?? 'the product';
  const template: Array<Omit<InstanceLogLine, 'ts'>> = [
    {
      stream: 'stdout',
      line: `${product} http: GET /health 200 4ms`,
      container: `${instance?.slug}-web`,
    },
    {
      stream: 'stdout',
      line: `${product} queue: drained 12 jobs in 1.4s`,
      container: `${instance?.slug}-worker`,
    },
    {
      stream: 'stderr',
      line: `${product} db pool: waiting for a connection (2.1s)`,
      container: `${instance?.slug}-web`,
    },
    {
      stream: 'stdout',
      line: `${product} http: POST /api/login 200 118ms`,
      container: `${instance?.slug}-web`,
    },
    {
      stream: 'stdout',
      line: `${product} cron: nightly export scheduled`,
      container: `${instance?.slug}-worker`,
    },
    {
      stream: 'stdout',
      line: `${product} http: GET /dashboard 200 61ms`,
      container: `${instance?.slug}-web`,
    },
  ];
  const lines = template
    .map((line, index) => ({ ...line, ts: at(-(template.length - index)) }))
    .filter((line) => (filter.length === 0 ? true : line.line.includes(filter)))
    .slice(-limit);
  return {
    instanceId,
    source: 'loki',
    lines,
    retentionDays: 30,
    truncated: lines.length >= limit,
    detail: `Masked lines from the platform log store, newest ${lines.length} of the last 15 minutes.`,
  };
}

export const observabilityHandlers = [
  http.get('*/api/v1/instances/:id/observability', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const report = reportFor(String(params.id));
    if (report === null) {
      return problem(
        404,
        'NOT_FOUND',
        'Instance not found',
        `No instance ${String(params.id)}.`,
        'Reload the instance list; the instance may have been deleted.',
      );
    }
    return HttpResponse.json(report);
  }),

  http.get('*/api/v1/instances/:id/logs', ({ params, request }) => {
    const guard = requireCapability(roleOf(request), 'instance.view_logs');
    if (guard) return guard;
    const url = new URL(request.url);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 200) || 200));
    const filter = (url.searchParams.get('filter') ?? '').slice(0, 200);
    return HttpResponse.json(logsFor(String(params.id), limit, filter));
  }),
];

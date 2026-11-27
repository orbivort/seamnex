import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { Instance, InstanceLogs, ObservabilityReport } from '@seamnex/domain';
import { getState } from '@seamnex/mocks';
import { server } from '@seamnex/mocks/server';
import { App } from '../../src/app';
import { openAs, present } from '../helpers';

/**
 * FR-2.6 / AC-45 and FR-4.5 / AC-39 — the two screens the review found asserted capabilities the
 * platform did not have: an observability tab that only claimed to exist, and a capacity board that
 * showed allocation as if it were consumption. Each test below fails if the screen goes back to
 * printing a number it did not measure or a threshold it was not given.
 */
async function openTab(name: string) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
  return screen.findByRole('tabpanel');
}

function crmInstance(): Instance {
  return present(
    getState().instances.find((item) => item.id === 'inst-crm'),
    'the inst-crm instance',
  );
}

/**
 * A report the console accepts verbatim, so a case varies only the block it is about: the target
 * stays `published` and the log store stays reachable, otherwise the console below would be gated
 * off and the case would test nothing.
 */
function reportBody(
  instance: Instance,
  profile: ObservabilityReport['profile'],
): ObservabilityReport {
  return {
    instanceId: instance.id,
    entryKey: instance.entryKey,
    product: instance.product,
    slug: instance.slug,
    profile,
    target: {
      state: 'published',
      metricsPath: `/api/v1/metrics/instances/${instance.id}`,
      address: 'api:8080',
      labels: { job: 'seamnex-instance', instance_id: instance.id },
      file: `instance-${instance.id}.json`,
      detail: 'The target file exists; Prometheus scrapes it on its next cycle.',
      generatedAt: instance.observedAt,
    },
    logs: {
      available: true,
      source: 'loki',
      retentionDays: 30,
      detail: 'Queryable per instance through the platform for 30 days.',
    },
    generatedAt: instance.observedAt,
  };
}

function logsBody(instanceId: string, lines: InstanceLogs['lines']): InstanceLogs {
  return {
    instanceId,
    source: 'loki',
    lines,
    retentionDays: 30,
    truncated: false,
    detail: `Masked lines from the platform log store, newest ${lines.length} of the last 15 minutes.`,
  };
}

describe('instance observability', () => {
  it('describes the persisted profile and the published scrape target', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    expect(await within(panel).findByText('Telemetry profile')).toBeDefined();
    // "published", never "scraped": the control plane writes the file Prometheus watches.
    expect(await within(panel).findByText('Target published')).toBeDefined();
    expect(
      within(panel).getByText(/api:8080\/api\/v1\/metrics\/instances\/inst-crm/),
    ).toBeDefined();
    expect(within(panel).getByText('instance_id=inst-crm')).toBeDefined();
    expect(within(panel).getByText('entry_key=D01-01')).toBeDefined();
    expect(within(panel).getByText(/EspoCRM — instance overview/)).toBeDefined();
    expect(within(panel).getByText(/EspoCRM is down/)).toBeDefined();
    expect(within(panel).getByText('critical')).toBeDefined();
    expect(within(panel).getByText(/retention 30 days/)).toBeDefined();
  });

  it('queries the log store per instance, masks the lines and narrows them on a filter', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    expect(await within(panel).findByText(/queue: drained 12 jobs/)).toBeDefined();
    expect(within(panel).getByText(/db pool: waiting for a connection/)).toBeDefined();
    expect(within(panel).getByText(/Masked lines from the platform log store/)).toBeDefined();

    fireEvent.change(within(panel).getByLabelText('Log filter'), {
      target: { value: 'db pool' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));

    // A literal filter, applied on submit: the query is a log-store round trip, not a keystroke.
    await waitFor(() => expect(within(panel).queryByText(/queue: drained/)).toBeNull());
    expect(within(panel).getByText(/db pool: waiting/)).toBeDefined();

    const hour = within(panel).getByRole('button', { name: '1h' });
    fireEvent.click(hour);
    await waitFor(() => expect(hour.getAttribute('aria-pressed')).toBe('true'));
  });

  it('says the log store is not configured instead of showing an empty console', async () => {
    const instance = present(
      getState().instances.find((item) => item.id === 'inst-crm'),
      'the inst-crm instance',
    );
    server.use(
      http.get('/api/v1/instances/inst-crm/observability', () =>
        HttpResponse.json({
          instanceId: instance.id,
          entryKey: instance.entryKey,
          product: instance.product,
          slug: instance.slug,
          profile: { dashboards: [], rules: [] },
          target: {
            state: 'not_configured',
            metricsPath: '/api/v1/metrics/instances',
            address: 'api:8080',
            labels: {},
            file: null,
            detail: 'Set SEAMNEX_PROMETHEUS_TARGETS_DIR to start publishing targets.',
            generatedAt: null,
          },
          logs: {
            available: false,
            source: 'none',
            retentionDays: 30,
            detail: 'Log queries need SEAMNEX_LOKI_URL; only container streams are available.',
          },
          generatedAt: instance.observedAt,
        }),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    expect(await within(panel).findByText('Stack off')).toBeDefined();
    expect(within(panel).getByText(/to start publishing targets/)).toBeDefined();
    expect(
      within(panel).getByText('The catalogue entry declares no dashboards for this product.'),
    ).toBeDefined();
    // The detail appears twice by design: once in the profile footer, once where the console would be.
    expect(within(panel).getAllByText(/only container streams are available/).length).toBe(2);
    // No console, because there is nothing to query — not an empty one that reads as "no traffic".
    expect(within(panel).queryByLabelText('Log filter')).toBeNull();
  });
});

describe('instance observability controls', () => {
  it('re-reads the profile when the operator refreshes it', async () => {
    const instance = crmInstance();
    let reads = 0;
    server.use(
      http.get('/api/v1/instances/inst-crm/observability', () => {
        reads += 1;
        return HttpResponse.json(
          reportBody(instance, {
            dashboards: [
              {
                uid: 'instance-overview',
                title: 'EspoCRM — instance overview',
                panels: ['Availability'],
              },
            ],
            rules: [],
          }),
        );
      }),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    expect(await within(panel).findByText('EspoCRM — instance overview')).toBeDefined();

    // The profile is a snapshot of a persisted artefact, so it only moves when asked: a refresh
    // is one read, not a poll.
    const before = reads;
    fireEvent.click(within(panel).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(reads).toBeGreaterThan(before));
  });

  it('reports a failed profile read and recovers when the operator retries', async () => {
    const instance = crmInstance();
    let failing = true;
    server.use(
      http.get('/api/v1/instances/inst-crm/observability', () =>
        failing
          ? HttpResponse.error()
          : HttpResponse.json(reportBody(instance, { dashboards: [], rules: [] })),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();

    failing = false;
    fireEvent.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(
      await within(panel).findByText(
        'The catalogue entry declares no dashboards for this product.',
      ),
    ).toBeDefined();
  });

  it('reports a failed log query without hiding the profile above it', async () => {
    server.use(http.get('/api/v1/instances/inst-crm/logs', () => HttpResponse.error()));

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    // The profile is its own read and still answered; only the console failed.
    expect(await within(panel).findByText('Target published')).toBeDefined();
    expect(await within(panel).findByText('The platform API could not be reached')).toBeDefined();
  });

  it('clears an applied filter and goes back to the unfiltered window', async () => {
    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    await within(panel).findByText(/queue: drained 12 jobs/);

    fireEvent.change(within(panel).getByLabelText('Log filter'), { target: { value: 'db pool' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(within(panel).queryByText(/queue: drained/)).toBeNull());

    fireEvent.click(within(panel).getByRole('button', { name: 'Clear' }));

    expect(await within(panel).findByText(/queue: drained 12 jobs/)).toBeDefined();
    // Clear drops the draft as well as the query, so the field is not left holding a dead filter.
    expect((within(panel).getByLabelText('Log filter') as HTMLInputElement).value).toBe('');
  });

  it('names an info-severity rule and renders a line whose container is unknown', async () => {
    const instance = crmInstance();
    server.use(
      http.get('/api/v1/instances/inst-crm/observability', () =>
        HttpResponse.json(
          reportBody(instance, {
            dashboards: [],
            rules: [
              {
                name: 'EspoCRM plugin disabled',
                expression: 'seamnex_plugin_up == 0',
                severity: 'info',
                for: '30m',
              },
            ],
          }),
        ),
      ),
      http.get('/api/v1/instances/inst-crm/logs', () =>
        HttpResponse.json(
          logsBody(instance.id, [
            {
              ts: '2026-11-16T09:59:30.000Z',
              stream: 'stderr',
              line: 'unattributed diagnostic line',
              container: null,
            },
          ]),
        ),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    expect(await within(panel).findByText('info')).toBeDefined();
    expect(await within(panel).findByText(/unattributed diagnostic line/)).toBeDefined();
  });

  it('says nothing matched rather than drawing an empty console', async () => {
    const instance = crmInstance();
    server.use(
      http.get('/api/v1/instances/inst-crm/logs', () =>
        HttpResponse.json(logsBody(instance.id, [])),
      ),
    );

    openAs('R1', '/instances/inst-crm');
    render(<App />);
    await screen.findByRole('heading', { name: 'EspoCRM' });

    const panel = await openTab('Observability');
    expect(await within(panel).findByText('No matching lines')).toBeDefined();
    // The controls stay: the store is configured, this window simply held nothing.
    expect(within(panel).queryByLabelText('Log filter')).not.toBeNull();
  });
});

describe('capacity consumption', () => {
  it('pairs allocated with measured consumption and names the sample it read', async () => {
    openAs('R1', '/capacity');
    render(<App />);
    await screen.findByRole('heading', { name: 'Capacity' });

    expect(await screen.findByText(/Alert bands: CPU 75 %, memory 90 %, disk 85 %/)).toBeDefined();

    const crmRow = present(
      await screen.findByRole('link', { name: /EspoCRM/ }),
      'the EspoCRM row',
    ).closest('tr');
    expect(within(present(crmRow, 'the EspoCRM table row')).getByText(/vCPU used/)).toBeDefined();
    expect(within(present(crmRow, 'the EspoCRM table row')).queryByText('no sample')).toBeNull();

    // A stopped instance has no sample at all — "not measured", never a zero that reads as idle.
    const shopRow = present(
      screen.getByRole('link', { name: /WooCommerce/ }),
      'the stopped instance row',
    ).closest('tr');
    expect(
      within(present(shopRow, 'the stopped instance row')).getAllByText('not measured').length,
    ).toBe(3);
  });

  it('draws its bands from the snapshot rather than from a literal', async () => {
    const snapshot = getState().capacity;
    server.use(
      http.get('/api/v1/capacity', () =>
        HttpResponse.json({
          ...snapshot,
          thresholds: { cpuPercent: 60, memoryPercent: 70, diskPercent: 65 },
        }),
      ),
    );

    openAs('R1', '/capacity');
    render(<App />);

    expect(await screen.findByText(/Alert bands: CPU 60 %, memory 70 %, disk 65 %/)).toBeDefined();
    expect(screen.queryByText(/Alert bands: CPU 75 %/)).toBeNull();
  });
});

describe('capacity thresholds in settings', () => {
  it('shows the stored percentages and saves a changed one', async () => {
    openAs('R1', '/admin/settings');
    render(<App />);
    await screen.findByRole('heading', { name: 'Settings' });

    expect(await screen.findByText('Capacity alert thresholds (%)')).toBeDefined();
    const stored = getState().settings;
    const cpu = present(screen.getByLabelText('CPU'), 'the CPU threshold field');
    expect((cpu as HTMLInputElement).value).toBe(String(stored.capacityCpuAlertPercent));
    expect(screen.getByLabelText('Memory')).toBeDefined();
    expect(screen.getByLabelText('Disk')).toBeDefined();

    fireEvent.change(cpu, { target: { value: '82' } });

    const save = screen.getByRole('button', { name: 'Save changes' });
    await waitFor(() => expect(save.hasAttribute('disabled')).toBe(false));
    fireEvent.click(save);

    expect(await screen.findByText('Settings saved')).toBeDefined();
    await waitFor(() => expect(getState().settings.capacityCpuAlertPercent).toBe(82));
  });
});

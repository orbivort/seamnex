import { describe, expect, it } from 'vitest';
import { createMetrics, METRICS } from '../../../../src/common/metrics/metrics';

describe('metrics registry', () => {
  it('exposes the injection token', () => {
    expect(typeof METRICS).toBe('symbol');
  });

  it('registers every bounded metric under the seamnex_ prefix', async () => {
    const metrics = createMetrics('api');
    const text = await metrics.registry.metrics();

    for (const name of [
      'seamnex_http_requests_total',
      'seamnex_http_request_duration_seconds',
      'seamnex_role_up',
      'seamnex_dependency_up',
      'seamnex_audit_append_seconds',
      'seamnex_jobs_created_total',
      'seamnex_job_transitions_total',
      'seamnex_job_stream_active',
      'seamnex_job_stream_rejected_total',
      'seamnex_secrets_decrypted_total',
      'seamnex_outbox_dispatched_total',
      'seamnex_queue_depth',
      'seamnex_scheduler_skipped_passes_total',
    ]) {
      expect(text).toContain(name);
    }
  });

  it('stamps the role as a default label and marks the role up', async () => {
    const metrics = createMetrics('scheduler');
    const text = await metrics.registry.metrics();
    expect(text).toContain('role="scheduler"');
    expect((await metrics.roleUp.get()).values[0]?.value).toBe(1);
  });

  it('records a counter with its labels', async () => {
    const metrics = createMetrics('api');
    metrics.httpRequests.labels('GET', '/jobs', '200').inc();
    metrics.jobsCreated.labels('deploy', 'fast').inc(2);
    metrics.dependencyUp.labels('postgres').set(1);

    const text = await metrics.registry.metrics();
    const line = (prefix: string): string | undefined =>
      text.split('\n').find((candidate) => candidate.startsWith(prefix));

    const requestLine = line('seamnex_http_requests_total{') ?? '';
    expect(requestLine).toContain('method="GET"');
    expect(requestLine).toContain('route="/jobs"');
    expect(requestLine).toContain('status="200"');
    expect(requestLine.endsWith(' 1')).toBe(true);

    const jobsLine = line('seamnex_jobs_created_total{') ?? '';
    expect(jobsLine).toContain('kind="deploy"');
    expect(jobsLine).toContain('lane="fast"');
    expect(jobsLine.endsWith(' 2')).toBe(true);

    expect(line('seamnex_dependency_up{')).toContain('dependency="postgres"');
  });

  it('uses one registry per instance so two roles do not collide', async () => {
    const api = createMetrics('api');
    const worker = createMetrics('deploy-worker');
    expect(api.registry).not.toBe(worker.registry);
    api.httpRequests.labels('GET', '/x', '200').inc();
    const workerText = await worker.registry.metrics();
    expect(workerText).not.toContain('seamnex_http_requests_total{');
  });
});

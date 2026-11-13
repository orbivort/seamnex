import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { RoleId } from '../../config/config';

export const METRICS = Symbol('seamnex.metrics');

/**
 * Metrics are bounded on purpose: no `job_id`, no `instance_id`, no request path with an id in it.
 * A label whose cardinality grows with data is how a Prometheus instance dies quietly.
 */
export type Metrics = {
  readonly registry: Registry;
  readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  readonly httpDuration: Histogram<'method' | 'route'>;
  readonly roleUp: Gauge<'role'>;
  readonly dependencyUp: Gauge<'dependency'>;
  readonly auditAppendSeconds: Histogram<'outcome'>;
  readonly jobsCreated: Counter<'kind' | 'lane'>;
  readonly jobTransitions: Counter<'from' | 'to'>;
  readonly jobStreamActive: Gauge<string>;
  readonly jobStreamRejected: Counter<string>;
  readonly secretsDecrypted: Counter<'scope'>;
  /**
   * Relay outcomes that could not be written to the audit chain. The launch proceeds (a launch must
   * not fail on an audit outage), so the metric is the only signal that the record of a relayed
   * sign-in has a hole.
   */
  readonly relayAuditFailures: Counter<'action'>;
  /**
   * Successful relayed sign-ins whose circuit-breaker counter could not be reset. The launch
   * proceeds, but a mapping whose counter stays elevated is marked `failed` after two further
   * rejections it did not cause, so the failure has to be visible.
   */
  readonly relayCredentialResetFailures: Counter<string>;
  readonly outboxDispatched: Counter<'event_type'>;
  readonly queueDepth: Gauge<'queue' | 'state'>;
  readonly schedulerSkippedPasses: Counter<string>;
};

export function createMetrics(role: RoleId): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ role });

  collectDefaultMetrics({ register: registry, prefix: 'seamnex_' });

  const metrics: Metrics = {
    registry,
    httpRequests: new Counter({
      name: 'seamnex_http_requests_total',
      help: 'HTTP requests handled, by route template',
      labelNames: ['method', 'route', 'status'],
      registers: [registry],
    }),
    httpDuration: new Histogram({
      name: 'seamnex_http_request_duration_seconds',
      help: 'HTTP request latency',
      labelNames: ['method', 'route'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [registry],
    }),
    roleUp: new Gauge({
      name: 'seamnex_role_up',
      help: '1 when this process role is running (it may still be idle)',
      labelNames: ['role'],
      registers: [registry],
    }),
    dependencyUp: new Gauge({
      name: 'seamnex_dependency_up',
      help: '1 when a dependency answered its readiness probe',
      labelNames: ['dependency'],
      registers: [registry],
    }),
    auditAppendSeconds: new Histogram({
      name: 'seamnex_audit_append_seconds',
      help: 'Time spent appending an audit row, including the chain lock',
      labelNames: ['outcome'],
      buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
      registers: [registry],
    }),
    jobsCreated: new Counter({
      name: 'seamnex_jobs_created_total',
      help: 'Jobs created, by kind and lane',
      labelNames: ['kind', 'lane'],
      registers: [registry],
    }),
    jobTransitions: new Counter({
      name: 'seamnex_job_transitions_total',
      help: 'Job state transitions',
      labelNames: ['from', 'to'],
      registers: [registry],
    }),
    jobStreamActive: new Gauge({
      name: 'seamnex_job_stream_active',
      help: 'Open job event streams on this replica',
      registers: [registry],
    }),
    jobStreamRejected: new Counter({
      name: 'seamnex_job_stream_rejected_total',
      help: 'Stream opens refused because the per-replica bound was reached',
      registers: [registry],
    }),
    secretsDecrypted: new Counter({
      name: 'seamnex_secrets_decrypted_total',
      help: 'Secret decryptions, by scope (each also writes a secret.read audit row)',
      labelNames: ['scope'],
      registers: [registry],
    }),
    relayAuditFailures: new Counter({
      name: 'seamnex_relay_audit_failures_total',
      help: 'Relay outcomes that could not be appended to the audit chain',
      labelNames: ['action'],
      registers: [registry],
    }),
    relayCredentialResetFailures: new Counter({
      name: 'seamnex_relay_credential_reset_failures_total',
      help: 'Relayed sign-ins that succeeded but whose failure counter could not be reset',
      registers: [registry],
    }),
    outboxDispatched: new Counter({
      name: 'seamnex_outbox_dispatched_total',
      help: 'Outbox events dispatched',
      labelNames: ['event_type'],
      registers: [registry],
    }),
    // Sampled by the scheduler from the database, because the database is the queue of record.
    queueDepth: new Gauge({
      name: 'seamnex_queue_depth',
      help: 'Jobs in a database state, sampled by the scheduler',
      labelNames: ['queue', 'state'],
      registers: [registry],
    }),
    schedulerSkippedPasses: new Counter({
      name: 'seamnex_scheduler_skipped_passes_total',
      help: 'Scheduler passes skipped because the previous pass had not finished',
      registers: [registry],
    }),
  };

  metrics.roleUp.labels(role).set(1);
  return metrics;
}

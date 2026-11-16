import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';

/**
 * FR-2.6 / AC-45 — per-instance observability, as the platform can honestly describe it.
 *
 * A profile is what the catalogue entry declares about observing the product: which dashboards
 * exist and which alert rules apply. It is derived once and persisted, because a screen that
 * recomputes a "profile" on every read is describing a guess, not an artefact an operator can
 * compare against the Prometheus/Grafana configuration that is actually loaded.
 */
export const ObservabilityDashboardSchema = z.object({
  /** Stable identifier, also the Grafana dashboard uid when the entry ships one. */
  uid: z.string().min(1),
  title: z.string().min(1),
  /** Panel titles in render order — enough to say what the dashboard answers without embedding it. */
  panels: z.array(z.string().min(1)),
});

export const ObservabilityRuleSchema = z.object({
  name: z.string().min(1),
  /** The PromQL expression. Published as data so the console can show what fires, verbatim. */
  expression: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']),
  /** How long the condition must hold, e.g. `5m`. */
  for: z.string().min(1),
});

export const ObservabilityProfileSchema = z.object({
  dashboards: z.array(ObservabilityDashboardSchema),
  rules: z.array(ObservabilityRuleSchema),
});

/**
 * Where the instance's metrics come from.
 *
 * `published` means the platform wrote the scrape-target file; it does not claim Prometheus has
 * scraped it. Saying "scraped" here would be a claim the control plane cannot verify, which is the
 * class of assertion this workstream exists to remove.
 */
export const ObservabilityTargetStateSchema = z.enum(['published', 'missing', 'not_configured']);

export const ObservabilityTargetSchema = z.object({
  state: ObservabilityTargetStateSchema,
  /** Path Prometheus uses, relative to the API origin. */
  metricsPath: z.string().min(1),
  /** `host:port` Prometheus scrapes — the API, not the product. */
  address: z.string().min(1),
  labels: z.record(z.string(), z.string()),
  /** File the target was written to, relative to the configured targets directory. */
  file: z.string().nullable(),
  detail: z.string().min(1),
  generatedAt: TimestampSchema.nullable(),
});

export const ObservabilityLogAccessSchema = z.object({
  available: z.boolean(),
  source: z.enum(['loki', 'none']),
  retentionDays: z.number().int().positive(),
  detail: z.string().min(1),
});

export const ObservabilityReportSchema = z.object({
  instanceId: IdSchema,
  entryKey: z.string().min(1),
  product: z.string().min(1),
  slug: z.string().min(1),
  profile: ObservabilityProfileSchema,
  target: ObservabilityTargetSchema,
  logs: ObservabilityLogAccessSchema,
  generatedAt: TimestampSchema,
});

/** One line returned by the platform log query. Timestamps come from the log store, not the clock. */
export const InstanceLogLineSchema = z.object({
  ts: TimestampSchema,
  stream: z.enum(['stdout', 'stderr']),
  line: z.string(),
  container: z.string().nullable(),
});

export const InstanceLogsSchema = z.object({
  instanceId: IdSchema,
  source: z.enum(['loki', 'none']),
  lines: z.array(InstanceLogLineSchema),
  retentionDays: z.number().int().positive(),
  truncated: z.boolean(),
  detail: z.string().min(1),
});

export type ObservabilityDashboard = z.infer<typeof ObservabilityDashboardSchema>;
export type ObservabilityRule = z.infer<typeof ObservabilityRuleSchema>;
export type ObservabilityProfile = z.infer<typeof ObservabilityProfileSchema>;
export type ObservabilityTarget = z.infer<typeof ObservabilityTargetSchema>;
export type ObservabilityReport = z.infer<typeof ObservabilityReportSchema>;
export type InstanceLogLine = z.infer<typeof InstanceLogLineSchema>;
export type InstanceLogs = z.infer<typeof InstanceLogsSchema>;

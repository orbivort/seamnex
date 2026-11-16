/**
 * The per-instance Prometheus exposition (FR-2.6, FR-4.6).
 *
 * This is deliberately **not** the prom-client registry. That registry is documented as carrying no
 * `instance_id` label, because a label whose cardinality grows with data is how a Prometheus instance
 * dies quietly. A per-instance series is legitimate only when it is one scrape target per instance —
 * so the series set is bounded by the targets Prometheus was told about, and the arithmetic lives in
 * a formatter a test can read rather than in a library call.
 *
 * The names are exported because the generated alert rules reference them: one definition for the
 * writer and the reader, so a rule cannot cite a metric nothing emits.
 */
export const INSTANCE_METRICS = {
  up: 'seamnex_instance_up',
  cpuLimitMillicores: 'seamnex_instance_cpu_limit_millicores',
  memoryLimitMb: 'seamnex_instance_memory_limit_mb',
  diskQuotaMb: 'seamnex_instance_disk_quota_mb',
  cpuMillicores: 'seamnex_instance_cpu_millicores',
  memoryMb: 'seamnex_instance_memory_mb',
  diskMb: 'seamnex_instance_disk_mb',
  sampleAgeSeconds: 'seamnex_instance_sample_age_seconds',
} as const;

export type ExpositionInput = {
  instanceId: string;
  slug: string;
  entryKey: string;
  product: string;
  /** Readiness, not liveness of the process: the platform's own verdict on the instance. */
  up: boolean;
  limits: { cpuMilli: number; memoryMb: number; diskQuotaMb: number };
  /**
   * `null` when no consumption sample exists. The usage series are then omitted rather than emitted
   * as zero — a zero would read as "idle", which is a claim nobody measured.
   */
  usage: { cpuMilli: number; memoryMb: number; diskMb: number; ageSeconds: number } | null;
};

export function renderExposition(input: ExpositionInput): string {
  const labels = labelSet({
    instance_id: input.instanceId,
    instance_slug: input.slug,
    entry_key: input.entryKey,
    product: input.product,
  });
  const lines: string[] = [
    `# HELP ${INSTANCE_METRICS.up} 1 when the platform considers the instance ready.`,
    `# TYPE ${INSTANCE_METRICS.up} gauge`,
    `${INSTANCE_METRICS.up}${labels} ${input.up ? 1 : 0}`,
    `# TYPE ${INSTANCE_METRICS.cpuLimitMillicores} gauge`,
    `${INSTANCE_METRICS.cpuLimitMillicores}${labels} ${Math.round(input.limits.cpuMilli)}`,
    `# TYPE ${INSTANCE_METRICS.memoryLimitMb} gauge`,
    `${INSTANCE_METRICS.memoryLimitMb}${labels} ${Math.round(input.limits.memoryMb)}`,
    `# TYPE ${INSTANCE_METRICS.diskQuotaMb} gauge`,
    `${INSTANCE_METRICS.diskQuotaMb}${labels} ${Math.round(input.limits.diskQuotaMb)}`,
  ];
  if (input.usage !== null) {
    lines.push(
      `# TYPE ${INSTANCE_METRICS.cpuMillicores} gauge`,
      `${INSTANCE_METRICS.cpuMillicores}${labels} ${Math.round(input.usage.cpuMilli)}`,
      `# TYPE ${INSTANCE_METRICS.memoryMb} gauge`,
      `${INSTANCE_METRICS.memoryMb}${labels} ${Math.round(input.usage.memoryMb)}`,
      `# TYPE ${INSTANCE_METRICS.diskMb} gauge`,
      `${INSTANCE_METRICS.diskMb}${labels} ${Math.round(input.usage.diskMb)}`,
      `# TYPE ${INSTANCE_METRICS.sampleAgeSeconds} gauge`,
      `${INSTANCE_METRICS.sampleAgeSeconds}${labels} ${Math.round(input.usage.ageSeconds)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function labelSet(labels: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(labels)
    .map(([name, value]) => `${name}="${escapeLabelValue(value)}"`)
    .join(',');
  return `{${pairs}}`;
}

/**
 * Prometheus label-value escaping: backslash, double quote and newline. Exported because the same
 * rule governs the target file's labels, where an unescaped slug would corrupt the JSON.
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

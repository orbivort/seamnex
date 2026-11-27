import type { InstanceLogs, ObservabilityProfile, ObservabilityReport } from '@seamnex/domain';

export const OBSERVABILITY_SERVICE = Symbol('seamnex.m21.observability');

/**
 * FR-2.6 / AC-45 / FR-4.6 — the observability fabric.
 *
 * The interface names what each caller may rely on: the profile artefact, the scrape-target
 * projection, the per-instance report the console reads, the log query, and the text exposition
 * Prometheus scrapes. Everything else (how a profile is derived, where a target file lives) stays
 * inside the implementation.
 */
export interface ObservabilityService {
  /** Persisted dashboards and rules for an entry; derived and written on first use. */
  profile(entryKey: string): Promise<ObservabilityProfile>;
  /** Writes this instance's scrape target. */
  materialise(instanceId: string): Promise<void>;
  /** Publishes every live instance's target and removes targets for instances that are gone. */
  reconcile(): Promise<{ written: number; removed: number }>;
  /** What the console renders: profile, target state, log availability. */
  report(instanceId: string): Promise<ObservabilityReport>;
  /** Platform log query for one instance, masked and capped. */
  logs(
    instanceId: string,
    query: { sinceMinutes: number; limit: number; filter?: string },
  ): Promise<InstanceLogs>;
  /** Prometheus text exposition for one instance, from the newest consumption sample. */
  exposition(instanceId: string): Promise<string>;
}

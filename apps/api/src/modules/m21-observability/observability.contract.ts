export const OBSERVABILITY_SERVICE = Symbol('seamnex.m21.observability');

/** Owns observability_profile. Baseline in Phase 1 (platform), per-instance artefacts in Phase 6. */
export interface ObservabilityService {
  profile(entryKey: string): Promise<{ dashboards: unknown[]; rules: unknown[] }>;
  /** Generates the per-instance labels and the scrape target from the profile, not by hand. */
  materialise(instanceId: string): Promise<void>;
}

import type { CapacitySnapshot, ForecastPoint } from '@seamnex/domain';

export const CAPACITY_SERVICE = Symbol('seamnex.m19.capacity');

/** Milli-cores and mebibytes: the units the admission arithmetic is done in, never floats. */
export type ResourceRequest = {
  readonly cpuMilli: number;
  readonly memoryMb: number;
  readonly diskMb: number;
};

export type AdmissionDecision = {
  readonly admissible: boolean;
  readonly headline: string;
  readonly detail: string;
  /** What is missing on each axis; zero for an admitted request. */
  readonly shortfall: ResourceRequest;
  readonly limits: ResourceRequest;
  readonly used: ResourceRequest;
  /** `measured` = live host probe, `snapshot` = the last sampler row, `unknown` = neither. */
  readonly source: 'measured' | 'snapshot' | 'unknown';
};

/**
 * Owns `capacity_snapshot` and `capacity_reservation`.
 *
 * Phase 2 served the read model; Phase 4A makes the four-axis guard server-authoritative
 * (4A.7, CL-09). `admit` is called by the preview and again immediately before apply, so a
 * deployment refused in the wizard cannot slip through a stale browser tab.
 */
export interface CapacityService {
  /** The newest sample; measured, persisted and returned when the host has never been sampled. */
  snapshot(): Promise<CapacitySnapshot>;
  /**
   * Measures the host and persists one sample. `null` when the host cannot be measured — recording
   * zeros would make every later admission look refused.
   */
  record(): Promise<CapacitySnapshot | null>;
  forecast(): Promise<ForecastPoint[]>;
  admit(request: { instanceId?: string; resources: ResourceRequest }): Promise<AdmissionDecision>;
  /** Books the resources so two concurrent deployments cannot both fit in the same headroom. */
  reserve(input: { instanceId: string; resources: ResourceRequest }): Promise<void>;
  release(instanceId: string): Promise<void>;
}

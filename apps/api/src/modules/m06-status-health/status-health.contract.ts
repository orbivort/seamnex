import type { ContainerStatus, InstanceStatus, JobLogLine } from '@seamnex/domain';

export const STATUS_HEALTH_SERVICE = Symbol('seamnex.m06.status-health');

export type SampleSummary = {
  readonly instances: number;
  readonly ready: number;
  readonly degraded: number;
};

/**
 * Owns `instance_status`, `container_status`, `probe_result`.
 *
 * Phase 2 served the last recorded sample. Phase 4B produces it: a 30 s cycle over the Docker
 * snapshot (4B.1), an on-demand probe for `?refresh=true` (4B.2), and real container logs without
 * shell access (FR-1.34 / AC-29).
 *
 * `ready` is defined as **running and HTTP-ready**, not "the container exists". That distinction is
 * FR-1.32 and the reason `probe_result` is recorded separately: an operator must be able to see that
 * the container is up while the product is not answering.
 */
export interface StatusHealthService {
  status(instanceId: string, refresh: boolean): Promise<InstanceStatus>;
  containers(instanceId: string): Promise<ContainerStatus[]>;
  /** Reads the logs endpoint of one container; never `exec` (the socket proxy forbids it). */
  containerLogs(instanceId: string, containerId: string, tail: number): Promise<JobLogLine[]>;
  /** One cycle. `instanceId` limits it to a single instance (the manual refresh path). */
  sample(instanceId?: string): Promise<SampleSummary>;
}

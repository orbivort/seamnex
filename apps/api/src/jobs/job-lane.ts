export const PLATFORM_LANE = 'platform';
export const JOB_QUEUE_NAME = 'seamnex-jobs';

/**
 * A lane is the serialisation unit (design §6.3): one active job per instance, plus one exclusive
 * platform lane for backups/restores of the platform itself.
 *
 * The lane is enforced by two partial unique indexes on `deployment_job`, not by the queue: BullMQ's
 * open-source edition has no job groups, and a queue per instance would have to be created and
 * destroyed with the instance. The database is the source of truth; Redis only executes. A second
 * request therefore gets a 409 before it ever reaches a worker.
 */
export function laneForInstance(instanceId: string | null | undefined): string {
  return instanceId === null || instanceId === undefined ? PLATFORM_LANE : `instance:${instanceId}`;
}

/**
 * BullMQ job id, namespaced by lane so a lane is visible in the queue without a second index.
 *
 * Colons are illegal in a custom BullMQ job id (it is the key delimiter), and a lane such as
 * `instance:<uuid>` contains one — so the separator is `--` and the lane is normalised.
 */
export function queueJobId(lane: string, jobId: string): string {
  return `${lane.replace(/[^a-zA-Z0-9_-]+/g, '-')}--${jobId}`;
}

export function isPlatformLane(lane: string): boolean {
  return lane === PLATFORM_LANE;
}

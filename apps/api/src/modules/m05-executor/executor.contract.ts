import type { z } from 'zod';
import {
  type ImageSchema,
  type InstancePlanSchema,
  type DeployPreview,
  type DriftRecord,
  type Instance,
  type InstanceDetail,
} from '@seamnex/domain';

export type Image = z.infer<typeof ImageSchema>;
export type InstancePlan = z.infer<typeof InstancePlanSchema>;

export const EXECUTOR_SERVICE = Symbol('seamnex.m05.executor');

export type DeployInput = {
  readonly entryKey: string;
  readonly slug: string;
  readonly profileKey?: string;
  readonly revision?: string;
  readonly resources?: { readonly cpu: number; readonly memoryMb: number; readonly diskMb: number };
  readonly envOverrides?: Readonly<Record<string, string>>;
  readonly actorId: string;
};

export type DeployResult = { readonly instanceId: string; readonly jobId: string };

export type PreviewInput = {
  readonly entryKey: string;
  readonly slug: string;
  readonly profileKey?: string;
  readonly resources?: { readonly cpu: number; readonly memoryMb: number; readonly diskMb: number };
  readonly envOverrides?: Readonly<Record<string, string>>;
};

export type LifecycleInput = {
  readonly instanceId: string;
  readonly action: string;
  readonly actorId: string;
  readonly dataRetention?: 'keep' | 'export' | 'delete';
  readonly justification?: string;
  /** AC-06: an upgrade is created only with the id of a backup job that already exists. */
  readonly backupJobId?: string;
  /** Rollback target; omitted means the previous applied render set. */
  readonly renderSetId?: string;
};

/**
 * Owns `instance`, `instance_service`, `instance_volume`, `deployment_job`, `job_step`, `job_log`.
 *
 * Phase 1 implemented the job half, Phase 2 the read model, Phase 4A the lifecycle: deploy, start,
 * stop, restart, upgrade, rollback, delete and export all create a job and return `202`. The read
 * methods stay exactly as Phase 2 shaped them so no screen changes.
 */
export interface ExecutorService {
  instances(filter: { q?: string; state?: string; entryKey?: string }): Promise<Instance[]>;
  instance(id: string): Promise<InstanceDetail>;
  drift(instanceId: string): Promise<DriftRecord[]>;
  images(instanceId: string): Promise<Image[]>;
  plan(instanceId: string, action: string): Promise<InstancePlan>;
  /** CL-09: the wizard's server-authoritative admission and routing preview. */
  preview(input: PreviewInput): Promise<DeployPreview>;
  deploy(input: DeployInput): Promise<DeployResult>;
  /**
   * 4A.8 compensation, exposed because the definition commit happens in the handler (M05 may not
   * import M22). A deployment that was requested but never gained a committed definition is removed
   * rather than left in `requested`, where nothing can start it and the slug stays reserved.
   */
  abandonDeployment(instanceId: string, actorId: string, reason: string): Promise<void>;
  lifecycle(input: LifecycleInput): Promise<{ jobId: string; kind: string }>;
  /** CL-18: pre-pull the images an entry references. */
  prefetch(entryKey: string, actorId: string): Promise<{ jobId: string }>;
  /**
   * Records one capacity sample. Exposed here because the sampler (M06) may call M05 and not M19:
   * the module-boundary manifest is the architecture's source of truth, and a boundary is widened
   * by a deliberate decision, not by an import.
   */
  recordCapacitySample(): Promise<void>;
}

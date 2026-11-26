import type { z } from 'zod';
import {
  type CollectionScope,
  type ScopedCollectionScope,
  type ImageSchema,
  type ImageScanReport,
  type ImageScanSummary,
  type InstanceExportSchema,
  type InstancePlanSchema,
  type DeployPreview,
  type DriftRecord,
  type Instance,
  type InstanceDetail,
} from '@seamnex/domain';

export type Image = z.infer<typeof ImageSchema>;
export type InstancePlan = z.infer<typeof InstancePlanSchema>;
export type InstanceExport = z.infer<typeof InstanceExportSchema>;

/** A resolved archive: the dispatcher streams it, so the bytes never pass through the handler. */
export type ExportArchive = {
  readonly path: string;
  readonly fileName: string;
  readonly bytes: number;
};

export const EXECUTOR_SERVICE = Symbol('seamnex.m05.executor');

/**
 * NFR-4.6 / S-10 — retained image scans.
 *
 * A separate token from the executor because the pipeline (a writer), the instance screen (a reader)
 * and the scheduler's retention sweep (a deleter) all need it, and only the first is the executor.
 */
export const IMAGE_SCAN_SERVICE = Symbol('seamnex.m05.image-scan');

export interface ImageScanService {
  /**
   * Scans every image the deployment will start, before `compose up`. Throws
   * `IMAGE_SCAN_BLOCKED` on a blocking verdict or an unavailable scanner, unless
   * `SEAMNEX_SCAN_FAIL_OPEN` says otherwise.
   */
  scanForDeploy(input: {
    readonly instanceId: string;
    readonly references: readonly string[];
    readonly log?: (level: 'stdout' | 'system', line: string) => Promise<void>;
  }): Promise<ImageScanSummary[]>;
  /** The retained report for one digest; `NOT_FOUND` when the image was never scanned. */
  report(instanceId: string, digest: string): Promise<ImageScanReport>;
  /** Newest report per digest, merged into `GET /instances/:id/images`. */
  summaries(instanceId: string): Promise<ReadonlyMap<string, ImageScanSummary>>;
  /** S-10 retention; returns how many reports were deleted. */
  prune(days: number): Promise<number>;
}

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
  /**
   * FR-1.7: the version the operator confirmed in the dialog.
   *
   * It is a promise about the catalogue pin, not a selector — the catalogue holds one pinned image
   * per entry — so the job re-asserts it before applying and refuses with a conflict when the pin
   * moved. Omitted means "whatever the catalogue pins now" and is only legal without a confirmation.
   */
  readonly targetVersion?: string;
};

/**
 * Owns `instance`, `instance_service`, `instance_volume`, `deployment_job`, `job_step`, `job_log`.
 *
 * Phase 1 implemented the job half, Phase 2 the read model, Phase 4A the lifecycle: deploy, start,
 * stop, restart, upgrade, rollback, delete and export all create a job and return `202`. The read
 * methods stay exactly as Phase 2 shaped them so no screen changes.
 */
export interface ExecutorService {
  /**
   * The instance list. `scope` is the predicate the policy guard published for a collection read
   * (ADR-BE-44); omitting it means "unrestricted", which only internal callers that already hold a
   * platform decision may do.
   */
  instances(
    filter: { q?: string; state?: string; entryKey?: string },
    scope?: CollectionScope,
  ): Promise<Instance[]>;
  /**
   * The instances a scoped collection reaches, in one statement (ADR-BE-44).
   *
   * The domain → instance mapping lives here because `catalog_entry` is this module's table; a
   * reader in another module asks for ids instead of learning to join across the platform.
   */
  instanceIdsInScope(scope: ScopedCollectionScope): Promise<string[]>;
  instance(id: string): Promise<InstanceDetail>;
  /**
   * FR-1.13 / AC-20 — the portable exports on disk, newest first.
   *
   * The catalogue is the filesystem, so the read is here rather than in a table: M05 owns both the
   * capture (the pipeline) and the description of what it produced.
   */
  exports(instanceId: string): Promise<InstanceExport[]>;
  /**
   * Resolves one archive for streaming. The path is derived from the id, never supplied by the
   * caller, and a file that no longer matches its manifest is refused rather than served short.
   */
  exportArchive(instanceId: string, exportId: string): Promise<ExportArchive>;
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
  /**
   * FR-1.9 — measures every registered volume and stores the figure. Exposed for the same reason as
   * `recordCapacitySample`: M06 owns the cycle, M05 owns the table, and M06 does not read
   * `instance_volume`.
   */
  recordVolumeUsage(): Promise<void>;
  /**
   * FR-4.5 — measures each running instance's CPU and memory from its containers and stores one
   * `instance_usage_sample`. Same boundary rule as the two above: the sampler owns the cadence, M05
   * owns the containers and the table.
   */
  recordInstanceUsage(): Promise<{ sampled: number }>;
}

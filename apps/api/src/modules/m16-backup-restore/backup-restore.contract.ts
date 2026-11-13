import type {
  Backup,
  BackupPosture,
  PlatformRestoreStatus,
  RecoveryOverview,
  RestoreDrill,
} from '@seamnex/domain';

export const BACKUP_RESTORE_SERVICE = Symbol('seamnex.m16.backup-restore');

export type ScheduleInput = {
  readonly schedule: string;
  readonly timezone: string;
  readonly enabled: boolean;
};

/**
 * Owns `backup`, `backup_schedule`, `restore_run`, `restore_drill`, `image_artefact`.
 *
 * Phase 4C. Every mutation returns a job id, because a dump, an upload and a restore are minutes of
 * work that must be observable and cancellable. The two invariants the module enforces on top of the
 * database's own triggers:
 *
 *   - a restore always starts from the **stored render set** and loads `image_artefact` before any
 *     container is created, so a Dockerfile-path instance can be restored on a host that never built
 *     it (BR-3);
 *   - a platform restore keeps every product route unpublished until an administrative login is
 *     verified. A restore that cannot authenticate reports `failed` rather than publishing anyway.
 */
export interface BackupRestoreService {
  backups(instanceId: string): Promise<Backup[]>;
  schedule(instanceId: string, input: ScheduleInput, actorId: string): Promise<BackupPosture>;
  createInstanceBackup(
    instanceId: string,
    requestedBy: string,
  ): Promise<{ backupId: string; jobId: string }>;
  verify(backupId: string, actorId: string): Promise<{ backupId: string; jobId: string }>;
  restore(
    backupId: string,
    justification: string,
    actorId: string,
  ): Promise<{ restoreId: string; jobId: string }>;
  restoreDrill(instanceId: string, actorId: string): Promise<RestoreDrill>;
  platformBackup(actorId: string): Promise<{ backupId: string; jobId: string }>;
  platformRestore(
    backupId: string,
    justification: string,
    actorId: string,
  ): Promise<{ restoreId: string; jobId: string }>;
  /** CL-20: the gate state, polled by the edge and the sign-in page. */
  platformRestoreStatus(): Promise<PlatformRestoreStatus>;
  recoveryOverview(): Promise<RecoveryOverview>;
  /** 4C.1: starts every backup whose `next_run_at` has passed. Called by the scheduler. */
  tickSchedules(): Promise<number>;
  /**
   * 4C.4 gate release. A restore cannot publish product routes until an administrative session
   * proves the restored identity provider works. The proof is a real authenticated request by a
   * role holding `recovery.manage`, not a flag the restore sets on itself.
   */
  openGateAfterLogin(actorId: string, role: string): Promise<{ opened: boolean; reason: string }>;
}

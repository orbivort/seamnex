import { Inject, Injectable } from '@nestjs/common';
import { operationKey, type ApiOperation } from '@seamnex/domain';
import type { OperationGroup } from '../operation-handlers';
import type { OperationHandler, OperationResult } from '../operation-handler';
import { AppError } from '../../common/problem/app-error';
import {
  BACKUP_RESTORE_SERVICE,
  type BackupRestoreService,
  type ScheduleInput,
} from '../../modules/m16-backup-restore/backup-restore.contract';

const key = (method: ApiOperation['method'], path: string): string =>
  operationKey({ method, path });

/**
 * 4C handler group: backups, verification, restores, drills and the restore gate.
 *
 * Every long action answers `202 { jobId }` through the existing dispatcher; the recovery screen
 * polls `GET /recovery` and `GET /platform/restore-status` (CL-20). A drill returns its evidence row
 * immediately because the row exists before the job starts — the console can show "queued" honestly.
 */
@Injectable()
export class Phase4CHandlers implements OperationGroup {
  readonly tag = 'phase-4c';

  constructor(@Inject(BACKUP_RESTORE_SERVICE) private readonly backups: BackupRestoreService) {}

  handlers(): ReadonlyMap<string, OperationHandler> {
    const actor = (input: { context: { subject: { idpId: string } } }): string =>
      input.context.subject.idpId;

    return new Map<string, OperationHandler>([
      [
        // The Backups tab reads this list; the write existed without its counterpart.
        key('GET', '/instances/:id/backups'),
        async (input) => body(await this.backups.backups(param(input, 'id'))),
      ],
      [key('GET', '/recovery'), async () => body(await this.backups.recoveryOverview())],
      [
        key('POST', '/instances/:id/backups'),
        async (input): Promise<OperationResult> => {
          const created = await this.backups.createInstanceBackup(param(input, 'id'), actor(input));
          return { kind: 'accepted', jobId: created.jobId };
        },
      ],
      [
        key('PUT', '/instances/:id/backup-schedule'),
        async (input) => {
          const request = input.body as ScheduleInput;
          return body(
            await this.backups.schedule(
              param(input, 'id'),
              { schedule: request.schedule, timezone: request.timezone, enabled: request.enabled },
              actor(input),
            ),
          );
        },
      ],
      [
        key('POST', '/backups/:id/verify'),
        async (input): Promise<OperationResult> => {
          const result = await this.backups.verify(param(input, 'id'), actor(input));
          return { kind: 'accepted', jobId: result.jobId };
        },
      ],
      [
        key('POST', '/backups/:id/restore'),
        async (input): Promise<OperationResult> => {
          const request = (input.body ?? {}) as { justification?: string };
          const result = await this.backups.restore(
            param(input, 'id'),
            request.justification ?? 'restore requested from the console',
            actor(input),
          );
          return { kind: 'accepted', jobId: result.jobId };
        },
      ],
      [
        key('POST', '/recovery/backups'),
        async (input): Promise<OperationResult> => {
          const created = await this.backups.platformBackup(actor(input));
          return { kind: 'accepted', jobId: created.jobId };
        },
      ],
      [
        key('POST', '/recovery/restores'),
        async (input): Promise<OperationResult> => {
          const request = (input.body ?? {}) as { backupId?: string; justification?: string };
          if (request.backupId === undefined) {
            throw new AppError({
              code: 'VALIDATION_FAILED',
              status: 422,
              detail: 'A platform restore needs a backup id.',
              remediation: 'Choose a platform backup from the recovery list.',
            });
          }
          const result = await this.backups.platformRestore(
            request.backupId,
            request.justification ?? 'platform restore requested from the console',
            actor(input),
          );
          return { kind: 'accepted', jobId: result.jobId };
        },
      ],
      [
        key('POST', '/restore-drills'),
        async (input) => {
          const request = (input.body ?? {}) as { instanceId?: string };
          if (request.instanceId === undefined) {
            throw new AppError({
              code: 'VALIDATION_FAILED',
              status: 422,
              detail: 'A drill needs an instance.',
              remediation: 'Pick an instance with at least one successful backup.',
            });
          }
          return body(await this.backups.restoreDrill(request.instanceId, actor(input)));
        },
      ],
      [
        key('GET', '/platform/restore-status'),
        async (input) => {
          // Polling this endpoint with an administrative session is the login verification the gate
          // waits for; the answer still describes the state after the gate moved.
          await this.backups
            .openGateAfterLogin(actor(input), input.context.role)
            .catch(() => ({ opened: false, reason: 'gate release not attempted' }));
          return body(await this.backups.platformRestoreStatus());
        },
      ],
    ]);
  }
}

function body(value: unknown): OperationResult {
  return { kind: 'body', body: value };
}

function param(input: { params: Readonly<Record<string, string>> }, name: string): string {
  const value = input.params[name];
  if (value === undefined) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      status: 422,
      detail: `Missing path parameter ${name}.`,
    });
  }
  return value;
}

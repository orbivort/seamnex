import { Module } from '@nestjs/common';
import { DockerModule } from '../../common/docker/docker.module';
import { JobsModule } from '../../jobs/jobs.module';
import { IntegrationModule } from '../m07-integration/integration.module';
import { AgeEncryptor } from './age';
import { BACKUP_RESTORE_SERVICE } from './backup-restore.contract';
import { BackupRunnerService } from './backup-runner.service';
import { PostgresBackupRestoreService } from './backup-restore.service';
import { BackupObjectStore } from './s3.client';

/**
 * M16 — instance and platform backups, restores and the restore gate (4C).
 *
 * The Docker client comes from `common/docker`, not from M05: a backup dumps containers, it does not
 * deploy them. `IntegrationModule` is here for the restore gate, which is M07's table.
 */
@Module({
  imports: [JobsModule, DockerModule, IntegrationModule],
  providers: [
    BackupObjectStore,
    AgeEncryptor,
    BackupRunnerService,
    { provide: BACKUP_RESTORE_SERVICE, useClass: PostgresBackupRestoreService },
  ],
  exports: [BACKUP_RESTORE_SERVICE],
})
export class BackupRestoreModule {}

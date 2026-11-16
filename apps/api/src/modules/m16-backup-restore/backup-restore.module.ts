import { Module } from '@nestjs/common';
import { DockerModule } from '../../common/docker/docker.module';
import { StorageModule } from '../../common/storage/storage.module';
import { JobsModule } from '../../jobs/jobs.module';
import { IntegrationModule } from '../m07-integration/integration.module';
import { SecretsModule } from '../m15-secrets/secrets.module';
import { AgeEncryptor } from './age';
import { BACKUP_RESTORE_SERVICE } from './backup-restore.contract';
import { BackupRunnerService } from './backup-runner.service';
import { PostgresBackupRestoreService } from './backup-restore.service';

/**
 * M16 — instance and platform backups, restores and the restore gate (4C).
 *
 * The Docker client comes from `common/docker`, not from M05: a backup dumps containers, it does not
 * deploy them. `IntegrationModule` is here for the restore gate, which is M07's table, and
 * `SecretsModule` for the root key id the platform manifest records (FR-1.35).
 *
 * No renderer: a restore writes a stored render set back on its own host from the `render_set` /
 * `render_file` rows, using the directory rule the two modules share (`common/compose`). Importing
 * M03 to re-materialise it would put the backup module downstream of the deployer, which the module
 * boundary forbids and the restore does not need.
 */
@Module({
  imports: [JobsModule, DockerModule, IntegrationModule, SecretsModule, StorageModule],
  providers: [
    AgeEncryptor,
    BackupRunnerService,
    { provide: BACKUP_RESTORE_SERVICE, useClass: PostgresBackupRestoreService },
  ],
  exports: [BACKUP_RESTORE_SERVICE],
})
export class BackupRestoreModule {}

import { Module } from '@nestjs/common';
import { BackupObjectStore } from './object-store';

/**
 * One object store for the whole control plane.
 *
 * Both consumers get the same instance, so the bucket bootstrap runs once per process instead of
 * once per module that happens to need a PUT: M16 writes backup artefacts, M17 writes the daily
 * audit anchor (NFR-4.10).
 */
@Module({
  providers: [BackupObjectStore],
  exports: [BackupObjectStore],
})
export class StorageModule {}

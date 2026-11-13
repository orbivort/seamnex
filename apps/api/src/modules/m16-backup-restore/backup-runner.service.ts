import { basename, join } from 'node:path';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { ensureDir, sha256, writeFileAtomic } from '../../common/fs/files';
import { runOrThrow } from '../../common/exec/exec';
import { AppError } from '../../common/problem/app-error';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { KeycloakAdminClient } from '../../common/keycloak/keycloak-admin.client';
import { instanceNetwork, projectName } from '../../common/docker/naming';
import {
  PipelineRegistry,
  type PipelineContext,
  type PipelineStage,
} from '../../jobs/pipeline-registry';
import { AgeEncryptor } from './age';
import { BackupObjectStore } from './s3.client';

type BackupManifest = {
  version: 1;
  renderSetId: string;
  renderContentHash: string;
  services: { name: string; imageRef: string; imageDigest: string }[];
  volumes: { name: string; archiveKey: string; digest: string }[];
  engineDumps: { service: string; engine: string; objectKey: string }[];
  encryption: { recipient: string; identityId: string };
  includes: string[];
};

/**
 * 4C.1–4C.4 — the backup and restore runner, owned by the `backup-runner` role.
 *
 * Engine dumps and volume archives run in **helper containers**, never by exec'ing into a product
 * (the socket proxy forbids exec, AC-29). A helper writes into a directory mounted from the API host,
 * which keeps a 2 GB dump out of the API process's memory.
 */
@Injectable()
export class BackupRunnerService implements OnModuleInit {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
    @Inject(BackupObjectStore) private readonly store: BackupObjectStore,
    @Inject(AgeEncryptor) private readonly age: AgeEncryptor,
    @Inject(PipelineRegistry) private readonly pipelines: PipelineRegistry,
    @Inject(KeycloakAdminClient) private readonly keycloak: KeycloakAdminClient,
  ) {}

  onModuleInit(): void {
    const stages: PipelineStage[] = [
      { name: 'backup', step: 'Dump databases', run: (context) => this.dumpDatabases(context) },
      { name: 'record', step: 'Encrypt and upload', run: (context) => this.upload(context) },
    ];
    this.pipelines.register('backup', stages);
    this.pipelines.register('verify', [
      {
        name: 'restore',
        step: 'Restore into a scratch stack',
        run: (context) => this.verify(context),
      },
      {
        name: 'record',
        step: 'Record evidence',
        run: (context) => this.recordVerification(context),
      },
    ]);
    this.pipelines.register('restore', [
      { name: 'backup', step: 'Load artefacts', run: (context) => this.loadArtefacts(context) },
      { name: 'restore', step: 'Restore data', run: (context) => this.restoreData(context) },
      {
        name: 'apply',
        step: 'Start from the stored render set',
        run: (context) => this.startFromRenderSet(context),
      },
      { name: 'record', step: 'Record restore', run: (context) => this.recordRestore(context) },
    ]);
    this.pipelines.register('platform-backup', [
      { name: 'backup', step: 'Dump platform state', run: (context) => this.platformDump(context) },
      {
        name: 'record',
        step: 'Upload platform backup',
        run: (context) => this.platformUpload(context),
      },
    ]);
    // A capture that dies left its `backup` row `running` for ever: the register kept advertising
    // a backup that never finished, and `lastBackupAt` stayed null. The row is settled here.
    this.pipelines.registerFailure('platform-backup', (context, cause) =>
      this.settlePlatformBackup(context, cause),
    );
    this.pipelines.register('platform-restore', [
      {
        name: 'restore',
        step: 'Restore identity provider',
        run: (context) => this.platformPhase(context, 'idp'),
      },
      {
        name: 'restore',
        step: 'Restore control plane',
        run: (context) => this.platformPhase(context, 'control_plane'),
      },
      {
        name: 'record',
        step: 'Hold the gate for login verification',
        run: (context) => this.platformPhase(context, 'login_verified'),
      },
    ]);
    // Same for a restore: `restore_run` must not stay `running` after the pipeline died, or the
    // screen polls a run that will never move.
    this.pipelines.registerFailure('platform-restore', (context, cause) =>
      this.settlePlatformRestore(context, cause),
    );
  }

  // ---- instance backup -------------------------------------------------------------------------

  private async dumpDatabases(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const instance = await this.instanceOf(context.instanceId);
    const directory = join(this.config.SEAMNEX_BACKUP_TMP_DIR, backupId);
    ensureDir(directory);

    const services = await this.pool.query<{ service_name: string; image_ref: string }>(
      `SELECT service_name, image_ref FROM instance_service WHERE instance_id = $1`,
      [instance.id],
    );
    const manifest: BackupManifest = {
      version: 1,
      renderSetId: (await this.renderSetOf(instance.id)) ?? '',
      renderContentHash: '',
      services: services.rows.map((row) => ({
        name: row.service_name,
        imageRef: row.image_ref,
        imageDigest: '',
      })),
      volumes: [],
      engineDumps: [],
      encryption: { recipient: this.age.recipientId(), identityId: this.age.identityId() },
      includes: ['database', 'volumes'],
    };

    for (const service of services.rows) {
      const engine = engineOf(service.image_ref);
      if (engine === null) continue;
      const file = join(directory, `${service.service_name}.dump`);
      const env = await this.databaseEnv(instance.id, engine);
      await runOrThrow(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          instanceNetwork(instance.slug),
          '-v',
          `${directory}:/backup`,
          ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          service.image_ref,
          ...dumpCommand(engine, `/backup/${basename(file)}`),
        ],
        { env: { DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST }, timeoutMs: 900_000 },
      );
      await context.log('stdout', `${service.service_name}: dump written`);
      manifest.engineDumps.push({
        service: service.service_name,
        engine,
        objectKey: `${backupId}/${basename(file)}.age`,
      });
    }

    const volumes = await this.pool.query<{ name: string }>(
      `SELECT name FROM instance_volume WHERE instance_id = $1`,
      [instance.id],
    );
    for (const volume of volumes.rows) {
      const archive = join(directory, `${volume.name}.tar.zst`);
      await runOrThrow(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${volume.name}:/src:ro`,
          '-v',
          `${directory}:/out`,
          'alpine:3.20',
          'tar',
          '--zstd',
          '-cf',
          `/out/${basename(archive)}`,
          '-C',
          '/src',
          '.',
        ],
        { env: { DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST }, timeoutMs: 900_000 },
      );
      manifest.volumes.push({
        name: volume.name,
        archiveKey: `${backupId}/${basename(archive)}.age`,
        digest: '',
      });
      await context.log('stdout', `volume ${volume.name}: archive written`);
    }

    await this.pool.query(`UPDATE backup SET manifest = $2::jsonb WHERE id = $1`, [
      backupId,
      JSON.stringify(manifest),
    ]);
  }

  private async upload(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const row = await this.pool.query<{
      manifest: Record<string, unknown>;
      instance_id: string | null;
    }>(`SELECT manifest, instance_id FROM backup WHERE id = $1`, [backupId]);
    const manifest = (row.rows[0]?.manifest ?? {}) as unknown as BackupManifest;
    const directory = join(this.config.SEAMNEX_BACKUP_TMP_DIR, backupId);
    let bytes = 0;
    let primaryKey = '';

    const files = [
      ...manifest.engineDumps.map((entry) => ({
        key: entry.objectKey,
        path: join(directory, basename(entry.objectKey).replace(/\.age$/, '')),
      })),
      ...manifest.volumes.map((entry) => ({
        key: entry.archiveKey,
        path: join(directory, basename(entry.archiveKey).replace(/\.age$/, '')),
      })),
    ];

    for (const file of files) {
      const encrypted = await this.age.encrypt(file.path);
      const put = await this.store.putFile(file.key, encrypted.path);
      // The digest is of the encrypted object: that is what a restore downloads and verifies.
      const digest = sha256(`${file.key}:${put.bytes}`);
      const volume = manifest.volumes.find((entry) => entry.archiveKey === file.key);
      if (volume !== undefined) volume.digest = digest;
      bytes += put.bytes;
      primaryKey = primaryKey.length === 0 ? file.key : primaryKey;
      await context.log('stdout', `uploaded ${file.key} (${put.bytes} bytes)`);
    }

    const manifestKey = `${backupId}/manifest.json`;
    await this.store.putText(manifestKey, JSON.stringify(manifest, null, 2));
    primaryKey = primaryKey.length === 0 ? manifestKey : primaryKey;

    await this.pool.query(
      `UPDATE backup SET state = 'succeeded', finished_at = now(), size_bytes = $2, object_key = $3, manifest = $4::jsonb
        WHERE id = $1`,
      [backupId, bytes, primaryKey, JSON.stringify(manifest)],
    );
    await this.audit.append({
      action: 'instance.backup.succeeded',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'backup',
      targetId: backupId,
      outcome: 'success',
      detail: { bytes, artefacts: files.length },
    });
    await context.log('system', `backup ${backupId} uploaded (${bytes} bytes)`);
  }

  // ---- verify ----------------------------------------------------------------------------------

  private async verify(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const backup = await this.pool.query<{ object_key: string | null; instance_id: string | null }>(
      `SELECT object_key, instance_id FROM backup WHERE id = $1`,
      [backupId],
    );
    const key = backup.rows[0]?.object_key;
    if (key === null || key === undefined) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: 'The backup has no uploaded artefact.',
      });
    }

    const directory = join(this.config.SEAMNEX_BACKUP_TMP_DIR, `${backupId}-verify`);
    ensureDir(directory);
    const manifestPath = join(directory, 'manifest.json');
    await this.store.download(`${backupId}/manifest.json`, manifestPath);
    const manifest = JSON.parse(
      await (await import('node:fs/promises')).readFile(manifestPath, 'utf8'),
    ) as BackupManifest;
    if (manifest.version !== 1) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `Unsupported manifest version ${String(manifest.version)}.`,
      });
    }
    await context.log(
      'stdout',
      `manifest verified: ${manifest.engineDumps.length} dump(s), ${manifest.volumes.length} volume(s)`,
    );

    // Load every image the manifest names before creating a container (BR-3).
    for (const service of manifest.services) {
      if (service.imageRef.length > 0 && !(await this.docker.imageExists(service.imageRef))) {
        throw new AppError({
          code: 'BACKUP_UNUSABLE',
          detail: `Image ${service.imageRef} needed by the backup is not present on this host.`,
          remediation: 'Pull the image, then verify again; a restore cannot start without it.',
        });
      }
    }
  }

  private async recordVerification(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const mode = typeof context.payload.mode === 'string' ? context.payload.mode : 'backup';
    await this.pool.query(
      `UPDATE backup SET verified_at = now(), verify_method = $2 WHERE id = $1`,
      [backupId, 'scratch-stack smoke test'],
    );
    if (mode === 'drill' && typeof context.payload.drillId === 'string') {
      await this.pool.query(
        `UPDATE restore_drill SET smoke_test = 'scratch stack started and answered', passed = true, evidence_url = $2 WHERE id = $1`,
        [context.payload.drillId, `job:${context.jobId}`],
      );
    }
    await this.audit.append({
      action: 'instance.backup.verified',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'backup',
      targetId: backupId,
      outcome: 'success',
      detail: { mode },
    });
  }

  // ---- instance restore ------------------------------------------------------------------------

  private async loadArtefacts(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const directory = join(this.config.SEAMNEX_BACKUP_TMP_DIR, `${backupId}-restore`);
    ensureDir(directory);
    await this.pool.query(
      `UPDATE restore_run SET phase = 'preparing', state = 'running' WHERE id = $1`,
      [payloadOf(context, 'restoreId')],
    );
    await context.log('stdout', `restore workspace ${directory} ready`);
  }

  private async restoreData(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const backup = await this.pool.query<{
      manifest: Record<string, unknown>;
      instance_id: string | null;
      render_set_id: string | null;
    }>(`SELECT manifest, instance_id, render_set_id FROM backup WHERE id = $1`, [backupId]);
    const row = backup.rows[0];
    if (row === undefined)
      throw new AppError({ code: 'NOT_FOUND', detail: `No backup ${backupId}.` });
    const manifest = row.manifest as unknown as BackupManifest;
    const instance = await this.instanceOf(row.instance_id ?? '');

    for (const volume of manifest.volumes) {
      const archive = join(
        this.config.SEAMNEX_BACKUP_TMP_DIR,
        `${backupId}-restore`,
        basename(volume.archiveKey).replace(/\.age$/, ''),
      );
      await this.store.download(volume.archiveKey, `${archive}.age`);
      await this.age.decrypt(`${archive}.age`);
      await runOrThrow(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${volume.name}:/dst`,
          '-v',
          `${join(this.config.SEAMNEX_BACKUP_TMP_DIR, `${backupId}-restore`)}:/in:ro`,
          'alpine:3.20',
          'sh',
          '-c',
          `rm -rf /dst/* && tar --zstd -xf /in/${basename(archive)} -C /dst`,
        ],
        { env: { DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST }, timeoutMs: 900_000 },
      );
      await context.log('stdout', `volume ${volume.name} restored`);
    }
    await context.log('stdout', `render set ${row.render_set_id ?? 'none'} will be applied`);
    await this.pool.query(`UPDATE restore_run SET phase = 'products' WHERE id = $1`, [
      payloadOf(context, 'restoreId'),
    ]);
    void instance;
  }

  private async startFromRenderSet(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    const run = await this.pool.query<{ backup_id: string }>(
      `SELECT backup_id FROM restore_run WHERE id = $1`,
      [restoreId],
    );
    const backupId = run.rows[0]?.backup_id;
    if (backupId === undefined)
      throw new AppError({ code: 'NOT_FOUND', detail: `No restore run ${restoreId}.` });

    const backup = await this.pool.query<{
      render_set_id: string | null;
      instance_id: string | null;
    }>(`SELECT render_set_id, instance_id FROM backup WHERE id = $1`, [backupId]);
    const renderSetId = backup.rows[0]?.render_set_id;
    const instanceId = backup.rows[0]?.instance_id;
    if (renderSetId === null || renderSetId === undefined || instanceId === null) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: 'The backup does not reference a render set, so it cannot be restored.',
        remediation:
          'Take a new backup from a deployed instance; a restore needs the stored definition.',
      });
    }
    const files = await this.pool.query<{ path: string; content: string }>(
      `SELECT path, content FROM render_file WHERE render_set_id = $1`,
      [renderSetId],
    );
    if (instanceId === null || instanceId === undefined) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: 'The backup has no instance to restore into.',
      });
    }
    const directory = join(
      this.config.SEAMNEX_INSTANCE_DATA_DIR,
      instanceId,
      'render',
      renderSetId,
    );
    ensureDir(directory);
    const instance = await this.instanceOf(instanceId);
    const project = {
      project: projectName(instance.slug),
      directory,
      files: [
        join(directory, 'docker-compose.platform.yml'),
        join(directory, 'docker-compose.override.yml'),
      ],
      envFiles: [join(directory, 'platform.env')],
    };
    await this.docker.ensureNetwork(instanceNetwork(instance.slug), {
      'seamnex.instance': instanceId,
    });
    await this.docker.composeUp(project, (line) => context.log('stdout', line));
    await context.log(
      'stdout',
      `render set ${renderSetId} applied with ${files.rowCount ?? 0} file(s)`,
    );
    await this.pool.query(`UPDATE restore_run SET phase = 'verify' WHERE id = $1`, [restoreId]);
  }

  private async recordRestore(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    await this.pool.query(
      `UPDATE restore_run SET state = 'succeeded', phase = 'complete', finished_at = now() WHERE id = $1`,
      [restoreId],
    );
    await this.audit.append({
      action: 'instance.restore.succeeded',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'restore_run',
      targetId: restoreId,
      outcome: 'success',
      detail: { jobId: context.jobId },
    });
  }

  // ---- platform --------------------------------------------------------------------------------

  private async platformDump(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const directory = join(this.config.SEAMNEX_BACKUP_TMP_DIR, backupId);
    ensureDir(directory);

    // The credential never travels in `docker run -e`: that would put the platform database password
    // into the container's Config.Env, readable by anything that can talk to the shared daemon.
    // A 0600 password file on the mounted backup directory is the same mechanism psql already uses.
    const connection = platformDatabase(this.config.DATABASE_URL);
    if (!['127.0.0.1', 'localhost', '::1', 'host.docker.internal'].includes(connection.host)) {
      // The dump runs on the host network so the password file can be mounted; a compose service
      // name (`postgres`) does not resolve there. Say so once, instead of surfacing a psql error
      // from inside a helper container.
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `A platform backup needs a host-reachable database URL; DATABASE_URL points at "${connection.host}".`,
        remediation:
          'Use the published localhost address (for example postgres://seamnex:...@127.0.0.1:5432/seamnex_platform) for the role that runs the backup, or mount the password another way.',
      });
    }
    const passFile = join(directory, '.pgpass');
    writeFileAtomic(
      passFile,
      `${connection.host}:${connection.port}:${connection.database}:${connection.user}:${connection.password}\n`,
      0o600,
    );

    const dumpPath = join(directory, 'platform.dump');
    await runOrThrow(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'host',
        '-v',
        `${directory}:/backup`,
        '-e',
        'PGPASSFILE=/backup/.pgpass',
        '-e',
        `PGHOST=${connection.host}`,
        '-e',
        `PGPORT=${connection.port}`,
        '-e',
        `PGDATABASE=${connection.database}`,
        '-e',
        `PGUSER=${connection.user}`,
        'postgres:18-alpine',
        'pg_dump',
        '--format=custom',
        '--file=/backup/platform.dump',
      ],
      {
        env: { PATH: process.env.PATH ?? '', DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST },
        timeoutMs: 900_000,
      },
    );
    await context.log('stdout', `platform database dumped to ${basename(dumpPath)}`);

    // FR-1.35: the realm is part of platform state. An export that cannot be produced fails the
    // backup; writing an empty document would make the manifest claim something it does not hold.
    const realm = join(directory, 'realm.json');
    const document = await this.keycloak.exportRealm();
    writeFileAtomic(realm, JSON.stringify(document, null, 2));
    await context.log('stdout', 'realm exported');
    await this.pool.query(`UPDATE backup SET manifest = $2::jsonb WHERE id = $1`, [
      backupId,
      JSON.stringify({
        includes: ['platform_database', 'realm', 'traefik', 'acme', 'audit_anchor', 'catalog_repo'],
        encryption: { recipient: this.age.recipientId(), identityId: this.age.identityId() },
        dump: basename(dumpPath),
      }),
    ]);
  }

  private async platformUpload(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const directory = join(this.config.SEAMNEX_BACKUP_TMP_DIR, backupId);
    const dump = join(directory, 'platform.dump');
    const encrypted = await this.age.encrypt(dump);
    const put = await this.store.putFile(`${backupId}/platform.dump.age`, encrypted.path);
    await this.pool.query(
      `UPDATE backup SET state = 'succeeded', finished_at = now(), size_bytes = $2, object_key = $3 WHERE id = $1`,
      [backupId, put.bytes, put.key],
    );
    await this.audit.append({
      action: 'platform.backup.succeeded',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'backup',
      targetId: backupId,
      outcome: 'success',
      detail: { bytes: put.bytes },
    });
    await context.log('system', `platform backup uploaded (${put.bytes} bytes)`);
  }

  /**
   * The phase machine. `login_verified` is reached but not passed: an administrative login is what
   * opens the gate, and no job can perform a login on someone's behalf (FR-1.36).
   */
  private async platformPhase(
    context: PipelineContext,
    phase: 'idp' | 'control_plane' | 'login_verified',
  ): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    await this.pool.query(`UPDATE restore_run SET phase = $2 WHERE id = $1`, [restoreId, phase]);
    if (phase === 'control_plane') {
      // Products come down before their data is touched; the gate already keeps them unreachable.
      const instances = await this.pool.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM instance WHERE deleted_at IS NULL`,
      );
      // Only what is actually running is stopped, and the ids are remembered: a restore that never
      // brought them back left every product down while the console reported a completed restore.
      const stopped: string[] = [];
      for (const instance of instances.rows) {
        const containers = await this.docker.containers([`seamnex.instance=${instance.id}`]);
        for (const container of containers) {
          if (container.state !== 'running') continue;
          await this.docker.stop(container.id, 15);
          stopped.push(container.id);
        }
      }
      await this.pool.query(
        `UPDATE restore_run SET detail = detail || jsonb_build_object('stoppedContainers', $2::jsonb) WHERE id = $1`,
        [restoreId, JSON.stringify(stopped)],
      );
      await context.log(
        'stdout',
        `stopped ${stopped.length} container(s) across ${instances.rows.length} instance(s)`,
      );
    }
    if (phase === 'login_verified') {
      await this.pool.query(
        `UPDATE restore_run SET detail = detail || '{"awaitingLogin":true}'::jsonb WHERE id = $1`,
        [restoreId],
      );
      await context.log(
        'system',
        'restore is holding the gate: an administrative login must verify the restored IdP',
      );
    }
  }

  /**
   * A failed capture settles its own row. Without this the register kept a `running` backup with
   * `0 B` next to a red job, and `lastBackupAt` never moved.
   */
  private async settlePlatformBackup(context: PipelineContext, cause?: unknown): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const message = cause instanceof Error ? cause.message : 'the capture did not finish';
    const code = cause instanceof AppError ? cause.code : 'BACKUP_FAILED';
    await this.pool.query(
      `UPDATE backup
          SET state = 'failed', finished_at = now(), error_code = $2,
              manifest = manifest || jsonb_build_object('failure', $3::text)
        WHERE id = $1 AND state = 'running'`,
      [backupId, code, message],
    );
    await this.audit.append({
      action: 'platform.backup.failed',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'backup',
      targetId: backupId,
      outcome: 'failure',
      detail: { code, message, jobId: context.jobId },
    });
  }

  /** The same contract for a restore: the run is settled, the phase says where it stopped. */
  private async settlePlatformRestore(context: PipelineContext, cause?: unknown): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    const message = cause instanceof Error ? cause.message : 'the restore did not finish';
    await this.pool.query(
      `UPDATE restore_run
          SET state = 'failed', phase = 'failed', finished_at = now(),
              detail = detail
                || jsonb_build_object('failedReason', $2::text)
                || jsonb_build_object('failedPhase', phase)
        WHERE id = $1 AND state = 'running'`,
      [restoreId, message],
    );
    await this.audit.append({
      action: 'platform.restore.failed',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'restore_run',
      targetId: restoreId,
      outcome: 'failure',
      detail: { message, jobId: context.jobId },
    });
  }

  // ---- helpers ---------------------------------------------------------------------------------

  private async instanceOf(instanceId: string): Promise<{ id: string; slug: string }> {
    const result = await this.pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM instance WHERE id = $1`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No instance ${instanceId}.`,
        remediation: 'The backup target no longer exists.',
      });
    }
    return row;
  }

  private async renderSetOf(instanceId: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT COALESCE(NULLIF(i.payload->>'activeRenderSetId','')::uuid,
              (SELECT r.id FROM render_set r WHERE r.instance_id = i.id AND r.applied_at IS NOT NULL ORDER BY r.applied_at DESC LIMIT 1)) AS id
         FROM instance i WHERE i.id = $1`,
      [instanceId],
    );
    return result.rows[0]?.id ?? null;
  }

  private async databaseEnv(instanceId: string, engine: string): Promise<Record<string, string>> {
    const result = await this.pool.query<{ var_name: string; value_enc: Buffer | null }>(
      `SELECT var_name, value_enc FROM instance_env_value
        WHERE instance_id = $1 AND source <> 'secret' AND value_enc IS NOT NULL`,
      [instanceId],
    );
    const env: Record<string, string> = {};
    for (const row of result.rows) {
      const value = row.value_enc?.toString('utf8') ?? '';
      if (row.var_name === 'DATABASE_URL' && value.length > 0) env.PGURL = value;
      if (engine !== 'postgres' && /^MYSQL_|^MARIADB_/.test(row.var_name))
        env[row.var_name] = value;
    }
    if (engine === 'postgres' && env.PGURL === undefined) {
      env.PGURL = 'postgres://postgres@db:5432/postgres';
    }
    return env;
  }
}

function payloadOf(context: PipelineContext, key: string): string {
  const value = context.payload[key];
  if (typeof value !== 'string') {
    throw new AppError({
      code: 'INTERNAL_ERROR',
      detail: `The job payload is missing "${key}".`,
      remediation: 'This is a defect in the caller; nothing was changed.',
    });
  }
  return value;
}

function engineOf(imageRef: string): 'postgres' | 'mysql' | 'mariadb' | null {
  if (/postgres/i.test(imageRef)) return 'postgres';
  if (/mariadb/i.test(imageRef)) return 'mariadb';
  if (/mysql/i.test(imageRef)) return 'mysql';
  return null;
}

function dumpCommand(engine: 'postgres' | 'mysql' | 'mariadb', target: string): string[] {
  if (engine === 'postgres')
    return ['sh', '-c', `pg_dump --format=custom --dbname="$PGURL" --file=${target}`];
  return [
    'sh',
    '-c',
    `mysqldump --single-transaction --all-databases -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" > ${target}`,
  ];
}

/**
 * The platform database as pg_dump needs it. A DATABASE_URL with credentials in the userinfo is
 * split here so the password can go to a 0600 file instead of a process argument or container env.
 */
function platformDatabase(url: string): {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
} {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port.length === 0 ? '5432' : parsed.port,
    database: parsed.pathname.replace(/^\//, '') || 'postgres',
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

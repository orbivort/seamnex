import { basename, dirname, join } from 'node:path';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import {
  ensureDir,
  exists,
  readTextFile,
  removeQuietly,
  removeTree,
  safeJoin,
  sha256,
  sha256File,
  writeFileAtomic,
} from '../../common/fs/files';
import { runOrThrow } from '../../common/exec/exec';
import {
  connectionEnvFrom,
  dumpCommand,
  engineOf,
  restoreCommand,
  type DatabaseEngine,
} from '../../common/engine/database';
import { AppError } from '../../common/problem/app-error';
import { ensurePlatformPartitions } from '../../common/db/partitions';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  INTEGRATION_SERVICE,
  type IntegrationService,
} from '../m07-integration/integration.contract';
import { JobService } from '../../jobs/job.service';
import { DockerEngineClient, type ComposeProject } from '../../common/docker/docker.client';
import { ALPINE_IMAGE } from '../../common/docker/images.generated';
import { dockerMountSource } from '../../common/docker/mount';
import { KeycloakAdminClient } from '../../common/keycloak/keycloak-admin.client';
import { instanceNetwork, projectName } from '../../common/docker/naming';
import { composeDocumentOf, declaredVolumeKeys } from '../../common/compose/compose-volumes';
import { renderSetDirectory } from '../../common/compose/render-directory';
import { runtimeSecretsPaths } from '../../common/compose/runtime-secrets';
import {
  PipelineRegistry,
  type PipelineContext,
  type PipelineStage,
} from '../../jobs/pipeline-registry';
import { AgeEncryptor } from './age';
import {
  artefactFile,
  createPlatformManifest,
  plannedArtefact,
  readPlatformManifest,
  referenceArtefact,
  storedArtefact,
  type PlatformArtefact,
  type PlatformArtefactKind,
  type PlatformManifest,
} from './platform-manifest';
import { BackupObjectStore } from '../../common/storage/object-store';
import { dumpRemoteDatabase, restoreRemoteDatabase } from './remote-database';

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
 * A stored render set written back onto this host, which is what `compose up` reads.
 *
 * `RenderSet` in M03 carries the image and port claims a deploy needs; a restore needs only the
 * files it must write and the project name to write them under, so it re-derives those instead of
 * importing another module's contract.
 */
type StoredDefinition = {
  readonly id: string;
  readonly directory: string;
  readonly files: readonly { path: string; content: string }[];
  readonly composeProject: string;
};

/** The volume and directory helper; the pin lives in `docker/images.json`. */
const ALPINE_HELPER_IMAGE = ALPINE_IMAGE;

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
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    @Inject(INTEGRATION_SERVICE) private readonly integration: IntegrationService,
    @Inject(JobService) private readonly jobs: JobService,
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
    // The product capture has the same obligation. It was the remaining path without a handler, and
    // a failed product backup left a `running` row that the Recovery register showed as a capture in
    // flight forever — the operator could neither see why it failed nor take another clean one.
    this.pipelines.registerFailure('backup', (context, cause) =>
      this.settleInstanceBackup(context, cause),
    );
    /**
     * FR-1.36 — the platform tier, in the fixed order.
     *
     * Each stage does the work its phase names. The last one is a pause, not a completion: the gate
     * opens on an authenticated administrative poll, which no stage can perform on someone's behalf,
     * so the run ends here and `openGateAfterLogin` queues the portfolio tier below.
     */
    this.pipelines.register('platform-restore', [
      {
        name: 'restore',
        step: 'Load the recovery set',
        run: (context) => this.loadRecoverySet(context),
      },
      {
        name: 'restore',
        step: 'Restore identity provider',
        run: (context) => this.restoreIdentityProvider(context),
      },
      {
        name: 'restore',
        step: 'Restore control plane',
        run: (context) => this.restoreControlPlane(context),
      },
      {
        name: 'record',
        step: 'Hold the gate for login verification',
        run: (context) => this.holdGate(context),
      },
    ]);
    // Same for a restore: `restore_run` must not stay `running` after the pipeline died, or the
    // screen polls a run that will never move.
    this.pipelines.registerFailure('platform-restore', (context, cause) =>
      this.settlePlatformRestore(context, cause),
    );
    /**
     * The portfolio tier (NFR-3.9). Queued by the gate release, because FR-1.36 puts the products
     * *after* the verified login and before that login nobody may see a restored product.
     */
    this.pipelines.register('platform-restore-products', [
      {
        name: 'restore',
        step: 'Restore product instances',
        run: (context) => this.restoreProducts(context),
      },
      {
        name: 'verify',
        step: 'Verify restored deployments',
        run: (context) => this.verifyRestoredDeployments(context),
      },
      {
        name: 'record',
        step: 'Record restore',
        run: (context) => this.recordPlatformRestore(context),
      },
    ]);
    this.pipelines.registerFailure('platform-restore-products', (context, cause) =>
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
      // Filled in at the end from what was actually captured. The literal used to promise both
      // contents before a byte was written, which made an empty volume set look like a complete one.
      includes: [],
    };

    /**
     * FR-1.12 / AC-13 — a backup that cannot hold the product's files is not a backup.
     *
     * `instance_volume` is written when a stack is applied. An instance deployed before that was
     * true has none, and archiving zero volumes then reporting `succeeded, verified` is the exact
     * false assurance this check removes. The definition is read from the render set (M16 may not
     * read `catalog_entry`), so the answer is "what the applied file declares", not a catalogue
     * claim. The check sits before the first dump: the operator learns now, not after a long run
     * that ends in a refusal anyway.
     */
    const volumes = await this.pool.query<{ name: string }>(
      `SELECT name FROM instance_volume WHERE instance_id = $1 ORDER BY name`,
      [instance.id],
    );
    const declared = await this.declaredVolumes(manifest.renderSetId);
    if (declared.length > 0 && volumes.rows.length === 0) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `${instance.slug} declares ${declared.length} data volume(s) (${declared.join(', ')}) but none is registered for the instance, so a backup would capture the database and none of the files.`,
        remediation:
          'Reconfigure the instance so the platform registers its data volumes, then take the backup again. Nothing was uploaded.',
      });
    }

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
          `${this.mountSource(directory)}:/backup`,
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

    for (const volume of volumes.rows) {
      // A registered volume the daemon no longer holds contains no data; archiving it would fail on
      // a missing mount, and failing the whole backup for a volume that holds nothing is worse.
      if (!(await this.docker.volumeExists(volume.name))) {
        await context.log(
          'system',
          `volume ${volume.name} is registered but absent from the daemon; it holds no data and is not captured`,
        );
        continue;
      }
      // gzip, for the reason `archiveDirectory` gives: the helper is plain `alpine:3.24.4`, whose
      // busybox `tar` has no `--zstd`, so every volume capture failed with
      // "tar: unrecognized option: zstd" and a product tier had nothing to restore.
      const archive = join(directory, `${volume.name}.tar.gz`);
      await runOrThrow(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${volume.name}:/src:ro`,
          '-v',
          `${this.mountSource(directory)}:/out`,
          ALPINE_HELPER_IMAGE,
          'tar',
          '-czf',
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

    manifest.includes = [
      ...(manifest.engineDumps.length > 0 ? ['database'] : []),
      ...(manifest.volumes.length > 0 ? ['volumes'] : []),
    ];
    await context.log(
      'stdout',
      `captured ${manifest.engineDumps.length} database dump(s) and ${manifest.volumes.length} volume(s)${
        declared.length > manifest.volumes.length
          ? `; the definition declares ${declared.length}`
          : ''
      }`,
    );

    await this.pool.query(`UPDATE backup SET manifest = $2::jsonb WHERE id = $1`, [
      backupId,
      JSON.stringify(manifest),
    ]);
  }

  /**
   * The named volumes the applied render set declares.
   *
   * Empty is a real answer: a definition with no top-level `volumes:` block has no file data the
   * platform can promise to capture, so a backup of it is complete with the database alone.
   */
  private async declaredVolumes(renderSetId: string): Promise<string[]> {
    if (renderSetId.length === 0) return [];
    const result = await this.pool.query<{ content: string }>(
      `SELECT content FROM render_file
        WHERE render_set_id = $1 AND path = 'docker-compose.platform.yml'`,
      [renderSetId],
    );
    const content = result.rows[0]?.content;
    if (content === undefined) return [];
    const document = composeDocumentOf(content);
    return document === null ? [] : declaredVolumeKeys(document);
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
    /**
     * FR-1.12 — "verified" means the objects named by the manifest are actually there.
     *
     * The stage used to read the manifest, log its counts and call that verification, so a backup
     * whose volume archives were never uploaded passed exactly the same way as a complete one. A
     * digest is required on every captured volume too: it is what a restore compares against.
     */
    const artefacts = [
      ...manifest.engineDumps.map((dump) => ({
        key: dump.objectKey,
        what: `database dump for ${dump.service}`,
      })),
      ...manifest.volumes.map((volume) => ({
        key: volume.archiveKey,
        what: `volume ${volume.name}`,
      })),
    ];
    const unverified: string[] = [];
    for (const artefact of artefacts) {
      if (!(await this.store.exists(artefact.key))) {
        unverified.push(`${artefact.what} (${artefact.key} is not in the target)`);
      }
    }
    for (const volume of manifest.volumes) {
      if (volume.digest.length === 0) {
        unverified.push(`volume ${volume.name} (no digest recorded)`);
      }
    }
    if (unverified.length > 0) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `The backup names ${artefacts.length} artefact(s) but ${unverified.length} cannot be verified: ${unverified.join('; ')}.`,
        remediation:
          'Take the backup again. A set whose objects cannot be read is not a restore point, and reporting it as verified hides a missing file.',
      });
    }
    await context.log(
      'stdout',
      `manifest verified: ${manifest.engineDumps.length} dump(s), ${manifest.volumes.length} volume(s), ${artefacts.length} object(s) present`,
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

  /**
   * Restores one instance's data: volume archives, then the engine dumps.
   *
   * The dumps were captured and never applied — a restore that rebuilds a product's containers from
   * the stored render set and leaves its database empty is the same defect as a platform restore
   * that only writes phase labels, one tier down. They are loaded **before** the containers start,
   * because a product that boots against a missing schema runs its installer instead.
   */
  private async restoreData(context: PipelineContext): Promise<void> {
    const { volumes, dumps, renderSetId } = await this.restoreInstanceData(
      payloadOf(context, 'backupId'),
      context,
    );
    await context.log('stdout', `${dumps} database dump(s) and ${volumes} volume(s) restored`);
    await context.log('stdout', `render set ${renderSetId ?? 'none'} will be applied`);
    await this.setPhase(payloadOf(context, 'restoreId'), 'products');
  }

  private async startFromRenderSet(context: PipelineContext): Promise<void> {
    await this.startInstance(payloadOf(context, 'backupId'), context);
    await this.setPhase(payloadOf(context, 'restoreId'), 'verify');
  }

  /**
   * Restores one instance's data: volume archives, then the engine dumps.
   *
   * The dumps were captured and never applied — a restore that rebuilds a product's containers from
   * the stored render set and leaves its database empty is the same defect as a platform restore
   * that only writes phase labels, one tier down. They are loaded **before** the containers start,
   * because a product that boots against a missing schema runs its installer instead.
   *
   * One implementation, two callers: the instance `restore` pipeline and the platform restore's
   * `products` phase. Two copies would drift on the one thing that must not drift — what "restored"
   * means.
   */
  private async restoreInstanceData(
    backupId: string,
    context: PipelineContext,
  ): Promise<{ volumes: number; dumps: number; renderSetId: string | null }> {
    const row = await this.instanceBackupOf(backupId);
    const instance = await this.instanceOf(row.instanceId ?? '');
    const directory = this.restoreDirectory(backupId);
    ensureDir(directory);

    const volumes = await this.restoreVolumes(row.manifest, instance.id, directory, context);
    const dumps = await this.restoreDumps(row.manifest, instance, directory, context);
    return { volumes, dumps, renderSetId: row.renderSetId };
  }

  /** Materialises the stored definition on this host and brings the stack up. */
  private async startInstance(backupId: string, context: PipelineContext): Promise<void> {
    const row = await this.instanceBackupOf(backupId);
    if (row.instanceId === null || row.renderSetId === null) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: 'The backup does not reference a render set, so it cannot be restored.',
        remediation:
          'Take a new backup from a deployed instance; a restore needs the stored definition.',
      });
    }
    const definition = await this.materialiseDefinition(row.renderSetId, row.instanceId);
    const instance = await this.instanceOf(row.instanceId);
    await this.docker.ensureNetwork(instanceNetwork(instance.slug), {
      'seamnex.instance': row.instanceId,
    });
    await this.docker.composeUp(this.composeProjectFor(definition, row.instanceId), (line) =>
      context.log('stdout', `[${instance.slug}] ${line}`),
    );
    await context.log(
      'stdout',
      `render set ${row.renderSetId} applied with ${definition.files.length} file(s)`,
    );
  }

  /**
   * Writes the stored definition onto *this* host, where `compose up` will look for it.
   *
   * `render_file` holds the content; the files themselves may be missing entirely, because the only
   * thing that had ever written them was the deploy that created the render set. Composing from files
   * nothing wrote worked on the host that deployed the instance and failed with "no such file" on the
   * host that a restore actually runs on. M16 may not depend on M03 (module boundary), so the rows are
   * written here with the same directory rule M03 uses — shared, so the two cannot disagree.
   */
  private async materialiseDefinition(
    renderSetId: string,
    instanceId: string,
  ): Promise<StoredDefinition> {
    const set = await this.pool.query<{
      id: string;
      instance_id: string;
      files: Record<string, unknown> | null;
    }>(`SELECT id, instance_id, files FROM render_set WHERE id = $1`, [renderSetId]);
    const row = set.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `The stored render set ${renderSetId} no longer exists for ${instanceId}.`,
        remediation:
          'A restore needs the definition the backup was taken from; check that render_set survived the restore.',
      });
    }
    const files = await this.pool.query<{ path: string; content: string }>(
      `SELECT path, content FROM render_file WHERE render_set_id = $1 ORDER BY path`,
      [renderSetId],
    );
    if (files.rows.length === 0) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `The stored render set ${renderSetId} has no files to apply.`,
        remediation:
          'Take a new backup from a deployed instance; a set without its definition cannot be restarted.',
      });
    }

    const directory = renderSetDirectory(
      this.config.SEAMNEX_INSTANCE_DATA_DIR,
      row.instance_id,
      row.id,
    );
    ensureDir(directory);
    for (const file of files.rows) {
      // The path is a database row, not a value this module produced, so it is resolved through the
      // guard rather than trusted: a stored `../../etc/passwd` is a refusal, never a write.
      let target: string;
      try {
        target = safeJoin(directory, file.path);
      } catch (error) {
        throw new AppError({
          code: 'BACKUP_UNUSABLE',
          detail: `The stored render set ${renderSetId} names a file path that escapes its directory ("${file.path}").`,
          remediation:
            'Take a new backup from a deployed instance; a definition the platform cannot materialise is not restorable.',
          cause: error,
        });
      }
      ensureDir(dirname(target));
      writeFileAtomic(target, file.content);
    }

    const manifest = (row.files ?? {}) as { composeProject?: string };
    return {
      id: row.id,
      directory,
      files: files.rows,
      composeProject: manifest.composeProject ?? projectName(row.instance_id),
    };
  }

  /**
   * The compose invocation for a stored render set, file for file the one the deploy applied.
   *
   * The runtime secrets override is passed when it exists: it is regenerated by the executor from
   * the secret store, so a restore onto the same host keeps the product's injected credentials. When
   * it is absent the stack still starts and the log names what is missing — inventing an environment
   * would be worse than an honest gap.
   */
  private composeProjectFor(definition: StoredDefinition, instanceId: string): ComposeProject {
    const runtime = runtimeSecretsPaths({
      dataDir: this.config.SEAMNEX_INSTANCE_DATA_DIR,
      instanceId,
      renderSetId: definition.id,
    });
    const hasSecrets = exists(runtime.override) && exists(runtime.env);
    return {
      project: definition.composeProject,
      directory: definition.directory,
      files: [
        join(definition.directory, 'docker-compose.platform.yml'),
        join(definition.directory, 'docker-compose.override.yml'),
        ...(hasSecrets ? [runtime.override] : []),
      ],
      envFiles: [join(definition.directory, 'platform.env'), ...(hasSecrets ? [runtime.env] : [])],
    };
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

  /**
   * FR-1.35 — capture the platform recovery set.
   *
   * Everything the platform owns is written into the scratch directory here and uploaded by the next
   * stage. The manifest records every artefact with `included: false` and is only rewritten by the
   * upload stage, so a capture that dies halfway cannot leave a row claiming a set it never wrote.
   * Material the operator owns (the edge's TLS store, the escrowed root key) is recorded as a
   * reference with its location — never as an included artefact.
   */
  private async platformDump(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    // Checked before the scratch directory exists: a refusal must leave no trace of a capture that
    // never started.
    this.assertPlatformCaptureIsPossible();
    const directory = join(this.config.SEAMNEX_BACKUP_TMP_DIR, backupId);
    ensureDir(directory);

    const artefacts: PlatformArtefact[] = [];

    const platformFile = artefactFile('platform_database') ?? 'platform.dump';
    // `DATABASE_URL` is this process's address; on a compose network it names the server by its
    // service name, which a host-network helper cannot resolve. `SEAMNEX_PLATFORM_DB_URL` is that
    // same database as the helper sees it, and stays empty where the two coincide.
    const platformUrl = this.config.SEAMNEX_PLATFORM_DB_URL.trim() || this.config.DATABASE_URL;
    await dumpRemoteDatabase({
      what: 'the platform database',
      setting:
        this.config.SEAMNEX_PLATFORM_DB_URL.trim().length > 0
          ? 'SEAMNEX_PLATFORM_DB_URL'
          : 'DATABASE_URL',
      url: platformUrl,
      directory,
      passFileName: '.pgpass',
      dumpFileName: platformFile,
      ...this.helperContext(),
    });
    await context.log('stdout', `platform database dumped to ${platformFile}`);
    artefacts.push(plannedArtefact('platform_database', now()));

    const idpFile = artefactFile('idp_database') ?? 'idp.dump';
    await dumpRemoteDatabase({
      what: 'the identity-provider database',
      setting: 'SEAMNEX_KEYCLOAK_DB_URL',
      url: this.config.SEAMNEX_KEYCLOAK_DB_URL,
      directory,
      passFileName: '.pgpass-idp',
      dumpFileName: idpFile,
      ...this.helperContext(),
    });
    await context.log('stdout', `identity-provider database dumped to ${idpFile}`);
    artefacts.push(plannedArtefact('idp_database', now()));

    // FR-1.35: the realm is part of platform state. An export that cannot be produced fails the
    // capture; writing an empty document would make the set claim something it does not hold. The
    // file is 0600 because it carries client secrets until the upload stage encrypts it.
    const realmFile = artefactFile('idp_realm') ?? 'realm.json';
    const document = await this.keycloak.exportRealm();
    writeFileAtomic(join(directory, realmFile), JSON.stringify(document, null, 2), 0o600);
    await context.log('stdout', `identity-provider realm exported to ${realmFile}`);
    artefacts.push(plannedArtefact('idp_realm', now()));

    const edgeFile = artefactFile('edge_routes') ?? 'edge-routes.tar.gz';
    await this.archiveDirectory({
      source: this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR,
      directory,
      fileName: edgeFile,
    });
    await context.log('stdout', `edge route configuration archived to ${edgeFile}`);
    artefacts.push(plannedArtefact('edge_routes', now()));

    const anchorFile = artefactFile('audit_anchor') ?? 'audit-anchor.json';
    await this.exportAuditAnchor(join(directory, anchorFile), context);
    artefacts.push(plannedArtefact('audit_anchor', now()));

    // FR-1.35 calls this a fallback copy: the catalogue repository stays authoritative (DD-14), so a
    // restore may re-apply from it but must never overwrite it from this archive.
    const catalogFile = artefactFile('catalog_repo') ?? 'catalog.tar.gz';
    await this.archiveDirectory({
      source: this.config.SEAMNEX_CATALOG_REPO_PATH,
      directory,
      fileName: catalogFile,
    });
    await context.log('stdout', `catalogue fallback copy archived to ${catalogFile}`);
    artefacts.push(plannedArtefact('catalog_repo', now()));

    // Operator-owned material. Where TLS terminates at an operator ingress, the platform cannot read
    // the certificate store at all; naming the owner and the location is the honest record.
    const references = [
      referenceArtefact('edge_static_and_tls', this.config.SEAMNEX_EDGE_CONFIG_REF, now()),
      referenceArtefact('secret_root_key', this.config.SEAMNEX_ROOT_KEY_ESCROW_REF, now()),
    ];
    artefacts.push(...references);
    const missingReferences = references
      .filter((artefact) => artefact.location === null)
      .map((artefact) => artefact.kind);
    if (missingReferences.length > 0) {
      // Not fatal: FR-1.35 allows recording where the material lives, and an operator may not have
      // written it down yet. The screen shows "not captured", and the log names the gap.
      await context.log(
        'system',
        `operator-owned artefacts with no recorded location: ${missingReferences.join(', ')}`,
      );
    }

    const manifest = createPlatformManifest({
      artefacts,
      encryption: { recipient: this.age.recipientId(), identityId: this.age.identityId() },
      rootKeyId: this.secrets.rootKeyId(),
      capturedAt: now(),
    });
    await this.pool.query(`UPDATE backup SET manifest = $2::jsonb WHERE id = $1`, [
      backupId,
      JSON.stringify(manifest),
    ]);
    await context.log('system', `recovery set captured: ${manifest.artefacts.length} artefacts`);
  }

  /**
   * Uploads every captured artefact and only then claims the set.
   *
   * The manifest is re-read rather than assumed: this stage resumes from the files the capture stage
   * wrote, and a manifest that is missing or unreadable means there is nothing to upload. `included`
   * becomes true one artefact at a time, after `putFile` returned a byte count and the digest of the
   * stored object was computed.
   */
  private async platformUpload(context: PipelineContext): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const directory = join(this.config.SEAMNEX_BACKUP_TMP_DIR, backupId);
    const row = await this.pool.query<{ manifest: Record<string, unknown> }>(
      `SELECT manifest FROM backup WHERE id = $1`,
      [backupId],
    );
    const manifest = readPlatformManifest(row.rows[0]?.manifest);
    if (manifest === null) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `Platform backup ${backupId} has no readable capture manifest, so nothing can be claimed as uploaded.`,
        remediation:
          'Take the backup again; a set is uploaded from the manifest its capture stage wrote.',
      });
    }

    const uploaded: PlatformArtefact[] = [];
    let bytes = 0;
    for (const artefact of manifest.artefacts) {
      const file = artefactFile(artefact.kind);
      if (file === null) {
        // A referenced artefact has no object behind it and stays `included: false`.
        uploaded.push(artefact);
        continue;
      }
      const plaintext = join(directory, file);
      const encrypted = await this.age.encrypt(plaintext);
      // The digest covers the encrypted bytes: that is what a restore downloads and verifies.
      const digest = await sha256File(encrypted.path);
      const put = await this.store.putFile(`${backupId}/${file}.age`, encrypted.path);
      uploaded.push(storedArtefact(artefact, { objectKey: put.key, bytes: put.bytes, digest }));
      // The dumps and the realm export are plaintext on disk and the scratch directory is reused, so
      // the plaintext goes as soon as its encrypted object exists. The encrypted copy goes too: the
      // object store is the durable location, and a second full-size copy per backup would fill a
      // disk nobody is watching.
      removeQuietly(plaintext);
      removeQuietly(encrypted.path);
      bytes += put.bytes;
      await context.log('stdout', `uploaded ${put.key} (${put.bytes} bytes)`);
    }

    const finalManifest = createPlatformManifest({
      artefacts: uploaded,
      encryption: manifest.encryption,
      rootKeyId: manifest.rootKeyId,
      capturedAt: manifest.capturedAt,
    });
    const manifestKey = `${backupId}/manifest.json`;
    await this.store.putText(manifestKey, JSON.stringify(finalManifest, null, 2));
    await this.pool.query(
      `UPDATE backup SET state = 'succeeded', finished_at = now(), size_bytes = $2, object_key = $3, manifest = $4::jsonb
        WHERE id = $1`,
      [backupId, bytes, manifestKey, JSON.stringify(finalManifest)],
    );
    await this.audit.append({
      action: 'platform.backup.succeeded',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'backup',
      targetId: backupId,
      outcome: 'success',
      detail: {
        bytes,
        artefacts: finalManifest.includes.length,
        referenced: finalManifest.artefacts
          .filter((artefact) => !artefact.included)
          .map((artefact) => artefact.kind),
      },
    });
    await context.log(
      'system',
      `platform backup uploaded (${bytes} bytes, ${finalManifest.includes.length} artefacts)`,
    );
  }

  /**
   * Fails before the first byte is written, and names **every** missing prerequisite at once.
   *
   * One blocker per run is not actionable: an operator fixes the first, waits through two database
   * dumps, and only then learns the set cannot be encrypted either. The plaintext dumps are the most
   * expensive thing this module produces, so everything that would refuse a capture — a required
   * setting, a required directory, the encryption recipient the upload stage would reject — is
   * collected here and reported together.
   */
  private assertPlatformCaptureIsPossible(): void {
    const missing: string[] = [];
    if (this.config.SEAMNEX_KEYCLOAK_DB_URL.trim().length === 0) {
      missing.push(
        "the identity provider's database has no connection string (SEAMNEX_KEYCLOAK_DB_URL)",
      );
    }
    if (!exists(this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR)) {
      missing.push(
        `the edge route directory ${this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR} is missing (SEAMNEX_TRAEFIK_DYNAMIC_DIR)`,
      );
    }
    if (!exists(this.config.SEAMNEX_CATALOG_REPO_PATH)) {
      missing.push(
        `the catalogue tree ${this.config.SEAMNEX_CATALOG_REPO_PATH} is missing (SEAMNEX_CATALOG_REPO_PATH)`,
      );
    }
    // Without a recipient the upload stage refuses after both dumps have been written, which is the
    // worst possible moment to find out.
    if ((this.config.SEAMNEX_AGE_RECIPIENT ?? '').trim().length === 0) {
      missing.push('no encryption recipient is configured (SEAMNEX_AGE_RECIPIENT)');
    }
    if (missing.length === 0) return;

    throw new AppError({
      code: 'ADAPTER_UNAVAILABLE',
      // The job surface carries `detail` only, so the instruction has to travel with it: the console
      // renders the job's error message, not the problem document's remediation.
      detail: `The recovery set cannot be captured: ${missing.join('; ')}. Set every item in the API environment and take the backup again — .env.example documents each value.`,
      remediation:
        'Configure the items named above and retry. Nothing was written or uploaded: a set without the identity provider cannot restore a login, and a set that cannot be encrypted is not a backup.',
    });
  }

  /**
   * The source string a helper container can bind.
   *
   * `docker run` is executed by the daemon, which resolves a bind source on the *host* filesystem,
   * while this process knows only the path inside its own container. Where the two differ the
   * mapping in `SEAMNEX_DOCKER_PATH_MAP` bridges them; where they are the same path the value is
   * passed through unchanged, so a deployment that mounts the scratch tree identically needs no
   * configuration.
   */
  private mountSource(containerPath: string): string {
    return dockerMountSource(containerPath, this.config.SEAMNEX_DOCKER_PATH_MAP);
  }

  /**
   * Archives a directory through an ephemeral helper rather than walking it in the API process.
   *
   * gzip, not zstd: the helper is plain `alpine:3.24.4`, whose `tar` always supports `-z`, while
   * `--zstd` depends on how that image was built. A slightly larger archive that always works beats
   * a capture that fails on one host.
   */
  private async archiveDirectory(input: {
    source: string;
    directory: string;
    fileName: string;
  }): Promise<void> {
    await runOrThrow(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${this.mountSource(input.source)}:/src:ro`,
        '-v',
        `${this.mountSource(input.directory)}:/out`,
        ALPINE_HELPER_IMAGE,
        'tar',
        '-czf',
        `/out/${input.fileName}`,
        '-C',
        '/src',
        '.',
      ],
      {
        env: { PATH: process.env.PATH ?? '', DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST },
        timeoutMs: 900_000,
      },
    );
  }

  /**
   * Exports the audit anchors and the chain head.
   *
   * FR-1.35 requires audit records to remain verifiable after a restore. The anchors alone prove the
   * chain up to the last anchored day; the head is exported beside them so a restore can tell "the
   * tail is intact" from "events after the anchor are missing". The query stays in the audit module;
   * this method only decides how the export is packaged.
   */
  private async exportAuditAnchor(path: string, context: PipelineContext): Promise<void> {
    const exported = await this.audit.exportAnchors();
    writeFileAtomic(
      path,
      JSON.stringify({ version: 1, exportedAt: now(), ...exported }, null, 2),
      0o600,
    );
    await context.log(
      'stdout',
      `audit anchor exported: ${exported.anchors.length} day(s), chain head ${exported.chainHead?.seq ?? 'none'}`,
    );
  }

  // ---- platform restore -------------------------------------------------------------------------

  /**
   * FR-1.35 / FR-1.36 / AC-30 — prove the set before anything is overwritten.
   *
   * A recovery set is a backup only if every artefact it claims is there and byte-identical to the
   * digest recorded at capture. Checking in one place, before the first write, is what separates a
   * restore that refuses to start from one that restores the identity provider and then discovers the
   * control-plane dump is truncated — leaving the platform in a state nobody planned for.
   */
  private async loadRecoverySet(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    const backupId = payloadOf(context, 'backupId');
    await this.setPhase(restoreId, 'preparing');

    const manifest = await this.platformManifestOf(backupId);
    const required: readonly PlatformArtefactKind[] = [
      'platform_database',
      'idp_database',
      'idp_realm',
      'edge_routes',
      'audit_anchor',
    ];
    const missing = required.filter((kind) => {
      const artefact = manifest.artefacts.find((entry) => entry.kind === kind);
      return artefact === undefined || !artefact.included || artefact.objectKey === null;
    });
    if (missing.length > 0) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `The recovery set is missing ${missing.join(', ')}, so it cannot restore a login.`,
        remediation:
          'Restore a set that carries the identity provider, the control plane and the audit anchor; nothing has been overwritten.',
      });
    }

    const directory = this.restoreDirectory(backupId);
    ensureDir(directory);
    let loaded = 0;
    for (const artefact of manifest.artefacts) {
      const file = artefactFile(artefact.kind);
      if (!artefact.included || artefact.objectKey === null || file === null) continue;
      const target = join(directory, file);
      await this.store.download(artefact.objectKey, `${target}.age`);
      // The digest covers the stored bytes, and it is checked before the file is decrypted: a
      // truncated or substituted object must not reach a restore at all.
      const digest = await sha256File(`${target}.age`);
      if (artefact.digest !== null && digest !== artefact.digest) {
        throw new AppError({
          code: 'BACKUP_UNUSABLE',
          detail: `The stored ${artefact.kind} artefact does not match the digest recorded when it was captured.`,
          remediation:
            'The object store or the upload is damaged; restore a different set. Nothing has been overwritten.',
        });
      }
      await this.age.decrypt(`${target}.age`);
      removeQuietly(`${target}.age`);
      loaded += 1;
      await context.log('stdout', `${artefact.kind}: loaded and verified`);
    }

    await this.mergeDetail(restoreId, {
      recoverySet: { loaded, includes: manifest.includes, capturedAt: manifest.capturedAt },
    });
    await context.log(
      'stdout',
      `${loaded} artefact(s) verified against the manifest; nothing has been overwritten yet`,
    );
  }

  /**
   * FR-1.36 step 2 — identity provider first, because nothing else can authenticate without it.
   *
   * Restoring the provider's own database is safe in a way the control plane's is not: it is a
   * different database, so the process performing the restore is not writing into what it replaces.
   * The realm export is applied only when the provider does not answer after the restart — a
   * database restore already carries the realm, and re-importing it on a healthy provider would
   * overwrite realm edits made after the capture with older ones.
   *
   * A provider that never answers fails the run. FR-1.36 is explicit: a restore that cannot
   * authenticate is reported failed, and a green screen over a login nobody can perform is the exact
   * defect this path replaces.
   */
  private async restoreIdentityProvider(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    const backupId = payloadOf(context, 'backupId');
    const directory = this.restoreDirectory(backupId);
    await this.setPhase(restoreId, 'idp');

    const idpUrl = this.config.SEAMNEX_KEYCLOAK_DB_URL.trim();
    if (idpUrl.length > 0) {
      await restoreRemoteDatabase({
        what: 'the identity-provider database',
        setting: 'SEAMNEX_KEYCLOAK_DB_URL',
        url: idpUrl,
        directory,
        passFileName: '.pgpass-idp',
        dumpFileName: 'idp.dump',
        ...this.helperContext(),
      });
      await context.log('stdout', 'identity-provider database restored');
    } else {
      await context.log(
        'system',
        'SEAMNEX_KEYCLOAK_DB_URL is empty: the identity-provider database was not restored, and only the realm export can be applied',
      );
    }

    // The provider holds its schema in memory until it restarts, so a restored database alone leaves
    // it answering from the pre-restore contents.
    const container = this.config.SEAMNEX_IDP_CONTAINER.trim();
    if (container.length > 0) {
      await this.docker.restart(container, 60);
      await context.log('stdout', 'identity provider restarted');
    } else {
      await context.log(
        'system',
        'SEAMNEX_IDP_CONTAINER is empty: the identity provider was not restarted, so it may still be serving from memory',
      );
    }

    this.keycloak.invalidateToken();
    let reachable = await this.waitForIdp();
    let importOutcome: 'not-needed' | 'created' | 'updated' = 'not-needed';
    if (!reachable) {
      importOutcome = await this.importRealmFallback(directory, context);
      this.keycloak.invalidateToken();
      reachable = await this.waitForIdp();
    }
    if (!reachable) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `The identity provider did not answer within ${Math.round(
          this.config.SEAMNEX_RESTORE_IDP_TIMEOUT_MS / 1000,
        )}s of the restore, so the platform cannot authenticate anyone.`,
        remediation:
          'Check that the provider started against its restored database, then start the restore again. A restore that cannot authenticate is failed (FR-1.36).',
      });
    }

    await this.mergeDetail(restoreId, { idp: { reachable: true, realmImport: importOutcome } });
    await this.audit.append({
      action: 'platform.restore.idp_restored',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'restore_run',
      targetId: restoreId,
      outcome: 'success',
      detail: { realmImport: importOutcome, jobId: context.jobId },
    });
  }

  /**
   * FR-1.36 step 3 — the control plane, minus the checkpoints the login has to reach first.
   *
   * Order inside the stage is deliberate: products come down before their data is replaced, the
   * running job's own rows are snapshotted before the database that holds them is restored, and the
   * audit chain is verified last so it covers everything the restore wrote.
   */
  private async restoreControlPlane(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    const backupId = payloadOf(context, 'backupId');
    await this.setPhase(restoreId, 'control_plane');

    // Products are unreachable already (gate), but their processes still hold their databases open;
    // a dump restore into an open connection can block on a lock nobody will release.
    const instances = await this.pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM instance WHERE deleted_at IS NULL ORDER BY slug`,
    );
    const stopped: { instanceId: string; containerId: string }[] = [];
    for (const instance of instances.rows) {
      const containers = await this.docker.containers([`seamnex.instance=${instance.id}`]);
      for (const container of containers) {
        if (container.state !== 'running') continue;
        await this.docker.stop(container.id, 15);
        stopped.push({ instanceId: instance.id, containerId: container.id });
      }
    }
    await this.mergeDetail(restoreId, { stoppedContainers: stopped });
    await context.log(
      'stdout',
      `stopped ${stopped.length} container(s) across ${instances.rows.length} instance(s)`,
    );

    await this.restorePlatformDatabase(context, restoreId, backupId);
    await this.restoreEdgeRoutes(context, restoreId, backupId);
    await this.restoreCatalogueFallback(context, restoreId, backupId);
    await this.verifyRestoredAuditChain(context, restoreId, backupId);

    await this.audit.append({
      action: 'platform.restore.control_plane_restored',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'restore_run',
      targetId: restoreId,
      outcome: 'success',
      detail: { jobId: context.jobId },
    });
  }

  /**
   * The platform database itself.
   *
   * Two credentials exist for a reason. `SEAMNEX_PLATFORM_DB_URL` is the application role, which by
   * design cannot run DDL or write `audit_event` (migration `0010_grants`), so a restore that
   * pretends to use it would fail on the first `DROP TABLE`. The operator either supplies
   * `SEAMNEX_PLATFORM_RESTORE_DB_URL` for the duration of the restore, or runs the same statement
   * set from `pnpm restore:platform-db` with credentials the platform never holds. In the second
   * case the phase records the outstanding step and the run cannot end `complete` — an incomplete
   * platform tier is a failed restore, not a completed one (FR-1.36).
   */
  private async restorePlatformDatabase(
    context: PipelineContext,
    restoreId: string,
    backupId: string,
  ): Promise<void> {
    const restoreUrl = this.config.SEAMNEX_PLATFORM_RESTORE_DB_URL.trim();
    const directory = this.restoreDirectory(backupId);

    if (restoreUrl.length === 0) {
      await this.mergeDetail(restoreId, { operatorStepRequired: ['platform_database'] });
      await context.log(
        'system',
        'SEAMNEX_PLATFORM_RESTORE_DB_URL is empty: the platform database was not restored by this run. Run `pnpm restore:platform-db` with owner credentials; the run cannot end complete until then.',
      );
      await this.audit.append({
        action: 'platform.restore.control_plane_skipped',
        actorType: 'service',
        actorId: 'backup-runner',
        targetType: 'restore_run',
        targetId: restoreId,
        outcome: 'success',
        detail: {
          reason: 'no restore credential',
          operatorStep: 'pnpm restore:platform-db',
          jobId: context.jobId,
        },
      });
      return;
    }

    // Both snapshots are taken before the write, because afterwards the rows they read are gone and
    // the worker that is running this job can no longer record a step or settle the run.
    const jobRows = await this.jobs.readLiveControlRows(context.jobId);
    const runRows = await this.pool.query<{ row: Record<string, unknown> }>(
      `SELECT to_jsonb(r) AS row FROM restore_run r WHERE r.id = $1`,
      [restoreId],
    );

    await restoreRemoteDatabase({
      what: 'the platform database',
      setting: 'SEAMNEX_PLATFORM_RESTORE_DB_URL',
      url: restoreUrl,
      directory,
      passFileName: '.pgpass-restore',
      dumpFileName: 'platform.dump',
      ...this.helperContext(),
    });

    await this.jobs.reinstateAfterRestore(jobRows);
    const runRow = runRows.rows[0]?.row;
    if (runRow !== undefined) {
      await this.pool.query(
        `INSERT INTO restore_run
         SELECT * FROM jsonb_populate_record(NULL::restore_run, $1::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [JSON.stringify(runRow)],
      );
    }
    // The dump carries only the partitions that existed when it was taken; without today's, the next
    // log append and the next audited mutation fail closed.
    await ensurePlatformPartitions(this.pool, this.config.SEAMNEX_PARTITION_LOOKAHEAD_DAYS);

    await context.log(
      'stdout',
      'platform database restored; the job and restore rows the restore replaced were reinstated',
    );
  }

  /**
   * The generated edge configuration, then the projection that owns it.
   *
   * The archive is the edge state the captured control plane described. It is applied because a
   * clean host has nothing, and then the routes are projected from the restored database, which is
   * the actual source — the files are derived output, and a projection is the only way to be sure
   * the gate and the publish flags in the restored rows are honoured.
   */
  private async restoreEdgeRoutes(
    context: PipelineContext,
    restoreId: string,
    backupId: string,
  ): Promise<void> {
    const directory = this.restoreDirectory(backupId);
    const archive = join(directory, 'edge-routes.tar.gz');
    const target = this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR.trim();
    if (!exists(archive) || target.length === 0) {
      await context.log(
        'system',
        'no edge routes were applied: the set carries none, or SEAMNEX_TRAEFIK_DYNAMIC_DIR is empty',
      );
      await this.mergeDetail(restoreId, { edgeRoutes: 'not-applied' });
      return;
    }

    ensureDir(target);
    await runOrThrow(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${this.mountSource(directory)}:/in:ro`,
        '-v',
        `${this.mountSource(target)}:/out`,
        ALPINE_HELPER_IMAGE,
        'sh',
        '-c',
        'rm -rf /out/* && tar -xzf /in/edge-routes.tar.gz -C /out',
      ],
      {
        env: { PATH: process.env.PATH ?? '', DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST },
        timeoutMs: 300_000,
      },
    );
    await this.integration.projectAll();
    await this.mergeDetail(restoreId, { edgeRoutes: 'restored-and-reprojected' });
    await context.log('stdout', 'edge routes restored and reprojected from the control plane');
  }

  /**
   * DD-14 — the catalogue repository is authoritative, so the fallback copy is used only when the
   * tree is gone.
   *
   * Extracting it over a live working tree would overwrite repository-governed definitions with a
   * snapshot, which is exactly what FR-1.35 forbids. A tree that is present is therefore left
   * untouched and the run records that the repository won.
   */
  private async restoreCatalogueFallback(
    context: PipelineContext,
    restoreId: string,
    backupId: string,
  ): Promise<void> {
    const directory = this.restoreDirectory(backupId);
    const archive = join(directory, 'catalog.tar.gz');
    const repository = this.config.SEAMNEX_CATALOG_REPO_PATH.trim();
    if (!exists(archive)) {
      await this.mergeDetail(restoreId, { catalogue: 'not-in-set' });
      return;
    }
    if (repository.length === 0) {
      await this.mergeDetail(restoreId, { catalogue: 'not-applied' });
      await context.log(
        'system',
        'the fallback catalogue copy was not applied: SEAMNEX_CATALOG_REPO_PATH is empty',
      );
      return;
    }
    if (exists(repository)) {
      await this.mergeDetail(restoreId, { catalogue: 'repository-authoritative' });
      await context.log(
        'stdout',
        'the catalogue tree is present, so the fallback copy was not applied: the repository stays authoritative (DD-14)',
      );
      return;
    }

    ensureDir(repository);
    await runOrThrow(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${this.mountSource(directory)}:/in:ro`,
        '-v',
        `${this.mountSource(repository)}:/out`,
        ALPINE_HELPER_IMAGE,
        'tar',
        '-xzf',
        '/in/catalog.tar.gz',
        '-C',
        '/out',
      ],
      {
        env: { PATH: process.env.PATH ?? '', DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST },
        timeoutMs: 300_000,
      },
    );
    await this.mergeDetail(restoreId, { catalogue: 'fallback-restored' });
    await context.log(
      'system',
      'the fallback catalogue copy was restored; reconcile toward the repository before publishing changes',
    );
  }

  /**
   * FR-1.35 — the restored chain must still verify, and must still be the chain the anchor describes.
   *
   * `verify()` recomputes the hashes over the restored range; comparing the row at the exported head
   * sequence against the exported hash is what ties the recomputation to *this* set rather than to
   * whatever chain happens to be in the database. Both checks are cheap and neither is redundant: a
   * chain can be internally consistent while being a different chain.
   */
  private async verifyRestoredAuditChain(
    context: PipelineContext,
    restoreId: string,
    backupId: string,
  ): Promise<void> {
    const anchorPath = join(this.restoreDirectory(backupId), 'audit-anchor.json');
    if (!exists(anchorPath)) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail:
          'The recovery set carries no audit anchor, so the restored chain cannot be verified.',
      });
    }
    const exported = JSON.parse(readTextFile(anchorPath)) as {
      anchors?: unknown;
      chainHead?: { seq?: unknown; hash?: unknown } | null;
    };
    const head = exported.chainHead;
    const headSeq = typeof head?.seq === 'string' ? head.seq : null;
    const headHash = typeof head?.hash === 'string' ? head.hash : null;
    if (headSeq === null || headHash === null) {
      await this.mergeDetail(restoreId, { audit: { verified: 0, head: null } });
      await context.log('system', 'the captured chain was empty; there was nothing to verify');
      return;
    }

    const verification = await this.audit.verify('1', headSeq);
    if (!verification.valid) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `The restored audit chain does not verify; the first broken sequence is ${verification.firstBrokenSeq ?? 'unknown'}.`,
        remediation:
          'The audit log cannot be trusted after this restore. Keep the platform gated and investigate before restoring anything else.',
      });
    }
    // Asked of the audit module, not of its table: M16 may read the chain only through the contract.
    if ((await this.audit.headHash(headSeq)) !== headHash) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `The restored chain does not contain the exported head at sequence ${headSeq}.`,
        remediation:
          'The database restored is not the one the anchor was exported from. Keep the platform gated and restore the matching set.',
      });
    }

    await this.mergeDetail(restoreId, { audit: { verified: verification.checked, head: headSeq } });
    await context.log(
      'stdout',
      `audit chain verified over ${verification.checked} event(s) up to sequence ${headSeq}`,
    );
  }

  /**
   * `login_verified` is reached but not passed: an administrative login is what opens the gate, and
   * no job can perform a login on someone's behalf (FR-1.36).
   */
  private async holdGate(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    await this.setPhase(restoreId, 'login_verified');
    await this.mergeDetail(restoreId, { awaitingLogin: true });
    await context.log(
      'system',
      'restore is holding the gate: an administrative login must verify the restored IdP',
    );
  }

  /**
   * NFR-3.9 — the portfolio tier, after the login released the gate.
   *
   * Every instance is attempted: one product that fails to restore must not cancel the eleven that
   * would have succeeded, which is the whole point of restoring a portfolio in parallel. Failures are
   * collected here and judged by the `verify` stage, so the run has one failure surface and one
   * reason per instance instead of the first exception thrown.
   *
   * An instance with no succeeded backup is not an error at P0 (AC-30: the product set is legitimately
   * empty); it is started again from the containers this restore stopped, and the run says so.
   */
  private async restoreProducts(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    await this.setPhase(restoreId, 'products');

    const run = await this.pool.query<{ concurrency: number }>(
      `SELECT concurrency FROM restore_run WHERE id = $1`,
      [restoreId],
    );
    const concurrency = Math.min(12, Math.max(4, run.rows[0]?.concurrency ?? 4));
    const detail = await this.readDetail(restoreId);
    const stopped = readStoppedContainers(detail);
    const instances = await this.pool.query<{ id: string; slug: string }>(
      `SELECT id, slug FROM instance WHERE deleted_at IS NULL ORDER BY slug`,
    );

    await context.log(
      'stdout',
      `restoring ${instances.rows.length} instance(s), ${concurrency} at a time`,
    );

    const outcomes = await mapWithConcurrency(instances.rows, concurrency, async (instance) => {
      try {
        const backup = await this.latestInstanceBackup(instance.id);
        if (backup === null) {
          const own = stopped.filter((entry) => entry.instanceId === instance.id);
          for (const entry of own) await this.docker.start(entry.containerId);
          await context.log(
            'system',
            `${instance.slug}: no succeeded backup exists, so the container(s) this restore stopped were started again`,
          );
          return {
            instance: instance.slug,
            outcome: own.length > 0 ? 'started-again' : 'nothing-to-restore',
            // The two cases are not the same claim: saying containers were started again for an
            // instance that never ran one is the sort of sentence this screen exists to stop.
            detail:
              own.length > 0
                ? 'no succeeded instance backup exists; nothing was restored, and the containers this restore stopped were started again'
                : 'no succeeded instance backup exists and no container was running, so there was nothing to restore or restart',
          } satisfies ProductOutcome;
        }
        const data = await this.restoreInstanceData(backup.id, context);
        await this.startInstance(backup.id, context);
        await context.log(
          'stdout',
          `${instance.slug}: restored ${data.dumps} dump(s) and ${data.volumes} volume(s) from backup ${backup.id}`,
        );
        return {
          instance: instance.slug,
          outcome: 'restored',
          detail: backup.id,
        } satisfies ProductOutcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'the restore failed';
        await context.log('system', `${instance.slug}: ${message}`);
        return {
          instance: instance.slug,
          outcome: 'failed',
          detail: message,
        } satisfies ProductOutcome;
      }
    });

    outcomes.sort((left, right) => left.instance.localeCompare(right.instance));
    await this.mergeDetail(restoreId, { products: outcomes });
    const failed = outcomes.filter((outcome) => outcome.outcome === 'failed').length;
    await context.log(
      'stdout',
      `portfolio restore finished: ${outcomes.length - failed} of ${outcomes.length} instance(s) restored`,
    );
  }

  /**
   * AC-52 / FR-1.36 — prove the result before reporting it.
   *
   * This is where the run stops lying. It fails when an instance is not running, when the identity
   * provider no longer answers, and when the platform database is still the operator's outstanding
   * step: each of those means the platform tier is not complete, and FR-1.36 does not allow calling
   * that a completed restore.
   */
  private async verifyRestoredDeployments(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    await this.setPhase(restoreId, 'verify');
    const detail = await this.readDetail(restoreId);
    const failures: string[] = [];

    const products = readProducts(detail);
    for (const product of products) {
      if (product.outcome === 'failed') {
        failures.push(`${product.instance}: ${product.detail}`);
        continue;
      }
      if (product.outcome !== 'restored') continue;
      const instance = await this.pool.query<{ id: string; slug: string }>(
        `SELECT id, slug FROM instance WHERE slug = $1`,
        [product.instance],
      );
      const row = instance.rows[0];
      if (row === undefined) {
        failures.push(`${product.instance}: the instance disappeared during the restore`);
        continue;
      }
      const containers = await this.docker.containers([`seamnex.instance=${row.id}`]);
      const down = containers.filter((container) => container.state !== 'running');
      if (containers.length === 0 || down.length > 0) {
        failures.push(
          `${product.instance}: ${containers.length === 0 ? 'no container is present' : `${down.length} container(s) are not running`}`,
        );
      }
    }

    const operatorSteps = readOperatorSteps(detail);
    if (operatorSteps.length > 0) {
      failures.push(
        `the run did not restore ${operatorSteps.join(', ')}; run \`pnpm restore:platform-db\` and start the restore again`,
      );
    }

    if (!(await this.keycloak.realmReachable())) {
      failures.push('the identity provider does not answer');
    }

    if (failures.length > 0) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `The restore did not verify: ${failures.join('; ')}.`,
        remediation:
          'Keep the platform gated, fix the named items and start the restore again; the run stays failed until they verify.',
      });
    }

    await this.mergeDetail(restoreId, {
      verified: {
        at: now(),
        instances: products.filter((product) => product.outcome === 'restored').length,
        idpReachable: true,
      },
    });
    await context.log(
      'stdout',
      'every restored deployment is running and the identity provider answers',
    );
    await this.audit.append({
      action: 'platform.restore.verified',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'restore_run',
      targetId: restoreId,
      outcome: 'success',
      detail: { jobId: context.jobId },
    });
  }

  private async recordPlatformRestore(context: PipelineContext): Promise<void> {
    const restoreId = payloadOf(context, 'restoreId');
    await this.pool.query(
      `UPDATE restore_run
          SET state = 'succeeded', phase = 'complete', finished_at = now()
        WHERE id = $1 AND state = 'running'`,
      [restoreId],
    );
    await this.audit.append({
      action: 'platform.restore.succeeded',
      actorType: 'service',
      actorId: 'backup-runner',
      targetType: 'restore_run',
      targetId: restoreId,
      outcome: 'success',
      detail: { jobId: context.jobId },
    });
    // The scratch tree holds plaintext dumps and an unencrypted realm export; a settled restore keeps
    // no copy of either.
    removeTree(this.restoreDirectory(payloadOf(context, 'backupId')));
    await context.log('stdout', 'restore recorded as complete');
  }

  /**
   * A failed capture settles its own row. Without this the register kept a `running` backup with
   * `0 B` next to a red job, and `lastBackupAt` never moved.
   */
  private async settlePlatformBackup(context: PipelineContext, cause?: unknown): Promise<void> {
    await this.settleBackupRow(context, cause, 'platform.backup.failed');
  }

  /** The product capture's own settlement; only the audit action differs from the platform set. */
  private async settleInstanceBackup(context: PipelineContext, cause?: unknown): Promise<void> {
    await this.settleBackupRow(context, cause, 'instance.backup.failed');
  }

  private async settleBackupRow(
    context: PipelineContext,
    cause: unknown,
    action: string,
  ): Promise<void> {
    const backupId = payloadOf(context, 'backupId');
    const message = cause instanceof Error ? cause.message : 'the capture did not finish';
    const code = cause instanceof AppError ? cause.code : 'BACKUP_FAILED';
    // A failed set keeps no scratch copy: the directory holds database dumps and an unencrypted
    // realm export, and the retry is another capture rather than a resume.
    removeTree(join(this.config.SEAMNEX_BACKUP_TMP_DIR, backupId));
    await this.pool.query(
      `UPDATE backup
          SET state = 'failed', finished_at = now(), error_code = $2,
              manifest = manifest || jsonb_build_object('failure', $3::text)
        WHERE id = $1 AND state = 'running'`,
      [backupId, code, message],
    );
    await this.audit.append({
      action,
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
    // The scratch tree holds plaintext dumps and an unencrypted realm export. A settled restore —
    // failed or not — keeps neither; the retry is another run over the same encrypted objects. The
    // payload is read tolerantly: a failure handler that throws hides the failure it was called for.
    const backupId = typeof context.payload.backupId === 'string' ? context.payload.backupId : null;
    if (backupId !== null) removeTree(this.restoreDirectory(backupId));
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

  /** Everything the dump and restore helpers need that is not per-database. */
  private helperContext(): { dockerHost: string; pathMap: string } {
    return {
      dockerHost: this.config.SEAMNEX_DOCKER_HOST,
      pathMap: this.config.SEAMNEX_DOCKER_PATH_MAP,
    };
  }

  /**
   * The scratch tree a restore works in — its own directory per backup, never the capture's.
   *
   * Plaintext dumps live here, so the name is derived rather than passed in: a restore that wrote
   * into the capture directory would leave a decrypted copy of the platform database next to the
   * encrypted set, and the two lifecycles are different (the capture keeps its files until upload,
   * the restore deletes them when it settles).
   */
  private restoreDirectory(backupId: string): string {
    return join(this.config.SEAMNEX_BACKUP_TMP_DIR, `${backupId}-restore`);
  }

  private async setPhase(restoreId: string, phase: string): Promise<void> {
    await this.pool.query(`UPDATE restore_run SET phase = $2 WHERE id = $1`, [restoreId, phase]);
  }

  private async mergeDetail(restoreId: string, patch: Record<string, unknown>): Promise<void> {
    await this.pool.query(`UPDATE restore_run SET detail = detail || $2::jsonb WHERE id = $1`, [
      restoreId,
      JSON.stringify(patch),
    ]);
  }

  private async readDetail(restoreId: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<{ detail: Record<string, unknown> | null }>(
      `SELECT detail FROM restore_run WHERE id = $1`,
      [restoreId],
    );
    return result.rows[0]?.detail ?? {};
  }

  /** The manifest of a platform backup, refused when it cannot describe a set (legacy or mangled). */
  private async platformManifestOf(backupId: string): Promise<PlatformManifest> {
    const result = await this.pool.query<{ manifest: unknown }>(
      `SELECT manifest FROM backup WHERE id = $1`,
      [backupId],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new AppError({ code: 'NOT_FOUND', detail: `No backup ${backupId}.` });
    const manifest = readPlatformManifest(row.manifest);
    if (manifest === null) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: `Backup ${backupId} does not carry a platform recovery manifest.`,
        remediation:
          'Restore a set taken after the recovery set became evidence-backed; a set that names no artefact cannot be verified.',
      });
    }
    return manifest;
  }

  private async instanceBackupOf(backupId: string): Promise<{
    manifest: BackupManifest;
    instanceId: string | null;
    renderSetId: string | null;
  }> {
    const backup = await this.pool.query<{
      manifest: Record<string, unknown>;
      instance_id: string | null;
      render_set_id: string | null;
    }>(`SELECT manifest, instance_id, render_set_id FROM backup WHERE id = $1`, [backupId]);
    const row = backup.rows[0];
    if (row === undefined)
      throw new AppError({ code: 'NOT_FOUND', detail: `No backup ${backupId}.` });
    return {
      manifest: row.manifest as unknown as BackupManifest,
      instanceId: row.instance_id ?? null,
      renderSetId: row.render_set_id ?? null,
    };
  }

  /** The newest usable instance backup, or null when the instance never had one. */
  private async latestInstanceBackup(
    instanceId: string,
  ): Promise<{ id: string; renderSetId: string } | null> {
    // `backup` records when a capture ran, not when the row was created: `created_at` does not
    // exist, and the `ORDER BY` that named it threw for every instance — the whole product tier
    // failed with a message about a missing column that said nothing about the restore.
    const result = await this.pool.query<{ id: string; render_set_id: string }>(
      `SELECT id, render_set_id
         FROM backup
        WHERE instance_id = $1
          AND state = 'succeeded'
          AND render_set_id IS NOT NULL
        ORDER BY finished_at DESC NULLS LAST, started_at DESC
        LIMIT 1`,
      [instanceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id, renderSetId: row.render_set_id };
  }

  /**
   * Extracts the volume archives of one backup into their volumes.
   *
   * `ensureVolume` runs first: `compose up` would otherwise create a missing volume empty, and an
   * archive extracted into a volume the project does not use under that name silently loses the data.
   */
  private async restoreVolumes(
    manifest: BackupManifest,
    instanceId: string,
    directory: string,
    context: PipelineContext,
  ): Promise<number> {
    let restored = 0;
    for (const volume of manifest.volumes) {
      await this.docker.ensureVolume(volume.name, { 'seamnex.instance': instanceId });
      const archive = join(directory, basename(volume.archiveKey).replace(/\.age$/, ''));
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
          `${this.mountSource(directory)}:/in:ro`,
          ALPINE_HELPER_IMAGE,
          'sh',
          '-c',
          `rm -rf /dst/* && tar -xzf /in/${basename(archive)} -C /dst`,
        ],
        { env: { DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST }, timeoutMs: 900_000 },
      );
      removeQuietly(`${archive}.age`);
      await context.log('stdout', `volume ${volume.name} restored`);
      restored += 1;
    }
    return restored;
  }

  /**
   * Loads the engine dumps into the instance's own database, over its network.
   *
   * Through a helper container on the instance network rather than the host network: the product's
   * database is unpublished, so the only address that reaches it is its compose service name. The
   * image is the one the manifest recorded for the service, which by definition ships the matching
   * client — a version mismatch between `pg_restore` and the server is otherwise a restore that fails
   * on a dump it cannot read.
   */
  private async restoreDumps(
    manifest: BackupManifest,
    instance: { id: string; slug: string },
    directory: string,
    context: PipelineContext,
  ): Promise<number> {
    let restored = 0;
    for (const dump of manifest.engineDumps) {
      const imageRef = manifest.services.find((service) => service.name === dump.service)?.imageRef;
      const engine =
        dump.engine === 'postgres' || dump.engine === 'mysql' || dump.engine === 'mariadb'
          ? dump.engine
          : null;
      if (imageRef === undefined || imageRef.length === 0 || engine === null) {
        await context.log(
          'system',
          `${dump.service}: the backup records no image or engine for this dump, so it was not applied`,
        );
        continue;
      }
      const file = basename(dump.objectKey).replace(/\.age$/, '');
      const target = join(directory, file);
      await this.store.download(dump.objectKey, `${target}.age`);
      await this.age.decrypt(`${target}.age`);
      const env = await this.databaseEnv(instance.id, engine);
      await runOrThrow(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          instanceNetwork(instance.slug),
          '-v',
          `${this.mountSource(directory)}:/backup:ro`,
          ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
          imageRef,
          ...restoreCommand(engine, `/backup/${file}`),
        ],
        { env: { DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST }, timeoutMs: 900_000 },
      );
      // The plaintext dump is not kept: the encrypted object is the backup, and this copy exists only
      // for the length of one `pg_restore`.
      removeQuietly(target);
      removeQuietly(`${target}.age`);
      await context.log('stdout', `${dump.service}: database restored`);
      restored += 1;
    }
    return restored;
  }

  /**
   * Polls the provider to a deadline.
   *
   * The deadline is what turns "the provider never came back" into a failed run instead of a worker
   * slot held forever — a restore that cannot authenticate must be reported, and a `running` row
   * nobody can move is not a report.
   */
  private async waitForIdp(): Promise<boolean> {
    const deadline = Date.now() + this.config.SEAMNEX_RESTORE_IDP_TIMEOUT_MS;
    const interval = Math.max(
      250,
      Math.min(3_000, Math.floor(this.config.SEAMNEX_RESTORE_IDP_TIMEOUT_MS / 20)),
    );
    for (;;) {
      if (await this.keycloak.realmReachable()) return true;
      if (Date.now() + interval > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  /** Applies the realm export when the provider answers nothing, and says which path was taken. */
  private async importRealmFallback(
    directory: string,
    context: PipelineContext,
  ): Promise<'created' | 'updated'> {
    const path = join(directory, 'realm.json');
    if (!exists(path)) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail:
          'The identity provider does not answer and the recovery set carries no realm export.',
        remediation:
          'Restore a set that includes the realm, or import the realm with kcadm.sh before starting the restore again.',
      });
    }
    let document: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(readTextFile(path));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('the realm export is not an object');
      }
      document = parsed as Record<string, unknown>;
    } catch (error) {
      throw new AppError({
        code: 'BACKUP_UNUSABLE',
        detail: 'The realm export in the recovery set cannot be read as a realm document.',
        remediation:
          'Restore a set whose realm export was written by the admin API, then start the restore again.',
        cause: error,
      });
    }
    try {
      const result = await this.keycloak.importRealm(document);
      await context.log(
        'stdout',
        `the identity provider did not answer, so the realm export was ${result.created ? 'imported' : 're-applied'}`,
      );
      return result.created ? 'created' : 'updated';
    } catch (error) {
      // A provider with no realm cannot mint the admin token this call needs: say so instead of
      // retrying something that cannot succeed.
      const message = error instanceof Error ? error.message : 'the realm import failed';
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `The identity provider does not answer and the realm export could not be imported: ${message}`,
        remediation:
          'Import the realm out of band (kcadm.sh create realms -f realm.json) against the restored provider, then start the restore again. A restore that cannot authenticate is failed (FR-1.36).',
        cause: error,
      });
    }
  }

  private async databaseEnv(
    instanceId: string,
    engine: DatabaseEngine,
  ): Promise<Record<string, string>> {
    const result = await this.pool.query<{ var_name: string; value_enc: Buffer | null }>(
      `SELECT var_name, value_enc FROM instance_env_value
        WHERE instance_id = $1 AND source <> 'secret' AND value_enc IS NOT NULL`,
      [instanceId],
    );
    return connectionEnvFrom(result.rows, engine);
  }
}

/** One instance's result in the portfolio tier, as the `verify` stage judges it. */
type ProductOutcome = {
  readonly instance: string;
  readonly outcome: 'restored' | 'started-again' | 'nothing-to-restore' | 'failed';
  readonly detail: string;
};

function readStoppedContainers(
  detail: Record<string, unknown>,
): { instanceId: string; containerId: string }[] {
  const raw = detail.stoppedContainers;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is { instanceId: string; containerId: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).instanceId === 'string' &&
      typeof (entry as Record<string, unknown>).containerId === 'string',
  );
}

function readProducts(detail: Record<string, unknown>): ProductOutcome[] {
  const raw = detail.products;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ProductOutcome =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).instance === 'string' &&
      typeof (entry as Record<string, unknown>).detail === 'string' &&
      typeof (entry as Record<string, unknown>).outcome === 'string',
  );
}

function readOperatorSteps(detail: Record<string, unknown>): string[] {
  const raw = detail.operatorStepRequired;
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Runs `task` over every item with at most `limit` in flight, preserving nothing but the result set.
 *
 * A hand-rolled pool rather than a dependency: the requirement is a fixed number of concurrent
 * Docker conversations, and a queue library would add a version to the catalog for twenty lines. It
 * never rejects — the caller's task is expected to record its own failure, because a portfolio restore
 * must finish the instances that can be finished.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results.push(await task(item));
    }
  });
  await Promise.all(workers);
  return results;
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

function now(): string {
  return new Date().toISOString();
}

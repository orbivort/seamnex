import { statSync } from 'node:fs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DeployPreview, DriftRecord, Instance, InstanceDetail } from '@seamnex/domain';
import type {
  DeployInput,
  DeployResult,
  ExportArchive,
  Image,
  InstanceExport,
  InstancePlan,
  LifecycleInput,
  PreviewInput,
} from './executor.contract';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { AppError } from '../../common/problem/app-error';
import { isFile } from '../../common/fs/files';
import { isUuid } from '../../common/http/uuid';
import { CAPACITY_SERVICE, type CapacityService } from '../m19-capacity/capacity.contract';
import { PLANNER_SERVICE, type PlannerService } from '../m04-planner/planner.contract';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { imageTagOf } from '../../common/docker/image-ref';
import { InstanceLifecycleService } from './lifecycle.service';
import type { ExecutorService } from './executor.contract';
import {
  archivePath,
  exportsDirectory,
  listExportRecords,
  readExportRecord,
  toInstanceExport,
} from './instance-exports';

type InstanceRow = {
  id: string;
  entry_key: string;
  slug: string;
  domain_route: string;
  profile_key: string | null;
  state: string;
  desired_state: string | null;
  payload: Record<string, unknown>;
  updated_at: Date;
  created_at: Date;
  /** The catalog document: the descriptive source when the instance payload does not carry it. */
  entry_payload: Record<string, unknown> | null;
  route_host: string | null;
  route_path_prefix: string | null;
  route_publish_model: string | null;
  route_tls_mode: string | null;
  route_auth_mode: string | null;
  route_published: boolean | null;
  status_state: string | null;
  status_ready: boolean | null;
  status_observed_at: Date | null;
  status_source: string | null;
  status_reason: string | null;
  source_path: string | null;
  source_url: string | null;
  source_revision: string | null;
  source_image_ref: string | null;
  source_policy_verdict: string | null;
  source_resolved_at: Date | null;
};

/**
 * The read-model projection, in one place so the fleet list and the detail page cannot drift.
 *
 * `payload` is a document the *writer* chose (the deploy pipeline writes a partial one, a seeded
 * row may carry none). It is therefore an input, never the answer: every contract field is filled
 * from the relational tables first and only then from the document. Projecting the document alone
 * is what made `GET /instances` answer `500` on a freshly seeded host.
 */
const INSTANCE_SELECT = `
  SELECT i.id, i.entry_key, i.slug, i.domain_route, i.profile_key, i.state, i.desired_state,
         i.payload, i.updated_at, i.created_at,
         e.payload AS entry_payload,
         r.host AS route_host, r.path_prefix AS route_path_prefix,
         r.publish_model AS route_publish_model, r.tls_mode AS route_tls_mode,
         r.auth_mode AS route_auth_mode, r.published AS route_published,
         s.state AS status_state, s.ready AS status_ready, s.observed_at AS status_observed_at,
         s.source AS status_source, s.reason AS status_reason,
         src.path AS source_path, src.source_url AS source_url,
         src.source_revision AS source_revision, src.resolved_image_ref AS source_image_ref,
         src.policy_verdict AS source_policy_verdict, src.created_at AS source_resolved_at
    FROM instance i
    LEFT JOIN catalog_entry e ON e.key = i.entry_key
    LEFT JOIN instance_route r ON r.instance_id = i.id
    LEFT JOIN instance_status s ON s.instance_id = i.id
    LEFT JOIN LATERAL (
      SELECT path, source_url, source_revision, resolved_image_ref, policy_verdict, created_at
        FROM source_resolution WHERE instance_id = i.id ORDER BY created_at DESC LIMIT 1
    ) src ON true`;

/**
 * The instance read model (deliverable 2.4). The row's document supplies the descriptive fields;
 * the relational columns and the status table always win, because they are what the platform
 * actually knows (ADR-BE-09 D10).
 */

@Injectable()
export class PostgresExecutorService implements ExecutorService {
  private readonly logger = new Logger('m05-executor');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PLANNER_SERVICE) private readonly planner: PlannerService,
    @Inject(InstanceLifecycleService) private readonly lifecycleService: InstanceLifecycleService,
    @Inject(CAPACITY_SERVICE) private readonly capacity: CapacityService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  preview(input: PreviewInput): Promise<DeployPreview> {
    return this.lifecycleService.preview(input);
  }

  async recordCapacitySample(): Promise<void> {
    await this.capacity.record();
  }

  /**
   * FR-1.9 — the measured half of the per-volume limit.
   *
   * `instance_volume` belongs to this module, so the sample is taken here and M06 only triggers it
   * (the same arrangement as the capacity snapshot). One pass per cycle, sequential: a helper
   * container per volume is an IO-bound metadata walk, and the sampler's interval — not a fan-out —
   * is what bounds the cost.
   *
   * A measurement that fails leaves the previous figure in place. Writing `0` because the daemon did
   * not answer would turn "unknown" into "empty", which is precisely the false claim this issue is
   * about. Crossing the quota is audited once, at the moment it happens, so the evidence names the
   * volume and the numbers rather than repeating every cycle.
   */
  async recordVolumeUsage(): Promise<void> {
    const result = await this.pool.query<{
      instance_id: string;
      name: string;
      quota_mb: number | null;
      used_mb: number;
    }>(
      `SELECT v.instance_id, v.name, v.quota_mb, v.used_mb
         FROM instance_volume v
         JOIN instance i ON i.id = v.instance_id AND i.deleted_at IS NULL
        ORDER BY v.instance_id, v.name`,
    );

    for (const volume of result.rows) {
      const usedMb = await this.docker.volumeUsageMb(volume.name).catch((error: unknown) => {
        this.logger.warn(
          `volume ${volume.name} could not be measured: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
      if (usedMb === null) continue;

      await this.pool.query(
        `UPDATE instance_volume SET used_mb = $3, sampled_at = now()
          WHERE instance_id = $1 AND name = $2`,
        [volume.instance_id, volume.name, usedMb],
      );

      const quotaMb = volume.quota_mb ?? 0;
      if (quotaMb <= 0 || usedMb < quotaMb || volume.used_mb >= quotaMb) continue;
      this.logger.warn(
        `volume ${volume.name} of instance ${volume.instance_id} holds ${usedMb} MiB against a ${quotaMb} MiB quota`,
      );
      await this.audit.append({
        action: 'instance.volume.quota_exceeded',
        actorType: 'service',
        actorId: 'status-sampler',
        targetType: 'instance',
        targetId: volume.instance_id,
        outcome: 'failure',
        detail: { volume: volume.name, usedMb, quotaMb },
      });
    }
  }

  /**
   * FR-4.5 / AC-39 — per-instance consumption, measured from the containers themselves.
   *
   * The capacity board used to label the deploy request's declared shape as "usage", so an idle
   * container that reserved 2 GB and held 40 MiB was indistinguishable from one at its limit. This
   * pass sums the daemon's own counters per instance and writes one sample per cycle.
   *
   * Three rules it must not break:
   *   - **no daemon, no row.** A failed `stats` call skips the instance instead of writing `0`, which
   *     would turn "unknown" into "idle" — the exact false claim this work removes.
   *   - **only running containers.** A stopped product holds no CPU, and its last sample is what the
   *     board should keep showing until a new one arrives.
   *   - **disk comes from `instance_volume`.** The volume walk is the platform's only measurement of
   *     file data (FR-1.9), so summing it here is reuse, not a second definition.
   */
  async recordInstanceUsage(): Promise<{ sampled: number }> {
    const containers = await this.docker
      .containers(['seamnex.instance'], true)
      .catch((error: unknown) => {
        this.logger.warn(
          `container list failed; no usage sample taken: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      });

    const byInstance = new Map<string, string[]>();
    for (const container of containers) {
      const instanceId = container.labels['seamnex.instance'];
      if (instanceId === undefined || container.state !== 'running') continue;
      const list = byInstance.get(instanceId) ?? [];
      list.push(container.id);
      byInstance.set(instanceId, list);
    }
    if (byInstance.size === 0) return { sampled: 0 };

    const volumes = await this.pool.query<{ instance_id: string; used_mb: string }>(
      `SELECT instance_id, COALESCE(SUM(used_mb), 0)::text AS used_mb
         FROM instance_volume
        GROUP BY instance_id`,
    );
    const diskByInstance = new Map(
      volumes.rows.map((row) => [row.instance_id, Number(row.used_mb)]),
    );

    let sampled = 0;
    for (const [instanceId, containerIds] of byInstance) {
      let cpuMilli = 0;
      let memoryMb = 0;
      let measured = 0;
      for (const containerId of containerIds) {
        // One call per container: a single stats read is a few milliseconds, and the batch size is
        // bounded by the number of containers the platform itself created.
        const stats = await this.docker.stats(containerId).catch((error: unknown) => {
          this.logger.warn(
            `stats for container ${containerId} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return null;
        });
        if (stats === null) continue;
        cpuMilli += stats.cpuMilli;
        memoryMb += stats.memoryMb;
        measured += 1;
      }
      if (measured === 0) continue;

      await this.pool.query(
        `INSERT INTO instance_usage_sample (instance_id, cpu_milli, memory_mb, disk_mb, containers)
         VALUES ($1, $2, $3, $4, $5)`,
        [instanceId, cpuMilli, memoryMb, diskByInstance.get(instanceId) ?? 0, measured],
      );
      sampled += 1;
    }

    if (sampled > 0) await this.pruneUsageSamples();
    return { sampled };
  }

  /**
   * Retention for the samples. One `DELETE` per pass that inserted something, which is why it is
   * not a scheduled job of its own: the table has no other writer.
   */
  private async pruneUsageSamples(): Promise<void> {
    const days = this.config.SEAMNEX_USAGE_SAMPLE_RETENTION_DAYS;
    await this.pool.query(
      `DELETE FROM instance_usage_sample WHERE sampled_at < now() - ($1 || ' days')::interval`,
      [String(days)],
    );
  }

  deploy(input: DeployInput): Promise<DeployResult> {
    return this.lifecycleService.deploy(input);
  }

  abandonDeployment(instanceId: string, actorId: string, reason: string): Promise<void> {
    return this.lifecycleService.abandonDeployment(instanceId, actorId, reason);
  }

  lifecycle(input: LifecycleInput): Promise<{ jobId: string; kind: string }> {
    return this.lifecycleService.lifecycle(input);
  }

  prefetch(entryKey: string, actorId: string): Promise<{ jobId: string }> {
    return this.lifecycleService.prefetch(entryKey, actorId);
  }

  async instances(filter: { q?: string; state?: string; entryKey?: string }): Promise<Instance[]> {
    const q = (filter.q ?? '').toLowerCase();
    const result = await this.pool.query<InstanceRow>(
      `${INSTANCE_SELECT}
        WHERE i.deleted_at IS NULL
          AND ($1 = '' OR lower(i.slug) LIKE '%' || $1 || '%'
               OR lower(coalesce(i.payload->>'product', e.product, '')) LIKE '%' || $1 || '%'
               OR lower(coalesce(i.payload->>'domain', e.domain, '')) LIKE '%' || $1 || '%')
          AND ($2 = '' OR i.state = $2)
          AND ($3 = '' OR i.entry_key = $3)
        ORDER BY i.created_at DESC, i.id`,
      [q, filter.state ?? '', filter.entryKey ?? ''],
    );
    return result.rows.map((row) => this.toInstance(row));
  }

  async instance(id: string): Promise<InstanceDetail> {
    if (!isUuid(id)) throw notFound(id);
    const result = await this.pool.query<InstanceRow>(
      `${INSTANCE_SELECT} WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw notFound(id);

    const [base, services, volumes] = await Promise.all([
      this.toInstance(row),
      this.pool.query<{
        service_name: string;
        role: string;
        image_ref: string;
        image_digest: string | null;
        internal_url: string | null;
      }>(
        `SELECT service_name, role, image_ref, image_digest, internal_url FROM instance_service WHERE instance_id = $1 ORDER BY service_name`,
        [id],
      ),
      this.pool.query<{
        name: string;
        mount_path: string;
        quota_mb: number | null;
        used_mb: number | null;
      }>(
        `SELECT name, mount_path, quota_mb, used_mb FROM instance_volume WHERE instance_id = $1 ORDER BY name`,
        [id],
      ),
    ]);

    // A volume registered before the catalog described it has no quota of its own; the instance's
    // disk reservation is the honest upper bound. `1` was neither: it made every such volume read as
    // permanently full.
    const reservationMb = Math.max(1, Math.round(base.resources.diskMb));
    const maintenance = base.maintenance;
    return {
      ...base,
      services: services.rows.map((service) => ({
        id: `${id}:${service.service_name}`,
        serviceName: service.service_name,
        role: service.role as InstanceDetail['services'][number]['role'],
        imageRef: service.image_ref,
        imageDigest: service.image_digest ?? 'sha256:unknown',
        internalUrl: service.internal_url ?? `http://${service.service_name}`,
      })),
      volumes: volumes.rows.map((volume) => ({
        id: `${id}:${volume.name}`,
        name: volume.name,
        mountPath: volume.mount_path,
        quotaMb: volume.quota_mb !== null && volume.quota_mb > 0 ? volume.quota_mb : reservationMb,
        usedMb: volume.used_mb ?? 0,
      })),
      integrationChecks: [],
      maintenance,
    };
  }

  /**
   * FR-1.13 / AC-20 — what the platform can honestly say this instance exported.
   *
   * Read from the sidecars the capture wrote, so the list cannot promise an archive that is not
   * there. A sidecar that fails to parse is skipped with a warning: one interrupted write must not
   * hide the others.
   */
  async exports(instanceId: string): Promise<InstanceExport[]> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    await this.assertInstanceExists(instanceId);
    const records = await listExportRecords(
      exportsDirectory(this.config.SEAMNEX_INSTANCE_DATA_DIR, instanceId),
      {
        onSkip: (fileName, reason) => this.logger.warn(`export ${fileName} skipped: ${reason}`),
      },
    );
    return records.map(toInstanceExport);
  }

  /**
   * Resolves an archive for the dispatcher to stream.
   *
   * The size check is not belt-and-braces: `content-length` is taken from the manifest, so serving a
   * truncated file would answer `200` with a short body and a browser would keep the fragment. A
   * mismatch is refused with the numbers named.
   */
  async exportArchive(instanceId: string, exportId: string): Promise<ExportArchive> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    await this.assertInstanceExists(instanceId);

    const directory = exportsDirectory(this.config.SEAMNEX_INSTANCE_DATA_DIR, instanceId);
    const record = await readExportRecord(directory, exportId);
    const path = archivePath(this.config.SEAMNEX_INSTANCE_DATA_DIR, instanceId, exportId);
    if (record === null || !isFile(path)) throw noExport(exportId);

    const bytes = statSync(path).size;
    if (bytes !== record.archive.bytes) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `Export ${exportId} is ${bytes} bytes on disk but its manifest records ${record.archive.bytes}.`,
        remediation:
          'The archive is truncated and was not served. Run the export again; the previous file is kept until you remove it.',
      });
    }
    return { path, fileName: record.archive.fileName, bytes };
  }

  /**
   * The row outlives the deployment (delete is a soft delete), and this check deliberately does not
   * filter `deleted_at`: AC-20's order is "export, then teardown", and an archive that becomes
   * unreachable the moment the instance is torn down would defeat the exit strategy it exists for.
   */
  private async assertInstanceExists(instanceId: string): Promise<void> {
    const result = await this.pool.query<{ id: string }>(`SELECT id FROM instance WHERE id = $1`, [
      instanceId,
    ]);
    if (result.rows[0] === undefined) throw notFound(instanceId);
  }

  /**
   * FR-1.29 — the environment drift of one instance.
   *
   * `scope = 'environment'` is part of the read, not a filter the screen applies: the panel is
   * titled "Environment drift", the requirement is about the environment, and a definition-hash row
   * shown there was labelled `varName: 'environment'` because nothing distinguished it. Definition
   * drift keeps its own writer and its own audit trail; it is not an environment variable.
   */
  async drift(instanceId: string): Promise<DriftRecord[]> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const result = await this.pool.query<{
      id: string;
      detail: Record<string, unknown>;
      expected_hash: string | null;
      observed_hash: string | null;
      detected_at: Date;
      resolved_at: Date | null;
    }>(
      `SELECT id, detail, expected_hash, observed_hash, detected_at, resolved_at
         FROM drift_record
        WHERE instance_id = $1 AND scope = 'environment'
        ORDER BY detected_at DESC`,
      [instanceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      varName: typeof row.detail.varName === 'string' ? row.detail.varName : 'unknown',
      declared: typeof row.detail.declared === 'string' ? row.detail.declared : row.expected_hash,
      observed: typeof row.detail.observed === 'string' ? row.detail.observed : row.observed_hash,
      kind: driftKind(row.detail.kind),
      detectedAt: row.detected_at.toISOString(),
      resolvedAt: row.resolved_at?.toISOString() ?? null,
    }));
  }

  async images(instanceId: string): Promise<Image[]> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const result = await this.pool.query<{
      image_digest: string;
      source_revision: string | null;
      object_key: string;
      created_at: Date;
    }>(
      `SELECT image_digest, source_revision, object_key, created_at
         FROM image_artefact WHERE instance_id = $1 ORDER BY created_at DESC`,
      [instanceId],
    );
    return result.rows.map((row, index) => ({
      digest: row.image_digest,
      version: row.source_revision ?? 'unversioned',
      state: index === 0 ? 'current' : 'previous',
      builtAt: row.created_at.toISOString(),
      artefact: row.object_key,
    }));
  }

  /** 4A.4: the plan projection now carries a real capacity verdict and a real diff. */
  plan(instanceId: string, action: string): Promise<InstancePlan> {
    return this.planner.instancePlan(instanceId, action);
  }

  private toInstance(row: InstanceRow): Instance {
    const payload = row.payload ?? {};
    const entry = row.entry_payload ?? {};
    const text = (source: Record<string, unknown>, key: string): string | null => {
      const value = source[key];
      return typeof value === 'string' && value.length > 0 ? value : null;
    };
    const number = (source: Record<string, unknown>, key: string): number | null => {
      const value = source[key];
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    };

    const resources = asRecord(payload.resources) ?? asRecord(entry.resources) ?? {};
    const resourceShape = {
      cpu: number(resources, 'cpu') ?? 0.25,
      memoryMb: Math.max(1, Math.round(number(resources, 'memoryMb') ?? 256)),
      diskMb: Math.max(1, Math.round(number(resources, 'diskMb') ?? 1024)),
    };
    const usage = asRecord(payload.usage) ?? {};
    const imageRef = text(payload, 'imageRef') ?? text(entry, 'imageRef') ?? 'unknown';
    const imageDigest =
      text(payload, 'imageDigest') ?? text(entry, 'imageDigest') ?? 'sha256:unknown';
    const upstream = asRecord(entry.upstream) ?? {};
    /*
     * FR-1.7: both halves of the delta come from facts that have a writer.
     *
     * `currentVersion` is what the last apply recorded (payload), falling back to the image tag the
     * instance was deployed with; `availableVersion` is the entry's upstream pin. The old pair read
     * two payload keys nothing wrote, so the dialog showed a version from a tag and "no update" for
     * ever.
     */
    const currentVersion = text(payload, 'currentVersion') ?? imageTagOf(imageRef) ?? 'unversioned';
    const latestVersion = text(upstream, 'latestVersion');
    const state = (row.status_state ?? row.state) as Instance['state'];
    const owner = namedRef(asRecord(payload.owner), text(entry, 'owner') ?? 'unassigned');
    const domainOwner = namedRef(
      asRecord(payload.domainOwner),
      text(entry, 'domainOwner') ?? owner.name,
    );
    const integration = asRecord(entry.integration) ?? {};

    return {
      id: row.id,
      slug: row.slug,
      entryKey: row.entry_key,
      entryKeys: [
        row.entry_key,
        ...asStringArray(payload.entryKeys).filter((key) => key !== row.entry_key),
      ],
      domain: text(payload, 'domain') ?? text(entry, 'domain') ?? 'Unassigned',
      product: text(payload, 'product') ?? text(entry, 'product') ?? row.entry_key,
      description:
        text(payload, 'description') ?? text(entry, 'description') ?? `${row.entry_key} deployment`,
      domainRoute: row.domain_route,
      profileKey: row.profile_key ?? text(payload, 'profileKey') ?? 'default',
      state,
      desiredState: (row.desired_state ??
        (state === 'stopped' ? 'stopped' : 'running')) as Instance['desiredState'],
      ready: row.status_ready ?? false,
      statusSource: (row.status_source ?? 'poll') as Instance['statusSource'],
      observedAt: (row.status_observed_at ?? row.updated_at).toISOString(),
      stateReason: row.status_reason ?? null,
      owner,
      domainOwner,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      currentVersion,
      availableVersion:
        latestVersion !== null && latestVersion !== currentVersion ? latestVersion : null,
      imageDigest,
      source: {
        path: (row.source_path ??
          text(payload, 'sourcePath') ??
          'compose') as Instance['source']['path'],
        sourceUrl: row.source_url ?? text(entry, 'repoUrl') ?? 'local',
        sourceRevision: row.source_revision ?? 'local',
        resolvedImageRef: row.source_image_ref ?? imageRef,
        policyVerdict: policyVerdict(row.source_policy_verdict),
        policyNotes: [],
        resolvedAt: (row.source_resolved_at ?? row.created_at).toISOString(),
      },
      route: {
        host: row.route_host ?? text(asRecord(payload.route) ?? {}, 'host') ?? row.domain_route,
        pathPrefix: row.route_path_prefix ?? '/',
        publishModel: (row.route_publish_model ?? 'subdomain') as Instance['route']['publishModel'],
        tlsMode: (row.route_tls_mode ?? 'acme') as Instance['route']['tlsMode'],
        authMode: (row.route_auth_mode ??
          text(entry, 'guaranteeClass') ??
          'native') as Instance['route']['authMode'],
        published: row.route_published ?? false,
      },
      resources: resourceShape,
      usage: {
        cpuPercent: number(usage, 'cpuPercent') ?? 0,
        memoryMb: number(usage, 'memoryMb') ?? 0,
        diskMb: number(usage, 'diskMb') ?? 0,
      },
      maintenance: asRecord(payload.maintenance) as Instance['maintenance'],
      backup: (asRecord(payload.backup) as Instance['backup'] | null) ?? {
        lastSuccessAt: null,
        lastVerifiedRestoreAt: null,
        schedule: 'not scheduled',
        scheduleTimezone: 'UTC',
        scheduleEnabled: false,
        verified: false,
      },
      eventModes: asEventModes(integration.eventModes),
      licenseId: text(payload, 'licenseId') ?? text(entry, 'licenseId') ?? 'unreviewed',
      licenseRestricted: payload.licenseRestricted === true,
      integrationVerified:
        payload.integrationVerified === true || text(integration, 'verifiedAt') !== null,
      metadataStale: payload.metadataStale === true || integration.stale === true,
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** The contract's `NamedRef` needs an id and a name; a bare string is the common case in `payload`. */
function namedRef(
  value: Record<string, unknown> | null,
  fallback: string,
): { id: string; name: string } {
  const id = typeof value?.id === 'string' && value.id.length > 0 ? value.id : fallback;
  const name = typeof value?.name === 'string' && value.name.length > 0 ? value.name : fallback;
  return { id, name };
}

/** Compose verdicts are stored permissively; the contract advertises three states. */
function policyVerdict(value: string | null): Instance['source']['policyVerdict'] {
  if (value === 'blocked') return 'violations';
  if (value === 'unsafe_approved') return 'exception-approved';
  return 'compliant';
}

function asEventModes(value: unknown): Instance['eventModes'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const mode = record?.mode;
    if (mode !== 'webhook' && mode !== 'schedule' && mode !== 'poll' && mode !== 'none') return [];
    const label =
      typeof record?.label === 'string' && record.label.length > 0 ? record.label : mode;
    const interval =
      typeof record?.minimumIntervalMinutes === 'number'
        ? record.minimumIntervalMinutes
        : undefined;
    return [
      interval === undefined ? { mode, label } : { mode, label, minimumIntervalMinutes: interval },
    ];
  });
}

/**
 * `detail.kind` is JSON written by the producer, so it is narrowed rather than cast: a row whose
 * kind is anything else would violate `DriftRecordSchema` on the client, and a contract violation
 * surfaces as an empty panel, not as an error an operator can read.
 */
function driftKind(value: unknown): DriftRecord['kind'] {
  return value === 'missing' || value === 'undeclared' || value === 'mismatch' ? value : 'mismatch';
}

function notFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No instance ${id}.`,
    remediation: 'Refresh the instance list.',
  });
}

function noExport(exportId: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No export ${exportId} for this instance.`,
    remediation:
      'Refresh the export list. An archive removed from disk is no longer listed, and nothing is served from a stale entry.',
  });
}

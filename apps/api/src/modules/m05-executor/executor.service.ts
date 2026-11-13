import { Inject, Injectable } from '@nestjs/common';
import type { DeployPreview, DriftRecord, Instance, InstanceDetail } from '@seamnex/domain';
import type {
  DeployInput,
  DeployResult,
  Image,
  InstancePlan,
  LifecycleInput,
  PreviewInput,
} from './executor.contract';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { isUuid } from '../../common/http/uuid';
import { CAPACITY_SERVICE, type CapacityService } from '../m19-capacity/capacity.contract';
import { PLANNER_SERVICE, type PlannerService } from '../m04-planner/planner.contract';
import { InstanceLifecycleService } from './lifecycle.service';
import type { ExecutorService } from './executor.contract';

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
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(PLANNER_SERVICE) private readonly planner: PlannerService,
    @Inject(InstanceLifecycleService) private readonly lifecycleService: InstanceLifecycleService,
    @Inject(CAPACITY_SERVICE) private readonly capacity: CapacityService,
  ) {}

  preview(input: PreviewInput): Promise<DeployPreview> {
    return this.lifecycleService.preview(input);
  }

  async recordCapacitySample(): Promise<void> {
    await this.capacity.record();
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
      this.pool.query<{ name: string; mount_path: string; quota_mb: number | null }>(
        `SELECT name, mount_path, quota_mb FROM instance_volume WHERE instance_id = $1 ORDER BY name`,
        [id],
      ),
    ]);

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
        quotaMb: volume.quota_mb !== null && volume.quota_mb > 0 ? volume.quota_mb : 1,
        usedMb: 0,
      })),
      integrationChecks: [],
      maintenance,
    };
  }

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
         FROM drift_record WHERE instance_id = $1 ORDER BY detected_at DESC`,
      [instanceId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      varName: typeof row.detail.varName === 'string' ? row.detail.varName : 'environment',
      declared: typeof row.detail.declared === 'string' ? row.detail.declared : row.expected_hash,
      observed: typeof row.detail.observed === 'string' ? row.detail.observed : row.observed_hash,
      kind: (typeof row.detail.kind === 'string'
        ? row.detail.kind
        : 'mismatch') as DriftRecord['kind'],
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
      currentVersion: text(payload, 'currentVersion') ?? imageRef.split(':').pop() ?? 'unversioned',
      availableVersion: text(payload, 'availableVersion'),
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

function notFound(id: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No instance ${id}.`,
    remediation: 'Refresh the instance list.',
  });
}

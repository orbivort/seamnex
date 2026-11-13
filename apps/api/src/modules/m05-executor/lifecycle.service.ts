import { Inject, Injectable, Logger } from '@nestjs/common';
import { LIFECYCLE_ACTIONS, type DeployPreview, type LifecycleAction } from '@seamnex/domain';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AppError } from '../../common/problem/app-error';
import { derivedEnvValues } from '../../common/identity/derived-env';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { RENDERER_SERVICE, type RendererService } from '../m03-renderer/renderer.contract';
import { CAPACITY_SERVICE, type CapacityService } from '../m19-capacity/capacity.contract';
import { JobService } from '../../jobs/job.service';
import { PipelineRegistry } from '../../jobs/pipeline-registry';
import type { DeployInput, DeployResult, LifecycleInput, PreviewInput } from './executor.contract';

// The action list lives in `@seamnex/domain` and nowhere else. This file used to keep a private copy,
// and the copy is what made `reconfigure` unreachable: the enum grew, the executor's list did not,
// and the API answered "Unknown lifecycle action" for a pipeline that was registered and tested.
// A second source of truth is not a detail — it is the defect.

type EntryRow = {
  key: string;
  packaging: 'compose' | 'dockerfile' | 'none';
  payload: Record<string, unknown>;
};

/**
 * 4A.6 / 4A.7 — the lifecycle API.
 *
 * Everything a caller can do to an instance starts here, and two rules hold across the whole file:
 *
 *   1. **admission before creation.** Capacity is decided before the instance row exists, so a
 *      refused deployment leaves no half-created instance to clean up (AC-07).
 *   2. **the job is the answer.** A mutation returns `202 { jobId }` and the pipeline does the work;
 *      nothing in this file touches Docker. That is what keeps the API responsive and the work
 *      cancellable, observable and retryable.
 *
 * An upgrade additionally refuses to be created without a backup job id: the pre-upgrade backup is
 * a precondition, not a promise the pipeline makes later (AC-06).
 */
@Injectable()
export class InstanceLifecycleService {
  private readonly logger = new Logger('m05-lifecycle');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RENDERER_SERVICE) private readonly renderer: RendererService,
    @Inject(CAPACITY_SERVICE) private readonly capacity: CapacityService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(PipelineRegistry) private readonly pipelines: PipelineRegistry,
  ) {}

  async deploy(input: DeployInput): Promise<DeployResult> {
    const entry = await this.entry(input.entryKey);
    await this.assertSlugAvailable(input.slug);

    const resources = this.resourcesOf(entry, input);
    /**
     * A deployment may not be given less memory than the entry declares.
     *
     * The declared shape is the reviewed one, and for a containerised runtime it also decides the
     * heap: Metabase (D11) in a 1 GB container gets a 256 MB JVM heap and dies with "Java heap
     * space" during startup, while the declared 2 GB gives it 495 MB and it boots. The wizard
     * pre-fills the field with the declared value, so landing below it takes an edit — and the
     * platform can prove the outcome before creating anything. CPU is not guarded: a smaller share
     * makes a product slow, not impossible.
     */
    const declaredMemoryMb = ((entry.payload.resources ?? {}) as { memoryMb?: number }).memoryMb;
    if (
      input.resources !== undefined &&
      declaredMemoryMb !== undefined &&
      input.resources.memoryMb < declaredMemoryMb
    ) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `${entry.key} is declared with ${declaredMemoryMb} MB of memory; ${input.resources.memoryMb} MB was requested.`,
        fieldErrors: [
          {
            field: 'resources.memoryMb',
            code: 'below_declared_minimum',
            message: `At least ${declaredMemoryMb} MB is required by this entry's declaration.`,
          },
        ],
        remediation:
          'Ask for the declared amount or more; nothing was created. A product that needs less is a catalog edit, not a per-deployment override.',
      });
    }

    const decision = await this.capacity.admit({ resources });
    if (!decision.admissible) {
      throw new AppError({
        code: 'CAPACITY_EXCEEDED',
        detail: decision.headline,
        remediation: `${decision.detail} Free capacity or lower the requested resources; nothing was created.`,
      });
    }

    // Validate the overrides through the same resolution the renderer uses *before* creating the
    // row: a ceiling violation must not leave an instance that can never be deployed.
    const plan = await this.renderer.plan({
      entryKey: entry.key,
      ...(input.profileKey === undefined ? {} : { profileKey: input.profileKey }),
      overrides: input.envOverrides ?? {},
    });
    // The plan is the authority on which profile was used: a requested profile the host does not
    // have resolves to the default one, and the instance must record the key that actually applied.
    const profile = plan.profileKey;
    if (plan.fieldErrors.length > 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: 'The environment overrides are not valid for this entry.',
        fieldErrors: plan.fieldErrors,
        remediation: 'Fix the highlighted variables; nothing was created.',
      });
    }

    const instanceId = await this.insertInstance(entry, input, resources, profile);

    // Everything after the row exists must either succeed or undo the row. A deploy that fails here
    // (a secret write, the queue, the audit chain) used to leave an instance in `requested` with no
    // job: nothing could start it, nothing could retry it, and the slug stayed taken for 30 days.
    try {
      /**
       * The whole resolved chain is applied, not only the operator's overrides.
       *
       * A catalog default used to be a UI value that never reached the container: the render reads
       * `instance_env_value`, and only overrides were written there. EspoCRM therefore installed with
       * `authenticationMethod = Espo` — its own default — while the catalog declared `Oidc`, the plan
       * reported `Oidc` and the deployment was recorded as native SSO. The precedence chain the
       * wizard prints (catalog default → profile → instance override → secret store) is only true if
       * the resolved value is what gets applied.
       *
       * Secrets are skipped: a masked value has nothing to write, and the ones the operator supplied
       * arrive through `envOverrides` and are stored as secret references. Variables capped at
       * `none` are skipped too: `updateInstanceEnv` refuses them by design, because the vendored file
       * owns them.
       */
      const resolved = Object.fromEntries(
        plan.values
          .filter(
            (value) => !value.masked && value.value !== null && value.overrideCeiling !== 'none',
          )
          .map((value) => [value.name, value.value as string]),
      );
      /**
       * Precedence: operator override → derived → catalog default.
       *
       * The two values D1 derives (site URL, client id) are properties of *this* instance, so a
       * catalog default is only right for the deployment it was verified against. Deriving them
       * here, rather than trusting the default, is what keeps a second instance of the same entry
       * from registering a redirect URI that cannot match. An explicit override still wins: an
       * operator who routes the product differently knows something the platform does not.
       */
      const applied = {
        ...resolved,
        ...derivedEnvValues({
          entryKey: entry.key,
          slug: input.slug,
          host: this.hostFor(input.slug),
          scheme: this.config.SEAMNEX_PRODUCT_URL_SCHEME,
          port: this.config.SEAMNEX_PRODUCT_URL_PORT,
        }),
        ...(input.envOverrides ?? {}),
      };
      if (Object.keys(applied).length > 0) {
        await this.renderer.updateInstanceEnv(instanceId, applied, input.actorId);
      }

      const job = await this.createJob('deploy', instanceId, input.actorId, {
        action: 'deploy',
        entryKey: entry.key,
        profileKey: profile,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
      });
      await this.capacity.reserve({ instanceId, resources });
      await this.audit.append({
        action: 'instance.deploy.requested',
        actorType: 'user',
        actorId: input.actorId,
        targetType: 'instance',
        targetId: instanceId,
        outcome: 'success',
        detail: {
          entryKey: entry.key,
          slug: input.slug,
          jobId: job.jobId,
          capacity: decision.headline,
        },
      });
      return { instanceId, jobId: job.jobId };
    } catch (error) {
      await this.abandon(instanceId);
      throw error;
    }
  }

  /**
   * Compensation for a half-created deployment: release the reservation and remove the row.
   *
   * Best effort on purpose — the original failure is the one the caller must see, so a second
   * failure here is logged and swallowed rather than replacing it. The delete is restricted to
   * `requested`, so a row something else already advanced is never dropped.
   */
  async abandonDeployment(instanceId: string, actorId: string, reason: string): Promise<void> {
    await this.abandon(instanceId);
    try {
      await this.audit.append({
        action: 'instance.deploy.abandoned',
        actorType: 'user',
        actorId,
        targetType: 'instance',
        targetId: instanceId,
        outcome: 'failure',
        detail: { reason },
      });
    } catch (error) {
      this.logger.error(
        `instance ${instanceId} was rolled back but the audit record could not be appended: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async abandon(instanceId: string): Promise<void> {
    try {
      // `capacity_reservation` belongs to M19, and `release` is already the operation that owns it.
      await this.capacity.release(instanceId);
      const removed = await this.pool.query(
        `DELETE FROM instance WHERE id = $1 AND state = 'requested' AND deleted_at IS NULL`,
        [instanceId],
      );
      if ((removed.rowCount ?? 0) > 0) {
        this.logger.warn(`deployment request rolled back; instance ${instanceId} removed`);
      }
    } catch (cleanupError) {
      this.logger.error(
        `deployment request failed and the instance ${instanceId} could not be rolled back: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
      );
    }
  }

  async lifecycle(input: LifecycleInput): Promise<{ jobId: string; kind: string }> {
    if (!LIFECYCLE_ACTIONS.includes(input.action as LifecycleAction)) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        detail: `Unknown lifecycle action "${input.action}".`,
        remediation: `Use one of ${LIFECYCLE_ACTIONS.join(', ')}.`,
      });
    }
    const action = input.action as LifecycleAction;
    const instance = await this.instance(input.instanceId);

    if (action === 'upgrade' && input.backupJobId === undefined) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: 'An upgrade must be preceded by a backup; no backup job was supplied.',
        remediation: 'Use the lifecycle endpoint, which creates the pre-upgrade backup first.',
      });
    }
    if (action === 'delete' && input.dataRetention === undefined) {
      // FR-1.13 — the remediation used to end with "(FR-1.13)". Error text is rendered to
      // operators, so the id stays here.
      throw new AppError({
        code: 'VALIDATION_FAILED',
        detail: 'A delete must state what happens to the data.',
        remediation: 'Send `dataRetention` as keep, export or delete.',
      });
    }

    const job = await this.createJob(action, instance.id, input.actorId, {
      action,
      ...(input.dataRetention === undefined ? {} : { dataRetention: input.dataRetention }),
      ...(input.backupJobId === undefined ? {} : { backupJobId: input.backupJobId }),
      ...(input.justification === undefined ? {} : { justification: input.justification }),
      ...(input.renderSetId === undefined ? {} : { renderSetId: input.renderSetId }),
    });
    await this.audit.append({
      action: `instance.${action}.requested`,
      actorType: 'user',
      actorId: input.actorId,
      targetType: 'instance',
      targetId: instance.id,
      outcome: 'success',
      detail: { jobId: job.jobId, dataRetention: input.dataRetention ?? null },
    });
    return { jobId: job.jobId, kind: action };
  }

  async preview(input: PreviewInput): Promise<DeployPreview> {
    const entry = await this.entry(input.entryKey);
    const resources = this.resourcesOf(entry, input);
    const decision = await this.capacity.admit({ resources });
    const conflict = await this.slugConflict(input.slug);
    const slugAvailable = conflict === null;
    const scaffoldWarning =
      entry.packaging === 'none' && !(await this.hasApprovedScaffold(entry.key))
        ? 'This entry has no Compose file or Dockerfile; approve a scaffold draft before deploying.'
        : null;

    return {
      admissible: decision.admissible && slugAvailable,
      // "already routed" was the message for both a live deployment and a 30-day reservation, and it
      // sent the operator looking for a route that does not exist. The reason and, for a reservation,
      // the date it lapses are the part that makes the refusal actionable.
      headline: conflict === null ? decision.headline : conflict.detail,
      detail: decision.detail,
      shortfall: decision.shortfall,
      capacitySource: decision.source,
      routeHost: this.hostFor(input.slug),
      slugAvailable,
      policyVerdict: 'allowed',
      warnings: [scaffoldWarning, conflict?.warning ?? null].filter(
        (item): item is string => item !== null,
      ),
      evaluatedAt: new Date().toISOString(),
    };
  }

  async prefetch(entryKey: string, actorId: string): Promise<{ jobId: string }> {
    await this.entry(entryKey);
    const job = await this.createJob('prepull', null, actorId, { entryKey });
    return { jobId: job.jobId };
  }

  // ---------------------------------------------------------------------------------------------

  private async insertInstance(
    entry: EntryRow,
    input: DeployInput,
    resources: { cpuMilli: number; memoryMb: number; diskMb: number },
    profile: string,
  ): Promise<string> {
    const payload = entry.payload;
    const httpPort = typeof payload.httpPort === 'number' ? payload.httpPort : 80;
    const label = (field: string, fallback: string): string =>
      typeof payload[field] === 'string' ? (payload[field] as string) : fallback;

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO instance (entry_key, slug, domain_route, profile_key, state, desired_state, owner_user_id, payload)
       VALUES ($1, $2, $3, $4, 'requested', 'running', $5, $6::jsonb)
       RETURNING id`,
      [
        entry.key,
        input.slug,
        this.hostFor(input.slug),
        profile,
        // The column is the person, not the catalog's owning team: `payload.owner` is the reviewed
        // label from the entry and cannot answer "who deployed this". It was never written, so a
        // deployment had no identity behind it and nobody to grant portal access to.
        input.actorId,
        JSON.stringify({
          product: label('product', entry.key),
          description: label('description', ''),
          domain: label('domain', ''),
          imageRef: label('imageRef', ''),
          imageDigest: label('imageDigest', ''),
          httpPort,
          resources: {
            cpu: resources.cpuMilli / 1000,
            memoryMb: resources.memoryMb,
            diskMb: resources.diskMb,
          },
          route: {
            host: this.hostFor(input.slug),
            pathPrefix: null,
            publishModel: 'subdomain',
            tlsMode: 'acme',
            authMode: label('guaranteeClass', 'native'),
          },
          owner: payload.owner ?? { id: input.actorId, name: input.actorId },
          licenseId: label('licenseId', 'unreviewed'),
        }),
      ],
    );
    const instanceId = result.rows[0]?.id;
    if (instanceId === undefined) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: 'The instance row was not created.',
        remediation: 'Retry; nothing was deployed.',
      });
    }
    return instanceId;
  }

  private async createJob(
    kind: string,
    instanceId: string | null,
    actorId: string,
    payload: Record<string, unknown>,
  ): Promise<{ jobId: string }> {
    const steps = this.pipelines.stepsFor(kind);
    if (steps.length === 0) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: `Job kind "${kind}" has no registered pipeline.`,
        remediation: 'This is a defect: the owning module registers its stages at boot.',
      });
    }
    const created = await this.jobs.create({
      kind,
      ...(instanceId === null ? {} : { instanceId }),
      requestedBy: actorId,
      payload,
      steps,
    });
    return { jobId: created.job.id };
  }

  private async entry(entryKey: string): Promise<EntryRow> {
    const result = await this.pool.query<EntryRow>(
      `SELECT key, packaging, payload FROM catalog_entry WHERE key = $1`,
      [entryKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No catalog entry ${entryKey}.`,
        remediation: 'Reload the catalog repository and check the entry key.',
      });
    }
    return row;
  }

  private async instance(instanceId: string): Promise<{ id: string; slug: string; state: string }> {
    const result = await this.pool.query<{ id: string; slug: string; state: string }>(
      `SELECT id, slug, state FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No instance ${instanceId}.`,
        remediation: 'Refresh the instance list.',
      });
    }
    return row;
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    const conflict = await this.slugConflict(slug);
    if (conflict !== null) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        status: 409,
        detail: conflict.detail,
        fieldErrors: [{ field: 'slug', code: 'taken', message: 'Choose another route slug.' }],
        remediation: conflict.warning,
      });
    }
  }

  /**
   * Why a slug cannot be used, or `null` when it is free.
   *
   * The two causes need different answers: a live deployment means the operator is looking at the
   * wrong product or needs a second copy, while a reservation means the name is simply unavailable
   * until a date. "Already in use (or reserved for 30 days)" answered both and helped with neither.
   */
  private async slugConflict(slug: string): Promise<{ detail: string; warning: string } | null> {
    const result = await this.pool.query<{
      entry_key: string;
      state: string;
      domain_route: string;
      deleted_at: Date | null;
      reserved_until: Date | null;
    }>(
      `SELECT entry_key, state, domain_route, deleted_at,
              CASE WHEN deleted_at IS NULL THEN NULL ELSE deleted_at + interval '30 days' END AS reserved_until
         FROM instance
        WHERE slug = $1 AND (deleted_at IS NULL OR deleted_at > now() - interval '30 days')
        ORDER BY (deleted_at IS NULL) DESC
        LIMIT 1`,
      [slug],
    );
    const row = result.rows[0];
    if (row === undefined) return null;

    if (row.deleted_at === null) {
      return {
        detail: `The slug "${slug}" is already published by ${row.entry_key} (${row.state}) at ${row.domain_route}.`,
        warning:
          'A live deployment owns this route. Choose another slug, or remove that deployment first.',
      };
    }
    return {
      detail: `The slug "${slug}" is reserved until ${formatDay(row.reserved_until)}: a deployment was deleted on ${formatDay(
        row.deleted_at,
      )}, and a slug stays reserved for 30 days after deletion.`,
      warning:
        'Nothing is published at that host; the name is held by a deletion, not by a running deployment. Choose another slug.',
    };
  }

  private async hasApprovedScaffold(entryKey: string): Promise<boolean> {
    const result = await this.pool.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM scaffold_artefact WHERE entry_key = $1 AND approved_at IS NOT NULL
       ) AS present`,
      [entryKey],
    );
    return result.rows[0]?.present === true;
  }

  private resourcesOf(
    entry: EntryRow,
    input: { resources?: { cpu: number; memoryMb: number; diskMb: number } },
  ): { cpuMilli: number; memoryMb: number; diskMb: number } {
    const declared = (entry.payload.resources ?? {}) as {
      cpu?: number;
      memoryMb?: number;
      diskMb?: number;
    };
    const requested = input.resources;
    const cpu = requested?.cpu ?? declared.cpu ?? 1;
    return {
      cpuMilli: Math.round(cpu * 1000),
      memoryMb: requested?.memoryMb ?? declared.memoryMb ?? 1024,
      diskMb: requested?.diskMb ?? declared.diskMb ?? 2048,
    };
  }

  /** The host the route projection will publish, so the wizard preview cannot promise another one. */
  private hostFor(slug: string): string {
    return `${slug}.${this.config.SEAMNEX_INGRESS_DOMAIN}`;
  }
}

/** A date an operator can act on, in UTC so the answer does not depend on the API host's zone. */
function formatDay(value: Date | null): string {
  if (value === null) return 'an unknown date';
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(value);
}

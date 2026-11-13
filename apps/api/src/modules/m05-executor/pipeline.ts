import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isTransitional, type InstanceState } from '@seamnex/domain';
import type { Pool } from 'pg';
import { withTransaction, type LogStream } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { OUTBOX_SERVICE, type Outbox } from '../m17-audit/audit.contract';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { requireAdapters } from '../../common/adapters';
import { AppError } from '../../common/problem/app-error';
import { ensureDir, writeFileAtomic } from '../../common/fs/files';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import { JobService } from '../../jobs/job.service';
import {
  PipelineRegistry,
  type PipelineContext,
  type PipelineStage,
} from '../../jobs/pipeline-registry';
import {
  SOURCE_RESOLVER_SERVICE,
  type ResolvedSource,
  type SourceResolverService,
} from '../m02-source-resolver/source-resolver.contract';
import {
  RENDERER_SERVICE,
  type RenderRoute,
  type RenderSet,
  type RendererService,
} from '../m03-renderer/renderer.contract';
import {
  PLANNER_SERVICE,
  type PlanRecord,
  type PlannerService,
} from '../m04-planner/planner.contract';
import { CAPACITY_SERVICE, type CapacityService } from '../m19-capacity/capacity.contract';
import {
  INTEGRATION_SERVICE,
  type IntegrationService,
} from '../m07-integration/integration.contract';
import { DockerEngineClient, type ComposeProject } from '../../common/docker/docker.client';
import { instanceNetwork } from '../../common/docker/naming';
import { describeProbe, probeProductHttp } from '../../common/exec/http-probe';

type InstanceRow = {
  id: string;
  entry_key: string;
  slug: string;
  domain_route: string;
  profile_key: string | null;
  state: string;
  payload: Record<string, unknown>;
  source_path: 'compose' | 'dockerfile' | 'scaffold' | null;
  /** `instance_route.host`; null until the first `integrate` stage materialises the route. */
  route_host: string | null;
};

type RunState = {
  instance: InstanceRow;
  source?: ResolvedSource;
  renderSet?: RenderSet;
  plan?: PlanRecord;
};

/**
 * One container as `verify` needs to judge it: what the daemon says about its life, not only that it
 * is listed as `running` between restarts.
 */
export type ContainerRuntime = {
  readonly id: string;
  readonly name: string;
  readonly service: string;
  readonly state: string;
  /** `healthy` | `unhealthy` | `starting`, or `none` when the definition declares no healthcheck. */
  readonly health: string;
  readonly restartCount: number;
  readonly exitCode: number;
};

/**
 * 4A.5 / 4A.2–4A.4 — the deployment pipeline.
 *
 * Stage order is the plan's own words: resolve source → compose policy → render → plan (admission) →
 * apply → verify → integrate → record. Two properties are deliberate:
 *
 *   - **the plan is applied, not the render set.** The executor reads `payload.planId` (or the plan
 *     the previous stage produced) and refuses to apply when the capacity verdict is `refused`, so a
 *     deployment admitted in the wizard cannot become admitted by retrying a stale tab.
 *   - **cancellation is checked between stages, and before apply.** A cancel during `apply` marks
 *     remaining steps skipped and never runs the rollback path, which would otherwise fight the
 *     operator's own delete.
 */
@Injectable()
export class DeploymentPipeline implements OnModuleInit {
  private readonly runs = new Map<string, RunState>();

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SOURCE_RESOLVER_SERVICE) private readonly sources: SourceResolverService,
    @Inject(RENDERER_SERVICE) private readonly renderer: RendererService,
    @Inject(PLANNER_SERVICE) private readonly planner: PlannerService,
    @Inject(CAPACITY_SERVICE) private readonly capacity: CapacityService,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(JobService) private readonly jobs: JobService,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
    @Inject(INTEGRATION_SERVICE) private readonly integration: IntegrationService,
    @Inject(PipelineRegistry) private readonly pipelines: PipelineRegistry,
    @Inject(OUTBOX_SERVICE) private readonly outbox: Outbox,
  ) {}

  onModuleInit(): void {
    const deploy: PipelineStage[] = [
      stage('resolve', 'Resolve source', (context) => this.resolve(context)),
      stage('render', 'Render definition', (context) => this.render(context)),
      stage('plan', 'Plan and admit', (context) => this.plan(context)),
      stage('apply', 'Apply', (context) => this.apply(context)),
      stage('verify', 'Verify readiness', (context) => this.verify(context)),
      stage('integrate', 'Register identity and check integration', (context) =>
        this.integrate(context),
      ),
      stage('record', 'Record digests and state', (context) => this.record(context)),
    ];

    this.pipelines.register('deploy', deploy);
    this.pipelines.register('reconfigure', deploy);
    this.pipelines.register('upgrade', [
      stage('resolve', 'Resolve source', (context) => this.resolve(context)),
      stage('render', 'Render definition', (context) => this.render(context)),
      stage('plan', 'Plan and admit', (context) => this.plan(context)),
      stage('backup', 'Confirm pre-upgrade backup', (context) => this.requireBackup(context)),
      stage('apply', 'Apply', (context) => this.apply(context)),
      stage('verify', 'Verify readiness', (context) => this.verify(context)),
      stage('integrate', 'Register identity and check integration', (context) =>
        this.integrate(context),
      ),
      stage('record', 'Record digests and state', (context) => this.record(context)),
    ]);

    this.pipelines.register('rollback', [
      stage('resolve', 'Load previous render set', (context) => this.resolveRollback(context)),
      stage('plan', 'Plan and admit', (context) => this.plan(context)),
      stage('apply', 'Apply previous render set', (context) => this.apply(context)),
      stage('verify', 'Verify readiness', (context) => this.verify(context)),
      stage('record', 'Record rollback', (context) => this.record(context)),
    ]);

    for (const kind of ['start', 'stop', 'restart'] as const) {
      this.pipelines.register(kind, [
        stage('apply', `${kind} containers`, (context) => this.simpleAction(context, kind)),
        stage('record', 'Record state', (context) => this.recordLifecycle(context)),
      ]);
    }

    this.pipelines.register('delete', [
      stage('apply', 'Remove project', (context) => this.delete(context)),
      stage('record', 'Record deletion', (context) => this.recordLifecycle(context)),
    ]);

    this.pipelines.register('export', [
      stage('apply', 'Archive data and render set', (context) => this.export(context)),
      stage('record', 'Record export', (context) => this.recordLifecycle(context)),
    ]);

    this.pipelines.register('prepull', [
      stage('resolve', 'Resolve images', (context) => this.prepull(context)),
    ]);

    this.pipelines.register('build', [
      stage('apply', 'Build image', (context) => this.build(context)),
      stage('record', 'Record artefact', (context) => this.recordLifecycle(context)),
    ]);

    // The `verify` kind belongs to M16 (a backup verification); a lifecycle readiness check runs
    // inside `deploy`, so registering it here would collide.

    // A job that throws leaves its instance in the state of the stage that broke. Every action the
    // console offers is gated on "not busy", so that state is a dead end: `failed` is the one state
    // the state machine lets an operator leave (rollback, reconfigure, delete). `build` and
    // `prepull` are deliberately absent — neither owns the instance's lifecycle.
    for (const kind of [
      'deploy',
      'reconfigure',
      'upgrade',
      'rollback',
      'delete',
      'export',
      'start',
      'stop',
      'restart',
    ] as const) {
      this.pipelines.registerFailure(kind, (context, cause) => this.markFailed(context, cause));
    }
  }

  // ---- stages ---------------------------------------------------------------------------------

  private async resolve(context: PipelineContext): Promise<void> {
    const instance = await this.instance(context.instanceId);
    this.runs.set(context.jobId, { instance });
    await this.setState(instance.id, 'resolving');

    const source = await this.sources.resolve({
      instanceId: instance.id,
      entryKey: instance.entry_key,
      ...(typeof context.payload.revision === 'string'
        ? { revision: context.payload.revision }
        : {}),
      onProgress: (line) => context.log('stdout', line),
    });
    this.requireRun(context.jobId).source = source;
    await context.log(
      'stdout',
      `source retained: ${source.files.map((file) => file.path).join(', ') || 'none'}`,
    );
  }

  private async resolveRollback(context: PipelineContext): Promise<void> {
    const instance = await this.instance(context.instanceId);
    this.runs.set(context.jobId, { instance });
    await this.setState(instance.id, 'rolling_back');

    const targetId =
      typeof context.payload.renderSetId === 'string'
        ? context.payload.renderSetId
        : await this.previousRenderSet(instance.id);
    if (targetId === null) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: 'There is no previous render set to roll back to.',
        remediation: 'Deploy once more; a rollback needs an applied predecessor.',
      });
    }
    const renderSet = await this.renderer.load(targetId);
    this.requireRun(context.jobId).renderSet = renderSet;
    await context.log('stdout', `rollback target render set ${renderSet.id.slice(0, 12)}`);
  }

  private async render(context: PipelineContext): Promise<void> {
    const state = this.requireRun(context.jobId);
    if (state.source === undefined) throw new Error('render ran before resolve');
    await this.setState(state.instance.id, 'rendering');

    const route = routeOf(state.instance);
    const resources = resourcesOf(state.instance);
    const renderSet = await this.renderer.render({
      instanceId: state.instance.id,
      entryKey: state.instance.entry_key,
      slug: state.instance.slug,
      action: context.action,
      profileKey: state.instance.profile_key ?? 'default',
      source: {
        path: state.source.path,
        directory: state.source.directory,
        composeFile: state.source.composeFile,
        dockerfilePath: state.source.dockerfilePath,
        imageRef: state.source.imageRef,
        policy: state.source.policy,
      },
      route,
      resources,
      httpPort: httpPortOf(state.instance),
    });
    state.renderSet = renderSet;
    await context.log(
      'stdout',
      `render set ${renderSet.id.slice(0, 12)} (${renderSet.files.length} files, ` +
        `${renderSet.publishedPorts} published, ${state.source.policy.publishedPorts} rewritten to expose)`,
    );
  }

  private async plan(context: PipelineContext): Promise<void> {
    const state = this.requireRun(context.jobId);
    const renderSet = state.renderSet;
    if (renderSet === undefined) throw new Error('plan ran before render');

    // 4A.8 / inv. 13: a definition that disagrees with the repository is not a deployable base.
    await this.assertDefinitionCommitted(state.instance, context);

    // Invariant 9: asserted again here, not only in the renderer, because this is the last stage
    // before a container exists.
    if (renderSet.publishedPorts > 0) {
      throw new AppError({
        code: 'COMPOSE_POLICY_BLOCKED',
        detail: `The render set still declares ${renderSet.publishedPorts} published port(s).`,
        remediation: 'This is a defect in the normalisation; nothing was started.',
      });
    }

    const decision = await this.capacity.admit({
      instanceId: state.instance.id,
      resources: resourcesOf(state.instance),
    });
    const record = await this.planner.plan({
      instanceId: state.instance.id,
      action: context.action,
      renderSetId: renderSet.id,
      policyVerdict: state.source?.policy.verdict ?? 'allowed',
      capacity: {
        admissible: decision.admissible,
        headline: decision.headline,
        detail: decision.detail,
        source: decision.source,
      },
      preUpgradeBackup: context.action === 'upgrade',
    });
    state.plan = record;

    await this.setState(state.instance.id, 'planned');
    await context.log(
      'stdout',
      `plan ${record.planId.slice(0, 12)}: ${record.changes.length} change(s), capacity ${record.capacityVerdict}, policy ${record.policyVerdict}`,
    );

    if (record.capacityVerdict === 'refused') {
      throw new AppError({
        code: 'CAPACITY_EXCEEDED',
        detail: decision.headline,
        remediation: `${decision.detail} Free capacity or lower the requested resources; nothing was started.`,
      });
    }
    if (record.capacityVerdict === 'unknown') {
      throw new AppError({
        code: 'CAPACITY_EXCEEDED',
        detail: 'Capacity could not be measured, so the deployment was not admitted.',
        remediation:
          'Start the status sampler or seed a capacity snapshot, then retry. Nothing was started.',
      });
    }
  }

  /** AC-06: an upgrade refuses to apply when its pre-upgrade backup did not succeed. */
  private async requireBackup(context: PipelineContext): Promise<void> {
    const backupJobId = context.payload.backupJobId;
    if (typeof backupJobId !== 'string') {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: 'An upgrade must be preceded by a backup job, and none was attached.',
        remediation: 'Start the upgrade through the lifecycle API, which creates the backup first.',
      });
    }
    const job = await this.jobs.get(backupJobId);
    if (job.state !== 'succeeded') {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `The pre-upgrade backup job ${backupJobId} is ${job.state}, not succeeded.`,
        remediation: 'Fix the backup, then retry the upgrade. Nothing was changed.',
      });
    }
    await context.log('stdout', `pre-upgrade backup ${backupJobId} verified`);
  }

  private async apply(context: PipelineContext): Promise<void> {
    requireAdapters(this.config, 'docker');
    const state = this.requireRun(context.jobId);
    const renderSet = state.renderSet;
    if (renderSet === undefined) throw new Error('apply ran before render');

    if (await context.cancelled()) {
      await context.log('system', 'cancelled before apply; nothing was changed');
      return;
    }

    await this.setState(state.instance.id, 'deploying');
    const secrets = await this.writeSecretsFile(state.instance.id, renderSet);
    if (secrets !== null) {
      await context.log(
        'stdout',
        `${Object.keys(parseServices(renderSet) ?? {}).length} service(s) receive the declared secrets at apply time`,
      );
    }
    const project = this.composeProjectFor(state.instance.id, renderSet);

    if (state.source?.path === 'dockerfile' || state.source?.path === 'scaffold') {
      const ref = state.source.imageRef;
      if (ref !== null) {
        await context.log('stdout', `building ${ref}`);
        await this.docker.build({
          context: state.source.directory,
          dockerfile: state.source.dockerfilePath ?? join(state.source.directory, 'Dockerfile'),
          tag: ref,
          labels: {
            'seamnex.instance': state.instance.id,
            'seamnex.entry': state.instance.entry_key,
          },
        });
      }
    }

    await this.docker.ensureNetwork(instanceNetwork(state.instance.slug), {
      'seamnex.instance': state.instance.id,
    });
    // A service with a `build:` section is rebuilt here, every apply. `compose up` builds only when
    // the image tag is missing, so relying on it meant a reviewed Dockerfile change was never built
    // once the tag existed — the container was recreated from the previous image and the deployment
    // reported success against a revision that never ran.
    const built = servicesWithBuild(renderSet);
    if (built.length > 0) {
      await context.log('stdout', `building from the definition: ${built.join(', ')}`);
      await this.docker.composeBuild(project, (line) => context.log('stdout', line));
    }
    await this.docker.composeUp(project, (line) => context.log('stdout', line));
    await context.log('stdout', 'compose project applied');
  }

  /**
   * 4A.4 — readiness, asked as two questions instead of one.
   *
   * The loop used to ask only *has it answered yet*, bounded by `SEAMNEX_VERIFY_TIMEOUT_MS`. That is the
   * wrong question for a container that cannot answer: a deployment of D11 (Metabase) spent its whole
   * 20-minute budget polling a JVM that aborted on a 12-character encryption key every 60 s, while
   * the platform held `restart_count = 18` for that container in its own status table and never
   * looked at it.
   *
   * It now also asks *can it ever answer*: a container that restarts `SEAMNEX_VERIFY_MAX_RESTARTS` times,
   * is observed `exited`, or stays `unhealthy` past its grace fails the stage at that point, and the
   * container's own last output goes into the job log. The clock remains the backstop for a product
   * that is merely slow (ERPNext's first install).
   */
  private async verify(context: PipelineContext): Promise<void> {
    const state = this.requireRun(context.jobId);
    await this.setState(state.instance.id, 'verifying');

    const startedAt = Date.now();
    const deadline = startedAt + this.config.SEAMNEX_VERIFY_TIMEOUT_MS;
    const noise = new RepeatedLineGuard(context);
    const unhealthySince = new Map<string, number>();
    const exitedSince = new Map<string, number>();
    let containers = await this.instanceContainers(state.instance);
    // Only the delta is evidence: `apply` itself may recreate a container once (`compose up`), and a
    // restart that happened before this stage began says nothing about whether the product will run.
    const baseline = new Map(containers.map((container) => [container.id, container.restartCount]));

    while (Date.now() < deadline) {
      const running = containers.filter((container) => container.state === 'running');
      if (containers.length > 0 && running.length === containers.length) {
        await noise.note('stdout', `${running.length} container(s) running`);
        if (await this.httpReady(state.instance, (line) => noise.note('stdout', line))) {
          await this.setState(state.instance.id, 'ready');
          return;
        }
      }

      await this.assertNotDying(
        context,
        containers,
        baseline,
        exitedSince,
        unhealthySince,
        Date.now() - startedAt,
        noise,
      );

      await sleep(3_000);
      containers = await this.instanceContainers(state.instance);
    }

    throw new AppError({
      code: 'INTEGRATION_CHECK_FAILED',
      detail: `The instance did not become ready within ${Math.round(this.config.SEAMNEX_VERIFY_TIMEOUT_MS / 1000)} s (${containers.length} container(s) observed).`,
      remediation:
        'Read the job log and the container status; a failed deploy keeps its previous render set.',
    });
  }

  /**
   * Fails the stage on evidence that the product cannot come up, instead of waiting out the budget.
   *
   * The three signals come from the Engine — `State.Status`, `State.Health.Status`, `RestartCount` —
   * not from a label the platform was supposed to write. `labels['seamnex.health']` was checked here for
   * two phases and nothing ever set it, so a crash-looping container read as "running" and the loop
   * wrote `2 container(s) running` next to its own failing probe, 309 times.
   */
  private async assertNotDying(
    context: PipelineContext,
    containers: readonly ContainerRuntime[],
    baseline: ReadonlyMap<string, number>,
    exitedSince: Map<string, number>,
    unhealthySince: Map<string, number>,
    elapsedMs: number,
    noise: RepeatedLineGuard,
  ): Promise<void> {
    const maxRestarts = this.config.SEAMNEX_VERIFY_MAX_RESTARTS;
    const graceMs = this.config.SEAMNEX_VERIFY_UNHEALTHY_GRACE_MS;
    const now = Date.now();

    for (const container of containers) {
      const restarts = container.restartCount - (baseline.get(container.id) ?? 0);
      // `dead` is terminal. `exited` is not: a container that has just stopped is `exited` for a
      // moment before the restart policy revives it, and failing on that instant would kill a
      // deployment that was about to succeed. Two polls of evidence, then it is a stopped container.
      const dead = container.state === 'dead';

      let exitedFor = 0;
      if (container.state === 'exited') {
        const since = exitedSince.get(container.id) ?? now;
        exitedSince.set(container.id, since);
        exitedFor = now - since;
      } else {
        exitedSince.delete(container.id);
      }

      let unhealthyFor = 0;
      if (container.health === 'unhealthy' && graceMs > 0) {
        const since = unhealthySince.get(container.id) ?? now;
        unhealthySince.set(container.id, since);
        unhealthyFor = now - since;
      } else {
        // Healthy, `starting`, or no healthcheck at all: whatever was accumulating no longer applies.
        unhealthySince.delete(container.id);
      }

      const reason = dead
        ? 'the daemon reports it dead'
        : exitedFor >= EXITED_OBSERVATION_MS
          ? `it exited (code ${container.exitCode}) and did not come back`
          : restarts >= maxRestarts
            ? `it restarted ${restarts} time(s) while this stage waited`
            : graceMs > 0 && unhealthyFor >= graceMs
              ? `its healthcheck has failed for ${Math.round(unhealthyFor / 1000)} s`
              : null;
      if (reason === null) continue;

      await noise.note('stderr', `${container.name} cannot become ready: ${reason}.`);

      // The product's own last words are the diagnosis. Without them the operator has to leave the
      // console, find the host and run `docker logs` against a container the screen does not name —
      // which is exactly how a one-line assertion error stayed invisible for twenty minutes.
      const tail = await this.docker.logs(container.id, 20).catch(() => '');
      const lines = tail.split(/\r?\n/).filter((line) => line.trim().length > 0);
      for (const line of lines.slice(-12)) await context.log('stderr', line);

      throw new AppError({
        code: 'INTEGRATION_CHECK_FAILED',
        detail:
          `${container.name} cannot become ready: ${reason}. ` +
          `The deployment was stopped after ${Math.round(elapsedMs / 1000)} s instead of waiting ${Math.round(this.config.SEAMNEX_VERIFY_TIMEOUT_MS / 1000)} s.`,
        remediation:
          'Read the container output above: a service that exits during startup is almost always a missing or invalid configuration value. Fix it, delete the failed deployment and deploy again; the previous render set is retained.',
      });
    }
  }

  /**
   * 4D.1/4D.2/4D.5 - identity, route and integration checks, run once the containers answer.
   *
   * This stage is why the 4D surface is not dead code: without it a deployed product would have no
   * IdP client, no Traefik router and no `integration_check` rows, and `ready` would mean "the
   * container started" rather than "the product is reachable through the platform" (FR-2.9).
   *
   * `ready` is decided here because `instance` is M05's table; M07 reports the verdict and never
   * writes it.
   */
  private async integrate(context: PipelineContext): Promise<void> {
    const state = this.requireRun(context.jobId);
    await this.setState(state.instance.id, 'integrating');

    // The route is materialised first: the identity client's redirect URI is derived from the host
    // the route row carries, and registering before the route existed meant a host change re-issued
    // the client against the *previous* host. The product then derived its own callback from the new
    // `siteUrl`, Keycloak refused the URI, and the only symptom was a login that bounced back.
    const route = await this.integration.materialiseRoute(state.instance.id, {}, context.actorId);
    await context.log(
      'stdout',
      `route ${route.host}${route.pathPrefix === '/' ? '' : route.pathPrefix} (${route.publishModel})`,
    );

    const identity = await this.integration.registerIdentity(state.instance.id, context.actorId);
    await context.log(
      'stdout',
      `identity client ${identity.clientId} (${identity.adapter.adapter}, sync=${identity.adapter.syncState})`,
    );

    const verdict = await this.integration.runChecks(state.instance.id);
    for (const check of verdict.checks) {
      await context.log(check.ok ? 'stdout' : 'stderr', `${check.check}: ${check.detail}`);
    }
    if (!verdict.ready) {
      throw new AppError({
        code: 'INTEGRATION_CHECK_FAILED',
        detail: `Post-deploy integration checks failed: ${verdict.blocking.join('; ')}`,
        remediation:
          'Fix the failing check and re-run the deployment. The previous render set is retained; the instance is not marked ready.',
      });
    }
    await this.setState(state.instance.id, 'ready');
    await context.log('stdout', 'integration checks passed; instance is ready');
  }

  /**
   * HTTP readiness from a one-shot probe container on the instance network. The alternative — a
   * published port — is exactly what the compose policy forbids, and an in-process fetch cannot
   * reach a bridge network the API is not attached to.
   *
   * `probeProductHttp` accepts any status below 500 and never follows a redirect: a product that
   * answers `302 → install/` is reachable, and `wget` used to read that relative `Location` as a host
   * name and fail the whole stage.
   */
  private async httpReady(
    instance: InstanceRow,
    note: (line: string) => Promise<void>,
  ): Promise<boolean> {
    const port = httpPortOf(instance);
    const probe = await probeProductHttp({
      runCli: (file, args, timeoutMs) => this.docker.runCli(file, args, timeoutMs),
      network: instanceNetwork(instance.slug),
      host: instance.slug,
      port,
    });
    if (!probe.ok) {
      await note(`readiness probe http://${instance.slug}:${port}/ ${describeProbe(probe)}`);
    }
    return probe.ok;
  }

  private async record(context: PipelineContext): Promise<void> {
    const state = this.requireRun(context.jobId);
    const renderSet = state.renderSet;

    if (renderSet !== undefined) {
      await this.recordServices(state.instance, renderSet);
      await this.pool.query(
        `UPDATE instance
            SET payload = payload || jsonb_build_object('activeRenderSetId', $2::text),
                source_path = $3,
                updated_at = now()
          WHERE id = $1`,
        [state.instance.id, renderSet.id, state.source?.path ?? state.instance.source_path],
      );
    }

    if (renderSet !== undefined) {
      // Only a set that has never been applied is stamped. `COALESCE` looked equivalent but is not:
      // the statement still touched a row, and the immutability trigger refuses any UPDATE after
      // `applied_at`, so a reconfigure that reused a byte-identical set failed at the last step
      // *after* the containers were already correct.
      await this.pool.query(
        `UPDATE render_set SET applied_at = now() WHERE id = $1 AND applied_at IS NULL`,
        [renderSet.id],
      );
    }
    await this.capacity.release(state.instance.id);
    await this.setState(state.instance.id, 'ready');
    await this.requestRegistryRebuild(state.instance.id, 'instance.ready');
    await this.requestRelayProvision(state.instance.id);

    await this.audit.append({
      action: `instance.${context.action}.succeeded`,
      actorType: 'user',
      actorId: context.actorId,
      targetType: 'instance',
      targetId: state.instance.id,
      outcome: 'success',
      detail: {
        jobId: context.jobId,
        renderSetId: renderSet?.id ?? null,
        planId: state.plan?.planId ?? null,
        changes: state.plan?.changes.length ?? 0,
      },
    });
    this.runs.delete(context.jobId);
  }

  /**
   * Failure settlement, registered per kind in `onModuleInit`.
   *
   * `instance` is M05's table, so the worker cannot do this itself: a generic job runner that wrote
   * another module's state would be the boundary violation the module test exists to reject.
   *
   * The guard is the point. A stage that failed *after* the work succeeded — the audit append in
   * `record`, say — leaves a `ready` instance behind, and overwriting that with `failed` would make
   * a healthy deployment look broken. Only a transitional state is replaced.
   */
  private async markFailed(context: PipelineContext, cause?: unknown): Promise<void> {
    const instanceId = this.runs.get(context.jobId)?.instance.id ?? context.instanceId;
    if (instanceId.length === 0) return;

    const row = await this.pool.query<{ slug: string; state: string }>(
      `SELECT slug, state FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    const instance = row.rows[0];
    if (instance === undefined || !isTransitional(instance.state as InstanceState)) return;

    const detail =
      cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : null;
    await this.setState(
      instanceId,
      'failed',
      detail === null ? `the ${context.action} job failed` : detail,
    );
    await context.log(
      'system',
      `job failed; instance ${instance.slug} moved from ${instance.state} to failed so an operator can act on it`,
    );
    await this.audit.append({
      action: `instance.${context.action}.failed`,
      actorType: 'system',
      actorId: 'm05-executor',
      targetType: 'instance',
      targetId: instanceId,
      outcome: 'failure',
      detail: { jobId: context.jobId, fromState: instance.state },
    });
  }

  private async simpleAction(
    context: PipelineContext,
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    const instance = await this.instance(context.instanceId);
    this.runs.set(context.jobId, { instance });
    if (action === 'start') await this.assertDefinitionCommitted(instance, context);
    const containers = await this.instanceContainers(instance);
    if (containers.length === 0) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: 'The instance has no containers to act on.',
        remediation: 'Deploy it first; a lifecycle action never creates containers.',
      });
    }
    await this.setState(
      instance.id,
      action === 'stop' ? 'stopping' : action === 'start' ? 'starting' : 'restarting',
    );
    await context.log('stdout', `${action} issued to ${containers.length} container(s)`);

    // Serially, nine containers meant nine graceful-stop windows end to end — longer than the
    // request budget the whole stage has. They are independent, so they run together and the stage
    // costs the slowest one. A single container that refuses to stop no longer hides the other
    // eight: the outcome is reported per service and the aggregate failure names them.
    const outcomes = await Promise.all(
      containers.map(async (container) => {
        try {
          if (action === 'start') await this.docker.start(container.id);
          if (action === 'stop') await this.docker.stop(container.id);
          if (action === 'restart') await this.docker.restart(container.id);
          return { service: container.service, error: null as string | null };
        } catch (error) {
          return {
            service: container.service,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const failed = outcomes.filter((outcome) => outcome.error !== null);
    for (const outcome of failed) {
      await context.log(
        'stderr',
        `${action} failed for ${outcome.service}: ${outcome.error ?? 'unknown error'}`,
      );
    }
    if (failed.length > 0) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `${action} did not complete for ${failed.map((outcome) => outcome.service).join(', ')}.`,
        remediation:
          'Retry the action; the log names the service that refused. A container that keeps failing needs its own logs.',
      });
    }

    await context.log('stdout', `${action} completed for ${outcomes.length} container(s)`);

    if (action === 'stop') {
      await this.setState(instance.id, 'stopped');
      return;
    }

    /**
     * FR-1.32: "a container started" is not "the application is ready". This used to set `ready`
     * unconditionally, so a restart of a slow product was reported as usable while its frontend was
     * still answering 502 — and the portal tile, which reads `ready`, offered it to end users.
     *
     * One probe decides the state. A product that needs longer stays `degraded` with a reason that
     * says so, and the sampler promotes it to `ready` once the probe passes; that is the same
     * evidence the status page shows, not a promise the job makes.
     */
    const ready = await this.httpReady(instance, (line) => context.log('stdout', line));
    await this.setState(
      instance.id,
      ready ? 'ready' : 'degraded',
      ready ? null : `containers started, but the readiness probe did not pass (${action})`,
    );
    await context.log(
      ready ? 'stdout' : 'stderr',
      ready
        ? 'readiness probe passed; instance is ready'
        : 'the product is not answering yet; the status sampler will confirm readiness',
    );
  }

  private async delete(context: PipelineContext): Promise<void> {
    const instance = await this.instance(context.instanceId);
    this.runs.set(context.jobId, { instance });
    const retention =
      typeof context.payload.dataRetention === 'string' ? context.payload.dataRetention : 'keep';
    const network = instanceNetwork(instance.slug);

    // A deployment that failed or was cancelled never recorded `applied_at`, but its containers are
    // running. Deleting only the applied set therefore left the project behind and the network
    // removal failed with "active endpoints" — a delete that cannot delete. The newest render set is
    // the one the running project was created from, so it is the one to bring down.
    const renderSet =
      (await this.renderer.applied(instance.id)) ?? (await this.latestRenderSet(instance.id));
    if (renderSet !== null) {
      const project = this.composeProjectFor(instance.id, renderSet);
      // The rendered document declares *this* network (`networks.default.name`), so `compose down`
      // removes it — and refuses while the platform's edge and IdP are still attached, which is the
      // state every ready instance is in. The project was gone and every container removed, yet the
      // job failed on "network seamnex-inst-<slug> has active endpoints": `down` never got past its own
      // network cleanup. Members that do not belong to the project leave first; its own containers
      // stay for `down` to remove, so a failed `down` does not also strip a running product off the
      // network it needs.
      await this.detachNetworkMembers(network, project.project, context);
      await this.docker.composeDown(project, retention === 'delete');
      await context.log('stdout', `project ${project.project} removed`);
    } else {
      await context.log('stdout', 'no render set recorded; there is no project to bring down');
    }
    // A successful `down` removed the network itself. When it did not, remove it here — after
    // detaching whatever is still attached, so a leftover attachment cannot fail a delete whose
    // work is already done.
    await this.detachNetworkMembers(network, null, context);
    await this.docker.removeNetwork(network);
    await this.setState(instance.id, 'deleting');
    await this.pool.query(
      `UPDATE instance SET deleted_at = now(), state = 'deleted', updated_at = now() WHERE id = $1`,
      [instance.id],
    );
    await this.capacity.release(instance.id);
    // The row survives as a soft delete, so nothing cascades the snapshot away; the registry would
    // keep advertising a product that no longer exists.
    await this.requestRegistryRebuild(instance.id, 'instance.deleted');
    await context.log('stdout', `project removed; data retention: ${retention}`);
  }

  private async export(context: PipelineContext): Promise<void> {
    const instance = await this.instance(context.instanceId);
    this.runs.set(context.jobId, { instance });
    const renderSet = await this.renderer.applied(instance.id);
    const directory = join(this.config.SEAMNEX_INSTANCE_DATA_DIR, instance.id, 'exports');
    ensureDir(directory);
    const target = join(directory, `${Date.now()}-export.json`);
    writeFileAtomic(
      target,
      `${JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          instance: {
            id: instance.id,
            slug: instance.slug,
            entryKey: instance.entry_key,
            state: instance.state,
          },
          renderSet:
            renderSet === null ? null : { id: renderSet.id, contentHash: renderSet.contentHash },
        },
        null,
        2,
      )}\n`,
    );
    await context.log('stdout', `export written to ${target}`);
  }

  private async prepull(context: PipelineContext): Promise<void> {
    const entryKey = typeof context.payload.entryKey === 'string' ? context.payload.entryKey : '';
    const images = await this.imagesForEntry(entryKey);
    requireAdapters(this.config, 'docker');
    for (const ref of images) {
      await context.log('stdout', `pulling ${ref}`);
      await this.docker.pull(ref, (line) => context.log('stdout', line));
    }
  }

  private async build(context: PipelineContext): Promise<void> {
    const state = this.requireRun(context.jobId);
    const ref = typeof context.payload.imageRef === 'string' ? context.payload.imageRef : null;
    if (ref === null || state.source?.dockerfilePath == null) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: 'A build needs an image reference and a Dockerfile.',
        remediation: 'Deploy the instance normally; the build stage is internal.',
      });
    }
    await this.docker.build({
      context: state.source.directory,
      dockerfile: state.source.dockerfilePath,
      tag: ref,
      labels: { 'seamnex.instance': state.instance.id, 'seamnex.entry': state.instance.entry_key },
    });
  }

  private async recordLifecycle(context: PipelineContext): Promise<void> {
    const state = this.runs.get(context.jobId);
    this.runs.delete(context.jobId);
    await this.audit.append({
      action: `instance.${context.action}.succeeded`,
      actorType: 'user',
      actorId: context.actorId,
      targetType: 'instance',
      targetId: state?.instance.id ?? context.instanceId,
      outcome: 'success',
      detail: { jobId: context.jobId },
    });
  }

  // ---- helpers --------------------------------------------------------------------------------

  /**
   * Secrets are injected as `environment` entries in a runtime-only override, not as `env_file`.
   *
   * Two reasons, both learned from a real deployment: an `env_file` path is resolved relative to the
   * file that declares it (so `platform.env` inside `runtime/` pointed at a file that does not
   * exist), and an `env_file` value loses to an `environment` literal in the upstream document — a
   * product that ships `ESPOCRM_DATABASE_PASSWORD: <example>` would have been deployed with the
   * example password while the operator believed their secret was applied. The override is written
   * with mode 0600 and lives outside the render set, so no secret enters a stored artefact.
   */
  private async writeSecretsFile(
    instanceId: string,
    renderSet: RenderSet,
  ): Promise<{ override: string; env: string } | null> {
    const secrets = await this.pool.query<{ var_name: string; secret_ref: string | null }>(
      `SELECT var_name, secret_ref FROM instance_env_value
        WHERE instance_id = $1 AND source = 'secret' AND secret_ref IS NOT NULL`,
      [instanceId],
    );
    if (secrets.rows.length === 0) return null;

    const values: Record<string, string> = {};
    for (const row of secrets.rows) {
      if (row.secret_ref === null) continue;
      values[row.var_name] = await this.secrets.open(row.secret_ref, `deploy ${instanceId}`);
    }
    if (Object.keys(values).length === 0) return null;

    const runtimeDir = join(this.config.SEAMNEX_INSTANCE_DATA_DIR, instanceId, 'runtime');
    ensureDir(runtimeDir);
    const override = join(runtimeDir, `${renderSet.id}.secrets.yml`);
    const env = join(runtimeDir, `${renderSet.id}.env`);
    const declared = Object.keys(parseServices(renderSet) ?? {});
    const serviceNames = declared.length > 0 ? declared : ['app'];

    // Interpolation source: lets an upstream file that names a credential (`${APP_DB_PASSWORD}`)
    // receive the real value without the value being written into the render set.
    writeFileAtomic(
      env,
      `${Object.entries(values)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => `${name}=${quoteEnv(value)}`)
        .join('\n')}\n`,
      0o600,
    );

    // Container injection: `environment` beats a literal of the same name in the upstream document,
    // which is the only way the operator's secret can win against an example value shipped upstream.
    const document = {
      services: Object.fromEntries(serviceNames.map((name) => [name, { environment: values }])),
    };
    writeFileAtomic(override, stringifyYaml(document, { lineWidth: 0 }), 0o600);
    return { override, env };
  }

  /**
   * Detaches every member of an instance network that does not belong to `keepProject`.
   *
   * The edge (`SEAMNEX_EDGE_CONTAINER`) and the IdP (`SEAMNEX_IDP_CONTAINER`) are joined to each network by
   * M07 and are not part of the compose project, so `compose down` cannot remove them — and the
   * daemon refuses to remove a network while they are attached. A failed detach is logged, not
   * thrown: the removal that follows fails loudly if the endpoint is still there, and the log then
   * names the container that refused.
   */
  private async detachNetworkMembers(
    network: string,
    keepProject: string | null,
    context: PipelineContext,
  ): Promise<void> {
    const endpoints = await this.docker.networkEndpoints(network);
    if (endpoints.length === 0) return;
    const own = new Set(
      keepProject === null
        ? []
        : (await this.docker.containers([`com.docker.compose.project=${keepProject}`])).map(
            (container) => container.id,
          ),
    );
    for (const endpoint of endpoints) {
      if (own.has(endpoint.id)) continue;
      try {
        await this.docker.disconnectNetwork(network, endpoint.id);
        await context.log('stdout', `${endpoint.name} left ${network}`);
      } catch (error) {
        await context.log(
          'stderr',
          `${endpoint.name} could not leave ${network}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** The most recent render set, applied or not: what a cancelled or failed deploy left behind. */
  private async latestRenderSet(instanceId: string): Promise<RenderSet | null> {
    const row = await this.pool.query<{ id: string }>(
      `SELECT id FROM render_set WHERE instance_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [instanceId],
    );
    const id = row.rows[0]?.id;
    return id === undefined ? null : this.renderer.load(id);
  }

  /**
   * The compose invocation for an applied render set. `delete` and `apply` share it so a project is
   * never brought down with a different file list than it was created with.
   */
  private composeProjectFor(instanceId: string, renderSet: RenderSet): ComposeProject {
    const runtimeDir = join(this.config.SEAMNEX_INSTANCE_DATA_DIR, instanceId, 'runtime');
    const secretsOverride = join(runtimeDir, `${renderSet.id}.secrets.yml`);
    const secretsEnv = join(runtimeDir, `${renderSet.id}.env`);
    const hasSecrets = existsSync(secretsOverride) && existsSync(secretsEnv);
    return {
      project: renderSet.composeProject,
      directory: renderSet.directory,
      files: [
        join(renderSet.directory, 'docker-compose.platform.yml'),
        join(renderSet.directory, 'docker-compose.override.yml'),
        ...(hasSecrets ? [secretsOverride] : []),
      ],
      envFiles: [join(renderSet.directory, 'platform.env'), ...(hasSecrets ? [secretsEnv] : [])],
    };
  }

  /**
   * `instance.yaml` must exist and agree with the recorded hash before a definition is applied or a
   * stopped instance is started. The handler writes the file immediately after creating the instance,
   * so a short wait covers the scheduling gap without turning a missing definition into a race.
   */
  private async assertDefinitionCommitted(
    instance: InstanceRow,
    context: PipelineContext,
  ): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const row = await this.pool.query<{ content_hash: string }>(
        `SELECT content_hash FROM instance_param WHERE instance_id = $1`,
        [instance.id],
      );
      if (row.rows[0] !== undefined) {
        const drift = await this.pool.query<{ drifted: boolean }>(
          `SELECT COALESCE((payload->>'instanceParamDrift')::boolean, false) AS drifted FROM instance WHERE id = $1`,
          [instance.id],
        );
        if (drift.rows[0]?.drifted === true) {
          throw new AppError({
            code: 'STATE_CONFLICT',
            detail: `instances/${instance.slug}/instance.yaml does not match its recorded hash.`,
            remediation:
              'Reconcile the definition and re-run the deployment; a drifted instance cannot start.',
          });
        }
        return;
      }
      await context.log('stdout', 'waiting for instances/<slug>/instance.yaml to be committed');
      await sleep(500);
    }
    throw new AppError({
      code: 'STATE_CONFLICT',
      detail: 'The instance definition was never committed to the catalogue repository.',
      remediation:
        'Re-run the deployment; 4A.8 requires instances/<slug>/instance.yaml before apply.',
    });
  }

  /**
   * The registry is a projection of what a deployment just wrote — route, credential granularity,
   * operations — so a product only becomes visible to `/registry` and resolvable as a workflow
   * target once it is rebuilt. Before this event existed, the projection moved only when an operator
   * edited catalog metadata: a completed deployment left six ready products and an empty registry.
   *
   * Emitted through the outbox (AD-18) rather than called here, because M05 does not own
   * `registry_snapshot` and the scheduler role is the only claimer.
   */
  private async requestRegistryRebuild(instanceId: string, reason: string): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await this.outbox.emit(tx, {
        aggregateType: 'instance',
        aggregateId: instanceId,
        eventType: 'registry.rebuild',
        payload: { reason },
      });
    });
  }

  /**
   * ADR-BE-22 — ask M24 to create the product accounts this deployment just made possible.
   *
   * Emitted as an event rather than called here, for the same reasons as the registry rebuild: M05
   * does not own `product_account`, the scheduler is the only claimer, and a deployment recorded
   * while the process restarts must still be provisioned. The alternative — the sweep's cadence —
   * is what made a fresh install show the product's own login form for up to a full interval.
   */
  private async requestRelayProvision(instanceId: string): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      await this.outbox.emit(tx, {
        aggregateType: 'instance',
        aggregateId: instanceId,
        eventType: 'relay.provision',
        payload: { reason: 'deployment-complete' },
      });
    });
  }

  private async instance(instanceId: string): Promise<InstanceRow> {
    // `route_host` is read, never written, from M07's table: it is the authority on where an
    // instance is published, and the payload snapshot below is only the *deploy-time* answer. A
    // domain change (`materialiseRoute` with a new host) updates the route row and not the
    // snapshot, so rendering from the snapshot put the previous host into `route.json` and into
    // every host-dependent value a re-render produces.
    const result = await this.pool.query<InstanceRow>(
      `SELECT i.id, i.entry_key, i.slug, i.domain_route, i.profile_key, i.state, i.payload,
              i.source_path, r.host AS route_host
         FROM instance i
         LEFT JOIN instance_route r ON r.instance_id = i.id
        WHERE i.id = $1 AND i.deleted_at IS NULL`,
      [instanceId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No instance ${instanceId}.`,
        remediation: 'Refresh the instance list; the deployment target no longer exists.',
      });
    }
    return row;
  }

  private async setState(
    instanceId: string,
    state: string,
    reason: string | null = null,
  ): Promise<void> {
    await this.pool.query(`UPDATE instance SET state = $2, updated_at = now() WHERE id = $1`, [
      instanceId,
      state,
    ]);
    // The reason travels with the state. A push that left `reason` untouched described a failed
    // instance as "transition in progress" — the message the sampler wrote while it was still
    // working — so the console showed a contradictory state and no way to read what happened.
    await this.pool.query(
      `INSERT INTO instance_status (instance_id, state, ready, observed_at, source, reason)
       VALUES ($1, $2, $3, now(), 'push', $4)
       ON CONFLICT (instance_id) DO UPDATE
          SET state = EXCLUDED.state, ready = EXCLUDED.ready, observed_at = now(), source = 'push',
              reason = EXCLUDED.reason`,
      [instanceId, state, state === 'ready', reason],
    );
  }

  /**
   * Containers of one instance with the facts a readiness decision needs.
   *
   * The list endpoint answers state only, and `state === 'running'` is exactly the observation that
   * lied during the D11 failure: a JVM that aborts eight seconds into boot is "running" between
   * restarts. One inspect per container supplies health, restart count and exit code; a container
   * that disappears mid-inspect (a recreate) keeps its list state instead of failing the poll.
   */
  private async instanceContainers(instance: InstanceRow): Promise<ContainerRuntime[]> {
    const containers = await this.docker.containers([`seamnex.instance=${instance.id}`]);
    return Promise.all(
      containers.map(async (container): Promise<ContainerRuntime> => {
        const inspect = await this.docker.inspect(container.id).catch(() => null);
        return {
          id: container.id,
          name: container.name.replace(/^\//, ''),
          service: container.service,
          state: inspect?.State?.Status ?? container.state,
          health: inspect?.State?.Health?.Status ?? 'none',
          restartCount: inspect?.RestartCount ?? 0,
          exitCode: inspect?.State?.ExitCode ?? 0,
        };
      }),
    );
  }

  private async recordServices(instance: InstanceRow, renderSet: RenderSet): Promise<void> {
    const containers = await this.docker.containers([`seamnex.instance=${instance.id}`]);
    // Roles are read from the definition, not from the order the daemon happened to list the
    // containers in: "first container is primary" labelled a cron daemon as the product's web tier
    // and a MariaDB as a worker, and the console renders exactly these values.
    const primary = primaryServiceOf(renderSet, httpPortOf(instance));
    for (const container of containers) {
      const identity = await this.docker.imageIdentity(container.image).catch(() => null);
      await this.pool.query(
        `INSERT INTO instance_service (instance_id, service_name, role, image_ref, image_digest, internal_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (instance_id, service_name) DO UPDATE
            SET role = EXCLUDED.role, image_ref = EXCLUDED.image_ref, image_digest = EXCLUDED.image_digest`,
        [
          instance.id,
          container.service,
          roleFor(container.service, primary),
          container.image,
          identity?.digest ?? null,
          `http://${container.service}`,
        ],
      );
    }
  }

  private async previousRenderSet(instanceId: string): Promise<string | null> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM render_set
        WHERE instance_id = $1 AND applied_at IS NOT NULL
        ORDER BY applied_at DESC OFFSET 1 LIMIT 1`,
      [instanceId],
    );
    return result.rows[0]?.id ?? null;
  }

  private async imagesForEntry(entryKey: string): Promise<string[]> {
    const result = await this.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM catalog_entry WHERE key = $1`,
      [entryKey],
    );
    const payload = result.rows[0]?.payload ?? {};
    const image = typeof payload.imageRef === 'string' ? payload.imageRef : null;
    return image === null ? [] : [image];
  }

  private requireRun(jobId: string): RunState {
    const state = this.runs.get(jobId);
    if (state === undefined) {
      throw new Error('the pipeline state is missing; a stage ran out of order');
    }
    return state;
  }
}

function stage(
  name: PipelineStage['name'],
  step: string,
  run: (context: PipelineContext) => Promise<void>,
): PipelineStage {
  return { name, step, run };
}

function routeOf(instance: InstanceRow): RenderRoute {
  const route = (instance.payload.route ?? {}) as Partial<RenderRoute>;
  return {
    // Relational truth first, then the deploy-time snapshot, then the column written at insert.
    // A render that ran after `SEAMNEX_INGRESS_DOMAIN` changed published the old host otherwise.
    host:
      instance.route_host ?? (typeof route.host === 'string' ? route.host : instance.domain_route),
    pathPrefix: route.pathPrefix ?? null,
    publishModel: route.publishModel ?? 'subdomain',
    tlsMode: route.tlsMode ?? 'acme',
    authMode: route.authMode ?? 'native',
  };
}

function resourcesOf(instance: InstanceRow): {
  cpuMilli: number;
  memoryMb: number;
  diskMb: number;
} {
  const resources = (instance.payload.resources ?? {}) as {
    cpu?: number;
    memoryMb?: number;
    diskMb?: number;
  };
  return {
    cpuMilli: Math.round((resources.cpu ?? 1) * 1000),
    memoryMb: resources.memoryMb ?? 1024,
    diskMb: resources.diskMb ?? 2048,
  };
}

function httpPortOf(instance: InstanceRow): number {
  const port = instance.payload.httpPort;
  return typeof port === 'number' ? port : 80;
}

function parseServices(renderSet: RenderSet): Record<string, unknown> | null {
  const file = renderSet.files.find((entry) => entry.path === 'docker-compose.platform.yml');
  if (file === undefined) return null;
  try {
    const parsed: unknown = parseYaml(file.content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const services = (parsed as { services?: unknown }).services;
    return typeof services === 'object' && services !== null
      ? (services as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Services whose definition carries a `build:` section: only these need `compose build`. */
function servicesWithBuild(renderSet: RenderSet): string[] {
  const services = parseServices(renderSet) ?? {};
  return Object.entries(services)
    .filter(([, raw]) => {
      const service = raw as { build?: unknown } | null;
      return typeof service === 'object' && service !== null && service.build !== undefined;
    })
    .map(([name]) => name);
}

/** The service that answers on the product's HTTP port: the same rule the renderer's alias uses. */
function primaryServiceOf(renderSet: RenderSet, httpPort: number): string | null {
  const services = parseServices(renderSet) ?? {};
  const port = String(httpPort);
  const matches = Object.entries(services).filter(([, raw]) => {
    const expose = (raw as { expose?: unknown }).expose;
    return Array.isArray(expose) && expose.map((entry) => String(entry)).includes(port);
  });
  return matches.length === 1 ? (matches[0]?.[0] ?? null) : null;
}

/** `SERVICE_ROLES` assignment from what the service is, never from list order. */
function roleFor(
  service: string,
  primary: string | null,
): 'primary' | 'database' | 'cache' | 'search' | 'worker' {
  if (service === primary) return 'primary';
  const name = service.toLowerCase();
  if (/mysql|maria|postgres|pg|database|db$/.test(name)) return 'database';
  if (/redis|memcache|valkey|cache/.test(name)) return 'cache';
  if (/elastic|opensearch|meilisearch|solr|search/.test(name)) return 'search';
  return 'worker';
}

/**
 * How long a container may be observed `exited` before it counts as stopped.
 *
 * Two polls of the 3 s loop: Docker reports `exited` for an instant before a restart policy revives
 * the container, and a stage that failed on that instant would kill deployments that were about to
 * work. Anything longer than a restart delay is a container that is not coming back.
 */
const EXITED_OBSERVATION_MS = 6_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Collapses the lines a poll loop repeats.
 *
 * The failed D11 deployment wrote 632 log lines for a twenty-minute wait — 309 identical probe
 * failures and 309 identical `2 container(s) running` — which buried the only line that mattered.
 * A repeated line is written when it first appears and then at most once per `heartbeatMs`, with the
 * count appended: the log still proves the stage was alive, without becoming a transcript of a timer.
 */
class RepeatedLineGuard {
  private readonly seen = new Map<string, { count: number; at: number }>();

  constructor(
    private readonly context: PipelineContext,
    private readonly heartbeatMs = 60_000,
  ) {}

  note = async (stream: LogStream, line: string): Promise<void> => {
    const seen = this.seen.get(line);
    if (seen === undefined) {
      this.seen.set(line, { count: 1, at: Date.now() });
      await this.context.log(stream, line);
      return;
    }
    seen.count += 1;
    if (Date.now() - seen.at < this.heartbeatMs) return;
    seen.at = Date.now();
    await this.context.log(stream, `${line} (${seen.count} attempts)`);
  };
}

/**
 * A dotenv value is quoted only when it has to be: `docker compose --env-file` strips quotes, so a
 * password containing `#` or a space survives, and one that does not is written verbatim.
 */
function quoteEnv(value: string): string {
  return /[\s#"']/.test(value) ? JSON.stringify(value) : value;
}

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
import { digestPinVerdict } from '../../common/docker/digest-pin';
import { AppError } from '../../common/problem/app-error';
import { ensureDir, writeFileAtomic } from '../../common/fs/files';
import { runtimeSecretsPaths } from '../../common/compose/runtime-secrets';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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
import { IMAGE_SCAN_SERVICE, type ImageScanService } from './executor.contract';
import {
  INTEGRATION_SERVICE,
  type IntegrationService,
} from '../m07-integration/integration.contract';
import {
  DockerEngineClient,
  type ComposeProject,
  type VolumeSummary,
} from '../../common/docker/docker.client';
import { instanceNetwork, projectName } from '../../common/docker/naming';
import { engineOf } from '../../common/engine/database';
import { writeExportArchive, type ExportArtefact } from './export-archive';
import { composeDocumentOf, mountPathForVolume } from '../../common/compose/compose-volumes';
import {
  describeProbe,
  installerReason,
  probeProductHttp,
  type HttpProbeResult,
} from '../../common/exec/http-probe';
import { productVersionOf } from '../../common/docker/image-ref';

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
  /** `instance_route.tls_mode`; null until the first `integrate` stage materialises the route. */
  route_tls_mode: string | null;
};

type RunState = {
  instance: InstanceRow;
  source?: ResolvedSource;
  renderSet?: RenderSet;
  plan?: PlanRecord;
  /** Set by `export`; the audit record names the artefact so AC-20 has evidence, not a promise. */
  artefact?: ExportArtefact;
  /**
   * Image reference → the id `build` produced in this run, or absent when the entry needs no build.
   * `apply` proves the tag still resolves to these before and after the containers exist, which is
   * the only claim about a local image that cannot be satisfied by a pull.
   */
  builds?: ReadonlyMap<string, string>;
};

/** One image a catalogue entry pins: the reference to fetch, and the digest that pin claims. */
type PinnedImage = {
  readonly reference: string;
  readonly digest: string | null;
};

/** A build a vendored tree declares: what to tag, and where its context and Dockerfile live. */
type DeclaredBuild = {
  readonly reference: string;
  readonly context: string;
  readonly dockerfile: string;
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
    @Inject(IMAGE_SCAN_SERVICE) private readonly images: ImageScanService,
  ) {}

  onModuleInit(): void {
    const deploy: PipelineStage[] = [
      stage('resolve', 'Resolve source', (context) => this.resolve(context)),
      stage('render', 'Render definition', (context) => this.render(context)),
      stage('plan', 'Plan and admit', (context) => this.plan(context)),
      // After admission, so an entry the capacity check refuses never costs a build; before apply,
      // because the definition is not startable until its images exist locally.
      stage('build', 'Build images', (context) => this.buildImages(context)),
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
      stage('build', 'Build images', (context) => this.buildImages(context)),
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

    // FR-1.7: the confirmation is re-asserted against the catalogue at job time. The dialog read the
    // pin minutes ago; applying whatever the catalogue holds now is what made "the operator
    // confirmed 9.2.1" unprovable.
    await this.assertConfirmedVersion(context, instance);

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

  /**
   * FR-1.7/AC-06: refuse an upgrade whose confirmed version is no longer the catalogue pin.
   *
   * The catalogue holds one pinned image per entry, so `targetVersion` is a promise about the pin
   * rather than a selector: equality with `payload.upstream.latestVersion` is the whole check. A
   * later multi-version catalogue changes the resolution step, not this assertion.
   */
  private async assertConfirmedVersion(
    context: PipelineContext,
    instance: InstanceRow,
  ): Promise<void> {
    const confirmed = context.payload.targetVersion;
    if (context.action !== 'upgrade' || typeof confirmed !== 'string' || confirmed.length === 0) {
      return;
    }
    const row = await this.pool.query<{ latest: string | null }>(
      `SELECT payload #>> '{upstream,latestVersion}' AS latest
         FROM catalog_entry WHERE key = $1`,
      [instance.entry_key],
    );
    const latest = row.rows[0]?.latest ?? null;
    if (latest !== confirmed) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail:
          latest === null
            ? `The confirmed upgrade target ${confirmed} cannot be re-asserted: ${instance.entry_key} records no upstream version.`
            : `The catalogue now pins ${latest}, not the confirmed ${confirmed}.`,
        remediation:
          'Re-open the upgrade dialog and confirm the version the catalogue pins now. Nothing was changed.',
      });
    }
    await context.log(
      'stdout',
      `confirmed upgrade target ${confirmed} still matches the catalogue pin`,
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

    /*
     * 4D.1 — the identity client's secret is applied before the definition that carries it.
     *
     * `registerIdentity` runs in `integrate`, which is after `apply`, because the redirect URI it
     * registers is derived from the route that stage materialises. A secret minted there could only
     * reach a container on the *next* deployment, and ERPNext booted without one, took its documented
     * fallback and never wrote a `Social Login Key` while every check stayed green. The value is put
     * on the instance here instead, so the render in the next statement includes it and `apply`
     * injects it; `registerIdentity` then registers that same value at the identity provider.
     */
    const secret = await this.integration.ensureIdentitySecret(state.instance.id, context.actorId);
    if (secret.variable !== null && secret.status !== 'applied') {
      await context.log(
        'stdout',
        `${secret.variable} ${secret.status === 'minted' ? 'generated and stored' : 'stored'} as the instance secret it is applied from`,
      );
    }

    const route = routeOf(state.instance, this.config.SEAMNEX_EDGE_TLS_MODE);
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

    /*
     * FR-1.5 — before anything from the definition starts. Two questions, depending on how the
     * artefact came to exist: an entry that builds (any service with a `build:` section) must be
     * running the image this run produced, and an entry that does not is compared with the digest the
     * catalogue records. The build ran in the previous stage, so nothing here may trigger one.
     */
    await this.assertPinnedImages(state, context);

    await this.docker.ensureNetwork(instanceNetwork(state.instance.slug), {
      'seamnex.instance': state.instance.id,
    });

    /*
     * NFR-4.6 / S-10 — the scan below asks the daemon about every image by name, so a sidecar nobody
     * has fetched yet is an inspect 404 rather than a finding. `compose up` would fetch it, but `up`
     * runs after the scan on purpose; on a host that had never pulled `mariadb:11.4.13@sha256:…` the
     * first deployment of D01-01 died here with the daemon's `no such image` and no stage had tried.
     */
    await this.ensureImagesLocal(state, renderSet, context);

    /*
     * NFR-4.6 / S-10 — scan what is about to start, after every image is local and before any
     * container exists. Placed here rather than in `prepull` because the build stage produced the
     * images: a Dockerfile path has no image to scan until `build` has run.
     */
    const scanned = await this.images.scanForDeploy({
      instanceId: state.instance.id,
      references: imagesOf(renderSet),
      log: (level, line) => context.log(level, line),
    });
    if (scanned.length > 0) {
      /*
       * `error` is a first-class verdict, so this line may not summarise every outcome as a pass: a
       * deployment that continued past an unscannable image (fail-open) would otherwise read as
       * "no blocking findings" one line after saying nothing was looked at.
       */
      const blocked = scanned.filter((summary) => summary.verdict === 'blocked').length;
      const unscanned = scanned.filter((summary) => summary.verdict === 'error').length;
      await context.log(
        'system',
        blocked === 0 && unscanned === 0
          ? `${scanned.length} image(s) scanned; no blocking findings`
          : `${scanned.length} image(s) examined: ${scanned.length - blocked - unscanned} passed, ${blocked} blocked, ${unscanned} not scanned`,
      );
    }

    await this.docker.composeUp(project, (line) => context.log('stdout', line));
    await context.log('stdout', 'compose project applied');
    // The tag was proved before `up`; this proves `up` did not change what it settled on. A rebuild
    // between the two would be invisible in the container list, which reports the image it started.
    await this.assertBuiltArtefactRunning(state, context);
    // FR-1.9 / FR-1.12: `compose up` is what creates the named volumes, so this is the first moment
    // they exist. Recorded here rather than in `record` on purpose — a deployment that fails its
    // readiness check still holds real data, and a backup of that state must not be empty.
    await this.recordVolumes(state.instance, renderSet, context);
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
        const probe = await this.httpReady(state.instance, (line) => noise.note('stdout', line));
        if (probe.ok && probe.installer !== null) {
          /*
           * Reachable and uninstalled is a state, not a failure, and not `ready`.
           *
           * D07-01's entrypoint starts Apache on purpose when its first-boot install refuses, so that
           * the operator can finish in the product's own installer — that is why this stage must not
           * throw here: `integrate` still has to materialise the route, or the installer it just
           * pointed at would be unreachable. What it must not do is call the instance ready, which is
           * what three screens (instance state, portal tile, integration checks) reported for a
           * product whose `/` was its Setup Wizard.
           */
          await this.setState(state.instance.id, 'degraded', installerReason(probe.installer));
          await context.log(
            'stderr',
            `${installerReason(probe.installer)}. The route stays published so the installation can be completed in a browser; reconfigure the instance afterwards.`,
          );
          return;
        }
        if (probe.ok) {
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
    /*
     * `ready` last, and not unconditionally: a product that answers with its own installer is
     * reachable, route-complete and not usable, and this is the stage that used to overwrite the
     * `degraded` verdict `verify` had just recorded.
     */
    if (verdict.installPending !== null) {
      await this.setState(state.instance.id, 'degraded', installerReason(verdict.installPending));
      await context.log(
        'stderr',
        `${installerReason(verdict.installPending)}; the instance is not marked ready`,
      );
      return;
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
   * name and fail the whole stage. The result is returned whole rather than as a boolean because
   * "answered" and "installed" are two facts, and the caller has to be able to tell them apart.
   */
  private async httpReady(
    instance: InstanceRow,
    note: (line: string) => Promise<void>,
  ): Promise<HttpProbeResult> {
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
    return probe;
  }

  private async record(context: PipelineContext): Promise<void> {
    const state = this.requireRun(context.jobId);
    const renderSet = state.renderSet;

    /*
     * FR-1.7: what is running, recorded from the artefact that was applied rather than from the
     * request. `targetVersion` proves intent; `appliedVersion` proves outcome, and they are equal
     * only because `assertConfirmedVersion` checked the pin. A Dockerfile/scaffold build records no
     * tag, so the previous value is kept rather than replaced with a guess.
     *
     * The version is the *product's* image, matched by repository against the entry's declared image.
     * Index 0 is the compose file's first service, which for D07-01 is the `mariadb:11.4` sidecar: the
     * instance screen showed "current version 11.4 — available 5.9" for an OrangeHRM 5.9 deployment,
     * and an upgrade confirmation would have compared the database's tag.
     */
    const declaredImage =
      typeof state.instance.payload.imageRef === 'string' ? state.instance.payload.imageRef : null;
    const appliedVersion =
      renderSet === undefined ? null : productVersionOf(renderSet.imageRefs, declaredImage);

    if (renderSet !== undefined) {
      await this.recordServices(state.instance, renderSet);
      await this.pool.query(
        `UPDATE instance
            SET payload = payload || jsonb_build_object('activeRenderSetId', $2::text)
                        || CASE WHEN $4::text IS NULL THEN '{}'::jsonb
                                ELSE jsonb_build_object('currentVersion', $4::text) END
                        || CASE WHEN $5::text IS NULL THEN '{}'::jsonb
                                ELSE jsonb_build_object('imageDigest', $5::text) END,
                source_path = $3,
                updated_at = now()
          WHERE id = $1`,
        [
          state.instance.id,
          renderSet.id,
          state.source?.path ?? state.instance.source_path,
          appliedVersion,
          this.builtPrimaryDigest(state, renderSet),
        ],
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
        // FR-1.7/AC-06: the trail now names the version the operator confirmed and the version the
        // applied artefact actually carries.
        targetVersion:
          typeof context.payload.targetVersion === 'string' ? context.payload.targetVersion : null,
        appliedVersion,
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
      detail: {
        jobId: context.jobId,
        fromState: instance.state,
        targetVersion:
          typeof context.payload.targetVersion === 'string' ? context.payload.targetVersion : null,
      },
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
    const probe = await this.httpReady(instance, (line) => context.log('stdout', line));
    // An installer page answers, so it is not "did not pass"; it is a product that is up and not
    // installed, and it must not become `ready` here either.
    const ready = probe.ok && probe.installer === null;
    await this.setState(
      instance.id,
      ready ? 'ready' : 'degraded',
      ready
        ? null
        : probe.installer !== null
          ? installerReason(probe.installer)
          : `containers started, but the readiness probe did not pass (${action})`,
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

  /**
   * FR-1.13 / AC-20 — a full data export, not a description of one.
   *
   * Two refusals happen before any helper runs, because a file whose name promises a full export and
   * whose contents are partial is the defect this stage used to be:
   *
   * - no applied (or latest) render set: there is no definition and no product to capture;
   * - a declared database service while the instance is not running: a stopped product cannot be
   *   dumped, and silently omitting its database would make the archive a lie.
   *
   * A failed capture therefore leaves no artefact behind — the writer removes its staging tree.
   */
  private async export(context: PipelineContext): Promise<void> {
    const instance = await this.instance(context.instanceId);
    this.runs.set(context.jobId, { instance });

    const applied = await this.renderer.applied(instance.id);
    const renderSet = applied ?? (await this.latestRenderSet(instance.id));
    if (renderSet === null) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `${instance.slug} has never been deployed, so there is no data to export.`,
        remediation:
          'Deploy the instance first. An export of a definition that never ran would hold no product data, which is not a full data export (FR-1.13).',
      });
    }

    const services = await this.pool.query<{ service_name: string; image_ref: string }>(
      `SELECT service_name, image_ref FROM instance_service WHERE instance_id = $1 ORDER BY service_name`,
      [instance.id],
    );
    const volumes = await this.pool.query<{ name: string }>(
      `SELECT name FROM instance_volume WHERE instance_id = $1 ORDER BY name`,
      [instance.id],
    );
    const environment = await this.pool.query<{
      var_name: string;
      value_enc: Buffer | null;
      source: string;
      secret_ref: string | null;
    }>(
      `SELECT var_name, value_enc, source, secret_ref FROM instance_env_value
        WHERE instance_id = $1 ORDER BY var_name`,
      [instance.id],
    );

    const datastores = services.rows.filter((service) => engineOf(service.image_ref) !== null);
    const running = instance.state === 'ready' || instance.state === 'degraded';
    if (datastores.length > 0 && !running) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: `${instance.slug} is ${instance.state}: ${datastores
          .map((service) => service.service_name)
          .join(', ')} cannot be dumped while the instance is not running.`,
        remediation:
          'Start the instance and run the export again. A stopped database is not an empty database; nothing was written.',
      });
    }

    const artefact = await writeExportArchive(
      {
        dataDir: this.config.SEAMNEX_INSTANCE_DATA_DIR,
        pathMap: this.config.SEAMNEX_DOCKER_PATH_MAP,
        docker: this.docker,
        log: (stream, line) => context.log(stream, line),
      },
      {
        instance: {
          id: instance.id,
          slug: instance.slug,
          entryKey: instance.entry_key,
          state: instance.state,
        },
        renderSet: {
          id: renderSet.id,
          contentHash: renderSet.contentHash,
          directory: renderSet.directory,
          applied: applied !== null,
        },
        services: services.rows.map((row) => ({
          service: row.service_name,
          imageRef: row.image_ref,
        })),
        volumes: volumes.rows.map((row) => row.name),
        envRows: environment.rows,
      },
    );

    this.requireRun(context.jobId).artefact = artefact;
    await context.log(
      'stdout',
      `export ${artefact.exportId} written: ${artefact.fileName} (${artefact.bytes} bytes; ${
        artefact.includes.join(', ') || 'no data'
      })`,
    );
  }

  /**
   * FR-1.5 — one place an image comes into existence.
   *
   * Two shapes reach it: a source that *is* a Dockerfile, and a Compose definition that declares
   * `build:` for a service — which is how a vendored tree says "this artefact is ours". Both used to
   * be scattered: the Dockerfile build sat inside `apply`, and the Compose build was left to
   * `compose up` unless `servicesWithBuild` happened to fire. Neither recorded what it produced, so a
   * reviewed Dockerfile change could be invisible and a pull could pass for a build.
   *
   * Nothing is pushed. The ids go into the run state and are what `apply` proves against; the
   * per-instance `instance_service.image_digest` is the record a later review reads.
   */
  private async buildImages(context: PipelineContext): Promise<void> {
    requireAdapters(this.config, 'docker');
    const state = this.requireRun(context.jobId);
    const renderSet = state.renderSet;
    const source = state.source;
    if (renderSet === undefined || source === undefined) {
      throw new AppError({
        code: 'STATE_CONFLICT',
        detail: 'The build stage ran before the definition existed.',
        remediation: 'Retry the deployment; resolve and render always run before build.',
      });
    }

    const builds = new Map<string, string>();

    /*
     * Before the CLI runs, not after: the mirrors are a property of this host's network, and a build
     * that spends its minutes on a CDN the host cannot reach looks identical in the log to one that
     * used a mirror. Naming them is what makes "the mirror was applied" checkable from evidence.
     */
    const mirrors = this.docker.buildMirrors();
    if (mirrors.length > 0) {
      await context.log(
        'stdout',
        `package mirrors forwarded to the build: ${mirrors.join(', ')} (host settings, never written into the image)`,
      );
    }

    if (source.path === 'dockerfile' || source.path === 'scaffold') {
      const ref = source.imageRef;
      if (ref !== null) {
        await context.log('stdout', `building ${ref} from ${source.directory}`);
        await this.docker.build({
          context: source.directory,
          dockerfile: source.dockerfilePath ?? join(source.directory, 'Dockerfile'),
          tag: ref,
          labels: {
            'seamnex.instance': state.instance.id,
            'seamnex.entry': state.instance.entry_key,
          },
        });
        await this.rememberBuild(builds, ref, context);
      }
      state.builds = builds;
      // The renderer also writes a `build:` block for this shape, so building it again through
      // Compose would be the same image twice; `up` reuses the tag this produced.
      return;
    }

    const services = servicesWithBuild(renderSet);
    if (services.length > 0) {
      /*
       * Compose parses *every* service before it builds any of them, and a definition is allowed to
       * declare a credential as required (`${VAR:?…}`). The secrets override is written by `apply`,
       * which runs after this stage, so the first real deployment of D07-01 aborted here with
       * "error while interpolating services.orangehrm-db.environment.MARIADB_ROOT_PASSWORD: required
       * variable ORANGEHRM_DATABASE_ROOT_PASSWORD is missing a value" — a healthy definition refused
       * by its own build, after pre-flight had passed.
       *
       * The files are 0600 and outside the render set, and `apply` rewrites them, so writing them
       * here changes nothing except the interpolation context the build needs.
       */
      const secrets = await this.writeSecretsFile(state.instance.id, renderSet);
      if (secrets !== null) {
        await context.log(
          'stdout',
          'secrets override written for build-time interpolation; no container is created by this step',
        );
      }
      const project = this.composeProjectFor(state.instance.id, renderSet);
      await context.log('stdout', `building from the definition: ${services.join(', ')}`);
      await this.docker.composeBuild(project, (line) => context.log('stdout', line));
      for (const service of services) {
        const ref = imageOfService(renderSet, service);
        if (ref === null) {
          await context.log(
            'system',
            `${service} declares build: without image:, so the artefact has no name the platform can pin; the definition should declare both`,
          );
          continue;
        }
        await this.rememberBuild(builds, ref, context);
      }
    }
    state.builds = builds;
  }

  private async rememberBuild(
    builds: Map<string, string>,
    ref: string,
    context: PipelineContext,
  ): Promise<void> {
    const id = await this.docker.imageId(ref);
    if (id === null) {
      throw new AppError({
        code: 'IMAGE_DIGEST_MISMATCH',
        detail: `${ref} was built but the daemon holds no image under that tag afterwards.`,
        remediation:
          'Read the build log above; the deployment stops here rather than start an image it cannot name.',
      });
    }
    builds.set(ref, id);
    await context.log('stdout', `${ref} built as ${id}`);
  }

  /**
   * FR-1.7 / "Prefetch images" — make the artefact local before the deployment window.
   *
   * For an entry whose definition declares `build:` that means *building* it. Pulling would fetch the
   * registry's idea of the tag, which is the artefact the build exists to replace, and
   * `pull_policy: never` would then make the deploy refuse it — a prefetch that guarantees a failure.
   * Building is also the point of doing this early: the release archive and the base image are the
   * slow downloads, and they leave the window with them.
   *
   * There is no instance here, so the tree is read from the vendored mirror rather than resolved. A
   * mirror that is absent falls back to the pull (every registry entry has no tree); a tree that
   * declares a build whose context or Dockerfile is missing is refused by name, because a prefetch
   * that guesses is worse than one that stops.
   */
  private async prepull(context: PipelineContext): Promise<void> {
    requireAdapters(this.config, 'docker');
    const entryKey = typeof context.payload.entryKey === 'string' ? context.payload.entryKey : '';
    if (entryKey.length === 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        detail: 'A prefetch job needs the entry key it is preparing.',
        remediation: 'Start "Prefetch images" from the catalog entry rather than as a bare job.',
      });
    }

    const declared = this.declaredBuilds(entryKey);
    if (declared.length > 0) {
      for (const build of declared) {
        await context.log('stdout', `building ${build.reference} from ${build.context}`);
        await this.docker.build({
          context: build.context,
          dockerfile: build.dockerfile,
          tag: build.reference,
        });
        const id = await this.docker.imageId(build.reference);
        await context.log(
          'stdout',
          id === null
            ? `${build.reference} built, but the daemon reports no id for it`
            : `${build.reference} built as ${id}; this entry is never pulled`,
        );
      }
      await context.log(
        'system',
        'no image was fetched from a registry; the deployment window now starts from a local artefact',
      );
      return;
    }

    const images = await this.imagesForEntry(entryKey);
    for (const image of images) {
      await context.log('stdout', `pulling ${image.reference}`);
      await this.docker.pull(image.reference, (line) => context.log('stdout', line), {
        expectedDigest: image.digest,
      });
      // The pin is checked against what the pull produced, not against what the entry asked for: a
      // resolve job that reports "pulled" while the tag has moved is the failure this stage exists for.
      await this.assertPinnedDigest(image.reference, image.digest, context);
    }
  }

  /**
   * FR-1.5 — before anything from the definition starts.
   *
   * A service with a `build:` section is *local*: its identity is the id this run produced, and no
   * pull may satisfy it. Everything else keeps the registry rule, where the catalogue's digest is the
   * claim being checked. The token is computed from the rendered definition, never from how the tag
   * happens to be spelled: a namespace cannot tell you where an image came from.
   */
  private async assertPinnedImages(state: RunState, context: PipelineContext): Promise<void> {
    const renderSet = state.renderSet;
    const source = state.source;
    if (renderSet === undefined) return;

    if (servicesWithBuild(renderSet).length > 0) {
      await this.assertLocalImages(state, renderSet, context);
      return;
    }

    if (source === undefined || source.path !== 'compose') return;
    if (source.imageRef === null || source.imageDigest === null) return;
    // A reference that names its own digest is already exact: `image:` cannot resolve anywhere else.
    if (source.imageRef.includes('@sha256:')) {
      await context.log('stdout', `${source.imageRef} pins its digest in the reference`);
      return;
    }
    if (!(await this.docker.imageExists(source.imageRef))) {
      await context.log(
        'stdout',
        `${source.imageRef} is not present locally; pulling it to check the pin`,
      );
      /*
       * The pin travels into the pull so a mirror that serves different content is refused *inside*
       * the attempt: the next mirror, or the registry itself, is then tried instead of failing the
       * deployment on the first mirror that answers.
       */
      await this.docker.pull(source.imageRef, (line) => context.log('stdout', line), {
        expectedDigest: source.imageDigest,
      });
    }
    await this.assertPinnedDigest(source.imageRef, source.imageDigest, context);
  }

  /**
   * Every image the definition starts, present locally — before the scan asks about them.
   *
   * `assertPinnedImages` speaks only for the entry's own image; a sidecar such as
   * `mariadb:11.4.13@sha256:…` is normally left to `compose up`. The scan runs before `up`, so a host
   * that had never fetched the sidecar answered the scan with the daemon's `404 no such image`, and
   * the deployment failed at a stage that was only supposed to look. Pulling here keeps the scan's
   * precondition true and turns an unreachable pin into the pull's own message.
   *
   * Images this run built are skipped: their tag is the artefact `build` produced, and a pull would
   * replace it with the registry's idea of the tag. `assertLocalImages` has already refused the case
   * where such a tag is absent.
   */
  private async ensureImagesLocal(
    state: RunState,
    renderSet: RenderSet,
    context: PipelineContext,
  ): Promise<void> {
    const built = new Set(state.builds?.keys() ?? []);
    for (const ref of imagesOf(renderSet)) {
      if (built.has(ref)) continue;
      if (await this.docker.imageExists(ref)) continue;
      await context.log('stdout', `${ref} is not present locally; pulling it before the scan`);
      await this.docker.pull(ref, (line) => context.log('stdout', line), {
        // A reference that names its own digest is already exact; the pull then checks that pin.
        expectedDigest: digestNamedIn(ref),
      });
    }
  }

  /**
   * The local pin: the tag must still resolve to the image this run built. That is the whole claim,
   * and it is the one a pull cannot fake.
   *
   * The per-instance record is a trust-on-first-use baseline, reported as drift rather than refused:
   * rebuilding an unchanged definition legitimately produces a new id when the layer cache is gone or
   * the base image moved, so a refusal there would tie redeployment to build reproducibility the
   * platform does not have. Refusing instead happens where substitution actually shows up — the tag
   * and the running container — in this method and in `assertBuiltArtefactRunning`.
   */
  private async assertLocalImages(
    state: RunState,
    renderSet: RenderSet,
    context: PipelineContext,
  ): Promise<void> {
    const previous = await this.recordedDigests(state.instance.id);
    for (const service of servicesWithBuild(renderSet)) {
      const ref = imageOfService(renderSet, service);
      if (ref === null) continue;

      const recorded = previous.get(service) ?? null;
      const built = state.builds?.get(ref) ?? null;
      /*
       * A rollback starts a definition no build produced in this run; the only identity available is
       * the one recorded when that definition was deployed. Comparing the tag with it is the same
       * question — "is this the artefact we built for this instance?" — asked of older evidence.
       */
      const expected = built ?? recorded;
      const observed = await this.docker.imageId(ref);
      const verdict = digestPinVerdict({
        mode: 'local',
        reference: ref,
        expected,
        observed,
      });
      if (!verdict.ok) {
        throw new AppError({
          code: 'IMAGE_DIGEST_MISMATCH',
          detail:
            built === null && recorded !== null
              ? `This job built nothing, so ${ref} is checked against the image recorded for this instance (${recorded}). It ${observed === null ? 'is not present on this host' : `resolves to ${observed}`}.`
              : verdict.detail,
          remediation: verdict.remediation,
        });
      }

      if (built === null) {
        await context.log(
          'stdout',
          `${ref} matches the image recorded for this instance (${expected})`,
        );
      } else if (recorded === null) {
        await context.log(
          'stdout',
          `${ref} is this instance's first local build; recording ${built} as the baseline`,
        );
      } else if (recorded !== built) {
        await context.log(
          'system',
          `${ref} was ${recorded} at the last deployment and is ${built} now: the artefact changed although the definition did not. Recorded as the new baseline`,
        );
      } else {
        await context.log('stdout', `${ref} matches the recorded build ${built}`);
      }
    }
  }

  /** After `up`: the tag must still be the build's output, or the containers are not what was built. */
  private async assertBuiltArtefactRunning(
    state: RunState,
    context: PipelineContext,
  ): Promise<void> {
    const builds = state.builds;
    if (builds === undefined || builds.size === 0) return;
    for (const [ref, built] of builds) {
      const current = await this.docker.imageId(ref);
      if (current === built) {
        await context.log('stdout', `${ref} still resolves to ${built} after apply`);
        continue;
      }
      throw new AppError({
        code: 'IMAGE_DIGEST_MISMATCH',
        detail:
          `${ref} resolves to ${current ?? 'nothing'} after the containers started, but this run built ` +
          `${built}. The running containers are not the artefact this deployment produced.`,
        remediation:
          'The containers are left running so the instance is not silently emptied. Inspect the tag, ' +
          'then redeploy: the job failed on purpose rather than report success for an image it did ' +
          'not build.',
      });
    }
  }

  /**
   * The id this run built for the product's own image, or `null` when the deployment pulls it.
   *
   * ADR-BE-40 gave identity a second shape: a locally built image has no repository digest, and the
   * id changes on every build because the build carries instance labels. The instance's *reported*
   * identity therefore has to come from the build, not from the catalogue's reference value — the
   * overview showed the catalogue digest (`0cc3f586…`, built once for a prefetch) while the
   * containers ran `65959ba07e6d…`, so the two screens of one instance disagreed about what was
   * running. A pulled image keeps the catalogue's answer: there the manifest digest is the pin, and
   * it is the value a reader can check against the registry.
   */
  private builtPrimaryDigest(state: RunState, renderSet: RenderSet): string | null {
    const builds = state.builds;
    if (builds === undefined || builds.size === 0) return null;
    const primary = primaryServiceOf(renderSet, httpPortOf(state.instance));
    if (primary === null) return null;
    const ref = imageOfService(renderSet, primary);
    return ref === null ? null : (builds.get(ref) ?? null);
  }

  private async recordedDigests(instanceId: string): Promise<Map<string, string>> {
    const result = await this.pool.query<{ service_name: string; image_digest: string | null }>(
      `SELECT service_name, image_digest FROM instance_service WHERE instance_id = $1`,
      [instanceId],
    );
    const digests = new Map<string, string>();
    for (const row of result.rows) {
      if (row.image_digest !== null) digests.set(row.service_name, row.image_digest);
    }
    return digests;
  }

  /**
   * The builds a vendored tree declares, read straight from the mirror.
   *
   * Used by `prepull`, which has no instance and therefore no resolved tree. Relative contexts are
   * joined to the tree here, which is the same base the renderer would pick.
   */
  private declaredBuilds(entryKey: string): DeclaredBuild[] {
    const root =
      this.config.SEAMNEX_SOURCE_MIRROR_DIR.length > 0
        ? this.config.SEAMNEX_SOURCE_MIRROR_DIR
        : join(this.config.SEAMNEX_CATALOG_REPO_PATH, 'upstream');
    const tree = join(root, entryKey);
    if (!existsSync(tree)) return [];

    const composePath = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yaml', 'compose.yml']
      .map((name) => join(tree, name))
      .find((candidate) => existsSync(candidate));
    if (composePath === undefined) return [];

    const document = parseYaml(readFileSync(composePath, 'utf8')) as { services?: unknown } | null;
    const services = document?.services;
    if (typeof services !== 'object' || services === null) return [];

    const builds: DeclaredBuild[] = [];
    for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
      const service = raw as { image?: unknown; build?: unknown } | null;
      if (service === null || service.build === undefined) continue;
      if (typeof service.image !== 'string' || service.image.trim().length === 0) {
        throw new AppError({
          code: 'VALIDATION_FAILED',
          detail: `${entryKey}: service ${name} declares build: without image:, so the prefetch cannot name the artefact it produced.`,
          remediation: `Declare both keys on ${name} in ${composePath}, then retry the prefetch.`,
        });
      }
      const block =
        typeof service.build === 'string'
          ? { context: service.build }
          : (service.build as { context?: unknown; dockerfile?: unknown });
      const declaredContext = typeof block.context === 'string' ? block.context : '.';
      const context = join(tree, declaredContext);
      if (!existsSync(context)) {
        throw new AppError({
          code: 'VALIDATION_FAILED',
          detail: `${entryKey}: the build context ${declaredContext} of service ${name} is not in the vendored tree at ${tree}.`,
          remediation:
            'Restore the tree in the catalogue mirror (or set SEAMNEX_SOURCE_MIRROR_DIR), then retry; a prefetch never clones.',
        });
      }
      const dockerfileName = typeof block.dockerfile === 'string' ? block.dockerfile : 'Dockerfile';
      builds.push({
        reference: service.image.trim(),
        context,
        dockerfile: join(context, dockerfileName),
      });
    }
    return builds;
  }

  private async assertPinnedDigest(
    reference: string,
    expected: string | null,
    context: PipelineContext,
  ): Promise<void> {
    if (expected === null) return;
    const observed = await this.docker.repoDigest(reference);
    const verdict = digestPinVerdict({ mode: 'registry', reference, expected, observed });
    if (verdict.ok) {
      await context.log('stdout', `${reference} matches the pinned digest ${expected}`);
      return;
    }
    throw new AppError({
      code: 'IMAGE_DIGEST_MISMATCH',
      detail: verdict.detail,
      remediation: verdict.remediation,
    });
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
      // The export's artefact is evidence: AC-20 asks that the data is *usable externally*, and an
      // audit line that names the id, size and contents is what a reviewer can check later.
      detail:
        state?.artefact === undefined
          ? { jobId: context.jobId }
          : {
              jobId: context.jobId,
              exportId: state.artefact.exportId,
              fileName: state.artefact.fileName,
              bytes: state.artefact.bytes,
              sha256: state.artefact.sha256,
              includes: state.artefact.includes,
            },
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

    const paths = runtimeSecretsPaths({
      dataDir: this.config.SEAMNEX_INSTANCE_DATA_DIR,
      instanceId,
      renderSetId: renderSet.id,
    });
    ensureDir(dirname(paths.override));
    const override = paths.override;
    const env = paths.env;
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
    const { override: secretsOverride, env: secretsEnv } = runtimeSecretsPaths({
      dataDir: this.config.SEAMNEX_INSTANCE_DATA_DIR,
      instanceId,
      renderSetId: renderSet.id,
    });
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
              i.source_path, r.host AS route_host, r.tls_mode AS route_tls_mode
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

  /**
   * FR-1.9 / FR-1.12 — the instance's data volumes, as the daemon has them.
   *
   * Three facts decide what is written:
   *   - **the name comes from the daemon.** Compose prefixes a named volume with `--project-name`
   *     (`seamnex-<slug>_db-data`), and a backup that mounted the key from the file would mount
   *     nothing. The label a Compose-created volume carries also gives the declarative key
   *     (`com.docker.compose.volume`), which is what the catalog describes.
   *   - **the quota comes from the declaration**, matched by that key (`VolumeSpecSchema`). A volume
   *     the catalog does not describe is not refused — it is a definition the entry has not caught
   *     up with — but it must not borrow a flattering default: the instance's whole disk reservation
   *     is used and the gap is named in the job log.
   *   - **a failed listing changes nothing.** Registration is an observation; deleting rows because
   *     the daemon could not be asked would erase the only record of where a product's data lives.
   */
  private async recordVolumes(
    instance: InstanceRow,
    renderSet: RenderSet,
    context: PipelineContext,
  ): Promise<void> {
    const project = projectName(instance.slug);
    let listed: VolumeSummary[];
    try {
      listed = await this.docker.volumes([`com.docker.compose.project=${project}`]);
    } catch (error) {
      await context.log(
        'system',
        `the volumes of ${project} could not be listed (${error instanceof Error ? error.message : String(error)}); the recorded set is unchanged`,
      );
      return;
    }

    const declared = await this.declaredVolumes(instance.entry_key);
    const platformFile = renderSet.files.find(
      (file) => file.path === 'docker-compose.platform.yml',
    );
    const document = platformFile === undefined ? null : composeDocumentOf(platformFile.content);
    const reservationMb = resourcesOf(instance).diskMb;
    const registered: string[] = [];

    for (const volume of listed) {
      const key = volume.labels['com.docker.compose.volume'] ?? volume.name;
      const spec = declared.get(key);
      const declaredPath = spec?.mountPath;
      const mountPath =
        declaredPath !== undefined && declaredPath.length > 0
          ? declaredPath
          : document === null
            ? null
            : mountPathForVolume(document, key);
      if (mountPath === null || mountPath.length === 0) {
        // A Compose volume is only created when a service mounts it, so this is a label the platform
        // cannot read rather than a volume with no path. Naming it is better than inventing `/`.
        await context.log(
          'system',
          `volume ${volume.name} has no mount path in the render set; it is not registered and a backup will refuse while the definition still declares it`,
        );
        continue;
      }
      if (spec === undefined) {
        await context.log(
          'system',
          `volume ${volume.name} is not declared by ${instance.entry_key}; its quota is the instance reservation of ${reservationMb} MB`,
        );
      }
      await this.pool.query(
        `INSERT INTO instance_volume (instance_id, name, mount_path, host_path, quota_mb)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (instance_id, name) DO UPDATE
            SET mount_path = EXCLUDED.mount_path,
                host_path = EXCLUDED.host_path,
                quota_mb = EXCLUDED.quota_mb`,
        [
          instance.id,
          volume.name,
          mountPath,
          volume.mountpoint.length > 0 ? volume.mountpoint : null,
          spec?.quotaMb ?? reservationMb,
        ],
      );
      registered.push(volume.name);
    }

    const existing = await this.pool.query<{ name: string }>(
      `SELECT name FROM instance_volume WHERE instance_id = $1`,
      [instance.id],
    );
    const stale = existing.rows.map((row) => row.name).filter((name) => !registered.includes(name));
    if (stale.length > 0) {
      await this.pool.query(
        `DELETE FROM instance_volume WHERE instance_id = $1 AND name = ANY($2::text[])`,
        [instance.id, stale],
      );
      await context.log(
        'system',
        `dropped ${stale.length} volume record(s) the daemon no longer holds: ${stale.join(', ')}`,
      );
    }

    await context.log(
      'stdout',
      `${registered.length} data volume(s) registered for backup and quota checks${
        registered.length === 0 ? ' (the definition declares none)' : `: ${registered.join(', ')}`
      }`,
    );
  }

  /** `catalog_entry.payload.volumes[]`, keyed by the Compose volume key. */
  private async declaredVolumes(
    entryKey: string,
  ): Promise<Map<string, { mountPath: string; quotaMb: number }>> {
    const result = await this.pool.query<{ volumes: unknown }>(
      `SELECT payload -> 'volumes' AS volumes FROM catalog_entry WHERE key = $1`,
      [entryKey],
    );
    const rows = Array.isArray(result.rows[0]?.volumes)
      ? (result.rows[0]?.volumes as unknown[])
      : [];
    const declared = new Map<string, { mountPath: string; quotaMb: number }>();
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue;
      const record = row as Record<string, unknown>;
      if (typeof record.name !== 'string' || record.name.length === 0) continue;
      const quotaMb =
        typeof record.quotaMb === 'number' && record.quotaMb > 0
          ? Math.round(record.quotaMb)
          : null;
      if (quotaMb === null) continue;
      declared.set(record.name, {
        mountPath: typeof record.mountPath === 'string' ? record.mountPath : '',
        quotaMb,
      });
    }
    return declared;
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

  /** The pinned image an entry deploys, with the digest that pin claims, or nothing when it names none. */
  private async imagesForEntry(entryKey: string): Promise<PinnedImage[]> {
    const result = await this.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM catalog_entry WHERE key = $1`,
      [entryKey],
    );
    const payload = result.rows[0]?.payload ?? {};
    const image = typeof payload.imageRef === 'string' ? payload.imageRef : null;
    if (image === null) return [];
    const digest = typeof payload.imageDigest === 'string' ? payload.imageDigest : null;
    return [{ reference: image, digest }];
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

/**
 * The edge mode is the last fallback, not a constant: an instance deployed before the route row
 * carried a truthful `tls_mode` still renders the certificate the deployment actually serves
 * (ISSUE-07). The relational column wins whenever it exists.
 */
function routeOf(instance: InstanceRow, edgeTlsMode: RenderRoute['tlsMode']): RenderRoute {
  const route = (instance.payload.route ?? {}) as Partial<RenderRoute>;
  return {
    // Relational truth first, then the deploy-time snapshot, then the column written at insert.
    // A render that ran after `SEAMNEX_INGRESS_DOMAIN` changed published the old host otherwise.
    host:
      instance.route_host ?? (typeof route.host === 'string' ? route.host : instance.domain_route),
    pathPrefix: route.pathPrefix ?? null,
    publishModel: route.publishModel ?? 'subdomain',
    tlsMode:
      instance.route_tls_mode === 'acme' || instance.route_tls_mode === 'internal'
        ? instance.route_tls_mode
        : (route.tlsMode ?? edgeTlsMode),
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

/**
 * Every `image:` the render set names, across the base file and the platform override.
 *
 * Both files are read because the split varies: an entry with a vendored compose keeps its images
 * in the base document, while a scaffold's platform file can carry them instead. Scanning only the
 * platform file would report "nothing to scan" for every vendored product.
 */
function imagesOf(renderSet: RenderSet): string[] {
  const images = new Set<string>();
  for (const file of renderSet.files) {
    if (!file.path.endsWith('.yml') && !file.path.endsWith('.yaml')) continue;
    let parsed: unknown;
    try {
      parsed = parseYaml(file.content);
    } catch {
      continue;
    }
    const services = (parsed as { services?: unknown } | null)?.services;
    if (typeof services !== 'object' || services === null) continue;
    for (const raw of Object.values(services as Record<string, unknown>)) {
      const image = (raw as { image?: unknown } | null)?.image;
      if (typeof image === 'string' && image.trim().length > 0) images.add(image.trim());
    }
  }
  return [...images];
}

/** The digest a reference names itself (`repo:tag@sha256:…`), or `null` when it names none. */
function digestNamedIn(reference: string): string | null {
  const index = reference.indexOf('@sha256:');
  return index === -1 ? null : reference.slice(index + 1);
}

/** The tag a service's definition names, or `null` when it declares none. */
function imageOfService(renderSet: RenderSet, service: string): string | null {
  const services = parseServices(renderSet) ?? {};
  const image = (services[service] as { image?: unknown } | undefined)?.image;
  return typeof image === 'string' && image.trim().length > 0 ? image.trim() : null;
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

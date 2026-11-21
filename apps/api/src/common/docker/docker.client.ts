import { readFileSync } from 'node:fs';
import Docker from 'dockerode';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { parseAllDocuments } from 'yaml';
import { requireAdapters } from '../adapters';
import { run, runOrThrow, spawnProcess } from '../exec/exec';
import { AppError } from '../problem/app-error';
import { digestPinVerdict } from './digest-pin';
import {
  IMAGE_TRUST_GUARD,
  type ImageTrustGuard,
  type ImageTrustOperation,
} from '../security/trusted-registries';

export type ContainerSummary = {
  readonly id: string;
  readonly name: string;
  readonly service: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly labels: Readonly<Record<string, string>>;
};

export type ImageIdentity = { readonly ref: string; readonly digest: string; readonly id: string };

/**
 * A volume as the daemon knows it. `name` is the authority: Compose prefixes a named volume with
 * the project (`seamnex-<slug>_db-data`), so the key in the file and the name to mount are two
 * different strings and only the engine can settle which is which.
 */
export type VolumeSummary = {
  readonly name: string;
  readonly mountpoint: string;
  readonly labels: Readonly<Record<string, string>>;
};

/** A container joined to a network: the daemon keys attachments by container id, not by name. */
export type NetworkEndpoint = { readonly id: string; readonly name: string };

/**
 * The subset of the Engine's stats payload this client reads.
 *
 * Declared here rather than taken from `dockerode`'s types because the library marks most counters
 * optional and some as `any`; a narrow local shape is what makes the CPU delta readable and testable.
 */
type DockerStats = {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; stats?: Record<string, number> };
};

export type ComposeProject = {
  readonly project: string;
  readonly directory: string;
  /** Absolute paths, in order; the base file first, the platform override second. */
  readonly files: readonly string[];
  /**
   * Interpolation sources, in precedence order. The platform file holds non-secret values; a
   * runtime secrets file may follow, which is what lets an upstream compose file that references a
   * credential by name (`MARIADB_PASSWORD: ${ESPOCRM_DATABASE_PASSWORD}`) receive the real value
   * without any of it entering the render set.
   */
  readonly envFiles: readonly string[];
};

/**
 * The buildx builder every build is routed through when `SEAMNEX_BUILDKIT_ADDR` is set.
 *
 * Fixed rather than generated: the builder is a property of the host, so every worker must agree on
 * one name. A generated name would register a fresh entry on every container recreate and leave the
 * cache behind with the old one.
 */
const BUILDKIT_BUILDER = 'seamnex-buildkit';

/**
 * The package-manager mirrors a build forwards, in the order a Dockerfile expects to declare them.
 *
 * One list, because the `--build-arg` pairs and the names the job log prints have to be the same set:
 * the defect this closes was a setting that reached no build at all, and a log that names a mirror it
 * did not forward would be the same lie in a friendlier font.
 */
const BUILD_MIRROR_ARGS = ['APK_MIRROR', 'APT_MIRROR', 'NPM_REGISTRY'] as const;

/**
 * The pull budget when the config object does not carry one.
 *
 * The schema defaults it to the same hour, so this is a guard for a partially built config (a test,
 * a script) rather than a second setting: `setTimeout(undefined)` would expire the attempt instantly
 * and turn every pull into a timeout.
 */
const DEFAULT_PULL_TIMEOUT_MS = 3_600_000;

/** One fetch attempt: the reference the daemon is asked for, and the mirror it came from or `null`. */
type PullAttempt = { readonly reference: string; readonly mirror: string | null };

/**
 * ADR-BE-12 D2 — Docker access.
 *
 * Two mechanisms, each where it is the only option:
 *   - the Engine API (`dockerode`) for containers, networks, volumes, images and logs, through the
 *     socket proxy with `EXEC=0`;
 *   - the CLI (`docker compose`, `buildx`, `save`, `load`) for the operations the API does not
 *     expose. Every CLI call is an argv array with `shell: false` and a timeout.
 *
 * There is no fallback that pretends: if the daemon is unreachable, the call throws
 * `ADAPTER_UNAVAILABLE`, and the job fails with that code.
 */
@Injectable()
export class DockerEngineClient {
  private readonly logger = new Logger('m05-docker');
  private readonly docker: Docker;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    /**
     * NFR-4.16 — the trusted-registry guard, injected rather than imported so the client keeps one
     * dependency direction. Optional at the type level only: a client without it refuses to pull or
     * build (see `assertTrustedImage`), because a guard that quietly disappears is the hole this
     * control exists to close.
     */
    @Optional()
    @Inject(IMAGE_TRUST_GUARD)
    private readonly imageTrust?: ImageTrustGuard,
  ) {
    this.docker = new Docker(
      connectionOf(config.SEAMNEX_DOCKER_HOST, config.SEAMNEX_DOCKER_TIMEOUT_MS),
    );
  }

  async ping(): Promise<void> {
    this.guard();
    try {
      await this.docker.ping();
    } catch (error) {
      throw this.unavailable('ping', error);
    }
  }

  async ensureNetwork(name: string, labels: Record<string, string> = {}): Promise<void> {
    this.guard();
    try {
      await this.docker.getNetwork(name).inspect();
      return;
    } catch {
      // Absent is the expected first-deploy case; anything else surfaces on create.
    }
    await this.docker.createNetwork({
      Name: name,
      Driver: 'bridge',
      Labels: { 'seamnex.managed': 'true', ...labels },
      CheckDuplicate: true,
    });
  }

  /**
   * Joins a container to a network. Idempotent: an existing attachment is the desired state, and the
   * engine answers `403` for it.
   *
   * `aliases` exist because a container joined to a second network is resolvable there by its name
   * only — and a product is configured with the *service* name (`keycloak:8080`), which lives on the
   * network the IdP was created on. Joining without the alias left the product unable to resolve its
   * identity provider: the token exchange failed with status 0 and the login died at the last step.
   * Docker cannot add an alias to an existing attachment, so an attachment that is missing one is
   * re-created.
   */
  async connectNetwork(
    network: string,
    containerId: string,
    aliases: readonly string[] = [],
  ): Promise<void> {
    this.guard();
    const endpoint = {
      Container: containerId,
      ...(aliases.length === 0 ? {} : { EndpointConfig: { Aliases: [...aliases] } }),
    };
    const handle = this.docker.getNetwork(network);
    try {
      await handle.connect(endpoint);
      return;
    } catch (error) {
      if (errorStatus(error) !== 403) throw error;
    }
    if (aliases.length === 0) return;

    const info = await handle.inspect();
    const endpoints = Object.values(info.Containers ?? {}) as Array<{ Name?: string }>;
    const attached = endpoints.find((entry) => entry.Name === containerId);
    if (attached === undefined) return;
    await this.disconnectNetwork(network, containerId);
    await handle.connect(endpoint);
  }

  async disconnectNetwork(network: string, containerId: string): Promise<void> {
    this.guard();
    await this.docker.getNetwork(network).disconnect({ Container: containerId, Force: true });
  }

  /**
   * Containers currently attached to a network, by container id and name — the edge and the IdP are
   * members of every instance network and `compose down` cannot detach them, so the delete has to
   * know them before it asks the daemon to remove the network.
   *
   * An absent network yields an empty list: a delete must not fail because an earlier attempt
   * already removed it.
   */
  async networkEndpoints(network: string): Promise<NetworkEndpoint[]> {
    this.guard();
    try {
      const info = await this.docker.getNetwork(network).inspect();
      const attached = (info.Containers ?? {}) as Record<string, { Name?: string }>;
      return Object.entries(attached).map(([id, endpoint]) => ({
        id,
        name: endpoint.Name ?? id.slice(0, 12),
      }));
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
  }

  async removeNetwork(name: string): Promise<void> {
    this.guard();
    await this.docker
      .getNetwork(name)
      .remove()
      .catch((error: unknown) => {
        // "not found" is success for a delete; "active endpoints" must fail loudly instead.
        if (!isNotFound(error)) throw error;
      });
  }

  async ensureVolume(name: string, labels: Record<string, string> = {}): Promise<void> {
    this.guard();
    await this.docker
      .createVolume({ Name: name, Labels: { 'seamnex.managed': 'true', ...labels } })
      .catch((error: unknown) => {
        if (!isAlreadyExists(error)) throw error;
      });
  }

  async removeVolume(name: string): Promise<void> {
    this.guard();
    await this.docker
      .getVolume(name)
      .remove()
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
  }

  /**
   * Volumes carrying every one of `labels`. Compose labels each volume it creates with
   * `com.docker.compose.project` (the project) and `com.docker.compose.volume` (the key in the file),
   * so one call answers "which volumes does this instance own" without parsing YAML or guessing the
   * project prefix.
   */
  async volumes(labels: readonly string[]): Promise<VolumeSummary[]> {
    this.guard();
    const result = await this.docker.listVolumes({ filters: { label: [...labels] } });
    return (result.Volumes ?? []).map((entry) => ({
      name: entry.Name,
      mountpoint: entry.Mountpoint ?? '',
      labels: entry.Labels ?? {},
    }));
  }

  /**
   * Whether the daemon still has the volume.
   *
   * Only a 404 is "absent". A transport or authorisation failure must surface: a backup that read
   * an unreachable daemon as "no volumes" is exactly the false success this module exists to stop.
   */
  async volumeExists(name: string): Promise<boolean> {
    this.guard();
    try {
      await this.docker.getVolume(name).inspect();
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  /**
   * Measured size of a volume, in MiB, through a read-only helper mount.
   *
   * The Engine API has no per-volume size, and `docker system df -v` reports every volume on the
   * host. A one-shot `du` is scoped to the volume, needs no host filesystem access and costs a
   * metadata walk rather than a copy. The mount is read-only so a sampling bug cannot write.
   */
  async volumeUsageMb(name: string): Promise<number> {
    this.guard();
    const result = await runOrThrow(
      'docker',
      ['run', '--rm', '-v', `${name}:/src:ro`, 'alpine:3.20', 'du', '-sm', '/src'],
      { env: this.dockerEnv(), timeoutMs: 300_000 },
    );
    const match = /^(\d+)/.exec(result.stdout.trim());
    return match === null ? 0 : Number(match[1]);
  }

  async containers(labels: readonly string[], all = true): Promise<ContainerSummary[]> {
    this.guard();
    const list = await this.docker.listContainers({ all, filters: { label: [...labels] } });
    return list.map((entry) => ({
      id: entry.Id,
      name: entry.Names[0] ?? entry.Id.slice(0, 12),
      service: entry.Labels?.['com.docker.compose.service'] ?? entry.Image,
      image: entry.Image,
      state: entry.State,
      status: entry.Status,
      labels: entry.Labels ?? {},
    }));
  }

  async inspect(containerId: string): Promise<Docker.ContainerInspectInfo> {
    this.guard();
    return this.docker.getContainer(containerId).inspect();
  }

  /**
   * FR-4.5 — one container's measured CPU and memory, as a single snapshot.
   *
   * The arithmetic is the one `docker stats --no-stream` uses: CPU is the delta between the sample
   * and the daemon's previous one, scaled by the number of online CPUs, and memory is the working set
   * (`usage` minus inactive page cache) rather than the cgroup's high-water total. Reporting `usage`
   * alone made every product look as if it were holding its page cache forever.
   *
   * Returns `null` when the daemon answers without usable counters — a container that has just
   * started has no delta yet. `null` is not zero: the caller must not write `0` and call it measured.
   */
  async stats(containerId: string): Promise<{ cpuMilli: number; memoryMb: number } | null> {
    this.guard();
    const raw = (await this.docker
      .getContainer(containerId)
      .stats({ stream: false })) as unknown as DockerStats | undefined;
    if (raw?.cpu_stats === undefined || raw.memory_stats === undefined) return null;

    const cpuDelta =
      (raw.cpu_stats.cpu_usage?.total_usage ?? 0) - (raw.precpu_stats?.cpu_usage?.total_usage ?? 0);
    const systemDelta =
      (raw.cpu_stats.system_cpu_usage ?? 0) - (raw.precpu_stats?.system_cpu_usage ?? 0);
    const online = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage?.percpu_usage?.length ?? 1;
    const cpuMilli =
      systemDelta > 0 && cpuDelta > 0 ? Math.round((cpuDelta / systemDelta) * online * 1000) : 0;

    const usage = raw.memory_stats.usage ?? 0;
    const inactive =
      raw.memory_stats.stats?.inactive_file ?? raw.memory_stats.stats?.total_inactive_file ?? 0;
    const memoryMb = Math.max(0, Math.round((usage - inactive) / (1024 * 1024)));
    return { cpuMilli, memoryMb };
  }

  /** Masked by the caller: this returns raw output, and the log pipeline masks on write. */
  async logs(containerId: string, tail = 200): Promise<string> {
    this.guard();
    const buffer = (await this.docker.getContainer(containerId).logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: false,
    })) as unknown as Buffer;
    return demultiplex(buffer);
  }

  async start(containerId: string): Promise<void> {
    this.guard();
    await this.docker
      .getContainer(containerId)
      .start()
      .catch((error: unknown) => {
        if (!isAlreadyStarted(error)) throw error;
      });
  }

  /**
   * A graceful stop and the client's own socket timeout are the same clock, and the Engine says
   * nothing while it waits. Asking for a 30 s grace over a 30 s idle timeout therefore destroys the
   * socket a millisecond before the daemon answers: the job records `socket hang up`, the container
   * it was stopping is already down, and an instance that was `ready` becomes `failed`.
   *
   * The grace is clamped below the transport budget instead. A product that needs longer than the
   * clamp is SIGKILLed by the daemon — a stopped instance the operator can start again is better
   * than a lifecycle action that can never succeed.
   */
  private stopGraceSeconds(requested: number): number {
    const budgetSeconds = Math.floor(this.config.SEAMNEX_DOCKER_TIMEOUT_MS / 1000) - 5;
    const clamped = Math.max(1, Math.min(requested, budgetSeconds));
    if (clamped !== requested) {
      this.logger.warn(
        `stop grace of ${requested}s exceeds the ${this.config.SEAMNEX_DOCKER_TIMEOUT_MS}ms Docker request budget; using ${clamped}s`,
      );
    }
    return clamped;
  }

  async stop(containerId: string, timeoutSeconds = 30): Promise<void> {
    this.guard();
    await this.docker
      .getContainer(containerId)
      .stop({ t: this.stopGraceSeconds(timeoutSeconds) })
      .catch((error: unknown) => {
        if (!isNotRunning(error)) throw error;
      });
  }

  async restart(containerId: string, timeoutSeconds = 30): Promise<void> {
    this.guard();
    await this.docker
      .getContainer(containerId)
      .restart({ t: this.stopGraceSeconds(timeoutSeconds) });
  }

  async removeContainer(containerId: string, force = true): Promise<void> {
    this.guard();
    await this.docker
      .getContainer(containerId)
      .remove({ force, v: false })
      .catch((error: unknown) => {
        if (!isNotFound(error)) throw error;
      });
  }

  /**
   * Fetch an image, trying the configured pull mirrors before the registry the reference names.
   *
   * NFR-4.16 at the last possible moment: pre-flight can be minutes old, and a queued job reaches
   * this call without re-reading the plan. The guard is the control, and it judges the *canonical*
   * reference — a mirror is a transport here, never a trusted registry of its own.
   *
   * The mirror list exists because the two fetch paths are not the same setting:
   * `SEAMNEX_REGISTRY_MIRROR` reaches BuildKit only, and the Engine's own `registry-mirrors` lives in
   * `daemon.json`, which this process cannot change. On a filtered network that left every pull at
   * 50–100 KB/s while a mirror served the same blobs at ~470 KB/s, and a deployment sat in a digest
   * check for hours.
   *
   * Order is the operator's ranking and the registry is always last, so a mirror that is down costs
   * one timeout and never a deployment. A mirror that serves different content fails the digest
   * check and the next attempt runs; failing the pin on the *final* attempt is what ends the pull.
   */
  async pull(
    ref: string,
    onProgress?: (line: string) => Promise<void>,
    options: { readonly expectedDigest?: string | null } = {},
  ): Promise<ImageIdentity> {
    await this.assertTrustedImage(ref, 'pull');
    this.guard();

    const expected = options.expectedDigest ?? null;
    /*
     * A digest reference is not prefixed: `docker tag` refuses a digest as the source, and the name
     * has no tag to retag onto anyway, so a mirror attempt could only fail. It is also already exact —
     * the pull asks for one manifest, not a moving tag.
     */
    const mirrors = ref.includes('@sha256:') ? [] : (this.config.pullMirrors ?? []);
    const attempts: readonly PullAttempt[] = [
      ...mirrors.map((mirror) => ({ reference: `${mirror}/${ref}`, mirror })),
      { reference: ref, mirror: null },
    ];

    let lastFailure: unknown = null;
    for (const [index, attempt] of attempts.entries()) {
      if (attempt.mirror !== null) {
        await this.note(onProgress, `mirror ${attempt.mirror}: ${ref}`);
      }
      try {
        await this.pullAttempt(attempt.reference, ref, onProgress);
        if (attempt.mirror !== null) await this.retag(attempt.reference, ref);
        const identity = await this.imageIdentity(ref);
        if (expected !== null) {
          const verdict = digestPinVerdict({
            mode: 'registry',
            reference: ref,
            expected,
            observed: await this.repoDigest(ref),
          });
          if (!verdict.ok) {
            throw new AppError({
              code: 'IMAGE_DIGEST_MISMATCH',
              detail: verdict.detail,
              remediation: verdict.remediation,
            });
          }
        }
        return identity;
      } catch (error) {
        lastFailure = error;
        const next = attempts[index + 1];
        if (next === undefined) break;
        await this.note(
          onProgress,
          `${attempt.reference} did not complete (${messageOf(error)}); trying ${next.reference}`,
        );
      }
    }
    throw lastFailure instanceof Error ? lastFailure : new Error(messageOf(lastFailure));
  }

  /**
   * One pull attempt, bounded by `SEAMNEX_PULL_TIMEOUT_MS`.
   *
   * `dockerode.pull` has no timeout of its own, so a daemon that is receiving 50 KB/s holds the job
   * open for as long as the job stays cancellable — hours, in the D06-01 case, with a "Downloading"
   * line every 100 ms that looks like progress. Dropping the response stream is the only handle this
   * process has on the daemon's copy of the transfer; what matters is that the stage does not wait
   * for it.
   */
  private async pullAttempt(
    reference: string,
    label: string,
    onProgress?: (line: string) => Promise<void>,
  ): Promise<void> {
    const timeoutMs = this.config.SEAMNEX_PULL_TIMEOUT_MS ?? DEFAULT_PULL_TIMEOUT_MS;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let stream: NodeJS.ReadableStream | null = null;

      function finish(error: Error | null): void {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === null) resolve();
        else reject(error);
      }

      const timer = setTimeout(() => {
        (stream as { destroy?: () => void } | null)?.destroy?.();
        finish(
          new AppError({
            code: 'ADAPTER_UNAVAILABLE',
            detail: `the pull of ${label} did not finish within ${Math.round(timeoutMs / 1000)} s (SEAMNEX_PULL_TIMEOUT_MS).`,
            remediation:
              'Check the registry or mirror this host reaches; the next attempt starts immediately.',
          }),
        );
      }, timeoutMs);

      void this.docker.pull(reference, (error: Error | null, response: NodeJS.ReadableStream) => {
        stream = response ?? null;
        if (error !== null) {
          finish(error);
          return;
        }
        this.docker.modem.followProgress(
          response,
          (progressError: Error | null) => finish(progressError),
          (event: { status?: string; id?: string }) => {
            if (onProgress !== undefined && typeof event.status === 'string') {
              void onProgress(`${event.id ?? label}: ${event.status}`).catch(() => undefined);
            }
          },
        );
      });
    });
  }

  /**
   * Name a mirror-pulled image with the reference the deployment uses, and drop the transport tag.
   *
   * The digest travels with the image, so retagging keeps the pin meaningful: `repoDigest` reports
   * the mirror-qualified digest the daemon recorded, and it is the same content-addressed value the
   * entry pins. Untagging the mirror name afterwards keeps `docker images` showing what the platform
   * will actually start, and is best effort — the canonical tag already exists by then.
   */
  private async retag(from: string, to: string): Promise<void> {
    await runOrThrow('docker', ['tag', from, to], {
      env: this.dockerEnv(),
      timeoutMs: 60_000,
    });
    try {
      await run('docker', ['rmi', from], { env: this.dockerEnv(), timeoutMs: 60_000 });
    } catch {
      // Best effort: the canonical tag exists by now, so a refused untag changes nothing.
    }
  }

  /** A line the job log should carry; a sink that fails must never fail the pull. */
  private async note(
    onProgress: ((line: string) => Promise<void>) | undefined,
    line: string,
  ): Promise<void> {
    if (onProgress === undefined) return;
    await onProgress(line).catch(() => undefined);
  }

  async imageIdentity(ref: string): Promise<ImageIdentity> {
    this.guard();
    const inspect = await this.docker.getImage(ref).inspect();
    const repoDigest = inspect.RepoDigests?.find((entry) => entry.includes('@'));
    return {
      ref,
      digest: repoDigest?.split('@')[1] ?? inspect.Id,
      id: inspect.Id,
    };
  }

  /**
   * The repository digest the daemon holds for a reference, or `null` when it holds none.
   *
   * Deliberately not `imageIdentity().digest`: that one falls back to the image config id, so a
   * locally built image answered with a `sha256:` value and made "the pin matches" unfalsifiable.
   * A pin can only be checked against a digest the registry recorded.
   */
  async repoDigest(ref: string): Promise<string | null> {
    this.guard();
    const inspect = await this.docker.getImage(ref).inspect();
    const entry = inspect.RepoDigests?.find((value) => value.includes('@'));
    return entry === undefined ? null : (entry.split('@')[1] ?? null);
  }

  /**
   * The config id the tag resolves to, or `null` when the daemon holds no such image.
   *
   * This is the identity a *local* build has: `docker build` produces an id and no repository digest,
   * so an entry that builds can only be pinned by id. Swallowing the inspect failure is deliberate —
   * "the tag is gone" is a verdict the caller reports, not an exception to unwrap.
   */
  async imageId(ref: string): Promise<string | null> {
    try {
      await this.guard();
      const inspect = await this.docker.getImage(ref).inspect();
      return typeof inspect.Id === 'string' && inspect.Id.length > 0 ? inspect.Id : null;
    } catch {
      return null;
    }
  }

  async imageExists(ref: string): Promise<boolean> {
    try {
      await this.guard();
      await this.docker.getImage(ref).inspect();
      return true;
    } catch {
      return false;
    }
  }

  // ---- CLI ------------------------------------------------------------------------------------

  /** `docker compose up`. The project name and directory are pinned; nothing is inferred. */
  async composeUp(
    project: ComposeProject,
    onLine?: (line: string) => Promise<void>,
  ): Promise<void> {
    /*
     * `--quiet-pull` means `up` fetches whatever the project names, so this is the third fetch path
     * NFR-4.16 has to cover. The images are read from the project's own files rather than trusted
     * from a caller-provided list: a list can be stale, the files are what Compose will parse.
     */
    await this.assertProjectImagesTrusted(project);
    const result = await runOrThrow(
      'docker',
      composeArgs(project, ['up', '-d', '--remove-orphans', '--quiet-pull']),
      {
        env: this.dockerEnv(),
        timeoutMs: 600_000,
      },
    );
    await this.emit(onLine, result.stdout);
  }

  /**
   * `docker compose build`. Required for any service whose definition carries a `build:` section.
   *
   * `compose up` only builds when the image is *absent*, so a tag that already exists locally — the
   * normal case after the first deployment — makes every later change to a reviewed Dockerfile
   * invisible: `up` reports success, the container is recreated from the stale image, and the
   * entry's `packagingSource` claims a revision that never ran. Layer caching keeps the call cheap
   * when nothing changed.
   */
  async composeBuild(
    project: ComposeProject,
    onLine?: (line: string) => Promise<void>,
  ): Promise<void> {
    /*
     * `--progress=plain` because BuildKit's default progress is cursor-animated frames on stderr:
     * piped, it collapses to one line, which is why a failed build reported
     * "docker exited with 1: Image seamnex/orangehrm:5.9 Building" — the first frame, with the
     * failing step and its error nowhere in the captured output. Plain progress emits one line per
     * step, so the job log names the instruction that failed and keeps the rest for the next reader.
     */
    await this.ensureBuilder();
    const args = composeArgs(project, ['build', '--progress=plain', ...this.buildArgs()]);
    const result = await runOrThrow('docker', args, {
      env: this.dockerEnv(),
      timeoutMs: 900_000,
    });
    await this.emit(onLine, result.stdout);
  }

  /**
   * The mirrors `build` forwards as `--build-arg` (`APK_MIRROR`, `APT_MIRROR`, `NPM_REGISTRY`).
   *
   * A definition the platform does not own fetches from whatever archive its Dockerfile names, and on
   * a filtered network that fetch is the whole cost of the stage: the first D07-01 build spent its
   * minutes in `apt-get` against `deb.debian.org` and in a SourceForge download. Compose offers no
   * daemon-level equivalent (`registry-mirrors` covers image pulls only, and BuildKit reads its own
   * config for those), so the one channel left is a build argument the Dockerfile declares. All three
   * names are forwarded unconditionally — a Dockerfile that declares none ignores them — and empty
   * forwards nothing, so CI and a clean host keep upstream.
   *
   * They are read from the API role's environment rather than from the definition: a mirror is a fact
   * about the build host, and a value written into the render set would travel to every other host.
   */
  private buildArgs(): string[] {
    const args: string[] = [];
    for (const name of BUILD_MIRROR_ARGS) {
      const value = this.config[name] ?? '';
      if (value.length > 0) args.push('--build-arg', `${name}=${value}`);
    }
    return args;
  }

  /**
   * The mirrors this process forwards to a build, named for the job log.
   *
   * A setting nothing reads is indistinguishable from one that was ignored — which is exactly how the
   * mirrors went unnoticed while a build spent its minutes on a CDN the host could not reach. The
   * `build` stage logs this list before the CLI runs, so "was the mirror applied" is answerable from
   * the log rather than from the host's environment.
   */
  buildMirrors(): string[] {
    return BUILD_MIRROR_ARGS.filter((name) => (this.config[name] ?? '').length > 0);
  }

  /**
   * Registers the buildx builder that fronts `SEAMNEX_BUILDKIT_ADDR` (ADR-BE-40 §7).
   *
   * A BuildKit build is a hijacked connection (`Upgrade: tcp`), and the socket proxy that guards the
   * Engine API answers it `403` — reported, before this existed, as
   * `unable to upgrade to tcp, received 403` on the first line of a `build` stage that had read no
   * Dockerfile yet. A *remote* builder is the one shape that needs no Engine session: the CLI speaks
   * gRPC to BuildKit directly, and `--load` returns the image through the proxy's ordinary image
   * endpoints. The builder is *not* created when no address is configured, so a host with direct
   * Engine access keeps the default builder and its shell-free argv.
   *
   * The registration lives in the CLI's own state (`$HOME/.docker/buildx`), so it is per container
   * and disappears with it; hence "register if absent" rather than "use what was bootstrapped".
   */
  private async ensureBuilder(): Promise<void> {
    const addr = this.buildkitAddr();
    if (addr.length === 0) return;
    const name = BUILDKIT_BUILDER;
    const inspect = async (): Promise<number> => {
      const result = await run('docker', ['buildx', 'inspect', name], {
        env: this.dockerEnv(),
        timeoutMs: 60_000,
      });
      return result.code;
    };
    if ((await inspect()) === 0) return;
    const created = await run(
      'docker',
      ['buildx', 'create', '--name', name, '--driver', 'remote', addr],
      { env: this.dockerEnv(), timeoutMs: 60_000 },
    );
    // Two workers share a queue: the second one loses the race between `inspect` and `create`, and
    // the builder it did not create is still the builder it needs. Only a builder that is *still*
    // absent is a failure.
    if (created.code !== 0 && (await inspect()) !== 0) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `the BuildKit builder "${name}" could not be registered for ${addr}: ${created.stderr.trim()}`,
        remediation:
          'Check SEAMNEX_BUILDKIT_ADDR and that the buildkit service is running; the job stopped before building anything.',
      });
    }
  }

  async composeDown(project: ComposeProject, removeVolumes: boolean): Promise<void> {
    const args = composeArgs(project, [
      'down',
      '--remove-orphans',
      ...(removeVolumes ? ['--volumes'] : []),
    ]);
    await runOrThrow('docker', args, { env: this.dockerEnv(), timeoutMs: 300_000 });
  }

  async composePs(project: ComposeProject): Promise<ContainerSummary[]> {
    const result = await runOrThrow('docker', composeArgs(project, ['ps', '--format', 'json']), {
      env: this.dockerEnv(),
      timeoutMs: 60_000,
    });
    return result.stdout
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line) as {
            ID?: string;
            Name?: string;
            Service?: string;
            Image?: string;
            State?: string;
            Status?: string;
          };
          return [
            {
              id: entry.ID ?? '',
              name: entry.Name ?? '',
              service: entry.Service ?? '',
              image: entry.Image ?? '',
              state: entry.State ?? '',
              status: entry.Status ?? '',
              labels: {},
            },
          ];
        } catch {
          return [];
        }
      });
  }

  /**
   * BuildKit through the configured builder; `--load` keeps the image local for `save`.
   *
   * `--load` is what makes the result usable at all here: a remote builder keeps the image in its own
   * store, and `apply` starts containers from the *host* daemon's.
   */
  async build(input: {
    context: string;
    dockerfile: string;
    tag: string;
    labels?: Record<string, string>;
  }): Promise<void> {
    // The tag is what enters the local store and later lands in a compose file, so it is the
    // reference the allow-list can actually judge; the base image is the Dockerfile policy's job.
    await this.assertTrustedImage(input.tag, 'build');
    await this.ensureBuilder();
    const args = ['buildx', 'build', '--load', '-t', input.tag, '-f', input.dockerfile];
    for (const [key, value] of Object.entries(input.labels ?? {}))
      args.push('--label', `${key}=${value}`);
    args.push(...this.buildArgs());
    args.push(input.context);
    await runOrThrow('docker', args, { env: this.dockerEnv(), timeoutMs: 900_000 });
  }

  async saveImage(ref: string, targetPath: string): Promise<void> {
    await runOrThrow('docker', ['save', '-o', targetPath, ref], {
      env: this.dockerEnv(),
      timeoutMs: 600_000,
    });
  }

  async loadImage(path: string): Promise<void> {
    await runOrThrow('docker', ['load', '-i', path], { env: this.dockerEnv(), timeoutMs: 600_000 });
  }

  /**
   * Streams a container's stdout into a process (a dump piped into an encryptor). The caller owns
   * both ends; this only proves the daemon is reachable first.
   */
  async assertAvailable(): Promise<void> {
    this.guard();
    await this.ping();
  }

  /** Raw child process for a streaming pipeline (dump → tar → age). */
  spawn(file: string, args: readonly string[], timeoutMs = 900_000) {
    return spawnProcess(file, args, { env: this.dockerEnv(), timeoutMs });
  }

  async runCli(file: string, args: readonly string[], timeoutMs = 900_000) {
    return run(file, args, { env: this.dockerEnv(), timeoutMs });
  }

  /**
   * NFR-4.16 — refuse an image the allow-list does not name.
   *
   * Two refusals live here, deliberately: an entity outside the list, and a client with no guard
   * wired at all. The second is the failure mode a "return early when undefined" guard would hide —
   * a role that forgot `SecurityModule` would deploy anything, and the log line nothing reads is not
   * a control.
   */
  private async assertTrustedImage(
    reference: string | null,
    operation: ImageTrustOperation,
  ): Promise<void> {
    if (reference === null || reference.trim().length === 0) return;
    if (this.imageTrust === undefined) {
      throw new AppError({
        code: 'ADAPTER_UNAVAILABLE',
        detail: `the trusted-registry guard is not wired in this process, so ${operation} of ${reference} cannot be authorised (NFR-4.16).`,
        remediation:
          'Import SecurityModule into the process root so the allow-list reader is available; the guard is never optional.',
      });
    }
    await this.imageTrust.assertTrusted(reference, operation);
  }

  /** Every `image:` a project will start, read from the files Compose itself will parse. */
  private async assertProjectImagesTrusted(project: ComposeProject): Promise<void> {
    const seen = new Set<string>();
    for (const file of project.files) {
      const content = readFileSync(file, 'utf8');
      for (const document of parseAllDocuments(content)) {
        const rendered = document.toJS({ maxAliasCount: 100 }) as unknown;
        const services = asRecord(asRecord(rendered)?.services);
        if (services === null) continue;
        for (const raw of Object.values(services)) {
          const image = asRecord(raw)?.image;
          if (typeof image !== 'string' || seen.has(image)) continue;
          seen.add(image);
          await this.assertTrustedImage(image, 'start');
        }
      }
    }
  }

  /**
   * The CLI environment: the Engine endpoint, nothing inherited, and the builder when one is
   * configured.
   *
   * `BUILDX_BUILDER` is the switch both `docker buildx build` and `docker compose build` honour —
   * Compose has no `--builder` flag, so a variable is the only way to route both shapes to one
   * daemon (ADR-BE-40 §7). It is set here, once, rather than threaded through each caller.
   */
  private dockerEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST,
      DOCKER_CLI_HINTS: 'false',
    };
    if (this.buildkitAddr().length > 0) env.BUILDX_BUILDER = BUILDKIT_BUILDER;
    return env;
  }

  /** The configured build endpoint, or empty when the daemon's own builder is the one to use. */
  private buildkitAddr(): string {
    return this.config.SEAMNEX_BUILDKIT_ADDR ?? '';
  }

  private guard(): void {
    requireAdapters(this.config, 'docker');
  }

  private async emit(
    onLine: ((line: string) => Promise<void>) | undefined,
    output: string,
  ): Promise<void> {
    if (onLine === undefined) return;
    for (const line of output.split(/\r?\n/)) {
      if (line.trim().length > 0) await onLine(line);
    }
  }

  private unavailable(operation: string, error: unknown): AppError {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`docker ${operation} failed: ${message}`);
    return new AppError({
      code: 'ADAPTER_UNAVAILABLE',
      detail: `The Docker Engine rejected ${operation}: ${message}`,
      remediation:
        'Check the socket proxy and DOCKER_HOST; the job stopped before applying anything.',
      cause: error,
    });
  }
}

/** A YAML node as an object, or `null` when it is anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function composeArgs(project: ComposeProject, command: readonly string[]): string[] {
  const args = [
    'compose',
    '--project-name',
    project.project,
    '--project-directory',
    project.directory,
  ];
  for (const file of project.files) args.push('-f', file);
  for (const envFile of project.envFiles) args.push('--env-file', envFile);
  // No `--no-color`: Compose removed it in v5 (`--ansi` replaced it, and output to a pipe carries no
  // colour anyway), so passing it made every apply exit 1 with "unknown flag". The CLI is a host
  // dependency the platform does not pin per major version, so it must not depend on a flag that
  // only some majors accept.
  args.push(...command);
  return args;
}

function connectionOf(host: string, timeout: number): Docker.DockerOptions {
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length), timeout };
  const url = new URL(host.includes('://') ? host : `tcp://${host}`);
  return {
    host: url.hostname,
    port: url.port.length > 0 ? Number(url.port) : 2375,
    protocol: url.protocol === 'https:' ? 'https' : 'http',
    timeout,
  };
}

/**
 * Docker multiplexes stdout and stderr with an 8-byte header per frame when the container has no
 * TTY. Returning the raw buffer would put control bytes in a log line.
 */
export function demultiplex(buffer: Buffer): string {
  const chunks: string[] = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, buffer.length);
    if (size === 0 || end <= start) break;
    chunks.push(buffer.subarray(start, end).toString('utf8'));
    offset = end;
  }
  // A container attached to a TTY writes plain text with no header; fall back to the whole buffer.
  if (chunks.length === 0) return buffer.toString('utf8');
  return chunks.join('');
}

function errorStatus(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const status = (error as { statusCode?: unknown }).statusCode;
    return typeof status === 'number' ? status : null;
  }
  return null;
}

function isNotFound(error: unknown): boolean {
  return errorStatus(error) === 404;
}

function isAlreadyExists(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 409 || status === 500;
}

function isNotRunning(error: unknown): boolean {
  return errorStatus(error) === 304 || errorStatus(error) === 409;
}

/** One sentence for a job log: an `AppError` carries its own, anything else its message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyStarted(error: unknown): boolean {
  return errorStatus(error) === 304;
}

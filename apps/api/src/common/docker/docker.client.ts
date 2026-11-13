import Docker from 'dockerode';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { requireAdapters } from '../adapters';
import { run, runOrThrow, spawnProcess } from '../exec/exec';
import { AppError } from '../problem/app-error';

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

/** A container joined to a network: the daemon keys attachments by container id, not by name. */
export type NetworkEndpoint = { readonly id: string; readonly name: string };

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

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
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

  async pull(ref: string, onProgress?: (line: string) => Promise<void>): Promise<ImageIdentity> {
    this.guard();
    await new Promise<void>((resolve, reject) => {
      void this.docker.pull(ref, (error: Error | null, stream: NodeJS.ReadableStream) => {
        if (error !== null) {
          reject(error);
          return;
        }
        this.docker.modem.followProgress(
          stream,
          (progressError: Error | null) => {
            if (progressError !== null) reject(progressError);
            else resolve();
          },
          (event: { status?: string; id?: string }) => {
            if (onProgress !== undefined && typeof event.status === 'string') {
              void onProgress(`${event.id ?? ref}: ${event.status}`).catch(() => undefined);
            }
          },
        );
      });
    });
    return this.imageIdentity(ref);
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
    const result = await runOrThrow('docker', composeArgs(project, ['build']), {
      env: this.dockerEnv(),
      timeoutMs: 900_000,
    });
    await this.emit(onLine, result.stdout);
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

  /** Rootless BuildKit through the socket proxy; `--load` keeps the image local for `save`. */
  async build(input: {
    context: string;
    dockerfile: string;
    tag: string;
    labels?: Record<string, string>;
  }): Promise<void> {
    const args = ['buildx', 'build', '--load', '-t', input.tag, '-f', input.dockerfile];
    for (const [key, value] of Object.entries(input.labels ?? {}))
      args.push('--label', `${key}=${value}`);
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

  private dockerEnv(): NodeJS.ProcessEnv {
    return { DOCKER_HOST: this.config.SEAMNEX_DOCKER_HOST, DOCKER_CLI_HINTS: 'false' };
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

function isAlreadyStarted(error: unknown): boolean {
  return errorStatus(error) === 304;
}

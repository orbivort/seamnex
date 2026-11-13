import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { AppError } from '../../common/problem/app-error';
import { ensureDir, safeJoin, sha256, writeFileAtomic } from '../../common/fs/files';
import { isAbsolute, join } from 'node:path';
import { stringifyCompose } from '../../common/compose/compose-policy';
import { parse as parseYaml } from 'yaml';
import { instanceNetwork, projectName } from '../../common/docker/naming';
import type { RenderInput, RenderedFile, RenderSet, RendererService } from './renderer.contract';

type RenderRow = {
  id: string;
  instance_id: string;
  content_hash: string;
  files: unknown;
  applied_at: Date | null;
};

/**
 * 4A.4 — the renderer.
 *
 * A render set is the complete, immutable description of what should run: the normalised compose
 * project, the platform override, the non-secret environment, the route intent and a manifest. It is
 * deduplicated on `(instance_id, content_hash)`, so a retried job reuses the set instead of creating
 * a second one, and it is immutable after `applied_at` (a trigger, not this code).
 *
 * Two deliberate omissions:
 *   - **secrets are not rendered.** The `.env` in the set holds non-secret values only; the executor
 *     opens each referenced secret from M15 at apply time. A render set on disk therefore never
 *     contains a credential, which is what makes `render_set.files` safe to keep and to back up.
 *   - **the upstream compose file is not rewritten.** The platform-owned copy is a separate file;
 *     the original lives in `source_file` byte-for-byte.
 */
@Injectable()
export class RenderSetService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async render(input: RenderInput): Promise<RenderSet> {
    const project = projectName(input.slug);
    const env = await this.environment(input.instanceId, input.entryKey);
    const documents = buildDocuments(input, project, env);

    const files: RenderedFile[] = documents.map((document) => ({
      path: document.path,
      sha256: sha256(document.content),
      content: document.content,
    }));
    const contentHash = hashOf(files);
    // Measured on the document that will be applied, not on the upstream file it came from: the
    // manifest is what a later `load()` re-reads, and a stale count there refused every rollback.
    const publishedPorts = remainingPublishedPorts(documents);

    const inserted = await this.pool.query<RenderRow>(
      `INSERT INTO render_set (instance_id, content_hash, files)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (instance_id, content_hash) DO NOTHING
       RETURNING id, instance_id, content_hash, files, applied_at`,
      [input.instanceId, contentHash, JSON.stringify(manifestOf(input, files, publishedPorts))],
    );

    const row =
      inserted.rows[0] ??
      (
        await this.pool.query<RenderRow>(
          `SELECT id, instance_id, content_hash, files, applied_at
             FROM render_set WHERE instance_id = $1 AND content_hash = $2`,
          [input.instanceId, contentHash],
        )
      ).rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: 'The render set could not be persisted.',
        remediation: 'Retry the deployment; no container was started.',
      });
    }

    // `ON CONFLICT DO NOTHING` means a reused set already has its files; writing them again is
    // idempotent and makes a restore onto a fresh host work without a special case.
    const directory = join(
      this.config.SEAMNEX_INSTANCE_DATA_DIR,
      input.instanceId,
      'render',
      row.id,
    );
    ensureDir(directory);
    for (const file of files) {
      const target = safeJoin(directory, file.path);
      ensureDir(join(target, '..'));
      writeFileAtomic(target, file.content);
      await this.pool.query(
        `INSERT INTO render_file (render_set_id, path, sha256, content) VALUES ($1, $2, $3, $4)
         ON CONFLICT (render_set_id, path) DO NOTHING`,
        [row.id, file.path, file.sha256, file.content],
      );
    }

    return {
      id: row.id,
      instanceId: row.instance_id,
      contentHash: row.content_hash,
      directory,
      files,
      composeProject: project,
      imageRefs: imageRefs(input),
      // Invariant 9 is "zero published ports in the applied document", so this counts what survived
      // normalisation — not how many were rewritten. Reporting the rewrite count made the pre-apply
      // assertion refuse every upstream file that publishes a port, which is most of them.
      publishedPorts,
    };
  }

  /**
   * The set that is *running right now*.
   *
   * `applied_at` alone cannot express a rollback: the trigger makes an applied set immutable, so
   * rolling back re-applies an older set without rewriting timestamps. The instance's
   * `activeRenderSetId` is the authority, and `applied_at` is the fallback for a row written before
   * Phase 4A.
   */
  async applied(instanceId: string): Promise<RenderSet | null> {
    const active = await this.pool.query<RenderRow>(
      `SELECT r.id, r.instance_id, r.content_hash, r.files, r.applied_at
         FROM instance i
         JOIN render_set r ON r.id = NULLIF(i.payload->>'activeRenderSetId', '')::uuid
        WHERE i.id = $1`,
      [instanceId],
    );
    const activeRow = active.rows[0];
    if (activeRow !== undefined) return this.materialise(activeRow);

    const result = await this.pool.query<RenderRow>(
      `SELECT id, instance_id, content_hash, files, applied_at FROM render_set
        WHERE instance_id = $1 AND applied_at IS NOT NULL
        ORDER BY applied_at DESC LIMIT 1`,
      [instanceId],
    );
    const row = result.rows[0];
    return row === undefined ? null : this.materialise(row);
  }

  async load(renderSetId: string): Promise<RenderSet> {
    const result = await this.pool.query<RenderRow>(
      `SELECT id, instance_id, content_hash, files, applied_at FROM render_set WHERE id = $1`,
      [renderSetId],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No render set ${renderSetId}.`,
        remediation: 'The restore cannot proceed without the render set the backup references.',
      });
    }
    return this.materialise(row);
  }

  /** Reads the stored rows rather than the JSONB: `render_file` is the authority for content. */
  private async materialise(row: RenderRow): Promise<RenderSet> {
    const files = await this.pool.query<{ path: string; sha256: string; content: string }>(
      `SELECT path, sha256, content FROM render_file WHERE render_set_id = $1 ORDER BY path`,
      [row.id],
    );
    const manifest = (row.files ?? {}) as {
      composeProject?: string;
      imageRefs?: string[];
      publishedPorts?: number;
    };
    const directory = join(
      this.config.SEAMNEX_INSTANCE_DATA_DIR,
      row.instance_id,
      'render',
      row.id,
    );
    ensureDir(directory);
    for (const file of files.rows) {
      const target = safeJoin(directory, file.path);
      ensureDir(join(target, '..'));
      writeFileAtomic(target, file.content);
    }
    // Counted from the stored platform document, not from the manifest: manifests written before
    // this rule recorded the number of ports *rewritten*, and `plan` refuses a loaded set that
    // claims a published port, so every rollback of such an instance failed with a false defect.
    const platform = files.rows.find((file) => file.path === 'docker-compose.platform.yml');
    return {
      id: row.id,
      instanceId: row.instance_id,
      contentHash: row.content_hash,
      directory,
      files: files.rows,
      composeProject: manifest.composeProject ?? projectName(row.instance_id),
      imageRefs: manifest.imageRefs ?? [],
      publishedPorts: platform === undefined ? 0 : publishedPortsOf(platform.content),
    };
  }

  /**
   * The environment the definition is rendered from: the catalogue's declared defaults, overlaid by
   * the values stored for the instance. Non-secret values only; a secret is a reference the executor
   * resolves at apply time.
   *
   * Defaults are read from `env_schema_var` as well as from `instance_env_value`, and the difference
   * is not cosmetic: a variable capped at `none` ("locked") is never persisted per instance *because*
   * nobody may set it, and the render used to omit it. The container then started without a value the
   * plan had already approved — a `WOOCOMMERCE_DATABASE_HOST` default of `db` never reached the
   * entrypoint, the entrypoint refused to start, and the wizard still reported the environment as
   * resolved. The precedence here mirrors `plan()`: default, then profile, then instance, with
   * secrets still resolved only by the executor.
   */
  private async environment(instanceId: string, entryKey: string): Promise<Map<string, string>> {
    const [declared, stored] = await Promise.all([
      this.pool.query<{ name: string; default_value: string | null }>(
        `SELECT name, default_value FROM env_schema_var
          WHERE entry_key = $1 AND default_value IS NOT NULL`,
        [entryKey],
      ),
      this.pool.query<{ var_name: string; value_enc: Buffer | null }>(
        `SELECT var_name, value_enc FROM instance_env_value
          WHERE instance_id = $1 AND source <> 'secret' AND value_enc IS NOT NULL`,
        [instanceId],
      ),
    ]);

    const env = new Map(declared.rows.map((row) => [row.name, row.default_value ?? '']));
    // A stored value wins: a profile or instance answer is the operator's decision, the default is
    // only where the chain starts.
    for (const row of stored.rows) {
      env.set(row.var_name, row.value_enc === null ? '' : row.value_enc.toString('utf8'));
    }
    return env;
  }
}

type RenderedDocument = { path: string; content: string };

function buildDocuments(
  input: RenderInput,
  project: string,
  env: Map<string, string>,
): RenderedDocument[] {
  const documents: RenderedDocument[] = [];
  const base = baseCompose(input);
  documents.push({ path: 'docker-compose.platform.yml', content: stringifyCompose(base) });
  documents.push({
    path: 'docker-compose.override.yml',
    content: stringifyCompose(overrideCompose(input, base, env)),
  });

  const envLines = [...env.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${quoteEnv(value)}`);
  documents.push({
    path: 'platform.env',
    // `# secrets are injected by the executor` is part of the contract of this file: a reader can
    // tell at a glance that the absence of a secret is intentional rather than a failed render.
    content: `# Generated by the platform. Non-secret values only; secrets are injected at apply time.\n${envLines.join('\n')}\n`,
  });

  documents.push({
    path: 'route.json',
    content: `${JSON.stringify(
      {
        project,
        host: input.route.host,
        pathPrefix: input.route.pathPrefix,
        publishModel: input.route.publishModel,
        tlsMode: input.route.tlsMode,
        authMode: input.route.authMode,
        containerPort: input.httpPort,
      },
      null,
      2,
    )}\n`,
  });

  return documents;
}

/** The compose project the executor applies. Compose requires lower-case [a-z0-9_-]. */
function baseCompose(input: RenderInput): Record<string, unknown> {
  if (input.source.path === 'dockerfile') {
    const image = input.source.imageRef ?? `seamnex/instance-${input.instanceId}:latest`;
    return {
      name: projectName(input.slug),
      services: {
        app: {
          build: {
            context: input.source.directory,
            dockerfile: input.source.dockerfilePath ?? 'Dockerfile',
          },
          image,
          expose: [String(input.httpPort)],
          env_file: ['platform.env'],
        },
      },
      networks: { default: { name: instanceNetwork(input.slug) } },
    };
  }

  if (input.source.composeFile !== null && Object.keys(input.source.policy.document).length > 0) {
    // The normalised document from the policy: published ports already rewritten to `expose`.
    return {
      ...withAbsoluteBuildContexts(input.source.policy.document, input.source.directory),
      name: projectName(input.slug),
      networks: { default: { name: instanceNetwork(input.slug) } },
    };
  }

  // Scaffold without a compose file: a single service over the generated Dockerfile.
  const image = input.source.imageRef ?? `seamnex/instance-${input.instanceId}:scaffold`;
  return {
    name: projectName(input.slug),
    services: {
      app: {
        build: {
          context: input.source.directory,
          dockerfile: input.source.dockerfilePath ?? 'Dockerfile',
        },
        image,
        expose: [String(input.httpPort)],
        env_file: ['platform.env'],
      },
    },
    networks: { default: { name: instanceNetwork(input.slug) } },
  };
}

/**
 * The platform-owned override: resource ceilings, restart policy, labels and log rotation.
 * Ceilings are **rejected** when exceeded (the planner refuses), never silently skipped — an
 * instance that quietly runs with fewer resources than requested is a worse outcome than a refusal.
 */
function overrideCompose(
  input: RenderInput,
  base: Record<string, unknown>,
  env: Map<string, string>,
): Record<string, unknown> {
  const services = asRecord(base.services) ?? {};
  const overrides: Record<string, unknown> = {};
  const primary = requirePrimaryService(services, input.httpPort);
  // Declared, non-secret variables are injected here rather than merged into the upstream document,
  // so the platform-owned copy stays a pure normalisation of the upstream file. `environment` beats
  // an upstream literal of the same name, which is the point: the catalog's declared value is the
  // operator's answer, not a suggestion.
  const injected =
    env.size === 0
      ? null
      : Object.fromEntries([...env.entries()].sort(([a], [b]) => a.localeCompare(b)));

  for (const name of Object.keys(services)) {
    overrides[name] = {
      restart: 'unless-stopped',
      labels: {
        'seamnex.instance': input.instanceId,
        'seamnex.entry': input.entryKey,
        'seamnex.project': projectName(input.slug),
        ...input.labels,
      },
      ...(injected === null ? {} : { environment: injected }),
      deploy: {
        resources: {
          limits: {
            cpus: (input.resources.cpuMilli / 1000).toFixed(2),
            memory: `${input.resources.memoryMb}M`,
          },
          reservations: { memory: `${Math.round(input.resources.memoryMb * 0.5)}M` },
        },
      },
      logging: { driver: 'json-file', options: { 'max-size': '10m', 'max-file': '3' } },
      security_opt: ['no-new-privileges:true'],
    };
  }

  // The route and the readiness probe both address the instance as `http://<slug>:<httpPort>`.
  // Compose names a container after its *service* (or the project/service pair), so without an alias
  // the slug resolved to nothing and every deployment failed verification with "no HTTP answer"
  // even though the container was healthy. The alias is attached to the one service that actually
  // exposes the product port, never to the database or the cache.
  (overrides[primary] as Record<string, unknown>).networks = {
    default: { aliases: [input.slug] },
  };

  return { services: overrides };
}

/**
 * The service that answers on the product's HTTP port. `expose` is the normalised form (the policy
 * rewrites `ports:` into it), so this is the only place that has to know the rule.
 */
function primaryService(services: Record<string, unknown>, httpPort: number): string | null {
  const port = String(httpPort);
  const matches = Object.entries(services).filter(([, raw]) => {
    const expose = asRecord(raw)?.expose ?? [];
    return Array.isArray(expose) && expose.map((entry) => String(entry)).includes(port);
  });
  if (matches.length === 1) return matches[0]?.[0] ?? null;
  // More than one service on the port is ambiguous; aliasing both would make the name resolve to
  // whichever answered first. A single-service project with no declared expose is the common
  // dockerfile case and has exactly one candidate.
  const names = Object.keys(services);
  return names.length === 1 ? (names[0] ?? null) : null;
}

/**
 * The same rule, but a mismatch is refused rather than rendered.
 *
 * A catalogue `httpPort` that no service exposes used to render silently: no alias was written, so
 * the readiness probe asked DNS for `http://<slug>:<port>` and the deployment died in `verify` with
 * "no HTTP answer" while the container was healthy — a five-minute timeout and a job log that named
 * neither the entry nor the port. The mistake is a data error (a host port copied from `ports:`
 * instead of the container port), so it is caught before anything is applied, with the numbers that
 * disagree in the message.
 */
function requirePrimaryService(services: Record<string, unknown>, httpPort: number): string {
  const primary = primaryService(services, httpPort);
  if (primary !== null) return primary;

  const exposed = Object.entries(services)
    .map(([name, raw]) => {
      const expose = asRecord(raw)?.expose;
      const ports = Array.isArray(expose) ? expose.map((entry) => String(entry)) : [];
      return `${name} exposes ${ports.length === 0 ? 'nothing' : ports.join(', ')}`;
    })
    .join('; ');
  throw new AppError({
    code: 'HTTP_PORT_NOT_EXPOSED',
    detail:
      `The catalogue entry declares httpPort ${httpPort}, but no single service in the definition ` +
      `exposes it (${exposed}).`,
    remediation:
      'Set the catalogue httpPort to the port the product listens on inside its container — the ' +
      'left-hand side of a `ports:` mapping is the host port and is never used. Nothing was applied.',
  });
}

function manifestOf(
  input: RenderInput,
  files: readonly RenderedFile[],
  publishedPorts: number,
): Record<string, unknown> {
  return {
    version: 1,
    instanceId: input.instanceId,
    entryKey: input.entryKey,
    action: input.action,
    profileKey: input.profileKey,
    composeProject: projectName(input.slug),
    publishedPorts,
    imageRefs: imageRefs(input),
    sourcePath: input.source.path,
    policyVerdict: input.source.policy.verdict,
    route: input.route,
    resources: input.resources,
    files: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
  };
}

function hashOf(files: readonly RenderedFile[]): string {
  const digest = sha256(
    files
      .map((file) => `${file.path}:${file.sha256}`)
      .sort()
      .join('\n'),
  );
  return digest;
}

function imageRefs(input: RenderInput): string[] {
  if (input.source.path === 'dockerfile' || input.source.path === 'scaffold') {
    return input.source.imageRef === null ? [] : [input.source.imageRef];
  }
  const services = asRecord(input.source.policy.document.services) ?? {};
  return Object.values(services)
    .map((service) =>
      typeof asRecord(service)?.image === 'string' ? (asRecord(service)?.image as string) : null,
    )
    .filter((image): image is string => image !== null);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Points every relative `build.context` at the resolved source tree.
 *
 * A compose document is applied from the render directory, which holds the generated documents and
 * none of the source: `build: { context: ./app }` therefore resolved to a directory that does not
 * exist and `compose build` died with a one-line "exited with 1" and no reason. The resolved source
 * is the only correct base — it is the tree the operator's revision was copied into — and the
 * upstream file itself is still retained byte-for-byte in `source_file`, so this is a normalisation
 * of the platform-owned copy, exactly like the `ports:` rewrite.
 */
function withAbsoluteBuildContexts(
  document: Record<string, unknown>,
  sourceDirectory: string,
): Record<string, unknown> {
  const services = asRecord(document.services) ?? {};
  const rewritten: Record<string, unknown> = {};

  for (const [name, raw] of Object.entries(services)) {
    const service = asRecord(raw);
    const build = asRecord(service?.build ?? null);
    if (service === null || build === null) {
      rewritten[name] = raw;
      continue;
    }
    const declared = typeof build.context === 'string' ? build.context : '.';
    rewritten[name] = {
      ...service,
      build: {
        ...build,
        context: isAbsolute(declared) ? declared : join(sourceDirectory, declared),
      },
    };
  }

  return { ...document, services: rewritten };
}

/** Invariant 9, measured on the document that will actually be applied. */
function remainingPublishedPorts(documents: readonly RenderedDocument[]): number {
  const platform = documents.find((document) => document.path === 'docker-compose.platform.yml');
  return platform === undefined ? 0 : publishedPortsOf(platform.content);
}

/** The same count, from stored content, so a loaded set is judged by what it holds. */
function publishedPortsOf(content: string): number {
  try {
    const parsed: unknown = parseYaml(content);
    const services = asRecord(asRecord(parsed)?.services) ?? {};
    return Object.values(services).reduce<number>((total, service) => {
      const ports = asRecord(service)?.ports;
      return total + (Array.isArray(ports) ? ports.length : 0);
    }, 0);
  } catch {
    return 0;
  }
}

function quoteEnv(value: string): string {
  return /[\s#"']/.test(value) ? JSON.stringify(value) : value;
}

export type { RendererService };

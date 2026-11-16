import { Inject, Injectable, Logger } from '@nestjs/common';
import type { EnvValue } from '@seamnex/domain';
import type { Pool } from 'pg';
import { PG_POOL } from '../../database/database.module';
import { DockerEngineClient } from '../../common/docker/docker.client';
import { isUuid } from '../../common/http/uuid';
import { AppError } from '../../common/problem/app-error';
import { RENDERER_SERVICE, type RendererService } from '../m03-renderer/renderer.contract';
import { InstanceParamsService } from './instance-params.service';
import type {
  DriftDirection,
  DriftFinding,
  DriftScanResult,
  EnvironmentDriftService,
} from './environment-drift.contract';

/**
 * Variables a container carries that the platform did not put there and that are never a product's
 * configuration. The namespace rule below already excludes almost all of them; this list keeps a
 * product whose declared names happen to start with a common word from pulling the whole
 * operating-system environment into the report.
 */
const RUNTIME_ENV_IGNORE = new Set([
  'HOME',
  'HOSTNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LOGNAME',
  'OLDPWD',
  'PATH',
  'PWD',
  'SHELL',
  'SHLVL',
  'TERM',
  'TZ',
  'USER',
]);

/**
 * A product image can carry hundreds of variables. The report is a list an operator reads, so the
 * worst case has to be bounded rather than assumed small.
 */
const MAX_FINDINGS = 200;

/** The placeholder recorded for a secret. The value never enters this table. */
const SECRET_PLACEHOLDER = '<secret>';

type ObservedService = {
  readonly service: string;
  readonly env: ReadonlyMap<string, string>;
  readonly created: Date | null;
};

type Observation = {
  readonly services: readonly ObservedService[];
  /** False when at least one container could not be inspected, which makes absence unprovable. */
  readonly complete: boolean;
};

type OpenRow = {
  readonly id: string;
  readonly var_name: string | null;
};

/** A finding plus the `detail` document written with it; the contract only exposes the finding. */
type ClassifiedFinding = DriftFinding & { readonly detail: Record<string, unknown> };

/**
 * FR-1.29 — the drift producer.
 *
 * The rule this file implements is narrow on purpose: *declared* values come from the environment
 * authority (M03), *applied* values from the render set that is running, and *observed* values from
 * the containers themselves. Nothing is guessed, and three cases are deliberately not reported:
 *
 *   - a variable the declaration leaves without a value is a `plan()` error, not drift;
 *   - a secret is compared by presence only, because reading it would decrypt every credential in
 *     the estate on a timer and write `secret.read` noise for a boolean answer;
 *   - an instance whose daemon or containers cannot be asked is *unobserved*, never clean — a
 *     control that answers "no drift" when it could not look is the defect this service exists to
 *     remove.
 *
 * Rows are also *healed*: a variable that stops drifting has its open row closed, so the partial
 * index `drift_record_open_idx` reflects the present rather than accumulating history that makes
 * the panel report yesterday's problem forever.
 */
@Injectable()
export class PostgresEnvironmentDriftService implements EnvironmentDriftService {
  private readonly logger = new Logger('m22-environment-drift');

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(RENDERER_SERVICE) private readonly renderer: RendererService,
    @Inject(DockerEngineClient) private readonly docker: DockerEngineClient,
    @Inject(InstanceParamsService) private readonly params: InstanceParamsService,
  ) {}

  async scan(instanceId: string): Promise<DriftScanResult> {
    if (!isUuid(instanceId)) throw notFound(instanceId);
    const instance = await this.pool.query<{ id: string }>(
      `SELECT id FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    if (instance.rows[0] === undefined) throw notFound(instanceId);

    const [declared, baseline, observation] = await Promise.all([
      this.renderer.instanceEnv(instanceId),
      this.appliedBaseline(instanceId),
      this.observe(instanceId),
    ]);
    if (observation === null) {
      return { observed: false, detected: [], created: [], resolved: 0 };
    }

    const findings = this.classify(instanceId, declared, observation, baseline);
    const { created, resolved } = await this.persist(instanceId, findings);
    if (findings.length > 0) {
      this.logger.debug(
        { instanceId, findings: findings.map((finding) => finding.varName), resolved },
        'environment drift recorded',
      );
    }
    return {
      observed: true,
      detected: findings.map((finding) => ({
        instanceId: finding.instanceId,
        varName: finding.varName,
        kind: finding.kind,
        direction: finding.direction,
      })),
      created,
      resolved,
    };
  }

  async scannable(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT i.id
         FROM instance i
        WHERE i.deleted_at IS NULL
          AND i.state IN ('ready', 'degraded')
          AND NULLIF(i.payload->>'activeRenderSetId', '') IS NOT NULL
        ORDER BY i.id`,
    );
    return result.rows.map((row) => row.id);
  }

  async definitionDrift(): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id
         FROM instance
        WHERE deleted_at IS NULL
          AND COALESCE((payload->>'instanceParamDrift')::boolean, false)
        ORDER BY id`,
    );
    return result.rows.map((row) => row.id);
  }

  async openVarNames(instanceId: string): Promise<ReadonlySet<string>> {
    if (!isUuid(instanceId)) return new Set();
    const result = await this.pool.query<{ var_name: string | null }>(
      `SELECT DISTINCT detail->>'varName' AS var_name
         FROM drift_record
        WHERE instance_id = $1 AND scope = 'environment' AND resolved_at IS NULL`,
      [instanceId],
    );
    return new Set(
      result.rows
        .map((row) => row.var_name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0),
    );
  }

  /**
   * Definition drift is repaired by re-committing the projection that was *already* committed.
   *
   * `instance_param.content_hash` is the hash of a file the platform wrote into the repository, so a
   * file that no longer matches it is a working-tree edit (or a lost file), not a new declaration.
   * Re-writing the projection restores the committed state and clears the flag that otherwise
   * blocks `start` until the control plane restarts — the only other way out was deleting the
   * instance.
   */
  async reconcileDefinition(
    instanceId: string,
    actorId: string,
  ): Promise<{ path: string; contentHash: string } | null> {
    if (!isUuid(instanceId)) return null;
    const row = await this.pool.query<{ drifted: boolean | null }>(
      `SELECT COALESCE((payload->>'instanceParamDrift')::boolean, false) AS drifted
         FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    if (row.rows[0]?.drifted !== true) return null;

    // A tree that cannot be written keeps the flag: an instance whose definition disagrees with the
    // repository must keep refusing to start rather than be told it is healthy.
    const written = await this.params.write(instanceId, actorId, { actorType: 'system' });
    await this.pool.query(
      `UPDATE instance SET payload = payload - 'instanceParamDrift', updated_at = now() WHERE id = $1`,
      [instanceId],
    );
    await this.pool.query(
      `UPDATE drift_record SET resolved_at = now()
        WHERE instance_id = $1 AND scope = 'instance_param' AND resolved_at IS NULL`,
      [instanceId],
    );
    return written;
  }

  /** The non-secret environment actually applied, or null when there is no readable render set. */
  private async appliedBaseline(instanceId: string): Promise<Map<string, string> | null> {
    try {
      const applied = await this.renderer.applied(instanceId);
      if (applied === null) return null;
      const file = applied.files.find((entry) => entry.path === 'platform.env');
      return file === undefined ? null : parseEnvFile(file.content);
    } catch (error) {
      // Materialising a render set touches the filesystem. A failure there means the baseline is
      // unknown; it must not be mistaken for "the declaration equals what was applied".
      this.logger.warn(
        { instanceId, err: error instanceof Error ? error.message : String(error) },
        'the applied render set could not be read; drift direction is reported as unknown',
      );
      return null;
    }
  }

  /**
   * Read-only observation of the running containers.
   *
   * A list failure, no containers, or every inspect failing all mean the same thing: the instance
   * cannot be observed. Reporting a full set of `missing` findings from a failed call is what turns
   * one daemon hiccup into an outage report.
   */
  private async observe(instanceId: string): Promise<Observation | null> {
    let containers: Awaited<ReturnType<DockerEngineClient['containers']>>;
    try {
      containers = await this.docker.containers([`seamnex.instance=${instanceId}`]);
    } catch (error) {
      this.logger.debug(
        { instanceId, err: error instanceof Error ? error.message : String(error) },
        'containers could not be listed; the instance is unobserved this pass',
      );
      return null;
    }
    if (containers.length === 0) return null;

    const services: ObservedService[] = [];
    let failed = 0;
    for (const container of containers) {
      try {
        const info = await this.docker.inspect(container.id);
        services.push({
          service: container.service,
          env: parseContainerEnv(info.Config?.Env ?? []),
          created: parseDate(info.Created),
        });
      } catch {
        failed += 1;
      }
    }
    if (services.length === 0) return null;
    return { services, complete: failed === 0 };
  }

  private classify(
    instanceId: string,
    declared: readonly EnvValue[],
    observation: Observation,
    baseline: Map<string, string> | null,
  ): ClassifiedFinding[] {
    const findings: ClassifiedFinding[] = [];
    const declaredNames = new Set(declared.map((variable) => variable.name));

    for (const variable of declared) {
      if (findings.length >= MAX_FINDINGS) break;

      if (variable.secret) {
        if (!observation.complete) continue;
        if (observation.services.some((service) => service.env.has(variable.name))) continue;
        findings.push({
          instanceId,
          varName: variable.name,
          kind: 'missing',
          direction: secretDirection(variable, observation.services),
          detail: {
            varName: variable.name,
            kind: 'missing',
            source: 'env-scan',
            secret: true,
            declared: SECRET_PLACEHOLDER,
            observed: null,
          },
        });
        continue;
      }
      if (variable.value === null) continue;

      // Carrying and comparing are the same read: a service either holds the variable with a value
      // or it does not, and the pair keeps the comparison below free of a second lookup.
      const carriers = observation.services.flatMap((service) => {
        const value = service.env.get(variable.name);
        return value === undefined ? [] : [{ service: service.service, value }];
      });
      if (carriers.length === 0) {
        // Absence is unprovable when a container could not be inspected.
        if (!observation.complete) continue;
        findings.push({
          instanceId,
          varName: variable.name,
          kind: 'missing',
          direction: declaredDirection(variable.name, variable.value, baseline),
          detail: {
            varName: variable.name,
            kind: 'missing',
            source: 'env-scan',
            declared: variable.value,
            observed: null,
          },
        });
        continue;
      }
      // Agreement in *any* service is enough: the same variable is legitimately the same value in
      // every container, and calling it a mismatch because one of them masks it would be noise.
      let disagreement: { service: string; value: string } | null = null;
      for (const carrier of carriers) {
        if (carrier.value === variable.value) {
          disagreement = null;
          break;
        }
        disagreement ??= carrier;
      }
      if (disagreement === null) continue;
      findings.push({
        instanceId,
        varName: variable.name,
        kind: 'mismatch',
        direction: declaredDirection(variable.name, variable.value, baseline),
        detail: {
          varName: variable.name,
          kind: 'mismatch',
          source: 'env-scan',
          service: disagreement.service,
          declared: variable.value,
          observed: disagreement.value,
        },
      });
    }

    const namespaces = namespacesOf(declaredNames);
    if (namespaces.size > 0) {
      for (const service of observation.services) {
        for (const [name, value] of service.env) {
          if (findings.length >= MAX_FINDINGS) break;
          if (declaredNames.has(name) || isIgnored(name, namespaces)) continue;
          if (findings.some((finding) => finding.varName === name)) continue;
          findings.push({
            instanceId,
            varName: name,
            kind: 'undeclared',
            direction: 'runtime_ahead',
            detail: {
              varName: name,
              kind: 'undeclared',
              source: 'env-scan',
              service: service.service,
              declared: null,
              observed: value,
            },
          });
        }
      }
    }
    return findings;
  }

  /**
   * One open row per variable: insert what is new, refresh what is still true, close what healed.
   *
   * `detected_at` is never bumped on refresh — the panel answers "how long has this been drifted",
   * and a row that looks new every pass hides a problem that has been open for a week.
   */
  private async persist(
    instanceId: string,
    findings: readonly ClassifiedFinding[],
  ): Promise<{ created: string[]; resolved: number }> {
    const open = await this.pool.query<OpenRow>(
      `SELECT id, detail->>'varName' AS var_name
         FROM drift_record
        WHERE instance_id = $1 AND scope = 'environment' AND resolved_at IS NULL`,
      [instanceId],
    );
    const byName = new Map<string, string>();
    // Two schedulers racing the same instance could have written the same variable twice. The
    // invariant is one open row per variable, so the extra rows are closed rather than tolerated.
    const duplicates: string[] = [];
    for (const row of open.rows) {
      if (row.var_name === null) continue;
      if (byName.has(row.var_name)) duplicates.push(row.id);
      else byName.set(row.var_name, row.id);
    }

    const seen = new Set<string>();
    const created: string[] = [];
    const lastSeenAt = new Date().toISOString();

    for (const finding of findings) {
      const detail = { ...finding.detail, lastSeenAt };
      const existing = byName.get(finding.varName);
      if (existing !== undefined) {
        seen.add(existing);
        await this.pool.query(
          `UPDATE drift_record SET direction = $2, detail = $3::jsonb WHERE id = $1`,
          [existing, finding.direction, JSON.stringify(detail)],
        );
        continue;
      }
      await this.pool.query(
        `INSERT INTO drift_record (scope, instance_id, expected_hash, observed_hash, direction, detail)
         VALUES ('environment', $1, NULL, NULL, $2, $3::jsonb)`,
        [instanceId, finding.direction, JSON.stringify(detail)],
      );
      created.push(finding.varName);
    }

    const stale = [
      ...new Set([...open.rows.map((row) => row.id).filter((id) => !seen.has(id)), ...duplicates]),
    ];
    if (stale.length > 0) {
      await this.pool.query(
        `UPDATE drift_record SET resolved_at = now()
          WHERE instance_id = $1 AND resolved_at IS NULL AND id = ANY($2::uuid[])`,
        [instanceId, stale],
      );
    }
    return { created, resolved: stale.length };
  }
}

/** `NAME=value` lines of a rendered `platform.env`; values are JSON-quoted only when they must be. */
function parseEnvFile(content: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    env.set(trimmed.slice(0, separator), unquoteEnv(trimmed.slice(separator + 1)));
  }
  return env;
}

function unquoteEnv(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** `Config.Env` of a container, as the daemon reports it. */
function parseContainerEnv(entries: readonly string[]): Map<string, string> {
  const env = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf('=');
    if (separator <= 0) continue;
    env.set(entry.slice(0, separator), entry.slice(separator + 1));
  }
  return env;
}

/**
 * The product namespace a variable must live in to be reported as undeclared.
 *
 * A name is `PREFIX_REST` for every product this platform ships, and the prefix is what separates
 * `PAPERLESS_ADMIN_USER` (the product's configuration, undeclared) from `PATH` (the container's).
 * Deriving it from the entry's own declarations avoids a new catalogue attribute for a rule that
 * only matters where declarations exist.
 */
function namespacesOf(declared: ReadonlySet<string>): Set<string> {
  const namespaces = new Set<string>();
  for (const name of declared) {
    const separator = name.indexOf('_');
    if (separator > 0) namespaces.add(name.slice(0, separator));
  }
  return namespaces;
}

function isIgnored(name: string, namespaces: ReadonlySet<string>): boolean {
  if (RUNTIME_ENV_IGNORE.has(name)) return true;
  const separator = name.indexOf('_');
  return separator <= 0 || !namespaces.has(name.slice(0, separator));
}

/**
 * `repo_ahead` when the declaration no longer matches what was applied (it moved), `runtime_ahead`
 * when it still does (the container moved). No applied baseline means the evidence cannot decide,
 * and `unknown` is the honest answer rather than the flattering one.
 */
function declaredDirection(
  name: string,
  value: string,
  baseline: Map<string, string> | null,
): DriftDirection {
  if (baseline === null) return 'unknown';
  return baseline.get(name) === value ? 'runtime_ahead' : 'repo_ahead';
}

/**
 * A secret has no applied baseline to read (it is never rendered), so its timestamps decide: a value
 * resolved after the container was created has not reached it yet.
 */
function secretDirection(variable: EnvValue, services: readonly ObservedService[]): DriftDirection {
  if (variable.source !== 'secret') return 'unknown';
  const appliedAt = Date.parse(variable.appliedAt);
  const created = services
    .map((service) => service.created?.getTime())
    .filter((time): time is number => typeof time === 'number');
  if (!Number.isFinite(appliedAt) || created.length === 0) return 'unknown';
  return appliedAt > Math.min(...created) ? 'repo_ahead' : 'runtime_ahead';
}

function parseDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function notFound(instanceId: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No instance ${instanceId}.`,
    remediation: 'Refresh the instance list.',
  });
}

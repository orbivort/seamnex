import { Inject, Injectable } from '@nestjs/common';

import {
  isTrustedImageReference,
  untrustedRegistryMessage,
  type PreviewBlocker,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { isPinnedImage } from '../../common/compose/compose-policy';
import { TrustedRegistriesReader } from '../../common/security/trusted-registries';
import { PG_POOL } from '../../database/database.module';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { CAPACITY_SERVICE, type CapacityService } from '../m19-capacity/capacity.contract';
import { RENDERER_SERVICE, type RendererService } from '../m03-renderer/renderer.contract';
import {
  SOURCE_RESOLVER_SERVICE,
  type SourceResolverService,
} from '../m02-source-resolver/source-resolver.contract';

/**
 * FR-1.11 — the deterministic checks that run before a deployment is admitted.
 *
 * Before this service existed the preview answered capacity, slug and scaffold and then hard-coded
 * `policyVerdict: 'allowed'`; the pin, the variables, the secrets and the compose policy were only
 * discovered inside the job, after an instance row and a job row existed and, for a compose policy
 * violation, after a clone. A pre-flight that cannot refuse is a progress bar.
 *
 * Two rules the implementation keeps:
 *
 *   - **No side effects.** Nothing is cloned, copied or written. The policy is evaluated against the
 *     vendored tree or the approved scaffold in place; an entry with neither reports `unknown`
 *     rather than guessing a verdict.
 *   - **Every blocker names its fix.** `field` is the form field to change where one exists, so the
 *     wizard can put the message on the step that can resolve it.
 */

export type PreflightInput = {
  readonly entryKey: string;
  readonly slug: string;
  readonly profileKey?: string;
  readonly resources?: { readonly cpu: number; readonly memoryMb: number; readonly diskMb: number };
  readonly envOverrides?: Readonly<Record<string, string>>;
};

export type PreflightResult = {
  readonly admissible: boolean;
  readonly blockers: readonly PreviewBlocker[];
  readonly warnings: readonly string[];
  readonly headline: string;
  readonly detail: string;
  readonly shortfall: {
    readonly cpuMilli: number;
    readonly memoryMb: number;
    readonly diskMb: number;
  };
  readonly capacitySource: 'measured' | 'snapshot' | 'unknown';
  readonly routeHost: string;
  readonly slugAvailable: boolean;
  readonly policyVerdict: 'allowed' | 'blocked' | 'unsafe_approved' | 'unknown';
  readonly policyEvaluatedAt: string | null;
  readonly policySource: 'local_evaluation' | 'source_resolution' | 'none';
};

type EntryRow = {
  key: string;
  packaging: 'compose' | 'dockerfile' | 'none';
  payload: Record<string, unknown>;
};

@Injectable()
export class PreflightService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(RENDERER_SERVICE) private readonly renderer: RendererService,
    @Inject(CAPACITY_SERVICE) private readonly capacity: CapacityService,
    @Inject(SOURCE_RESOLVER_SERVICE) private readonly sources: SourceResolverService,
    /**
     * NFR-4.16 — the allow-list the deploy will enforce. Read here so the wizard refuses for the
     * same reason the pull path would, instead of admitting a deployment that fails at apply.
     */
    @Inject(TrustedRegistriesReader) private readonly trusted: TrustedRegistriesReader,
  ) {}

  async run(input: PreflightInput): Promise<PreflightResult> {
    const routeHost = `${input.slug}.${this.config.SEAMNEX_INGRESS_DOMAIN}`;
    const blockers: PreviewBlocker[] = [];
    const warnings: string[] = [];

    const entry = await this.entry(input.entryKey);
    if (entry === null) {
      blockers.push({
        code: 'unknown_entry',
        field: 'entryKey',
        message: `No catalog entry "${input.entryKey}" exists. Reload the catalogue and pick the product again.`,
        blocking: true,
      });
      return {
        admissible: false,
        blockers,
        warnings,
        headline: `No catalog entry "${input.entryKey}".`,
        detail: 'Nothing was checked: an unknown entry cannot be rendered, planned or applied.',
        shortfall: { cpuMilli: 0, memoryMb: 0, diskMb: 0 },
        capacitySource: 'unknown',
        routeHost,
        slugAvailable: false,
        policyVerdict: 'unknown',
        policyEvaluatedAt: null,
        policySource: 'none',
      };
    }

    const resources = this.resourcesOf(entry, input);

    // FR-1.5/FR-1.11: an unpinned image is refused here, not by the renderer fifteen seconds later.
    const imageRef = text(entry.payload.imageRef);
    const imageDigest = text(entry.payload.imageDigest);
    if (entry.packaging !== 'none' && imageRef !== null && !isPinnedImage(imageRef)) {
      blockers.push({
        code: 'image_unpinned',
        field: 'entryKey',
        message: `The catalogue pins "${imageRef}", which is a floating reference. Pin an explicit version or digest.`,
        blocking: true,
      });
    }
    if (imageDigest !== null && !/^sha256:[0-9a-f]{64}$/i.test(imageDigest)) {
      blockers.push({
        code: 'image_unpinned',
        field: 'entryKey',
        message: 'The catalogue records an image digest that is not a sha256 digest.',
        blocking: true,
      });
    }
    /*
     * NFR-4.16: the catalogue's own image is checked as well as the compose services. An entry can
     * point at a registry the allow-list has never approved even when its vendored compose file is
     * fine, and the message names the exact namespace to add.
     */
    if (entry.packaging !== 'none' && imageRef !== null) {
      const trustedEntries = await this.trusted.entries();
      if (!isTrustedImageReference(imageRef, trustedEntries)) {
        blockers.push({
          code: 'image_untrusted_registry',
          field: 'entryKey',
          message: untrustedRegistryMessage(imageRef),
          blocking: true,
        });
      }
    }

    // FR-1.17/FR-1.23: the source has to exist before a job can resolve it.
    if (entry.packaging === 'none') {
      if (!(await this.hasApprovedScaffold(entry.key))) {
        blockers.push({
          code: 'scaffold_unapproved',
          field: 'entryKey',
          message:
            'This entry has no Compose file or Dockerfile and no approved scaffold. Approve a scaffold draft before deploying.',
          blocking: true,
        });
      }
    } else if (!(await this.hasResolvableSource(entry))) {
      blockers.push({
        code: 'source_unresolved',
        field: 'entryKey',
        message:
          'The entry declares a packaging but no repository URL or vendored tree to resolve it from.',
        blocking: true,
      });
    }

    // FR-1.25/AC-51: the same resolution the deploy would use, so the field errors are the same ones.
    try {
      const plan = await this.renderer.plan({
        entryKey: entry.key,
        ...(input.profileKey === undefined ? {} : { profileKey: input.profileKey }),
        overrides: { ...(input.envOverrides ?? {}) },
      });
      for (const fieldError of plan.fieldErrors) {
        blockers.push({
          code: 'env_invalid',
          field: fieldError.field,
          message: fieldError.message,
          blocking: true,
        });
      }
    } catch (error) {
      // A resolution failure that is not a field error (an unknown profile) is still a blocker: the
      // deployment would fail at the same point with the same message.
      blockers.push({
        code: 'env_invalid',
        field: 'profileKey',
        message: error instanceof Error ? error.message : String(error),
        blocking: true,
      });
    }

    // FR-1.11: a profile secret that no longer resolves is a field error on the wizard, not a failed
    // apply after the containers were rendered.
    try {
      const unresolved = await this.renderer.unresolvedSecrets({
        entryKey: entry.key,
        ...(input.profileKey === undefined ? {} : { profileKey: input.profileKey }),
      });
      for (const secret of unresolved) {
        blockers.push({
          code: 'secret_unresolved',
          field: secret.varName,
          message: `${secret.varName}: ${secret.reason}`,
          blocking: true,
        });
      }
    } catch (error) {
      blockers.push({
        code: 'secret_unresolved',
        field: 'profileKey',
        message: error instanceof Error ? error.message : String(error),
        blocking: true,
      });
    }

    // AC-07: capacity, decided before any container starts.
    const decision = await this.capacity.admit({ resources });
    if (!decision.admissible) {
      blockers.push({
        code: 'capacity',
        field: 'resources',
        message: `${decision.headline} ${decision.detail}`.trim(),
        blocking: true,
      });
    }

    const quotas = volumeQuotaShortfall(entry.payload, resources.diskMb);
    if (quotas.shortfallMb > 0) {
      blockers.push({
        code: 'capacity',
        field: 'resources',
        message: `Volume quotas total ${quotas.declaredMb} MB, ${quotas.shortfallMb} MB more than the ${resources.diskMb} MB disk reservation; a deployment would be refused.`,
        blocking: true,
      });
    }

    const conflict = await this.slugConflict(input.slug);
    if (conflict !== null) {
      blockers.push({
        code: 'route_conflict',
        field: 'slug',
        message: conflict.detail,
        blocking: true,
      });
      warnings.push(conflict.warning);
    }

    // FR-1.20/FR-1.23: the compose policy verdict, with the evidence it came from.
    let policyVerdict: PreflightResult['policyVerdict'] = 'unknown';
    let policyEvaluatedAt: string | null = null;
    let policySource: PreflightResult['policySource'] = 'none';
    try {
      const preview = await this.sources.previewPolicy(entry.key);
      policyVerdict = preview.verdict;
      policyEvaluatedAt = preview.evaluatedAt;
      policySource = preview.source;
      if (preview.verdict === 'blocked') {
        const rules = [...new Set(preview.violations.map((violation) => violation.rule))];
        blockers.push({
          code: 'policy_blocked',
          field: 'entryKey',
          message: `The source policy would block this deployment: ${rules.join(', ')}.`,
          blocking: true,
        });
      } else if (preview.verdict === 'unknown') {
        blockers.push({
          code: 'policy_unknown',
          field: null,
          message: preview.reason ?? 'The source policy could not be evaluated before admission.',
          // Advisory, not blocking: the job evaluates the policy before applying anything, and
          // refusing every entry that is fetched at deployment time would block the normal path.
          blocking: false,
        });
      }
    } catch (error) {
      blockers.push({
        code: 'policy_unknown',
        field: null,
        message: `The source policy could not be evaluated: ${error instanceof Error ? error.message : String(error)}`,
        blocking: false,
      });
    }

    const blocking = blockers.filter((blocker) => blocker.blocking);
    const admissible = blocking.length === 0;
    const first = blocking[0];

    return {
      admissible,
      blockers,
      warnings,
      headline: admissible
        ? 'Ready to deploy'
        : `${blocking.length} blocker${blocking.length === 1 ? '' : 's'} must be fixed first`,
      detail: admissible
        ? `Capacity, route, variables, secrets and policy were checked. The policy verdict is ${policyVerdict}.`
        : first === undefined
          ? 'A pre-flight check failed.'
          : // The field, because the message alone is generic: three unanswered variables all
            // produce "A value is required.", and the caller prints this as the reason the plan was
            // refused.
            first.field === null
            ? first.message
            : `${first.field}: ${first.message}`,
      shortfall: decision.shortfall,
      capacitySource: decision.source,
      routeHost,
      slugAvailable: conflict === null,
      policyVerdict,
      policyEvaluatedAt,
      policySource,
    };
  }

  private async entry(entryKey: string): Promise<EntryRow | null> {
    const result = await this.pool.query<EntryRow>(
      `SELECT key, packaging, payload FROM catalog_entry WHERE key = $1`,
      [entryKey],
    );
    return result.rows[0] ?? null;
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

  /**
   * Whether a non-scaffold entry has anything to resolve.
   *
   * Existence on disk is the cheap half: a vendored tree is what an air-gapped host deploys from,
   * and a repository URL is the other source. Neither is fetched here.
   */
  private async hasResolvableSource(entry: EntryRow): Promise<boolean> {
    const repoUrl = text(entry.payload.repoUrl);
    if (repoUrl !== null && repoUrl.length > 0) return true;
    const row = await this.pool.query<{ repo_url: string | null }>(
      `SELECT repo_url FROM catalog_entry WHERE key = $1`,
      [entry.key],
    );
    return (row.rows[0]?.repo_url ?? '').length > 0;
  }

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
      detail: `The slug "${slug}" is reserved until ${row.reserved_until?.toISOString().slice(0, 10) ?? 'the reservation lapses'}: a deployment was deleted there and a slug stays reserved for 30 days after deletion.`,
      warning:
        'Nothing is published at that host; the name is held by a deletion, not by a running deployment. Choose another slug.',
    };
  }

  private resourcesOf(
    entry: EntryRow,
    input: PreflightInput,
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
}

/** FR-1.9: Σ declared volume quota against the disk reservation, same numbers the job renders with. */
function volumeQuotaShortfall(
  payload: Record<string, unknown>,
  diskMb: number,
): { volumes: { name: string; quotaMb: number }[]; declaredMb: number; shortfallMb: number } {
  const rows = Array.isArray(payload.volumes) ? payload.volumes : [];
  const volumes = rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return [];
    const record = row as Record<string, unknown>;
    if (typeof record.name !== 'string' || record.name.length === 0) return [];
    if (typeof record.quotaMb !== 'number' || !(record.quotaMb > 0)) return [];
    return [{ name: record.name, quotaMb: Math.round(record.quotaMb) }];
  });
  const declaredMb = volumes.reduce((total, volume) => total + volume.quotaMb, 0);
  return { volumes, declaredMb, shortfallMb: Math.max(0, declaredMb - diskMb) };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

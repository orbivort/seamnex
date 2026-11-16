import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CatalogEntrySchema,
  ScaffoldDraftSchema,
  isComposeRule,
  type ScaffoldConfirmation,
  type ScaffoldDraft,
} from '@seamnex/domain';
import type { Pool } from 'pg';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { PG_POOL } from '../../database/database.module';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import {
  CATALOG_REPOSITORY,
  type CatalogRepositoryService,
} from '../m22-catalog-repository/catalog-repo.contract';
import { AppError } from '../../common/problem/app-error';
import { cloneAtRevision } from '../../common/exec/git';
import { ensureDir, safeJoin, sha256, writeFileAtomic } from '../../common/fs/files';
import {
  evaluateCompose,
  parseCompose,
  type ComposePolicyResult,
  type ComposeRule,
} from '../../common/compose/compose-policy';
import { evaluateDockerfile } from '../../common/compose/dockerfile-policy';
import { emptyPolicy, type SourcePolicyResult } from '../../common/compose/policy-result';
import { evaluateComposeText } from '../../common/compose/source-policy';
import type {
  ResolveInput,
  ResolvedSource,
  ResolvedSourceFile,
  SourceResolverService,
} from './source-resolver.contract';

const COMPOSE_CANDIDATES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
];
const DOCKERFILE_CANDIDATES = ['Dockerfile', 'docker/Dockerfile', 'build/Dockerfile'];
const ENV_CANDIDATES = ['.env.example', '.env.sample', 'env.example'];

type EntryRow = {
  key: string;
  repo_url: string | null;
  packaging: 'compose' | 'dockerfile' | 'none';
  payload: Record<string, unknown>;
};

/**
 * 4A.2 — resolves a deployable source.
 *
 * Three things this service refuses to do, each because the alternative is a silent wrong answer:
 *   - guess a source path from `packaging` alone. The tree is inspected, and the precedence is
 *     Compose → Dockerfile → scaffold; an entry that says "compose" but ships only a Dockerfile
 *     takes the Dockerfile path and the decision is recorded.
 *   - rewrite the customer's file. The upstream bytes are retained and hashed into `source_file`;
 *     the normalised copy is a render artefact, not a mutation.
 *   - apply a compose file that breaks the policy. A blocked file fails *before* a job starts, with
 *     the offending service named, unless an approved exception covers the rule.
 */
@Injectable()
export class FilesystemSourceResolver implements SourceResolverService {
  private readonly logger = new Logger('m02-source-resolver');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    // `catalog_commit` is M22's table; recording a commit is its job, not this module's.
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepositoryService,
  ) {}

  async resolve(input: ResolveInput): Promise<ResolvedSource> {
    const entry = await this.entry(input.entryKey);
    const instanceRoot = join(this.config.SEAMNEX_INSTANCE_DATA_DIR, input.instanceId);
    // A fresh directory per attempt: nothing is deleted, so a concurrent reader (a log, a backup)
    // never observes a tree being rewritten underneath it.
    const directory = join(instanceRoot, 'source', String(Date.now()));
    ensureDir(directory);

    const scaffold = await this.scaffoldDraft(entry.key);
    const source = await this.fetch(entry, directory, input);

    const detected = detect(source.directory);
    const path =
      detected.composeFile !== null
        ? 'compose'
        : detected.dockerfilePath !== null
          ? 'dockerfile'
          : 'scaffold';

    if (input.onProgress !== undefined) {
      await input.onProgress(
        `source path resolved: ${path}` +
          (source.revision === null ? ' (local tree)' : ` at ${source.revision.slice(0, 12)}`),
      );
    }

    /*
     * Every path is policy-checked before anything starts (NFR-4.15), and the verdict is recorded
     * *before* a refusal is raised. A blocked attempt therefore leaves a `source_resolution` row with
     * the violations it found and the substitutions it would have made; the exception request reads
     * that row, so an approver decides on a deviation the platform observed rather than on one a
     * client described.
     */
    const waivers = await this.waivers(entry.key);
    let policy: SourcePolicyResult;
    let files: ResolvedSourceFile[];

    if (path === 'compose') {
      const composePath = detected.composeFile as string;
      files = retain(source.directory, [composePath, ...detected.envFiles]);
      policy = this.evaluate(this.readCompose(composePath), waivers.rules);
    } else if (path === 'dockerfile') {
      const dockerfilePath = detected.dockerfilePath as string;
      files = retain(source.directory, [dockerfilePath, ...detected.envFiles]);
      policy = evaluateDockerfile(readFileSync(dockerfilePath, 'utf8'), new Set(waivers.rules));
    } else {
      if (scaffold === null) {
        throw new AppError({
          code: 'NOT_FOUND',
          detail: `${entry.key} has no Compose file, no Dockerfile and no approved scaffold.`,
          remediation: 'Generate a scaffold draft for the entry, approve it, then deploy again.',
        });
      }
      files = writeScaffold(directory, scaffold.files);
      policy = this.evaluateScaffold(files, waivers.rules);
    }

    const imageRef =
      path === 'dockerfile'
        ? `seamnex/instance-${input.instanceId}:${(source.revision ?? 'local').slice(0, 12)}`
        : payloadString(entry.payload, 'imageRef');
    const imageDigest = path === 'dockerfile' ? null : payloadString(entry.payload, 'imageDigest');

    const resolutionId = await this.record({
      instanceId: input.instanceId,
      path,
      sourceUrl: source.url,
      revision: source.revision ?? 'local',
      imageRef,
      imageDigest,
      policy,
      files,
    });

    if (policy.verdict === 'blocked') {
      await this.auditBlocked(input.instanceId, entry.key, policy, resolutionId, waivers.expired);
      throw refusal(entry.key, policy, waivers.expired, resolutionId);
    }

    return {
      resolutionId,
      path,
      sourceUrl: source.url,
      revision: source.revision ?? 'local',
      directory: source.directory,
      composeFile: path === 'compose' ? detected.composeFile : null,
      dockerfilePath: path === 'dockerfile' ? detected.dockerfilePath : null,
      imageRef,
      imageDigest,
      policy,
      files,
    };
  }

  evaluate(composeContent: string, waived: readonly ComposeRule[]): ComposePolicyResult {
    return evaluateCompose(parseCompose(composeContent), new Set(waived));
  }

  async confirmScaffold(
    entryKey: string,
    draftId: string,
    actorId: string,
  ): Promise<ScaffoldConfirmation> {
    const row = await this.pool.query<{
      id: string;
      files: unknown;
      created_at: Date;
      approved_by: string | null;
    }>(
      `SELECT id, files, created_at, approved_by FROM scaffold_artefact WHERE id = $1 AND entry_key = $2`,
      [draftId, entryKey],
    );
    const artefact = row.rows[0];
    if (artefact === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `No scaffold draft ${draftId} for ${entryKey}.`,
        remediation: 'Reload the catalog entry and regenerate the draft.',
      });
    }

    const draft = ScaffoldDraftSchema.parse({
      entryKey,
      draftId,
      createdAt: artefact.created_at.toISOString(),
      approvedBy: artefact.approved_by,
      files: artefact.files,
      diagnostics: [],
    });

    // The working tree is the authority (ADR-BE-08): the confirmed draft is written there, and the
    // commit hash is what `catalog/reload` will read next.
    const root = join(this.config.SEAMNEX_CATALOG_REPO_PATH, 'scaffold', entryKey);
    ensureDir(root);
    for (const file of draft.files) {
      const target = safeJoin(root, file.path);
      ensureDir(dirname(target));
      writeFileAtomic(target, file.content);
    }

    const sha = sha256(JSON.stringify({ entryKey, files: draft.files }));
    const approvedAt = new Date();
    await this.audit.append({
      action: 'catalog.scaffold.confirmed',
      actorType: 'user',
      actorId,
      targetType: 'catalog_entry',
      targetId: entryKey,
      outcome: 'success',
      detail: { draftId, files: draft.files.map((file) => file.path), sha },
    });

    await this.pool.query(
      `UPDATE scaffold_artefact SET approved_by = $2, approved_at = now() WHERE id = $1`,
      [draftId, actorId],
    );
    await this.catalog.recordCommit({
      sha,
      kind: 'scaffold',
      actor: actorId,
      message: `Confirm scaffold draft for ${entryKey}`,
    });
    await this.pool.query(`UPDATE catalog_entry SET updated_at = now() WHERE key = $1`, [entryKey]);

    return {
      ...draft,
      approvedBy: actorId,
      createdAt: approvedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------------------------

  private async entry(entryKey: string): Promise<EntryRow> {
    const result = await this.pool.query<EntryRow>(
      `SELECT key, repo_url, packaging, payload FROM catalog_entry WHERE key = $1`,
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

  /** Clones when the entry declares a repository; otherwise resolves to the local working tree. */
  private async fetch(
    entry: EntryRow,
    directory: string,
    input: ResolveInput,
  ): Promise<{ directory: string; url: string | null; revision: string | null }> {
    const parsed = CatalogEntrySchema.safeParse({ ...entry.payload, key: entry.key });
    const repoUrl = (parsed.success ? parsed.data.repoUrl : null) ?? entry.repo_url;

    // A vendored tree wins over the network, always: it is the revision the operator pinned and
    // reviewed, and it is the only path that works on a host with no route to the git server.
    const mirror = this.mirror(entry.key, directory);
    if (mirror !== null) {
      this.logger.log({
        msg: 'source resolved from vendored tree',
        entryKey: entry.key,
        revision: mirror.revision,
      });
      return { directory, url: mirror.url, revision: mirror.revision };
    }

    if (repoUrl === null || repoUrl.length === 0 || entry.packaging === 'none') {
      return { directory, url: null, revision: null };
    }

    try {
      const clone = await cloneAtRevision({
        url: repoUrl,
        targetDir: directory,
        ...(input.revision === undefined ? {} : { revision: input.revision }),
        allowedHosts: this.config.sourceAllowedHosts,
        timeoutMs: 300_000,
      });
      return { directory, url: repoUrl, revision: clone.commit };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ msg: 'source fetch failed', entryKey: entry.key, repoUrl, err: message });
      if (
        message.includes('not allow-listed') ||
        message.includes('must use https') ||
        message.includes('private address')
      ) {
        throw new AppError({
          code: 'SOURCE_URL_REJECTED',
          detail: `The source URL for ${entry.key} was refused: ${message}`,
          remediation: `Put the repository on an allow-listed host (${this.config.sourceAllowedHosts.join(', ')}), or add it to SEAMNEX_SOURCE_ALLOWED_HOSTS.`,
        });
      }
      throw new AppError({
        code: 'UNAVAILABLE',
        detail: `The source repository for ${entry.key} could not be fetched: ${message}`,
        remediation: 'Check the repository URL and the host network, then retry the deployment.',
        cause: error,
      });
    }
  }

  /**
   * Copies a vendored upstream tree into the per-attempt directory.
   *
   * The tree is copied rather than read in place so two concurrent resolutions never share a
   * directory and a later edit to the mirror cannot change a resolution that already happened. The
   * revision is the first line of `SOURCE_REVISION` when the operator supplied one, otherwise a
   * content hash of the tree, so "what was deployed" is still provable without the git host.
   */
  private mirror(entryKey: string, directory: string): { url: string; revision: string } | null {
    const root =
      this.config.SEAMNEX_SOURCE_MIRROR_DIR.length > 0
        ? this.config.SEAMNEX_SOURCE_MIRROR_DIR
        : join(this.config.SEAMNEX_CATALOG_REPO_PATH, 'upstream');
    const source = join(root, entryKey);
    if (!existsSync(source)) return null;

    cpSync(source, directory, { recursive: true });
    const declared = existsSync(join(source, 'SOURCE_REVISION'))
      ? (readFileSync(join(source, 'SOURCE_REVISION'), 'utf8').split(/\r?\n/)[0] ?? '').trim()
      : '';
    const revision =
      declared.length > 0
        ? declared
        : `mirror-${sha256(JSON.stringify(listTree(source))).slice(0, 12)}`;
    return { url: `mirror://${entryKey}`, revision };
  }

  /**
   * The read surface for the draft (FR-1.22). It deliberately does **not** filter on
   * `approved_at`: before confirmation there is no approved row, and returning nothing would leave
   * the entry screen unable to show what it is asking the operator to confirm.
   */
  async scaffold(entryKey: string): Promise<ScaffoldDraft> {
    const result = await this.pool.query<{
      id: string;
      files: ScaffoldFiles;
      approved_by: string | null;
      created_at: Date;
    }>(
      `SELECT id, files, approved_by, created_at FROM scaffold_artefact
        WHERE entry_key = $1 ORDER BY created_at DESC LIMIT 1`,
      [entryKey],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AppError({
        code: 'NOT_FOUND',
        detail: `${entryKey} has no scaffold draft.`,
        remediation: 'This product ships a Compose file or a Dockerfile, so no scaffold is needed.',
      });
    }
    return {
      entryKey,
      draftId: row.id,
      createdAt: row.created_at.toISOString(),
      approvedBy: row.approved_by,
      files: row.files,
      // Draft diagnostics are produced by the confirmation step, which re-validates the files before
      // committing them. Reporting invented "pass" rows here would be a claim nobody checked.
      diagnostics: [],
    };
  }

  private async scaffoldDraft(
    entryKey: string,
  ): Promise<{ id: string; files: ScaffoldFiles } | null> {
    const result = await this.pool.query<{ id: string; files: unknown }>(
      `SELECT id, files FROM scaffold_artefact
        WHERE entry_key = $1 AND approved_at IS NOT NULL
        ORDER BY approved_at DESC LIMIT 1`,
      [entryKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const files = ScaffoldDraftSchema.shape.files.safeParse(row.files);
    if (!files.success) return null;
    return { id: row.id, files: files.data };
  }

  /**
   * NFR-4.15 — the waivers this deployment may use, and the ones that lapsed.
   *
   * Two defects lived in the query this replaces. It ignored `scope`, so **one approved exception
   * waived the rule for every product**: `SELECT DISTINCT rule … WHERE state='approved'` has no
   * product in it at all. And it silently dropped an expired row, so the refusal could not say "your
   * exception ran out" — the operator saw a rule they believed was waived, failing again, with no
   * explanation. An expired exception therefore comes back as `expired` and is quoted in the refusal
   * (AC-33: "expiry blocks the next deployment").
   *
   * `scope` is the catalog entry key (design §5, data model: the scope is what is approved). A row
   * whose scope matches nothing — every row written before this change carried free text — waives
   * nothing, which is the safe direction: a legacy exception must be re-filed to have effect.
   */
  private async waivers(entryKey: string): Promise<{
    rules: ComposeRule[];
    expired: ExpiredWaiver[];
  }> {
    const result = await this.pool.query<{
      rule: string;
      live: boolean;
      expires_at: Date;
    }>(
      /* A plan-scoped row is honoured when a caller has a plan; a resolution has none yet (the plan
         is written after the source is resolved), so the product scope is what decides here. */
      `SELECT rule, expires_at > now() AS live, expires_at
         FROM policy_exception
        WHERE state = 'approved' AND scope = $1
        ORDER BY expires_at DESC`,
      [entryKey],
    );

    const live = new Set<ComposeRule>();
    const expired = new Map<ComposeRule, Date>();
    for (const row of result.rows) {
      if (!isComposeRule(row.rule)) continue;
      if (row.live) live.add(row.rule);
      else if (!expired.has(row.rule)) expired.set(row.rule, row.expires_at);
    }
    return {
      rules: [...live],
      expired: [...expired.entries()]
        .filter(([rule]) => !live.has(rule))
        .map(([rule, expiresAt]) => ({ rule, expiresAt })),
    };
  }

  private readCompose(path: string): string {
    const content = readFileSync(path, 'utf8');
    // Parse once here so a malformed file is refused before a job starts, with a readable message.
    parseCompose(content);
    return content;
  }

  /**
   * The scaffold path's artefacts are ingested definitions like any other (NFR-4.15): a draft can
   * carry a compose file or a Dockerfile, and either is applied by the platform once confirmed. The
   * compose file wins, because it is what `compose` would have detected had the draft been committed
   * before resolution.
   */
  private evaluateScaffold(
    files: readonly ResolvedSourceFile[],
    waived: readonly ComposeRule[],
  ): SourcePolicyResult {
    const compose = files.find((file) => COMPOSE_CANDIDATES.includes(basename(file.path)));
    if (compose !== undefined) return evaluateComposeText(compose.content, new Set(waived));
    const dockerfile = files.find((file) => DOCKERFILE_CANDIDATES.includes(basename(file.path)));
    if (dockerfile !== undefined) {
      return evaluateDockerfile(dockerfile.content, new Set(waived));
    }
    // A draft with neither is a bare run definition: the platform generates the compose project, so
    // it publishes no port and binds no host path.
    return emptyPolicy();
  }

  private async auditBlocked(
    instanceId: string,
    entryKey: string,
    policy: SourcePolicyResult,
    resolutionId: string,
    expired: readonly ExpiredWaiver[],
  ): Promise<void> {
    await this.audit.append({
      action: 'deployment.compose_policy.blocked',
      actorType: 'system',
      actorId: 'm02-source-resolver',
      targetType: 'instance',
      targetId: instanceId,
      outcome: 'failure',
      detail: {
        entryKey,
        resolutionId,
        violations: policy.violations.map((violation) => ({
          rule: violation.rule,
          service: violation.service,
        })),
        expiredRules: expired.map((waiver) => waiver.rule),
      },
    });
  }

  private async record(input: {
    instanceId: string;
    path: ResolvedSource['path'];
    sourceUrl: string | null;
    revision: string;
    imageRef: string | null;
    imageDigest: string | null;
    policy: SourcePolicyResult;
    files: readonly ResolvedSourceFile[];
  }): Promise<string> {
    /*
     * The verdict and its evidence are one row (0034). Three things changed here: the verdict is
     * recorded for every path rather than only `compose` (a Dockerfile can now be `unsafe_approved`),
     * the substitutions are stored so "the patch is recorded as a diff" is a fact rather than a
     * claim (FR-1.20, design §11.5), and a blocked attempt is stored as well — the exception request
     * cites this row.
     */
    const inserted = await this.pool.query<{ id: string }>(
      `INSERT INTO source_resolution
         (instance_id, path, source_url, source_revision, resolved_image_ref, resolved_image_digest,
          policy_verdict, patch_diff, policy_violations)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
       RETURNING id`,
      [
        input.instanceId,
        input.path,
        input.sourceUrl,
        input.revision,
        input.imageRef,
        input.imageDigest,
        input.policy.verdict,
        JSON.stringify(input.policy.patch),
        JSON.stringify(input.policy.violations),
      ],
    );
    const resolutionId = inserted.rows[0]?.id;
    if (resolutionId === undefined) {
      throw new AppError({
        code: 'INTERNAL_ERROR',
        detail: 'The source resolution row was not created.',
        remediation: 'Retry the deployment; the job has not started.',
      });
    }

    for (const file of input.files) {
      await this.pool.query(
        `INSERT INTO source_file (resolution_id, path, sha256, content) VALUES ($1, $2, $3, $4)
         ON CONFLICT (resolution_id, path) DO NOTHING`,
        [resolutionId, file.path, file.sha256, file.content],
      );
    }
    return resolutionId;
  }
}

type ScaffoldFiles = ScaffoldConfirmation['files'];

/** Inspects a fetched tree. The first match wins, in the documented precedence order. */
function detect(directory: string): {
  composeFile: string | null;
  dockerfilePath: string | null;
  envFiles: string[];
} {
  const compose =
    COMPOSE_CANDIDATES.map((name) => locate(directory, name)).find((path) => path !== null) ?? null;
  const dockerfile =
    DOCKERFILE_CANDIDATES.map((name) => locate(directory, name)).find((path) => path !== null) ??
    null;
  const envFiles = ENV_CANDIDATES.map((name) => locate(directory, name)).filter(
    (path): path is string => path !== null,
  );
  return { composeFile: compose, dockerfilePath: dockerfile, envFiles };
}

function locate(directory: string, candidate: string): string | null {
  try {
    const path = safeJoin(directory, candidate);
    return existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

function retain(directory: string, paths: readonly string[]): ResolvedSourceFile[] {
  return paths.map((path) => {
    const content = readFileSync(path, 'utf8');
    return {
      path: path.slice(directory.length + 1).replace(/\\/g, '/'),
      sha256: sha256(content),
      content,
    };
  });
}

function writeScaffold(directory: string, files: ScaffoldFiles): ResolvedSourceFile[] {
  const written: ResolvedSourceFile[] = [];
  for (const file of files) {
    const target = safeJoin(directory, file.path);
    ensureDir(dirname(target));
    writeFileSync(target, file.content, 'utf8');
    written.push({ path: file.path, sha256: sha256(file.content), content: file.content });
  }
  return written;
}

/** An approved exception whose time box has closed: it waives nothing, and the refusal says so. */
type ExpiredWaiver = { rule: ComposeRule; expiresAt: Date };

/**
 * The refusal an operator can act on (AC-33).
 *
 * It names the blocking constructs, says when a covering exception ran out, and points at the two
 * things that resolve it: fix the source, or have a second party approve a time-boxed exception for
 * *this* product. It also names the recorded attempt, because that row is what the exception request
 * reads — and an operator who cannot find the evidence assumes there is none.
 */
function refusal(
  entryKey: string,
  policy: SourcePolicyResult,
  expired: readonly ExpiredWaiver[],
  resolutionId: string,
): AppError {
  const blocking = policy.violations.filter((violation) => !policy.waived.includes(violation.rule));
  const lapsed =
    expired.length === 0
      ? ''
      : ` An approved exception for ${expired
          .map((waiver) => `${waiver.rule} (expired ${waiver.expiresAt.toISOString()})`)
          .join(', ')} no longer covers a deployment.`;
  return new AppError({
    code: 'COMPOSE_POLICY_BLOCKED',
    detail: `The source definition is refused by the platform policy: ${blocking
      .slice(0, 3)
      .map((violation) => violation.detail)
      .join(' ')}${lapsed}`,
    fieldErrors: blocking.map((violation) => ({
      field: violation.service ?? violation.rule,
      code: violation.rule,
      message: violation.detail,
    })),
    remediation: `Remove the offending construct, or have a second party approve a time-boxed policy exception for ${entryKey} (Governance → Maintenance and policy exceptions), then deploy again. Resolution ${resolutionId} is recorded with the violations and the normalisation it would have applied.`,
  });
}

function payloadString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

/** Sorted relative paths of a tree: the input to the mirror's content hash. */
function listTree(root: string, prefix = ''): string[] {
  const entries = readdirSync(join(root, prefix), { withFileTypes: true });
  return entries
    .flatMap((entry) => {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      return entry.isDirectory() ? listTree(root, relative) : [relative];
    })
    .sort();
}

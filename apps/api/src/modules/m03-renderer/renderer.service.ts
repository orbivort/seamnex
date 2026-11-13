import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { checkEnvValue, ruleFingerprint } from '@seamnex/domain';
import type {
  EnvImportResult,
  EnvPlan,
  EnvProfile,
  EnvSchemaFile,
  EnvSchemaVar,
  EnvValue,
  ReloadEnvironmentResult,
} from '@seamnex/domain';
import type { EnvUpdateResponse } from './renderer.contract';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, type Queryable } from '@seamnex/db';
import { PG_POOL } from '../../database/database.module';
import { AUDIT_SERVICE, type AuditService } from '../m17-audit/audit.contract';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import { AppError } from '../../common/problem/app-error';
import type { RenderInput, RenderSet, RendererService } from './renderer.contract';
import { RenderSetService } from './render.service';

type VarRow = {
  name: string;
  type: EnvSchemaVar['type'];
  required: boolean;
  default_value: string | null;
  constraint_text: string | null;
  conditional: string | null;
  secret: boolean;
  override_ceiling: EnvSchemaVar['overrideCeiling'];
  purpose: string | null;
  options: string[] | null;
  /** `catalog/env/<KEY>.json` → `rule`; `null` for a declaration that makes no enforceable claim. */
  validation_rule: EnvSchemaVar['rule'] | null;
};

/**
 * Deliverable 2.3 — resolution without rendering.
 *
 * Precedence is `default → profile → instance → secret`; a ceiling of `none` refuses a value from
 * anywhere but the schema itself, and `profile_only` refuses an instance override. Those refusals
 * are reported per field instead of throwing, because the wizard renders them next to the input.
 */
@Injectable()
export class PostgresRendererService implements RendererService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(AUDIT_SERVICE) private readonly audit: AuditService,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
    @Inject(RenderSetService) private readonly renderSets: RenderSetService,
  ) {}

  // The render half lives in `render.service.ts`; this class stays the environment authority. Both
  // are exposed through one token so a caller cannot depend on half of M03 by accident.

  render(input: RenderInput): Promise<RenderSet> {
    return this.renderSets.render(input);
  }

  applied(instanceId: string): Promise<RenderSet | null> {
    return this.renderSets.applied(instanceId);
  }

  load(renderSetId: string): Promise<RenderSet> {
    return this.renderSets.load(renderSetId);
  }

  async schema(entryKey: string): Promise<EnvSchemaVar[]> {
    const rows = await this.vars(entryKey);
    if (rows.length === 0) await this.assertEntryExists(entryKey);
    // Provenance is per entry, not per row: every variable in the projection came from the same
    // file revision, and repeating the sha on 21 rows would be noise in the payload.
    const revision = await this.schemaRevision(entryKey);
    return rows.map((row) => ({ ...toSchemaVar(row), revision }));
  }

  async profiles(): Promise<EnvProfile[]> {
    const result = await this.pool.query<{
      key: string;
      target: 'production' | 'staging';
      updated_by: string | null;
      updated_at: Date;
    }>(`SELECT key, target, updated_by, updated_at FROM env_profile ORDER BY key`);
    const values = await this.pool.query<{
      profile_key: string;
      var_name: string;
      value_enc: Buffer | null;
      secret_ref: string | null;
    }>(`SELECT profile_key, var_name, value_enc, secret_ref FROM env_profile_value`);
    return result.rows.map((row) => ({
      key: row.key,
      name: row.key,
      target: row.target,
      updatedBy: row.updated_by ?? 'system',
      updatedAt: row.updated_at.toISOString(),
      values: values.rows
        .filter((value) => value.profile_key === row.key)
        .map((value) => ({
          varName: value.var_name,
          value: value.value_enc === null ? null : value.value_enc.toString('utf8'),
          secretRef: value.secret_ref,
        })),
    }));
  }

  async plan(input: {
    entryKey: string;
    profileKey?: string;
    overrides: Record<string, string>;
  }): Promise<EnvPlan> {
    const vars = await this.vars(input.entryKey);
    const profileKey = await this.resolveProfile(input.profileKey);
    if (vars.length === 0) {
      // An entry that declares no variables has nothing to resolve: that is an empty plan, not a
      // missing one. Throwing `NOT_FOUND` here made the wizard's "environment resolves" check
      // unprovable (a failed request and a clean plan were indistinguishable) and refused the
      // deployment of every product that ships without an environment schema.
      await this.assertEntryExists(input.entryKey);
      return {
        entryKey: input.entryKey,
        profileKey,
        values: [],
        fieldErrors: [],
        requiresRecreate: false,
        resolvedAt: new Date().toISOString(),
      };
    }

    const profile = await this.pool.query<{
      var_name: string;
      value_enc: Buffer | null;
      secret_ref: string | null;
    }>(`SELECT var_name, value_enc, secret_ref FROM env_profile_value WHERE profile_key = $1`, [
      profileKey,
    ]);
    const profileValues = new Map(profile.rows.map((row) => [row.var_name, row]));
    const fieldErrors: EnvPlan['fieldErrors'] = [];
    let requiresRecreate = false;

    const values = vars.map((row): EnvPlan['values'][number] => {
      const base = toSchemaVar(row);
      const instanceValue = input.overrides[row.name];
      const profileValue = profileValues.get(row.name);
      let value: string | null = row.default_value;
      let source: EnvPlan['values'][number]['source'] = 'default';
      // One error per field: a value that may not be set there is not also "the wrong length", and
      // pushing both would put a second, unactionable message beside the input.
      let rejected = false;

      if (instanceValue !== undefined) {
        if (row.override_ceiling === 'none') {
          fieldErrors.push({
            field: row.name,
            code: 'ceiling',
            message: 'This variable cannot be overridden.',
          });
          rejected = true;
        } else {
          value = instanceValue;
          source = 'instance';
        }
      } else if (profileValue !== undefined) {
        value =
          profileValue.secret_ref === null
            ? (profileValue.value_enc?.toString('utf8') ?? null)
            : null;
        source = profileValue.secret_ref === null ? 'profile' : 'secret';
      }

      if (row.required && (value === null || value.length === 0)) {
        fieldErrors.push({ field: row.name, code: 'required', message: 'A value is required.' });
        rejected = true;
      }
      if (row.override_ceiling === 'profile_only' && source === 'instance') {
        fieldErrors.push({
          field: row.name,
          code: 'ceiling',
          message: 'Only a profile may set this variable.',
        });
        value = row.default_value;
        source = 'default';
        rejected = true;
      }

      /**
       * The enforceable half of the declaration (`rule`, projected from `catalog/env/<KEY>.json`).
       *
       * This is the check whose absence let a 12-character `MB_ENCRYPTION_SECRET_KEY` through a
       * declaration that asked for 64 hexadecimal characters: the value was correct-length for the
       * form and wrong for the product, and the deployment paid for it with a full verify window.
       * The resolved value is checked *before* masking, so a secret is validated without being
       * echoed back in the error.
       */
      if (!rejected) {
        const violation = checkEnvValue(base, value);
        if (violation !== null) {
          fieldErrors.push({ field: row.name, code: violation.code, message: violation.message });
        }
      }

      const recreate =
        row.override_ceiling !== 'none' && source !== 'default' && RECREATE.has(row.name);
      if (recreate) requiresRecreate = true;

      /**
       * Only a value that actually came from somewhere is masked.
       *
       * Marking every `type: secret` row as masked made an unresolved variable render as
       * `•••••••• · catalog default` — a screen telling the operator a credential is configured when
       * nothing is. A secret with no value is "not set", and the plan must be able to say so.
       */
      const masked = row.secret && source !== 'default';

      return {
        ...base,
        value: masked ? null : value,
        source,
        masked,
        error: null,
        requiresRecreate: recreate,
      };
    });

    return {
      entryKey: input.entryKey,
      profileKey,
      values,
      fieldErrors,
      requiresRecreate,
      resolvedAt: new Date().toISOString(),
    };
  }

  async importEnv(
    input: { entryKey: string; source: 'dotenv' | 'compose'; content: string },
    actorId: string,
  ): Promise<EnvImportResult> {
    const vars = await this.vars(input.entryKey);
    const declared = new Map(vars.map((row) => [row.name, row]));
    const parsed = parseEnv(input.content);
    const mapped: EnvImportResult['mapped'] = [];
    const unmapped: string[] = [];

    for (const [name, value] of parsed) {
      const variable = declared.get(name);
      if (variable === undefined) {
        unmapped.push(name);
        continue;
      }
      mapped.push({
        name,
        value: variable.secret ? null : value,
        secret: variable.secret,
        accepted: true,
        reason: variable.secret
          ? 'Secret values are never imported; enter them at deploy time.'
          : null,
      });
    }

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      await this.audit.append(
        {
          action: 'catalog.env.imported',
          actorType: 'user',
          actorId,
          targetType: 'catalog_entry',
          targetId: input.entryKey,
          outcome: 'success',
          detail: {
            source: input.source,
            parsed: parsed.size,
            mapped: mapped.length,
            unmapped: unmapped.length,
          },
        },
        tx,
      );
    });

    return {
      entryKey: input.entryKey,
      source: input.source,
      parsed: parsed.size,
      mapped,
      unmapped,
      fieldErrors: [],
      importedAt: new Date().toISOString(),
    };
  }

  async instanceEnv(instanceId: string): Promise<EnvValue[]> {
    const instance = await this.pool.query<{ entry_key: string; profile_key: string | null }>(
      `SELECT entry_key, profile_key FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    const row = instance.rows[0];
    if (row === undefined) throw notFound(instanceId);

    const vars = await this.vars(row.entry_key);
    const stored = await this.pool.query<{
      var_name: string;
      source: EnvValue['source'];
      value_enc: Buffer | null;
      secret_ref: string | null;
      resolved_at: Date;
    }>(
      `SELECT var_name, source, value_enc, secret_ref, resolved_at FROM instance_env_value WHERE instance_id = $1`,
      [instanceId],
    );
    const byName = new Map(stored.rows.map((entry) => [entry.var_name, entry]));

    return vars.map((variable) => {
      const value = byName.get(variable.name);
      const masked = variable.secret || value?.secret_ref !== null;
      return {
        name: variable.name,
        purpose: variable.purpose ?? variable.name,
        type: variable.type,
        secret: variable.secret,
        value: masked ? null : (value?.value_enc?.toString('utf8') ?? variable.default_value),
        masked,
        source: value?.source ?? 'default',
        overrideCeiling: variable.override_ceiling,
        appliedAt: (value?.resolved_at ?? new Date()).toISOString(),
        requiresRecreate: RECREATE.has(variable.name),
        drift: value !== undefined && value.value_enc === null && variable.default_value !== null,
      };
    });
  }

  async updateInstanceEnv(
    instanceId: string,
    values: Record<string, string>,
    actorId: string,
  ): Promise<EnvUpdateResponse> {
    const instance = await this.pool.query<{ entry_key: string }>(
      `SELECT entry_key FROM instance WHERE id = $1 AND deleted_at IS NULL`,
      [instanceId],
    );
    const row = instance.rows[0];
    if (row === undefined) throw notFound(instanceId);
    const vars = new Map(
      (await this.vars(row.entry_key)).map((variable) => [variable.name, variable]),
    );

    const diff: EnvUpdateResponse['diff'] = [];
    let requiresRecreate = false;

    /**
     * Validate the whole request before writing anything.
     *
     * Two reasons it is a pass of its own rather than a check inside the write loop: a rejected
     * value must not leave the other values written (half an environment is worse than none), and
     * the operator needs every offending field at once, not the first one the loop happened to
     * reach. The rule check is the same `checkEnvValue` the preview and the deploy request use, so
     * a value the wizard refused cannot be stored through this route either.
     */
    const fieldErrors: NonNullable<EnvPlan['fieldErrors']> = [];
    for (const [name, value] of Object.entries(values)) {
      const variable = vars.get(name);
      if (variable === undefined) {
        fieldErrors.push({
          field: name,
          code: 'unrecognized_key',
          message: 'Not declared in the environment schema.',
        });
        continue;
      }
      if (variable.override_ceiling === 'none') {
        fieldErrors.push({
          field: name,
          code: 'ceiling',
          message: 'The override ceiling is none.',
        });
        continue;
      }
      const violation = checkEnvValue(toSchemaVar(variable), value);
      if (violation !== null) {
        fieldErrors.push({ field: name, code: violation.code, message: violation.message });
      }
    }
    if (fieldErrors.length > 0) {
      throw new AppError({
        code: 'VALIDATION_FAILED',
        status: 422,
        detail: `The environment change was refused by the declaration for ${row.entry_key}.`,
        fieldErrors,
        remediation: 'Fix the flagged variables; nothing was stored.',
      });
    }

    await withTransaction(this.pool, async (tx) => {
      await this.audit.lockChain(tx);
      for (const [name, value] of Object.entries(values)) {
        const variable = vars.get(name);
        // The pre-pass above proved these; a missing one here would be a defect, not a user error.
        if (variable === undefined)
          throw new Error(`"${name}" was not declared by ${row.entry_key}`);

        // `tx`, not `this.pool`: a second client would be a second connection held while this
        // transaction already holds one, and ten concurrent updates deadlocked the pool. It would
        // also read outside this transaction's snapshot, so a name written earlier in the loop
        // could still report the pre-update value.
        const previous = await tx.query<{ value_enc: Buffer | null }>(
          `SELECT value_enc FROM instance_env_value WHERE instance_id = $1 AND var_name = $2`,
          [instanceId, name],
        );
        const previousValue = previous.rows[0]?.value_enc?.toString('utf8') ?? null;
        if (previousValue !== value) {
          diff.push({
            name,
            from: previousValue,
            to: variable.secret ? null : value,
            requiresRecreate: RECREATE.has(name),
          });
          if (RECREATE.has(name)) requiresRecreate = true;
        }

        if (variable.secret) {
          // `tx` is passed so the secret write joins this transaction. Opening a second one would
          // wait on the chain lock this transaction already holds, and only the statement timeout
          // would end the wait.
          const secret = await this.secrets.put('instance', instanceId, name, value, tx);
          await this.upsertValue(tx, instanceId, name, 'secret', null, secret.id);
        } else {
          await this.upsertValue(
            tx,
            instanceId,
            name,
            'instance',
            Buffer.from(value, 'utf8'),
            null,
          );
        }
      }

      await this.audit.append(
        {
          action: 'instance.env.updated',
          actorType: 'user',
          actorId,
          targetType: 'instance',
          targetId: instanceId,
          outcome: 'success',
          detail: { changed: diff.map((entry) => entry.name), requiresRecreate },
        },
        tx,
      );
    });

    return {
      diff,
      requiresRecreate,
      // Render and apply belong to Phase 4A: the values are persisted, the containers are not
      // restarted, and the response says so rather than implying a deployment happened.
      applied: false,
      note: 'Stored. Render and apply run in Phase 4A; a redeploy is required for the containers to see these values.',
    };
  }

  /**
   * AD-09 — project `catalog/env/<KEY>.json` into `env_schema_var`.
   *
   * One file is applied whole or not at all. Three conflicts are refused instead of forced, because
   * each would turn a repository edit into a broken deployment:
   *   - removing a variable that a live instance still stores a value for (the next redeploy would
   *     resolve a name the container reads but the platform no longer declares);
   *   - lowering a ceiling under a value that was set at the level being removed (the next `plan()`
   *     would fail with a `ceiling` error against a file nobody edited);
   *   - adding or tightening a `rule` under a stored value it refuses (the next `plan()` would fail
   *     for an instance, with no edit to blame).
   *
   * Refusing the whole file — rather than the individual variable — keeps the projection an exact
   * image of the file: a projection that half-matches is drift an operator cannot see.
   */
  async applySchemas(input: {
    schemas: readonly EnvSchemaFile[];
    revision: string;
    actorId: string;
    actorType?: 'user' | 'service' | 'system';
  }): Promise<ReloadEnvironmentResult> {
    const totals: ReloadEnvironmentResult = {
      added: 0,
      changed: 0,
      removed: 0,
      refused: [],
      applied: [],
    };

    for (const file of input.schemas) {
      const entryKey = file.entryKey;
      const projected = await this.pool.query(`SELECT 1 FROM catalog_entry WHERE key = $1`, [
        entryKey,
      ]);
      if (projected.rowCount === 0) {
        totals.refused.push({
          key: entryKey,
          name: null,
          reason: `no catalog entry "${entryKey}" is projected; repair catalog/${entryKey}.json first`,
        });
        continue;
      }

      const current = new Map((await this.vars(entryKey)).map((row) => [row.name, row]));
      const declared = new Map(file.variables.map((variable) => [variable.name, variable]));
      const removedNames = [...current.keys()].filter((name) => !declared.has(name)).sort();

      const conflicts = await this.conflicts(entryKey, declared, current, removedNames);
      if (conflicts.length > 0) {
        for (const conflict of conflicts) totals.refused.push({ key: entryKey, ...conflict });
        continue;
      }

      const added = file.variables.filter((variable) => !current.has(variable.name)).length;
      const changed = file.variables.filter((variable) => {
        const before = current.get(variable.name);
        return before !== undefined && differs(before, variable);
      }).length;
      const removed = removedNames.length;
      const contentHash = hashVariables(file.variables);

      totals.added += added;
      totals.changed += changed;
      totals.removed += removed;
      if (added + changed + removed > 0)
        totals.applied.push({ key: entryKey, added, changed, removed });

      // A reload that changed nothing must not write an audit record: "I re-read and nothing moved"
      // is the common case, and a chain full of no-ops hides the records that matter. A known hash
      // with a delta is *not* skipped — that means the projection was changed out of band and this
      // reload is the repair.
      const known = await this.pool.query(
        `SELECT 1 FROM env_schema_revision WHERE entry_key = $1 AND content_hash = $2`,
        [entryKey, contentHash],
      );
      if ((known.rowCount ?? 0) > 0 && added + changed + removed === 0) continue;

      await withTransaction(this.pool, async (tx) => {
        await this.audit.lockChain(tx);
        const revision = await tx.query<{ id: string }>(
          `INSERT INTO env_schema_revision (entry_key, git_sha, content_hash, variables)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (entry_key, git_sha) DO UPDATE SET content_hash = env_schema_revision.content_hash
           RETURNING id`,
          [entryKey, input.revision, contentHash, JSON.stringify(file.variables)],
        );
        const revisionId = revision.rows[0]?.id;
        if (revisionId === undefined) {
          throw new AppError({
            code: 'INTERNAL_ERROR',
            detail: `The environment schema revision for ${entryKey} could not be recorded.`,
            remediation: 'Retry the reload; the projection was not changed by this attempt.',
          });
        }

        for (const variable of file.variables) {
          await tx.query(
            `INSERT INTO env_schema_var
               (entry_key, name, type, required, default_value, constraint_text, conditional, secret,
                override_ceiling, purpose, options, schema_revision_id, validation_rule)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             ON CONFLICT (entry_key, name) DO UPDATE
                SET type = EXCLUDED.type,
                    required = EXCLUDED.required,
                    default_value = EXCLUDED.default_value,
                    constraint_text = EXCLUDED.constraint_text,
                    conditional = EXCLUDED.conditional,
                    secret = EXCLUDED.secret,
                    override_ceiling = EXCLUDED.override_ceiling,
                    purpose = EXCLUDED.purpose,
                    options = EXCLUDED.options,
                    schema_revision_id = EXCLUDED.schema_revision_id,
                    validation_rule = EXCLUDED.validation_rule`,
            [
              entryKey,
              variable.name,
              variable.type,
              variable.required,
              variable.defaultValue,
              variable.constraint,
              variable.conditional,
              variable.secret,
              variable.overrideCeiling,
              variable.purpose,
              variable.options ?? null,
              revisionId,
              variable.rule === undefined ? null : JSON.stringify(variable.rule),
            ],
          );
        }

        if (removedNames.length > 0) {
          await tx.query(
            `DELETE FROM env_schema_var WHERE entry_key = $1 AND name = ANY($2::text[])`,
            [entryKey, removedNames],
          );
        }

        await this.audit.append(
          {
            action: 'catalog.env.schema.applied',
            actorType: input.actorType ?? 'user',
            actorId: input.actorId,
            targetType: 'catalog_entry',
            targetId: entryKey,
            outcome: 'success',
            detail: {
              added,
              changed,
              removed,
              contentHash,
              revision: input.revision,
              removedNames,
            },
          },
          tx,
        );
      });
    }

    return totals;
  }

  /** Every reason this file may not be applied. Empty means it is safe to project. */
  private async conflicts(
    entryKey: string,
    declared: ReadonlyMap<string, EnvSchemaVar>,
    current: ReadonlyMap<string, VarRow>,
    removedNames: readonly string[],
  ): Promise<{ name: string | null; reason: string }[]> {
    const found: { name: string | null; reason: string }[] = [];

    if (removedNames.length > 0) {
      const rows = await this.pool.query<{ var_name: string; slug: string }>(
        `SELECT iv.var_name, i.slug
           FROM instance_env_value iv
           JOIN instance i ON i.id = iv.instance_id
          WHERE i.entry_key = $1 AND i.deleted_at IS NULL AND iv.var_name = ANY($2::text[])
          ORDER BY i.slug`,
        [entryKey, removedNames],
      );
      for (const row of rows.rows) {
        found.push({
          name: row.var_name,
          reason: `instance ${row.slug} stores a value for this variable; clear it before the declaration is removed`,
        });
      }
    }

    for (const [name, variable] of declared) {
      const before = current.get(name);
      if (before === undefined) continue;
      if (ceilingRank(before.override_ceiling) <= ceilingRank(variable.overrideCeiling)) continue;

      const rows = await this.pool.query<{ slug: string }>(
        `SELECT i.slug
           FROM instance_env_value iv
           JOIN instance i ON i.id = iv.instance_id
          WHERE i.entry_key = $1 AND i.deleted_at IS NULL AND iv.var_name = $2
            AND iv.source IN ('instance', 'secret')
          ORDER BY i.slug`,
        [entryKey, name],
      );
      if ((rows.rowCount ?? 0) > 0) {
        found.push({
          name,
          reason: `instances ${rows.rows.map((row) => row.slug).join(', ')} set this variable above the new ceiling "${variable.overrideCeiling}"`,
        });
      }
    }

    /**
     * A rule added or tightened under a value that is already stored.
     *
     * The other two conflicts are the same shape: the file would break a live instance, so the file
     * is refused rather than applied. A value the new rule refuses is exactly that — `plan()` now
     * reports it, so the next redeploy of that instance would fail at the preview with no edit to
     * blame. The operator clears the value or relaxes the rule first.
     *
     * Secrets are not checked: reading them means decrypting, and a catalog reload must not write
     * `secret.read` records (or hold plaintext) for every credential in the estate. A secret that
     * predates a rule is still caught by `plan()` on the next deploy, which resolves the real value.
     */
    for (const [name, variable] of declared) {
      if (variable.rule === undefined) continue;
      const rows = await this.pool.query<{ slug: string; value: string }>(
        `SELECT i.slug, convert_from(iv.value_enc, 'UTF8') AS value
           FROM instance_env_value iv
           JOIN instance i ON i.id = iv.instance_id
          WHERE i.entry_key = $1 AND i.deleted_at IS NULL AND iv.var_name = $2
            AND iv.value_enc IS NOT NULL
          ORDER BY i.slug`,
        [entryKey, name],
      );
      for (const row of rows.rows) {
        const violation = checkEnvValue(variable, row.value);
        if (violation === null) continue;
        found.push({
          name,
          reason: `instance ${row.slug} stores a value the new rule refuses (${violation.code}); clear the value or relax the rule`,
        });
      }
    }

    return found;
  }

  private async upsertValue(
    tx: PoolClient,
    instanceId: string,
    name: string,
    source: 'instance' | 'secret',
    valueEnc: Buffer | null,
    secretRef: string | null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO instance_env_value (instance_id, var_name, source, value_enc, secret_ref, resolved_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (instance_id, var_name) DO UPDATE
          SET source = EXCLUDED.source, value_enc = EXCLUDED.value_enc,
              secret_ref = EXCLUDED.secret_ref, resolved_at = now()`,
      [instanceId, name, source, valueEnc, secretRef],
    );
  }

  private async vars(entryKey: string): Promise<VarRow[]> {
    const result = await this.pool.query<VarRow>(
      `SELECT name, type, required, default_value, constraint_text, conditional, secret, override_ceiling,
              purpose, options, validation_rule
         FROM env_schema_var WHERE entry_key = $1 ORDER BY name`,
      [entryKey],
    );
    return result.rows;
  }

  /** The newest repository revision this entry's projection came from, or `null` before a reload. */
  private async schemaRevision(entryKey: string): Promise<string | null> {
    const result = await this.pool.query<{ git_sha: string }>(
      `SELECT git_sha FROM env_schema_revision
        WHERE entry_key = $1 ORDER BY loaded_at DESC, id DESC LIMIT 1`,
      [entryKey],
    );
    return result.rows[0]?.git_sha ?? null;
  }

  private async assertEntryExists(entryKey: string): Promise<void> {
    const exists = await this.pool.query(`SELECT 1 FROM catalog_entry WHERE key = $1`, [entryKey]);
    if (exists.rowCount === 0) throw notFound(entryKey);
  }

  /**
   * A profile that does not exist is **not** an error: a caller that names one the host has never
   * seen would otherwise get an environment resolved from nothing, or a hard failure on a host whose
   * profiles are named differently. The plan reports the profile it actually used, and `deploy`
   * stores that same key, so the answer cannot disagree with the instance.
   */
  private async resolveProfile(requested: string | undefined): Promise<string> {
    if (requested !== undefined) {
      const exists = await this.pool.query(`SELECT 1 FROM env_profile WHERE key = $1`, [requested]);
      if ((exists.rowCount ?? 0) > 0) return requested;
    }
    return this.defaultProfile();
  }

  private async defaultProfile(): Promise<string> {
    const result = await this.pool.query<{ key: string }>(
      `SELECT key FROM env_profile ORDER BY key LIMIT 1`,
    );
    return result.rows[0]?.key ?? 'default';
  }
}

/** Variables whose change requires a recreated container rather than a restart (AC-28). */
const RECREATE = new Set(['PUBLIC_URL', 'MAIL_HOST', 'DATABASE_URL', 'REDIS_URL']);

function toSchemaVar(row: VarRow): EnvSchemaVar {
  return {
    name: row.name,
    purpose: row.purpose ?? row.name,
    type: row.type,
    required: row.required,
    defaultValue: row.default_value,
    constraint: row.constraint_text,
    // Served verbatim now: the file knows *when* a variable is required, and the API inventing the
    // same English sentence for every row was neither true nor translatable.
    conditional: row.conditional,
    secret: row.secret,
    overrideCeiling: row.override_ceiling,
    ...(row.options === null ? {} : { options: row.options }),
    // `null` (a projection from before rules existed) must not become `{}`, which would say "a rule
    // exists and it constrains nothing".
    ...(row.validation_rule === null ? {} : { rule: row.validation_rule }),
  };
}

/** `none` < `profile_only` < `profile_and_instance`: a downgrade narrows who may set a value. */
function ceilingRank(ceiling: VarRow['override_ceiling']): number {
  return ceiling === 'none' ? 0 : ceiling === 'profile_only' ? 1 : 2;
}

/** Every projected field a file can change. `options` is compared order-insensitively. */
function differs(before: VarRow, after: EnvSchemaVar): boolean {
  return (
    before.type !== after.type ||
    before.required !== after.required ||
    before.default_value !== after.defaultValue ||
    before.constraint_text !== after.constraint ||
    before.conditional !== after.conditional ||
    before.secret !== after.secret ||
    before.override_ceiling !== after.overrideCeiling ||
    (before.purpose ?? '') !== after.purpose ||
    !sameOptions(before.options, after.options) ||
    // Compared as a tuple, not as JSON text: two files that declare the same rule with the keys in a
    // different order are the same rule, and reporting them as a change would rewrite the revision
    // for a formatting edit.
    ruleFingerprint(before.validation_rule) !== ruleFingerprint(after.rule)
  );
}

function sameOptions(
  before: readonly string[] | null,
  after: readonly string[] | undefined,
): boolean {
  const left = [...(before ?? [])].sort();
  const right = [...(after ?? [])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Content address of the declaration, independent of formatting and declaration order: the loader
 * hashes the parsed file too, so re-indenting must not look like a change.
 */
function hashVariables(variables: readonly EnvSchemaVar[]): string {
  const normalized = [...variables]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((variable) => ({
      name: variable.name,
      purpose: variable.purpose,
      type: variable.type,
      required: variable.required,
      defaultValue: variable.defaultValue,
      constraint: variable.constraint,
      conditional: variable.conditional,
      secret: variable.secret,
      overrideCeiling: variable.overrideCeiling,
      options: variable.options === undefined ? null : [...variable.options].sort(),
      // Part of the content address: tightening a rule is a declaration change, and a reload that
      // reported "nothing changed" while the enforceable constraint moved would hide a deployment
      // that can no longer be repeated.
      rule: ruleFingerprint(variable.rule),
    }));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function parseEnv(content: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('- ')) {
      const pair = trimmed.slice(2).trim();
      const [name, ...rest] = pair.split('=');
      if (name !== undefined && rest.length > 0)
        values.set(name.trim(), stripQuotes(rest.join('=').trim()));
      continue;
    }
    const [name, ...rest] = trimmed.split('=');
    if (name === undefined || rest.length === 0) continue;
    values.set(name.trim(), stripQuotes(rest.join('=').trim()));
  }
  return values;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function notFound(key: string): AppError {
  return new AppError({
    code: 'NOT_FOUND',
    detail: `No environment definition for ${key}.`,
    remediation: 'Reload the catalog repository and check the entry key.',
  });
}

export type { Queryable };

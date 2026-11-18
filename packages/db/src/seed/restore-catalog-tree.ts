import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '../client';
import { loadRootEnv } from '../env';
import {
  DEFAULT_PRODUCT_KEYS,
  applyDefaultCatalogPlan,
  catalogRepoRoot,
  planDefaultCatalog,
  requireCompleteDefaultSet,
} from './default-catalog';

/**
 * `pnpm catalog:restore` — write the default working tree back when only its projection survived.
 *
 * The two halves of the catalogue live in different places: the rows are in PostgreSQL's volume, the
 * documents are in `SEAMNEX_CATALOG_REPO_PATH`, which is a directory under `temp/`. Deleting `temp/`
 * (or cloning over it, or moving the checkout) therefore keeps the projection and loses the tree, and
 * the two steps that could repair it both refuse by design:
 *
 *   - `pnpm db:seed` writes the default set only into an *empty* projection, because a seed that
 *     topped up a configured catalogue would be a second author of the operator's rows;
 *   - `pnpm catalog:project` stops with `no catalogue working tree … while N catalog entries are
 *     projected`, because exiting `0` there is how an empty environment ships unnoticed.
 *
 * The result was a `pnpm dev` that could not be recovered by any documented command: the projector
 * said restoring the tree "is a deliberate step, not a retry" and named no step. This is that step.
 *
 * It is deliberately narrow. The tree is written back only when the two halves provably belong
 * together — `<root>/catalog/` is absent *and* `catalog_entry` holds exactly `DEFAULT_PRODUCT_KEYS`,
 * i.e. the projection is the one the seed itself made from the vendored documents. Any other key set
 * came from somewhere this repository cannot reconstruct (an operator's checkout, a reload of a tree
 * that is now gone), and inventing six documents beside rows the tree would not declare is the
 * hazard `default-catalog.ts` exists to prevent. Those cases are refused with the keys that do not
 * line up, so the answer is "restore from a backup or a checkout", not a guess.
 *
 * Exit codes: `0` = tree restored, already present, or nothing projected to restore for; `1` =
 * anything an operator has to look at (a projection this command must not touch, an incomplete
 * checkout, no database).
 */
export type TreeRestoreDecision = {
  /** Whether the default tree may be written. `false` means the run ends with `code`. */
  readonly restore: boolean;
  readonly code: 0 | 1;
  readonly lines: readonly string[];
};

/**
 * What to do with the projection and the tree as they were read.
 *
 * Split from the process that acts on it for the same reason `catalog-projection.ts` is: the
 * interesting failure is not "does `pg` connect", it is "is this projection the default set", and
 * that question is answerable without a database.
 */
export function decideTreeRestore(input: {
  readonly root: string;
  /** Whether `<root>/catalog` exists — the loader's own definition of an absent tree. */
  readonly catalogPresent: boolean;
  readonly projectedKeys: readonly string[];
}): TreeRestoreDecision {
  const { root, catalogPresent, projectedKeys } = input;

  /*
   * A tree that is there is the operator's, even an empty `catalog/`: `pnpm catalog:project` reads
   * it and reports what it does or does not declare. Writing beside it is the one thing this command
   * must never do.
   */
  if (catalogPresent) {
    return {
      restore: false,
      code: 0,
      lines: [
        `${root}/catalog is present; the working tree is not the half that is missing`,
        '  `pnpm catalog:project` reads it, and `pnpm dev` runs that step',
      ],
    };
  }

  /*
   * Nothing projected means nothing to reconstruct *for*: the seed writes both halves into an empty
   * projection, and it refuses only because rows already exist. A restore here would leave a tree no
   * row refers to, which the next reload reads as six deletions.
   */
  if (projectedKeys.length === 0) {
    return {
      restore: false,
      code: 0,
      lines: [
        `no catalog entries are projected, so there is nothing for ${root} to be the tree of`,
        '  `pnpm db:seed` writes the default set into an empty projection',
      ],
    };
  }

  const projected = new Set(projectedKeys);
  const missing = DEFAULT_PRODUCT_KEYS.filter((key) => !projected.has(key));
  const unexpected = projectedKeys.filter(
    (key) => !(DEFAULT_PRODUCT_KEYS as readonly string[]).includes(key),
  );

  if (missing.length > 0 || unexpected.length > 0) {
    return {
      restore: false,
      code: 1,
      lines: [
        `${projectedKeys.length} entries are projected but they are not the default set; nothing was written`,
        `  default keys the projection lacks: ${missing.join(', ') || '(none)'}`,
        `  projected keys no vendored document declares: ${unexpected.join(', ') || '(none)'}`,
        '  those rows came from a tree this repository cannot reproduce: restore it from its own source',
        '  (a checkout or a backup), then run `pnpm catalog:project`',
      ],
    };
  }

  return {
    restore: true,
    code: 0,
    lines: [
      `${projectedKeys.length} projected entries are exactly the default set; writing the tree back from the vendored documents`,
    ],
  };
}

function log(line: string): void {
  console.log(`[catalog] ${line}`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function restore(): Promise<number> {
  loadRootEnv();

  const root = catalogRepoRoot(process.env.SEAMNEX_CATALOG_REPO_PATH);
  log(`root ${root}`);

  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.length === 0) {
    console.error(
      '[catalog] DATABASE_URL is required to read the projection this tree belongs to.',
    );
    return 1;
  }

  const pool = createPool({
    connectionString,
    max: 1,
    applicationName: 'seamnex-catalog-restore',
  });

  try {
    const projected = await pool.query<{ key: string }>(
      `SELECT key FROM catalog_entry ORDER BY key`,
    );
    const decision = decideTreeRestore({
      root,
      catalogPresent: existsSync(join(root, 'catalog')),
      projectedKeys: projected.rows.map((row) => row.key),
    });

    for (const line of decision.lines) log(line);
    if (!decision.restore) return decision.code;

    const plan = planDefaultCatalog({ root });
    // Before anything is written: a checkout missing a vendored document or a declaration is a
    // broken build, and half a default set is indistinguishable from a complete one on disk.
    requireCompleteDefaultSet(plan);

    const written = applyDefaultCatalogPlan(plan);
    const expected = plan.entries.length + plan.environments.length;
    log(`${written.length} of ${expected} file(s) written; existing files are never replaced`);
    /*
     * The declarations are files at this point, not rows: `env_schema_var` is written by
     * `applySchemas` alone. Naming the step is the difference between a repaired host and a reader
     * who assumes the restore also projected.
     */
    log(
      'the tree is back; run `pnpm catalog:project` to project the declarations (`pnpm dev` does)',
    );
    return 0;
  } catch (error) {
    // One actionable line, not a stack: every failure here is "the tree cannot be written" or "the
    // database is unreachable", and both are operator problems.
    console.error(`[catalog] ${messageOf(error)}`);
    return 1;
  } finally {
    await pool.end();
  }
}

void restore().then((code) => {
  process.exitCode = code;
});

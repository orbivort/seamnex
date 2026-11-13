import type { ReloadEnvironmentResult } from '@seamnex/domain';
import type { CatalogWorkingTree } from '../modules/m22-catalog-repository/catalog-repo.contract';

/**
 * The bootstrap projection's *decision*, split from the process that carries it out.
 *
 * `scripts/project-catalog.ts` boots the module graph, reads the tree and calls `applySchemas`; what
 * it does with each of those results is decided here, without a container, a database or a test
 * double. That split is deliberate: the interesting failures of a startup step are not "does Nest
 * wire up", they are "the tree is absent while a projection exists", "a file the loader refuses was
 * read anyway", and "the run says it succeeded while nothing was applied".
 */
export type ProjectionDecision = {
  /** Whether `applySchemas` may run at all. `false` means the run ends with `code`. */
  readonly apply: boolean;
  readonly code: 0 | 1;
  readonly lines: readonly string[];
};

/**
 * What to do with one read of the working tree.
 *
 * `code` is `1` for every state an operator has to look at, and `0` only for "there is genuinely
 * nothing to project". A bootstrap step that exits `0` after projecting nothing is how the
 * environment schema stayed empty without anyone noticing.
 */
export function decideProjection(input: {
  readonly root: string;
  readonly tree: CatalogWorkingTree;
  /** Rows in `catalog_entry`, read before this decision: the evidence a tree is *expected*. */
  readonly projectedEntries: number;
}): ProjectionDecision {
  const { root, tree, projectedEntries } = input;

  /*
   * A file that exists and failed validation is not an absent file (the loader's own contract says
   * so). Projecting the rest would leave the projection silently short of what the tree declares, so
   * the run stops and names every artefact instead.
   */
  if (tree.invalid.length > 0) {
    return {
      apply: false,
      code: 1,
      lines: [
        `${tree.invalid.length} artefact(s) in ${root} failed validation; nothing was projected`,
        ...tree.invalid.map(
          (artefact) =>
            `  ${artefact.path} (${artefact.scope} ${String(artefact.key)}): ${artefact.reason}`,
        ),
      ],
    };
  }

  /*
   * `revision: 'absent'` means `<root>/catalog` was not there. With entries already projected there
   * are two causes and both need a human: the seed resolved one root and this process resolved
   * another, or the tree was deleted while the projection survived. Saying "nothing to project"
   * would hide either behind a green exit code. With no entries it is simply a stack nobody has
   * defaulted yet.
   */
  if (tree.revision === 'absent') {
    return projectedEntries === 0
      ? {
          apply: false,
          code: 0,
          lines: [`no catalogue working tree at ${root}; nothing to project`],
        }
      : {
          apply: false,
          code: 1,
          lines: [
            `no catalogue working tree at ${root} while ${projectedEntries} catalog entries are projected`,
            '  either the seed and this process resolved different roots, or the tree was removed while the projection stayed',
            '  the seed only writes into an empty projection, so restoring it is a deliberate step, not a retry',
          ],
        };
  }

  /*
   * Entries in the tree, none in the database. `applySchemas` would refuse every declaration with
   * "no catalog entry … is projected; repair catalog/<KEY>.json first" — advice for a *missing
   * document*, when here the documents are fine and nothing has projected them. The projector does
   * not project entries (M01's job), so the run has to stop and say which step is actually missing.
   */
  if (projectedEntries === 0 && tree.documents.length > 0) {
    return {
      apply: false,
      code: 1,
      lines: [
        `${tree.revision}: the tree declares ${tree.documents.length} entries but none are projected`,
        '  project them first: `pnpm db:seed` does it for the default set when catalog_entry is empty,',
        '  `POST /catalog/reload` does it for a full tree and needs the API up with an R1 session',
        '  declarations cannot be applied to an entry that is not projected',
      ],
    };
  }

  if (tree.envSchemas.length === 0) {
    return {
      apply: false,
      code: 0,
      lines: [
        `${tree.revision}: ${tree.documents.length} entries, no environment declarations — nothing to project`,
      ],
    };
  }

  return {
    apply: true,
    code: 0,
    lines: [
      `${tree.revision}: ${tree.documents.length} entries, ${tree.envSchemas.length} environment declarations`,
    ],
  };
}

/** The `code` a Node system error carries (`ECONNREFUSED`), or `null` when it has none. */
function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

/**
 * One line an operator can act on.
 *
 * A pool that cannot reach PostgreSQL rejects with an `AggregateError` whose own `message` is empty —
 * one nested error per address it tried — so `error.message` alone printed a blank line and the
 * startup step looked like a crash with no cause. Reading the nested messages and the `code` is the
 * difference between "paste this into a search" and "re-run and hope".
 */
export function describeFailure(error: unknown): string {
  if (error instanceof AggregateError) {
    const code = codeOf(error);
    const headline = error.message.length > 0 ? error.message : 'aggregate failure';
    const parts = error.errors.map((inner) => describeFailure(inner));
    return [`${headline}${code === null ? '' : ` (${code})`}`, ...parts].join('; ');
  }

  if (error instanceof Error) {
    const code = codeOf(error);
    return `${error.message.length > 0 ? error.message : error.name}${code === null ? '' : ` (${code})`}`;
  }

  return String(error);
}

/**
 * The receipt of one `applySchemas` call.
 *
 * A refusal is a failure of the run, not a warning: `applySchemas` refuses a whole file when applying
 * it would break a running instance, so the projection is now *behind* the tree and the next deploy
 * of that product would plan against the stale declaration.
 */
export function projectionReceipt(result: ReloadEnvironmentResult): {
  readonly code: 0 | 1;
  readonly lines: readonly string[];
} {
  const lines: string[] = [];

  for (const applied of result.applied) {
    lines.push(
      `  ${applied.key}: ${applied.added} added, ${applied.changed} changed, ${applied.removed} removed`,
    );
  }

  if (result.applied.length === 0 && result.refused.length === 0) {
    lines.push('  already current: 0 added, 0 changed, 0 removed');
  }

  for (const refused of result.refused) {
    lines.push(
      `  refused ${refused.key}${refused.name === null ? '' : ` (${refused.name})`}: ${refused.reason}`,
    );
  }

  return { code: result.refused.length > 0 ? 1 : 0, lines };
}

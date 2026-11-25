/**
 * `pnpm catalog:restore` — removed in favour of a git checkout (ADR-BE-42 §11).
 *
 * The command wrote the vendored default set back when only its projection survived. It has nothing
 * to write now: the documents are deployable content in the catalogue repository, not files shipped
 * here. Keeping a working implementation would mean keeping a second copy of the catalogue in this
 * repository, which is the arrangement this change removes.
 *
 * It stays registered for one release and fails loudly, because a script that silently succeeds
 * while doing nothing is worse than one that says it moved.
 */
const REPLACEMENT = [
  '`catalog:restore` no longer exists: the catalogue is a checkout, not vendored content.',
  '',
  '  Fetch a tag from the configured source (the same server path the console uses):',
  '      pnpm catalog:sync --ref <tag>',
  '',
  '  On an air-gapped host, place a checkout in SEAMNEX_CATALOG_REPO_PATH instead:',
  '      git clone --depth 1 --branch <tag> <mirror-url> temp/catalog-repo',
  '',
  '  Then project the declarations:',
  '      pnpm catalog:project',
  '',
  'See docs/operations/catalog-repo-format.md.',
].join('\n');

console.error(`[catalog] ${REPLACEMENT}`);
process.exitCode = 1;

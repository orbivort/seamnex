/**
 * Formatting belongs to Prettier alone. The ESLint config carries no stylistic rule — its presets
 * are `js.configs.recommended` and `typescript-eslint`'s recommended set, neither of which formats
 * — so there is no overlap to arbitrate and `eslint-config-prettier` has nothing to switch off.
 * If `tseslint.configs.stylistic` is ever added, that package has to arrive in the same commit.
 *
 * Only the options that differ from Prettier 3's defaults are written down. `semi: true`,
 * `trailingComma: 'all'`, `arrowParens: 'always'`, `bracketSpacing: true` and `proseWrap:
 * 'preserve'` for Markdown were all restating the default, which reads as though the project had
 * chosen them and leaves two places to change if it ever does.
 *
 * @type {import('prettier').Config}
 */
export default {
  printWidth: 100,
  /**
   * Applies to CSS strings as well as JS: `singleQuote` is shared by Prettier's printers, so the
   * stylesheets' `@import './tokens.css'` stays single-quoted. That is consistent with
   * `stylelint-config-standard` v40, which no longer carries a string-quote rule at all.
   */
  singleQuote: true,
  /**
   * Prettier does not read `.editorconfig`, and the editor's `end_of_line` is advisory at best:
   * without this, a CRLF working copy reformats every file on the first `pnpm format`.
   */
  endOfLine: 'lf',
};

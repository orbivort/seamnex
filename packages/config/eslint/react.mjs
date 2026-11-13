import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/**
 * The design system's token layer only holds if nothing quietly routes around it. Stylelint
 * reads CSS, so it cannot see a class string in a `.tsx` file: these selectors are the only
 * gate that can.
 *
 * Each rule names the token to use instead, because "don't do that" is not a fix.
 */
const classStringSelectors = [
  {
    selector: String.raw`Literal[value=/text-\[(?:\d+(?:\.\d+)?)(?:px|rem)\]/]`,
    message:
      'Arbitrary font size. The type scale in @seamnex/ui/styles.css is text-micro / label / meta / body / body-lg / lead / heading / title-sm / title / metric / display — pick the role, not a pixel value.',
  },
  {
    selector: String.raw`TemplateElement[value.raw=/text-\[(?:\d+(?:\.\d+)?)(?:px|rem)\]/]`,
    message:
      'Arbitrary font size. The type scale in @seamnex/ui/styles.css is text-micro / label / meta / body / body-lg / lead / heading / title-sm / title / metric / display — pick the role, not a pixel value.',
  },
  {
    selector: String.raw`Literal[value=/(?:text|bg|border|ring|fill|stroke|outline|divide|from|to)-\[#[0-9a-fA-F]{3,8}\]/]`,
    message:
      'Hard-coded hex colour. Add the value to @theme in @seamnex/ui/styles.css (or use an existing status/surface token) and apply its utility, so dark mode and forced-colours can reach it.',
  },
  {
    selector: String.raw`TemplateElement[value.raw=/(?:text|bg|border|ring|fill|stroke|outline|divide|from|to)-\[#[0-9a-fA-F]{3,8}\]/]`,
    message:
      'Hard-coded hex colour. Add the value to @theme in @seamnex/ui/styles.css (or use an existing status/surface token) and apply its utility, so dark mode and forced-colours can reach it.',
  },
  {
    selector: String.raw`Literal[value=/rounded-\[/]`,
    message:
      'Arbitrary radius. The scale is rounded-xs / sm / md / lg in @theme — extend it rather than bypassing it.',
  },
  {
    selector: String.raw`TemplateElement[value.raw=/rounded-\[/]`,
    message:
      'Arbitrary radius. The scale is rounded-xs / sm / md / lg in @theme — extend it rather than bypassing it.',
  },
];

/**
 * An array index used as a `key`. On a static list it is cosmetic; on a dynamic one React reuses
 * the DOM of whatever row previously held that position, and local state follows the wrong row.
 */
const indexKeySelector = {
  selector:
    'JSXAttribute[name.name="key"] > JSXExpressionContainer > Identifier[name=/^(index|i)$/]',
  message:
    'Array index as a React key. Use the row identifier so reordering cannot reuse the wrong element (a static placeholder list may use a literal key instead).',
};

/**
 * React preset: the SPAs and the shared packages, and nothing else.
 *
 * Deliberately scope-agnostic — no `files` key here. `eslint.config.mjs` decides which trees are
 * React, because a `files: ['**\/*.{ts,tsx}']` written here was silently applied to `apps/api`
 * and `packages/db` as well: the Hooks and a11y rules resolved on server files.
 *
 * The presets are extended rather than re-listed. `eslint-plugin-react-hooks` v7 ships the
 * React Compiler rule family (purity, immutability, refs, set-state-in-effect, …) and jsx-a11y
 * ships 34 rules; the previous hand-picked list carried 2 and 10 of them.
 */
export default [
  {
    ...reactHooks.configs.flat.recommended,
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      // The preset ships these three as `warn`. Every package runs `eslint --max-warnings=0`,
      // so a warning already fails the build while reading as advice; they are errors.
      'react-hooks/exhaustive-deps': 'error',
      'react-hooks/incompatible-library': 'error',
      'react-hooks/unsupported-syntax': 'error',
      'no-restricted-syntax': ['error', ...classStringSelectors, indexKeySelector],
    },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // `depth: 3` is the existing contract: `Dialog` and `Field` wrap the input two levels below
      // the label, so the preset's default depth of 2 reports a label that does have a control.
      'jsx-a11y/label-has-associated-control': ['error', { assert: 'either', depth: 3 }],
    },
  },
];

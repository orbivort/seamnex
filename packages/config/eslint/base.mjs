import js from '@eslint/js';
import n from 'eslint-plugin-n';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export const ignores = [
  '**/dist/**',
  // The demo build has its own output directory so it cannot be restored over `dist`, which
  // also means it needs its own ignore: linting a minified bundle is noise, not a finding.
  '**/dist-demo/**',
  '**/node_modules/**',
  '**/coverage/**',
  '**/temp/**',
  '**/.turbo/**',
  '**/public/mockServiceWorker.js',
  // Tooling metadata, not project source: the skills' own scripts are not part of the build and
  // linting them made `pnpm lint` red for reasons no contributor could act on. Every other agent
  // workspace `.gitignore` lists is here for that reason — several of them carry hook scripts.
  '**/.codex/**',
  '**/.claude/**',
  '**/.cursor/**',
  '**/.windsurf/**',
  '**/.continue/**',
  '**/.gemini/**',
  '**/.roo/**',
  '**/.kiro/**',
  '**/.openhands/**',
  '**/.specstory/**',
  '**/.codebuddy/**',
  '**/.trae/**',
  '**/.qoder/**',
];

/**
 * Every file that receives the TypeScript parser, the type-aware config and the TS rule overlay.
 *
 * `mts`/`cts` are here because ESLint treats them as JavaScript by default and fails to parse a
 * declaration file's `export type` — which is how `@seamnex/config/module-boundaries.d.mts` broke the
 * lint gate the moment it was added.
 */
export const TS = ['**/*.{ts,tsx,mts,cts}'];

/** Reaching into another package's source tree bypasses its entry point and its boundaries. */
export const deepImportPattern = {
  group: ['@seamnex/*/src/*', '../../packages/*/src/*'],
  message:
    'Import from a package entry point (for example "@seamnex/ui") instead of reaching into its source tree.',
};

export const sharedRules = {
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/no-non-null-assertion': 'error',
  // `verbatimModuleSyntax` is on, so an elided type import is a runtime import: the rule is a
  // correctness gate here, not a style preference.
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],
  // Errors, not warnings: a warning that nobody reads is a rule that is off, and
  // `eslint --max-warnings=0` in every package would only reintroduce the same failure later.
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  // `== null` stays legal: it is the one comparison that reads better than the `===` pair and
  // matches both `null` and `undefined` on purpose.
  eqeqeq: ['error', 'always', { null: 'ignore' }],
};

/**
 * Security rules (practice 6.1/6.15/6.17/6.19) and the built-in-module prefix (6.27).
 *
 * A curated set rather than the plugins' `recommended` bundles: their full sets include
 * `detect-object-injection` and `detect-non-literal-fs-filename`, which fire on essentially every
 * property access and every path built from configuration in this codebase. A rule that is always
 * suppressed trains reviewers to ignore the report, which is worse than not having it.
 *
 * `eslint-plugin-n` is curated for the same reason: `flat/recommended-module` resolves imports
 * with Node's algorithm, so every extensionless TypeScript import is reported as
 * `n/no-missing-import` (761 findings on the current tree) and the one real signal is buried.
 * The rules below are the ones that hold for a TypeScript codebase.
 */
export const securityRules = {
  'n/prefer-node-protocol': 'error',
  'n/no-deprecated-api': 'error',
  'security/detect-child-process': 'error',
  'security/detect-eval-with-expression': 'error',
  'security/detect-non-literal-require': 'error',
  'security/detect-unsafe-regex': 'error',
};

/**
 * Tests and build configs execute on Node even when the code under test runs in a browser:
 * `apps/console/test/unit/contract.test.ts` reads `process.cwd()` and `vite.config.ts` is a Node
 * module. Node globals are additive, so a jsdom test keeps whatever its tree declared.
 */
const NODE_TREES = [
  '**/*.test.{ts,tsx}',
  '**/test/**/*.{ts,tsx}',
  '**/vite.config.ts',
  '**/vitest.config.ts',
];

export default tseslint.config(
  { ignores },
  {
    // A stale `eslint-disable` is a rule somebody silenced for a reason that no longer exists.
    // Reporting it keeps the suppression comments honest (practice 3.1).
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  /*
   * Scoped to TypeScript on purpose. `typescript-eslint` sets its parser on an unscoped config,
   * which meant `scripts/*.mjs` were parsed as TypeScript while none of the TS rules applied to
   * them: a parse that can accept syntax the file's runtime rejects, for no benefit.
   *
   * Environment globals are also not declared here. Merging `browser` and `node` made every
   * frontend file accept `process`/`Buffer` and every backend file accept `document`/`window`;
   * each preset now declares the environment it actually runs in.
   */
  ...tseslint.configs.recommended.map((config) =>
    config.files === undefined ? { ...config, files: TS } : config,
  ),
  {
    files: TS,
    rules: {
      ...sharedRules,
      'no-restricted-imports': ['error', { patterns: [deepImportPattern] }],
    },
  },
  {
    files: NODE_TREES,
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.{ts,tsx,mjs,js,cjs}'],
    plugins: { n, security },
    rules: securityRules,
  },
);

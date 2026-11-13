import { fileURLToPath } from 'node:url';
import globals from 'globals';
import { deepImportPattern } from './base.mjs';
import explicitInject from './rules/explicit-inject.mjs';
import moduleBoundaries from './rules/module-boundaries.mjs';
import noMultiStatementQuery from './rules/no-multi-statement-parameterised-query.mjs';
import noPoolQueryInTransaction from './rules/no-pool-query-in-transaction.mjs';

/**
 * Node/TypeScript preset for the backend (ADR-BE-03).
 *
 * The module boundary is decided by `packages/config/module-boundaries.json`, through the same
 * predicate the boundary test in `apps/api` uses (`@seamnex/config/module-boundaries`). It used to be
 * generated into 23 `no-restricted-imports` blocks, which could only express "this directory is
 * forbidden" and therefore permitted the `*.module.ts` edges that the test forbade — two gates,
 * two answers, one of them red.
 *
 * Like the React preset this one carries no `files`-less rules: `base` is composed once, in
 * `eslint.config.mjs`, so `js.configs.recommended` and the TypeScript preset are not evaluated
 * twice for a file that is both.
 */

const BACKEND = ['apps/api/**/*.ts', 'packages/db/**/*.ts'];
const TYPE_AWARE = ['apps/api/**/*.ts'];
const SCRIPTS = ['scripts/**/*.mjs', '*.mjs'];

/**
 * The repo root, not `process.cwd()`. The project service resolves each file to its nearest
 * tsconfig, but `allowDefaultProject` and every reported path are relative to this, and a config
 * whose meaning depends on which directory the linter was started from is a config that caches
 * differently on CI than on a laptop.
 */
const TSCONFIG_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * ADR-BE-04: only @seamnex/db may talk to the driver directly. A *type* import is allowed —
 * `type { Pool } from 'pg'` carries no runtime dependency and is how a provider is typed.
 *
 * This lives in the core rule since typescript-eslint 8.64 deprecated its own copy of
 * `no-restricted-imports`; core gained `allowTypeImports`, and running both copies of one rule
 * over the same file is explicitly unsupported.
 */
const driverPattern = {
  group: ['pg', 'pg-*'],
  message: 'Import the pool from @seamnex/db. Modules use the injected pool, never the driver.',
  allowTypeImports: true,
};

const seamnexPlugin = {
  rules: {
    'explicit-inject': explicitInject,
    'module-boundaries': moduleBoundaries,
    // The two failure modes a query builder would have caught for free, kept as rules so the
    // dependency is not the only thing standing between a review and the same defect again.
    'no-multi-statement-parameterised-query': noMultiStatementQuery,
    'no-pool-query-in-transaction': noPoolQueryInTransaction,
  },
};

export default [
  {
    files: BACKEND,
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: TSCONFIG_ROOT,
      },
    },
    rules: {
      // A rejected promise that nobody awaits is how a job silently reports success.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // `eqeqeq` lives in `sharedRules`: the backend was its only consumer while the SPAs were
      // free to use `==`, which is the same bug in both trees.
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      // Core `no-process-exit` was deprecated when the Node rules left ESLint core; this is its
      // maintained replacement. The one legitimate caller is the role supervisor, which carries
      // its own suppression (apps/api/src/bootstrap/run-role.ts).
      'n/no-process-exit': 'error',
    },
  },
  {
    files: TYPE_AWARE,
    // The plugin object is shared by reference; ESLint only reads it. Registering it on the
    // backend block keeps the rule available to `packages/db` without applying it there.
    plugins: { seamnex: seamnexPlugin },
    rules: {
      'no-restricted-imports': ['error', { patterns: [deepImportPattern, driverPattern] }],
      // ADR-BE-03: the predicate is a no-op outside `src/modules`, so the whole package can carry
      // the rule and a new module directory cannot escape it by being new.
      'seamnex/module-boundaries': 'error',
      // ADR-BE-17: an undecorated constructor parameter resolves to `undefined` under tsx.
      'seamnex/explicit-inject': 'error',
      // Pool discipline: these two are the defects a query builder would have prevented, and they
      // are cheaper as rules than as a dependency. See each rule's header for the failure mode.
      'seamnex/no-pool-query-in-transaction': 'error',
      'seamnex/no-multi-statement-parameterised-query': 'error',
    },
  },
  {
    files: [...SCRIPTS, '**/*.mjs', '**/eslint/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.test.ts', '**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      /*
       * A test double promises a result without awaiting anything — `async () => ({ allow: true })`
       * is the honest shape for a stub, and rewriting it as `() => Promise.resolve(...)` changes
       * the signature without making the test better. The rule stays on for production code, where
       * an `async` with no `await` is a real smell.
       */
      '@typescript-eslint/require-await': 'off',
    },
  },
];

import { defineConfig } from 'vitest/config';

/**
 * The workspace project list, for local runs and for the editor's Vitest extension.
 *
 * CI does not use this file: `turbo run test` runs each package in its own directory, which is
 * what keeps one coverage report per package. What this adds is the other direction — Vitest 5 no
 * longer looks upward for a config, so without it a root invocation finds no tests at all.
 *
 * `pnpm test:workspace` runs every project here; `--project <name>` narrows to one. Note the v5
 * rule that `process.cwd()` stays at the invocation root for a multi-project run; tests that read
 * the filesystem resolve against both the package and the repository root for that reason.
 */
export default defineConfig({
  test: {
    projects: [
      'apps/api',
      'apps/console',
      'apps/portal',
      'packages/api-client',
      'packages/db',
      'packages/domain',
      'packages/shell',
      'packages/ui',
      'packages/utils',
    ],
  },
});

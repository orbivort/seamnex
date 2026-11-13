import { coverageConfigDefaults, type ViteUserConfig } from 'vitest/config';

/**
 * The coverage and hygiene policy every workspace package shares.
 *
 * Why it lives here: each `vitest.config.ts` used to restate the provider, the reporters, the
 * report directory and its own exclusion list. A user-supplied `coverage.exclude` replaces
 * Vitest's defaults rather than extending them, so five hand-written lists meant five chances to
 * silently drop declaration files (or `dist`) from the exclusion and start measuring generated
 * output. The spread in `coverageConfig` is the one place that keeps the defaults.
 *
 * This module is imported by tooling configs only; it must not import app code, so `@seamnex/config`
 * stays a leaf in the package graph.
 */

// `vitest/config` augments Vite's `UserConfig` with `test`, so the option types are reached
// through it rather than re-declared here.
type TestConfig = NonNullable<ViteUserConfig['test']>;
type Coverage = NonNullable<TestConfig['coverage']>;
type Thresholds = NonNullable<Coverage['thresholds']>;
type Reporters = NonNullable<Coverage['reporter']>;

/**
 * `json-summary` is the machine-readable report a PR comment or an upload step reads; `lcov` stays
 * for the artifact.
 *
 * `github-actions` belongs nowhere in this list: the V8 provider resolves a reporter name it does
 * not recognise as a package import, so listing it here fails every coverage run under CI with
 * `Cannot find package 'github-actions'`. It is a *test* reporter, and Vitest already appends it by
 * itself when `GITHUB_ACTIONS` is set — the only environment where its annotations mean anything.
 */
const COVERAGE_REPORTERS: Reporters = ['text', 'lcov', 'json-summary'];

export type CoverageOptions = {
  /** Source files to measure. Required: in v5 only loaded files are reported without it. */
  include: string[];
  /** Package-specific exclusions, appended to the shared list below. */
  exclude?: string[];
};

/**
 * The floor every measured file must clear on its own, on all four metrics.
 *
 * `perFile: true` with top-level numbers means both readings hold: the aggregate must clear 90 %
 * *and* every file must clear 90 % independently, so a well-covered subtree cannot carry an
 * untested module over the line. With `coverage.include` set, v5 reports every matched file even
 * when no test imports it — an unimported file is 0 % and fails here, which is the point: a new
 * source file is unmeasured until a test exercises it.
 *
 * There is deliberately no per-package override. A config that could lower a metric is a config
 * that eventually does, and the one place to change this policy is this constant.
 */
export const PER_FILE_COVERAGE_THRESHOLDS = {
  statements: 90,
  branches: 90,
  functions: 90,
  lines: 90,
  perFile: true,
} satisfies Thresholds;

/**
 * Exclusions that are never package-specific.
 *
 * Vitest 5 removed `coverage.all` and reports every file matched by `coverage.include`, and its
 * `coverageConfigDefaults.exclude` is empty — so a declaration file, a spec or a barrel of types
 * inside `src` is measured unless it is named here. The globs stay explicit rather than assumed.
 */
const BASE_EXCLUDES = [
  '**/*.d.ts',
  '**/*.{test,spec}.?(c|m)[jt]s?(x)',
  '**/__tests__/**',
  '**/node_modules/**',
];

export function coverageConfig({ include, exclude = [] }: CoverageOptions): Coverage {
  return {
    provider: 'v8',
    reporter: COVERAGE_REPORTERS,
    reportsDirectory: './coverage',
    include,
    exclude: [...coverageConfigDefaults.exclude, ...BASE_EXCLUDES, ...exclude],
    // A red suite must still produce the numbers CI uploads, otherwise a failure hides the reason.
    reportOnFailure: true,
    // Not optional: a package cannot be measured without being held to the floor.
    thresholds: PER_FILE_COVERAGE_THRESHOLDS,
  };
}

/**
 * Mock and timer hygiene, stated rather than inherited.
 *
 * `clearMocks` is the v5 default; `restoreMocks` is not, and the difference matters the first time
 * a test replaces an implementation with `vi.spyOn(...).mockImplementation()`. Neither has an
 * effect on a suite that uses no spies — which is the case here today: module mocks are replaced
 * by MSW handlers.
 */
export const testDefaults = {
  clearMocks: true,
  restoreMocks: true,
} satisfies TestConfig;

/**
 * Test-task gate.
 *
 * `turbo run test` reports success for a package that declares no `test` script: there is nothing
 * to run, so nothing fails. That is how `@seamnex/ui`, `@seamnex/shell`, `@seamnex/utils` and `@seamnex/api-client` —
 * the code both SPAs are built from — stayed outside the suite and outside every coverage report
 * without anyone noticing.
 *
 * The rule: a package that ships runtime source must declare `test` and `test:coverage`, and point
 * at a Vitest config. A package with nothing to test must say so here, with a reason.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());
const groups = ['apps', 'packages'];

/**
 * Packages that ship code but are exercised through another package's suite.
 *
 * `@seamnex/mocks` is the mock platform itself: its handlers are driven by every frontend test, so a
 * `test` task here would assert the fixtures rather than the code.
 */
const EXEMPT = new Map([['@seamnex/mocks', 'mock platform; exercised by the app suites']]);

const problems = [];

function packageDirs(group) {
  const base = resolve(root, group);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(base, entry.name))
    .filter((dir) => existsSync(resolve(dir, 'package.json')));
}

/** Runtime source: `.ts`/`.tsx` under `src`, excluding declarations and tests. */
function hasRuntimeSource(dir) {
  const src = resolve(dir, 'src');
  if (!existsSync(src)) return false;
  const stack = [src];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.d.ts')) continue;
      if (/\.(test|spec)\./.test(entry.name)) continue;
      return true;
    }
  }
  return false;
}

for (const group of groups) {
  for (const dir of packageDirs(group)) {
    const manifest = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    const name = manifest.name ?? relative(root, dir).replace(/\\/g, '/');
    if (EXEMPT.has(name)) continue;
    if (!existsSync(resolve(dir, 'src')) || !hasRuntimeSource(dir)) continue;

    const missing = [];
    if (manifest.scripts?.test === undefined) missing.push('`test` script');
    if (manifest.scripts?.['test:coverage'] === undefined) missing.push('`test:coverage` script');
    if (!existsSync(resolve(dir, 'vitest.config.ts'))) missing.push('`vitest.config.ts`');

    if (missing.length > 0) {
      problems.push(`${name}: no ${missing.join(', ')}`);
    }
  }
}

if (problems.length > 0) {
  console.error('Packages that ship source but cannot be tested:');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('\nAdd a Vitest config and both scripts, or record the exemption with a reason.');
  process.exitCode = 1;
} else {
  console.log('Every package that ships runtime source declares a test task.');
}

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadBoundaries, tablesByModule, type BoundaryManifest } from '@seamnex/db';
import { checkSpecifier } from '@seamnex/config/module-boundaries';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..', '..');
const apiSrc = join(apiRoot, 'src');
const modulesRoot = join(apiSrc, 'modules');

const manifest: BoundaryManifest = loadBoundaries();

/**
 * The cross-cutting mechanisms predate the module contracts: they are platform machinery, not a
 * product domain. Their tables are declared in the manifest (`runtime[]`) rather than in this file,
 * so the manifest remains the only place ownership is written down — and every directory under
 * `src` must appear, so a new one cannot avoid the rule by being new.
 */
const RUNTIME_OWNERSHIP: Record<
  string,
  Readonly<{ owns: readonly string[]; reads: readonly string[] }>
> = Object.fromEntries(
  manifest.runtime.map((entry) => [entry.dir, { owns: entry.owns, reads: entry.reads }]),
);
const sqlNode = statSync(join(apiRoot, 'package.json')).isFile();

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Deliverable 1.2, statically checkable half. The ESLint preset forbids the imports; this test
 * fails without a lint run, which is what CI needs when lint is skipped locally.
 */
describe('module boundaries', () => {
  it('has a contract file for every module in the manifest', () => {
    const missing = manifest.modules
      .filter(
        (module) =>
          !readdirSync(join(modulesRoot, module.dir)).some((file) => file.endsWith('.contract.ts')),
      )
      .map((module) => `${module.id} ${module.name}`);

    expect(missing, 'modules without a *.contract.ts interface file').toEqual([]);
  });

  /**
   * The same predicate the ESLint preset uses (`@seamnex/config/module-boundaries`). One rule, two
   * gates: a declared `mayImport` edge is fine through a `*.contract.ts` interface or the
   * `*.module.ts` composition edge, and reaching into a service, client or store is not.
   */
  it('only imports another module through its contract or module file', () => {
    const violations: string[] = [];

    for (const file of walk(modulesRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const specifier = match[1] ?? '';
        const verdict = checkSpecifier(file, specifier, manifest);
        if (verdict.ok) continue;
        violations.push(`${relative(apiRoot, file)} imports ${specifier} — ${verdict.reason}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps every §7.2 table owned by exactly one module', () => {
    const tables = tablesByModule(manifest);
    expect(tables.size).toBeGreaterThanOrEqual(70);

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const table of tables.keys()) {
      if (seen.has(table)) duplicates.push(table);
      seen.add(table);
    }
    expect(duplicates).toEqual([]);
  });

  it('allows the audit and secrets services to be used by every module', () => {
    // Cross-cutting by design (design §6.2): audit consumes events from everywhere, and every
    // module may write a secret through M15 rather than touching the table.
    expect(manifest.crossCutting).toContain('M15');
    expect(manifest.crossCutting).toContain('M17');
  });

  /**
   * The dynamic half of deliverable 1.2: a module's source must not name a table it neither owns
   * nor declares as readable. Import rules cannot see a table name inside a SQL string; this can.
   */
  it('never names a table outside its own ownership or declared reads', () => {
    const violations: string[] = [];

    for (const module of manifest.modules) {
      const dir = join(modulesRoot, module.dir);
      const allowed = new Set([...module.owns, ...module.reads, ...Object.keys(manifest.shared)]);
      for (const file of walk(dir)) {
        // Comments are prose ("Owns instance_status, ..."), so they are stripped before scanning.
        const source = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        for (const table of tablesByModule(manifest).keys()) {
          if (allowed.has(table)) continue;
          // Only SQL usage counts: an English sentence mentioning "instance" is not a violation,
          // `SELECT ... FROM instance` in the wrong module is.
          const sqlUse = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+${table}\\b`, 'i');
          if (sqlUse.test(source)) {
            violations.push(`${module.id} ${relative(apiRoot, file)} reads or writes ${table}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  /**
   * The reverse direction of the ownership check: a migration that creates a table nobody owns is
   * a table nobody governs. `integration_metadata` shipped that way — readable by four modules,
   * owned by none — and the manifest's own `$comment` says it cannot happen.
   */
  it('owns every table a migration creates', () => {
    const migrations = join(apiRoot, '..', '..', 'packages', 'db', 'migrations');
    const owned = new Set([...tablesByModule(manifest).keys(), ...Object.keys(manifest.shared)]);
    const orphans: string[] = [];

    for (const file of readdirSync(migrations).filter((name) => name.endsWith('.up.sql'))) {
      // Comments and quoted strings are prose or dynamic DDL (`CREATE TABLE IF NOT EXISTS %I ...`
      // inside a DO block). Matching them yields words like "IF" as table names.
      const source = readFileSync(join(migrations, file), 'utf8')
        .replace(/--.*$/gm, '')
        .replace(/'[^']*'/g, "''");
      for (const match of source.matchAll(
        /CREATE TABLE(?: IF NOT EXISTS)?\s+([a-z_][a-z0-9_]*)/gi,
      )) {
        const table = match[1] ?? '';
        // Partitions are created dynamically (`job_log_p20260101`) and own no boundary.
        if (/_p\d{6,8}$/.test(table)) continue;
        if (!owned.has(table)) orphans.push(`${table} (${file})`);
      }
    }

    expect(orphans, 'tables created by a migration but owned by no module').toEqual([]);
  });

  it('covers every runtime directory and forbids undeclared table access', () => {
    const declared = new Set([...Object.keys(RUNTIME_OWNERSHIP), 'modules']);
    const actual = readdirSync(apiSrc, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    const undeclared = actual.filter((dir) => !declared.has(dir));
    expect(undeclared, 'src directories without an ownership declaration').toEqual([]);

    const allTables = [...tablesByModule(manifest).keys()];
    const shared = new Set(Object.keys(manifest.shared));
    const violations: string[] = [];

    for (const [dir, entry] of Object.entries(RUNTIME_OWNERSHIP)) {
      const allowed = new Set([...entry.owns, ...entry.reads, ...shared]);
      for (const file of walk(join(apiSrc, dir))) {
        const source = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        for (const table of allTables) {
          if (allowed.has(table)) continue;
          const sqlUse = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\\s+${table}\\b`, 'i');
          if (sqlUse.test(source)) {
            violations.push(`${relative(apiRoot, file)} reads or writes ${table}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('sanity: the API package is the boundary root used by the manifest', () => {
    expect(sqlNode).toBe(true);
    expect(manifest.root).toBe('apps/api/src/modules');
  });
});

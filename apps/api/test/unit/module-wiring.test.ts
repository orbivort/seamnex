import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dependency graph, checked statically.
 *
 * Un-globalizing a module is a silent change: a token that used to resolve from anywhere now
 * resolves only where the module is imported, and nothing fails until the container is built — at
 * which point the role exits at boot with "Nest can't resolve dependencies". A live container test
 * would prove it, but it needs a Postgres and a Redis to satisfy the other providers.
 *
 * So the rule is checked where it is expressible: every `@Inject(TOKEN)` must be satisfied by a
 * module the injecting module actually imports, or by one that is genuinely global. This is a
 * static approximation — it does not evaluate `useFactory` conditionals — but it fails on exactly
 * the mistake un-globalizing invites.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(here, '..', '..');
const srcRoot = join(apiRoot, 'src');
const modulesRoot = join(srcRoot, 'modules');

/**
 * Global by design, and the whole list of them. Configuration and the four pieces of
 * infrastructure every one of the nine roles builds are cross-cutting; everything else states its
 * edges.
 */
const INTENTIONALLY_GLOBAL = new Set([
  'AuditModule',
  'ConfigModule',
  'DatabaseModule',
  'IdentityModule',
  'MetricsModule',
  'RedisModule',
]);

type ModuleMeta = {
  readonly className: string;
  readonly file: string;
  readonly dir: string;
  readonly isGlobal: boolean;
  readonly imports: readonly string[];
  readonly provides: readonly string[];
  readonly exports: readonly string[];
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** The bracketed array that follows `key:`, honouring nesting — `providers` contains objects. */
function extractArray(block: string, key: string): string[] {
  const match = new RegExp(`\\b${key}:\\s*\\[`).exec(block);
  if (match === null) return [];
  let depth = 0;
  const start = match.index + match[0].length - 1;
  for (let i = start; i < block.length; i += 1) {
    if (block[i] === '[') depth += 1;
    else if (block[i] === ']') {
      depth -= 1;
      if (depth === 0) return pluckNames(block.slice(start + 1, i));
    }
  }
  return [];
}

const STRATEGY_KEYS = new Set([
  'provide',
  'useClass',
  'useExisting',
  'useFactory',
  'useValue',
  'inject',
  'deps',
  'true',
  'false',
  'imports',
  'exports',
]);

/** The identifiers in an array literal, minus the object keys that name a strategy. */
function pluckNames(text: string): string[] {
  return [...text.matchAll(/[A-Za-z_$][\w$]*/g)]
    .map((match) => match[0])
    .filter((name) => !STRATEGY_KEYS.has(name));
}

function readModule(file: string): ModuleMeta | undefined {
  // Comments are prose — app.module's `providers` block names tokens it does not provide — so they
  // are stripped before anything is parsed as an identifier.
  const source = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const decoratorAt = source.indexOf('@Module(');
  if (decoratorAt < 0) return undefined;
  const classAt = source.indexOf('export class', decoratorAt);
  if (classAt < 0) return undefined;

  const block = source.slice(decoratorAt, classAt);
  const className = /export class (\w+)/.exec(source.slice(classAt))?.[1] ?? '';

  return {
    className,
    file,
    dir: dirname(file),
    // `@Global()` sits before `@Module(` and therefore outside `block`; one module per file.
    isGlobal: source.includes('@Global()'),
    imports: extractArray(block, 'imports'),
    provides: extractArray(block, 'providers'),
    exports: extractArray(block, 'exports'),
  };
}

const moduleFiles = [
  join(srcRoot, 'app.module.ts'),
  ...walk(srcRoot).filter((file) => file.endsWith('.module.ts')),
];

const modules = moduleFiles
  .map(readModule)
  .filter((entry): entry is ModuleMeta => entry !== undefined && entry.className.length > 0);

const byClass = new Map(modules.map((entry) => [entry.className, entry]));

/** Which module provides a token, and where that module lives. */
const providedBy = new Map<string, ModuleMeta>();
for (const entry of modules) {
  for (const name of entry.provides) if (!providedBy.has(name)) providedBy.set(name, entry);
}

const appModule = byClass.get('AppModule');

const moduleDirs = modules
  .filter((entry) => entry.dir.startsWith(modulesRoot))
  .sort((a, b) => b.dir.length - a.dir.length);

/** The module a source file belongs to; `undefined` means the root (`AppModule`) scope. */
function ownerOf(file: string): ModuleMeta | undefined {
  const dir = moduleDirs.find((candidate) => file.startsWith(candidate.dir));
  return dir;
}

function reachable(from: ModuleMeta): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current.className)) continue;
    seen.add(current.className);
    for (const name of current.imports) {
      const next = byClass.get(name);
      if (next !== undefined) queue.push(next);
    }
  }
  return seen;
}

/** What a root-scope file may see: everything `AppModule` imports. */
const rootVisibility = appModule === undefined ? new Set<string>() : reachable(appModule);

describe('module wiring', () => {
  it('finds every module file', () => {
    // A parser that silently matches nothing would make the rest of this file vacuous.
    expect(modules.length).toBeGreaterThanOrEqual(20);
    expect(appModule).toBeDefined();
  });

  it('has no @Global() outside the infrastructure set', () => {
    const globals = modules.filter((entry) => entry.isGlobal).map((entry) => entry.className);
    expect(globals.sort()).toEqual([...INTENTIONALLY_GLOBAL].sort());
  });

  it('resolves every injected token from a declared import', () => {
    const violations: string[] = [];

    for (const file of walk(srcRoot)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;

      const owner = ownerOf(file);
      const visibility = owner === undefined ? rootVisibility : reachable(owner);

      for (const match of readFileSync(file, 'utf8').matchAll(/@Inject\(([A-Za-z_$][\w$]*)\)/g)) {
        const token = match[1] ?? '';
        const provider = providedBy.get(token);
        if (provider === undefined) continue;
        if (provider.isGlobal) continue;
        if (owner !== undefined && provider.className === owner.className) continue;
        if (visibility.has(provider.className)) continue;

        violations.push(
          `${relative(apiRoot, file)} injects ${token}, provided by ${provider.className}, which ${
            owner?.className ?? 'AppModule'
          } cannot see`,
        );
      }
    }

    expect(violations).toEqual([]);
  });
});

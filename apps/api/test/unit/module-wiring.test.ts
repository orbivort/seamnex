import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dependency graph, checked statically.
 *
 * Three mistakes are silent until a role boots and exits with "Nest can't resolve dependencies",
 * and all three are invisible to type checking:
 *
 *   1. a token injected from a module that cannot see its provider — un-globalizing a module moved
 *      the token out of reach of everything that used to resolve it;
 *   2. a token that no module provides at all — `AuditModule` was rewritten without its outbox
 *      provider and five consumers kept injecting the token, so `pnpm dev:stack` died on a
 *      dependency that no test had asked for;
 *   3. an `exports` entry that names something the module neither provides nor imports — it
 *      exports nothing, and the token resolves nowhere outside the module while reading correctly.
 *
 * A live container test would prove all three, but it needs a Postgres and a Redis to satisfy the
 * other providers. So the rules are checked where they are expressible: this is a static
 * approximation — it does not evaluate `useFactory` conditionals, and it cannot see a token the
 * framework itself provides (`HttpAdapterHost` is injected from `@nestjs/core`) — but it fails on
 * exactly the mistakes above.
 *
 * `@Inject(forwardRef(() => TOKEN))` is read like a plain injection: deferral changes *when* the
 * dependency is built, not whether it resolves.
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

type Injection = {
  readonly file: string;
  readonly token: string;
  readonly deferred: boolean;
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Comments are prose — a module's `providers` block named a token it does not provide, and a
 * comment may quote an `@Inject()` — so they are stripped before anything is parsed as code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
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

/**
 * The injection sites in a file.
 *
 * A constructor parameter is where a token becomes a runtime dependency, so this — not the imports
 * at the top of the file — is what the graph rules are checked against.
 */
function injectionsIn(source: string): { token: string; deferred: boolean }[] {
  // Two passes rather than one pattern with an optional group: a `deferred` flag derived from
  // which pass matched cannot drift from the text, and each pattern stays linear to scan.
  const found: { at: number; token: string; deferred: boolean }[] = [];
  for (const match of source.matchAll(/@Inject\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
    found.push({ at: match.index ?? 0, token: match[1] ?? '', deferred: false });
  }
  for (const match of source.matchAll(/@Inject\(\s*forwardRef\(\(\)\s*=>\s*([A-Za-z_$][\w$]*)/g)) {
    found.push({ at: match.index ?? 0, token: match[1] ?? '', deferred: true });
  }
  return found.sort((a, b) => a.at - b.at).map(({ token, deferred }) => ({ token, deferred }));
}

function readModule(file: string): ModuleMeta | undefined {
  const source = stripComments(readFileSync(file, 'utf8'));
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

/**
 * Every identifier the repository declares.
 *
 * A token that is not declared here comes from outside — `HttpAdapterHost` is the one that is
 * injected — and this file has no business calling the framework's own providers missing.
 */
const declaredNames = new Set<string>();
for (const file of walk(srcRoot)) {
  if (file.endsWith('.test.ts')) continue;
  const source = stripComments(readFileSync(file, 'utf8'));
  for (const match of source.matchAll(/export (?:const|class|interface|type|enum) (\w+)/g)) {
    declaredNames.add(match[1] ?? '');
  }
}

const injections: Injection[] = [];
for (const file of walk(srcRoot)) {
  if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
  for (const found of injectionsIn(stripComments(readFileSync(file, 'utf8')))) {
    injections.push({ file, ...found });
  }
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
    expect(injections.length).toBeGreaterThanOrEqual(300);
    expect(appModule).toBeDefined();
  });

  it('has no @Global() outside the infrastructure set', () => {
    const globals = modules.filter((entry) => entry.isGlobal).map((entry) => entry.className);
    expect(globals.sort()).toEqual([...INTENTIONALLY_GLOBAL].sort());
  });

  it('resolves every injected token from a declared import', () => {
    const violations: string[] = [];

    for (const { file, token } of injections) {
      const provider = providedBy.get(token);
      // A token nobody provides is the next test's subject, not this one's.
      if (provider === undefined) continue;
      if (provider.isGlobal) continue;

      const owner = ownerOf(file);
      if (owner !== undefined && provider.className === owner.className) continue;

      const visibility = owner === undefined ? rootVisibility : reachable(owner);
      if (visibility.has(provider.className)) continue;

      violations.push(
        `${relative(apiRoot, file)} injects ${token}, provided by ${provider.className}, which ${
          owner?.className ?? 'AppModule'
        } cannot see`,
      );
    }

    expect(violations).toEqual([]);
  });

  it('provides every token this repository declares', () => {
    const orphans = injections
      .filter(({ token }) => declaredNames.has(token) && providedBy.get(token) === undefined)
      .map(
        ({ file, token }) =>
          `${relative(apiRoot, file)} injects ${token}, which no module provides`,
      );

    expect([...new Set(orphans)]).toEqual([]);
  });

  it('exports only what it provides or imports', () => {
    const dead = modules.flatMap((entry) =>
      entry.exports
        .filter((name) => !entry.provides.includes(name) && !entry.imports.includes(name))
        .map((name) => `${entry.className} exports ${name}, which it neither provides nor imports`),
    );

    expect(dead).toEqual([]);
  });
});

describe('injection parser', () => {
  it('reads a deferred injection as an edge of the same graph', () => {
    const source =
      'constructor(@Inject(APP_CONFIG) a: A, @Inject(forwardRef(() => TOKEN)) b: B) {}';

    expect(injectionsIn(source)).toEqual([
      { token: 'APP_CONFIG', deferred: false },
      { token: 'TOKEN', deferred: true },
    ]);
  });

  it('reads every injection in a parameter list, not only the first', () => {
    const source = '@Inject(A) x: A, @Inject(B) y: B, @Inject(C) z: C';

    expect(injectionsIn(source).map((entry) => entry.token)).toEqual(['A', 'B', 'C']);
  });
});

import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * The module-boundary rule, written once.
 *
 * ADR-BE-03 claims a cross-module import "fails the build, before review". It did not: the ESLint
 * preset permitted `*.module.ts` edges listed in `mayImport`, while the boundary test forbade every
 * specifier that did not end in `.contract` — so the two gates disagreed and the test was red while
 * the claim stood. One predicate, consumed by both, is the fix.
 *
 * The rule, in order:
 *   1. a file may always import anything inside its own module directory;
 *   2. a file outside `src/modules` is not restricted here (platform machinery: `common`, `config`,
 *      `contract`, `database`, `jobs`, …);
 *   3. a module may import another module only if that module is declared in its `mayImport`, or is
 *      cross-cutting;
 *   4. such an import must name a `*.contract.ts` (the interface) or a `*.module.ts` (the
 *      composition edge) — reaching into a service, client or store is a violation.
 *
 * Resolution is centralised here too: both consumers hand over a raw specifier and this module
 * turns it into a path, so they cannot disagree about `..` handling.
 *
 * Plain ESM with JSDoc types, because three very different loaders consume it: the ESLint flat
 * config, the vitest suite (through `@seamnex/config/module-boundaries`), and Node itself.
 */

/** @typedef {import('../../packages/db/src/ownership').ModuleBoundary} ModuleBoundary */
/** @typedef {import('../../packages/db/src/ownership').BoundaryManifest} BoundaryManifest */

export const MANIFEST_URL = new URL('./module-boundaries.json', import.meta.url);

/** @returns {BoundaryManifest} */
export function loadManifest(url = MANIFEST_URL) {
  return JSON.parse(readFileSync(url, 'utf8'));
}

/**
 * ESLint reports Windows paths with backslashes; the manifest and this module speak `/`.
 * @param {string} file
 * @returns {string}
 */
export function toPosix(file) {
  return file.replace(/\\/g, '/');
}

/**
 * The module a path belongs to, found by directory segment rather than by prefix, so an absolute
 * path from ESLint and a repo-relative path from a test resolve identically.
 *
 * @param {string} file
 * @param {BoundaryManifest} manifest
 * @returns {ModuleBoundary | undefined}
 */
export function moduleOfPath(file, manifest) {
  const segments = toPosix(file).split('/');
  return manifest.modules.find((module) => segments.includes(module.dir));
}

/**
 * A relative specifier resolved against its importer. A bare specifier (`@nestjs/common`,
 * `node:fs`) is not a module import and returns `null`.
 *
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string | null}
 */
export function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(toPosix(fromFile)), specifier));
}

/**
 * @param {string} targetPath
 * @returns {'contract' | 'module' | 'internal'}
 */
export function importKind(targetPath) {
  const withoutExtension = targetPath.endsWith('.ts') ? targetPath.slice(0, -3) : targetPath;
  if (withoutExtension.endsWith('.contract')) return 'contract';
  if (withoutExtension.endsWith('.module')) return 'module';
  return 'internal';
}

/**
 * @param {ModuleBoundary} fromModule
 * @param {ModuleBoundary} toModule
 * @param {BoundaryManifest} manifest
 * @returns {string[]} the module ids this module may name at all
 */
export function allowedTargets(fromModule, manifest) {
  return [...new Set([...(fromModule.mayImport ?? []), ...(manifest.crossCutting ?? [])])].sort();
}

/**
 * @typedef {{ ok: true } | {
 *   ok: false,
 *   code: 'undeclared' | 'internal',
 *   fromModule: ModuleBoundary,
 *   toModule: ModuleBoundary,
 *   allowed: string[],
 *   reason: string,
 * }} ImportVerdict
 */

/**
 * @param {string} fromFile
 * @param {string} targetPath resolved path of the import target
 * @param {BoundaryManifest} manifest
 * @returns {ImportVerdict}
 */
export function checkImport(fromFile, targetPath, manifest) {
  const fromModule = moduleOfPath(fromFile, manifest);
  // Rule 2: platform machinery is not a module and this rule does not govern it.
  if (fromModule === undefined) return { ok: true };

  const toModule = moduleOfPath(targetPath, manifest);
  if (toModule === undefined) return { ok: true };

  // Rule 1: inside its own directory anything goes.
  if (fromModule.id === toModule.id) return { ok: true };

  const allowed = allowedTargets(fromModule, manifest);

  // Rule 3: the edge itself must be declared.
  if (!allowed.includes(toModule.id)) {
    return {
      ok: false,
      code: 'undeclared',
      fromModule,
      toModule,
      allowed,
      reason: `${fromModule.id} ${fromModule.name} may not depend on ${toModule.id} ${toModule.name}: the edge is not in its mayImport. Allowed: ${allowed.join(', ') || '(none)'}.`,
    };
  }

  // Rule 4: a declared edge still has to go through the interface or the composition edge.
  const kind = importKind(targetPath);
  if (kind === 'internal') {
    return {
      ok: false,
      code: 'internal',
      fromModule,
      toModule,
      allowed,
      reason: `${fromModule.id} ${fromModule.name} may not import a file inside ${toModule.id} ${toModule.name}: import its *.contract.ts interface (or its *.module.ts when wiring the graph). Cross-module calls go through the contract, or through the outbox.`,
    };
  }

  return { ok: true };
}

/**
 * The convenience both gates actually call: a specifier in, a verdict out.
 *
 * @param {string} fromFile
 * @param {string} specifier
 * @param {BoundaryManifest} manifest
 * @returns {ImportVerdict}
 */
export function checkSpecifier(fromFile, specifier, manifest) {
  const target = resolveImport(fromFile, specifier);
  if (target === null) return { ok: true };
  return checkImport(fromFile, target, manifest);
}

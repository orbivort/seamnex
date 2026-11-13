/**
 * Types for `module-boundaries.mjs`. The runtime file is plain ESM so the ESLint flat config can
 * import it without a TypeScript loader; these declarations are what the API boundary test sees.
 */

export type ModuleBoundary = {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly owns: readonly string[];
  readonly mayImport: readonly string[];
  readonly reads: readonly string[];
};

export type RuntimeBoundary = {
  readonly $comment?: string;
  readonly dir: string;
  readonly owns: readonly string[];
  readonly reads: readonly string[];
};

export type BoundaryManifest = {
  readonly root: string;
  readonly crossCutting: readonly string[];
  readonly shared: Record<string, string>;
  readonly runtime: readonly RuntimeBoundary[];
  readonly modules: readonly ModuleBoundary[];
};

export type ImportKind = 'contract' | 'module' | 'internal';

export type ImportVerdict =
  | { ok: true }
  | {
      readonly ok: false;
      readonly code: 'undeclared' | 'internal';
      readonly fromModule: ModuleBoundary;
      readonly toModule: ModuleBoundary;
      readonly allowed: string[];
      readonly reason: string;
    };

export declare const MANIFEST_URL: URL;

export declare function loadManifest(url?: URL): BoundaryManifest;
export declare function toPosix(file: string): string;
export declare function moduleOfPath(
  file: string,
  manifest: BoundaryManifest,
): ModuleBoundary | undefined;
export declare function resolveImport(fromFile: string, specifier: string): string | null;
export declare function importKind(targetPath: string): ImportKind;
export declare function allowedTargets(
  fromModule: ModuleBoundary,
  manifest: BoundaryManifest,
): string[];
export declare function checkImport(
  fromFile: string,
  targetPath: string,
  manifest: BoundaryManifest,
): ImportVerdict;
export declare function checkSpecifier(
  fromFile: string,
  specifier: string,
  manifest: BoundaryManifest,
): ImportVerdict;

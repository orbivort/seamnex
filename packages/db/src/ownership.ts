import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The boundary manifest is data, not prose: the ESLint preset uses it to forbid imports and the
 * boundary test uses it to assert that no module touches another module's tables.
 */
export type ModuleId = `M${string}`;

export type ModuleBoundary = {
  readonly id: ModuleId;
  readonly name: string;
  readonly dir: string;
  readonly owns: readonly string[];
  readonly mayImport: readonly ModuleId[];
  readonly reads: readonly string[];
};

/**
 * A directory under `apps/api/src` that is platform machinery rather than a product domain, yet
 * still names tables (`jobs`, `audit`, `secrets`). The boundary test uses this instead of a
 * hard-coded map, so the manifest stays the only place ownership is declared.
 */
export type RuntimeBoundary = {
  readonly $comment?: string;
  readonly dir: string;
  readonly owns: readonly string[];
  readonly reads: readonly string[];
};

export type BoundaryManifest = {
  readonly root: string;
  readonly crossCutting: readonly ModuleId[];
  readonly shared: Record<string, ModuleId | string>;
  readonly runtime: readonly RuntimeBoundary[];
  readonly modules: readonly ModuleBoundary[];
};

export const MANIFEST_PATH = fileURLToPath(
  new URL('../../config/module-boundaries.json', import.meta.url),
);

export function loadBoundaries(path: string = MANIFEST_PATH): BoundaryManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as BoundaryManifest;
}

/** table → owning module id. Every owned table appears exactly once. */
export function tablesByModule(
  manifest: BoundaryManifest = loadBoundaries(),
): Map<string, ModuleId> {
  const map = new Map<string, ModuleId>();
  for (const module of manifest.modules) {
    for (const table of module.owns) {
      const existing = map.get(table);
      if (existing !== undefined) {
        throw new Error(`Table ${table} is owned by both ${existing} and ${module.id}`);
      }
      map.set(table, module.id);
    }
  }
  return map;
}

export function ownerOfTable(
  table: string,
  manifest: BoundaryManifest = loadBoundaries(),
): ModuleId | undefined {
  return tablesByModule(manifest).get(table);
}

export function moduleByDir(
  dir: string,
  manifest: BoundaryManifest = loadBoundaries(),
): ModuleBoundary | undefined {
  return manifest.modules.find((module) => module.dir === dir);
}

/** Modules that may read a table: its owner, plus any module that declares it in `reads`. */
export function readersOfTable(
  table: string,
  manifest: BoundaryManifest = loadBoundaries(),
): ModuleId[] {
  const readers = manifest.modules
    .filter((module) => module.reads.includes(table))
    .map((module) => module.id);
  const owner = ownerOfTable(table, manifest);
  return owner === undefined ? readers : [owner, ...readers];
}

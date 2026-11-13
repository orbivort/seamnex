import { loadBoundaries, type BoundaryManifest } from '@seamnex/db';

/**
 * The 23 modules of design §6.1, as data.
 *
 * Phase 1 ships their interfaces and one implementation (M15 secrets, M17 audit, plus the job half
 * of M5). The registry exists so that "which module owns this table" and "which module is
 * implemented" are answerable without reading the directory tree — and so a test can assert that
 * every module in the boundary manifest has a contract file.
 */
export type ModuleStatus = 'implemented' | 'contract-only';

export type ModuleEntry = {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly status: ModuleStatus;
  readonly phase: string;
};

const PHASES: Record<string, { status: ModuleStatus; phase: string }> = {
  M05: { status: 'implemented', phase: '1 (jobs), 4A (Docker apply)' },
  M15: { status: 'implemented', phase: '1' },
  M17: { status: 'implemented', phase: '1' },
};

export function moduleRegistry(manifest: BoundaryManifest = loadBoundaries()): ModuleEntry[] {
  return manifest.modules.map((module) => {
    const known = PHASES[module.id];
    return {
      id: module.id,
      name: module.name,
      dir: module.dir,
      status: known?.status ?? 'contract-only',
      phase: known?.phase ?? 'unassigned',
    };
  });
}

export function implementedModules(manifest?: BoundaryManifest): ModuleEntry[] {
  return moduleRegistry(manifest).filter((entry) => entry.status === 'implemented');
}

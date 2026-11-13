import { describe, expect, it } from 'vitest';
import type { BoundaryManifest } from '@seamnex/db';
import { implementedModules, moduleRegistry } from '../../../src/modules/modules.registry';

function manifest(modules: Array<{ id: string; name: string; dir: string }>): BoundaryManifest {
  return { modules } as unknown as BoundaryManifest;
}

const MANIFEST = manifest([
  { id: 'M05', name: 'Executor', dir: 'm05-executor' },
  { id: 'M15', name: 'Secrets', dir: 'm15-secrets' },
  { id: 'M17', name: 'Audit', dir: 'm17-audit' },
  { id: 'M01', name: 'Catalog', dir: 'm01-catalog' },
]);

describe('moduleRegistry', () => {
  it('marks the three implemented modules and leaves the rest contract-only', () => {
    const entries = moduleRegistry(MANIFEST);

    expect(entries).toEqual([
      {
        id: 'M05',
        name: 'Executor',
        dir: 'm05-executor',
        status: 'implemented',
        phase: '1 (jobs), 4A (Docker apply)',
      },
      { id: 'M15', name: 'Secrets', dir: 'm15-secrets', status: 'implemented', phase: '1' },
      { id: 'M17', name: 'Audit', dir: 'm17-audit', status: 'implemented', phase: '1' },
      {
        id: 'M01',
        name: 'Catalog',
        dir: 'm01-catalog',
        status: 'contract-only',
        phase: 'unassigned',
      },
    ]);
  });

  it('reads the boundary manifest by default', () => {
    const entries = moduleRegistry();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((entry) => entry.id.startsWith('M'))).toBe(true);
  });

  it('filters to the implemented modules for the status surface', () => {
    expect(implementedModules(MANIFEST).map((entry) => entry.id)).toEqual(['M05', 'M15', 'M17']);
  });

  it('returns an empty registry for an empty manifest', () => {
    expect(moduleRegistry(manifest([]))).toEqual([]);
    expect(implementedModules(manifest([]))).toEqual([]);
  });
});

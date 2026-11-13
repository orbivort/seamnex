import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MANIFEST_PATH,
  loadBoundaries,
  moduleByDir,
  ownerOfTable,
  readersOfTable,
  tablesByModule,
  type BoundaryManifest,
  type ModuleBoundary,
  type ModuleId,
} from '../../src/ownership';

const scratch = mkdtempSync(join(tmpdir(), 'seamnex-ownership-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

type ModuleInput = {
  readonly id: ModuleId;
  readonly dir: string;
  readonly owns?: readonly string[];
  readonly mayImport?: readonly ModuleId[];
  readonly reads?: readonly string[];
};

function moduleOf(input: ModuleInput): ModuleBoundary {
  return {
    id: input.id,
    name: input.id,
    dir: input.dir,
    owns: input.owns ?? [],
    mayImport: input.mayImport ?? [],
    reads: input.reads ?? [],
  };
}

function manifestOf(...modules: ModuleBoundary[]): BoundaryManifest {
  return {
    root: 'apps/api/src',
    crossCutting: [],
    shared: {},
    runtime: [],
    modules,
  };
}

/** Two modules, one shared table, one table only the second module reads. */
function sampleManifest(): BoundaryManifest {
  return manifestOf(
    moduleOf({ id: 'M01', dir: 'catalog', owns: ['catalog_entry', 'shared_table'] }),
    moduleOf({ id: 'M02', dir: 'deploy', owns: ['instance'], reads: ['catalog_entry'] }),
  );
}

describe('MANIFEST_PATH', () => {
  it('points at the shared module-boundaries manifest', () => {
    expect(MANIFEST_PATH).toMatch(/module-boundaries\.json$/);
  });
});

describe('loadBoundaries', () => {
  it('reads the manifest on disk by default and finds owned tables in it', () => {
    const manifest = loadBoundaries();

    expect(manifest.root.length).toBeGreaterThan(0);
    expect(manifest.modules.length).toBeGreaterThan(0);
    expect(tablesByModule(manifest).size).toBeGreaterThanOrEqual(70);
  });

  it('reads an alternative manifest when a path is given', () => {
    const path = join(scratch, 'boundaries.json');
    writeFileSync(path, JSON.stringify(sampleManifest()));

    const manifest = loadBoundaries(path);

    expect(manifest.modules.map((module) => module.id)).toEqual(['M01', 'M02']);
    expect(manifest.root).toBe('apps/api/src');
  });
});

describe('tablesByModule', () => {
  it('maps every owned table to exactly one module', () => {
    const tables = tablesByModule(sampleManifest());

    expect(tables.get('catalog_entry')).toBe('M01');
    expect(tables.get('shared_table')).toBe('M01');
    expect(tables.get('instance')).toBe('M02');
    expect(tables.has('unowned')).toBe(false);
  });

  it('refuses a manifest in which two modules claim the same table', () => {
    const contested = manifestOf(
      moduleOf({ id: 'M01', dir: 'one', owns: ['audit_event'] }),
      moduleOf({ id: 'M02', dir: 'two', owns: ['audit_event'] }),
    );

    expect(() => tablesByModule(contested)).toThrow(/owned by both M01 and M02/);
  });
});

describe('ownerOfTable', () => {
  it('names the owning module, and undefined for a table nobody owns', () => {
    const manifest = sampleManifest();

    expect(ownerOfTable('instance', manifest)).toBe('M02');
    expect(ownerOfTable('role_binding', manifest)).toBeUndefined();
  });

  it('defaults to the manifest on disk', () => {
    expect(ownerOfTable('audit_event')).toBeDefined();
  });
});

describe('moduleByDir', () => {
  it('finds a module by its directory, and undefined when no module matches', () => {
    const manifest = sampleManifest();

    expect(moduleByDir('deploy', manifest)?.id).toBe('M02');
    expect(moduleByDir('billing', manifest)).toBeUndefined();
  });

  it('defaults to the manifest on disk', () => {
    const manifest = loadBoundaries();
    const dir = manifest.modules[0]?.dir ?? '';
    expect(moduleByDir(dir)?.dir).toBe(dir);
  });
});

describe('readersOfTable', () => {
  it('lists the owner first, followed by every module that declares it in reads', () => {
    expect(readersOfTable('catalog_entry', sampleManifest())).toEqual(['M01', 'M02']);
  });

  it('lists only readers when no module owns the table', () => {
    const manifest = manifestOf(
      moduleOf({ id: 'M01', dir: 'one', reads: ['schema_migration'] }),
      moduleOf({ id: 'M02', dir: 'two', reads: ['schema_migration'] }),
    );

    expect(readersOfTable('schema_migration', manifest)).toEqual(['M01', 'M02']);
  });

  it('returns an empty list for a table no module declares', () => {
    expect(readersOfTable('does_not_exist', sampleManifest())).toEqual([]);
  });
});

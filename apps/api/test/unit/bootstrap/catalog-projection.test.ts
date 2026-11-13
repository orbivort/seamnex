import { describe, expect, it } from 'vitest';
import {
  ENV_SCHEMA_FORMAT,
  type CatalogEntry,
  type EnvSchemaFile,
  type ReloadEnvironmentResult,
} from '@seamnex/domain';
import {
  decideProjection,
  describeFailure,
  projectionReceipt,
} from '../../../src/bootstrap/catalog-projection';
import type { CatalogWorkingTree } from '../../../src/modules/m22-catalog-repository/catalog-repo.contract';

/**
 * The bootstrap step's decisions, without a container or a database.
 *
 * Each case is a state a fresh clone can actually reach, and the exit code is the assertion: a
 * startup step that reports success after projecting nothing is the failure this module exists to
 * make impossible, so "nothing to do" and "something is wrong" must not share a code.
 */

const ROOT = '/srv/seamnex/temp/catalog-repo';

function declaration(entryKey = 'D01-01'): EnvSchemaFile {
  return { format: ENV_SCHEMA_FORMAT, entryKey, variables: [] };
}

function tree(overrides: Partial<CatalogWorkingTree> = {}): CatalogWorkingTree {
  return {
    revision: 'content-0123456789abcdef',
    documents: [],
    envSchemas: [],
    invalid: [],
    ...overrides,
  };
}

describe('decideProjection', () => {
  it('refuses to project when a file the tree holds failed validation', () => {
    const decision = decideProjection({
      root: ROOT,
      tree: tree({
        invalid: [
          {
            path: 'catalog/env/D01-01.json',
            scope: 'environment',
            key: 'D01-01',
            reason: 'entryKey "D01-02" does not match the filename "D01-01"',
          },
        ],
        envSchemas: [declaration()],
      }),
      projectedEntries: 3,
    });

    // Projecting the valid half would leave the projection silently short of what the tree declares.
    expect(decision.apply).toBe(false);
    expect(decision.code).toBe(1);
    expect(decision.lines[0]).toContain('1 artefact(s)');
    expect(decision.lines.join('\n')).toContain('does not match the filename');
  });

  it('treats an absent tree on an undefaulted stack as nothing to do', () => {
    const decision = decideProjection({
      root: ROOT,
      tree: tree({ revision: 'absent' }),
      projectedEntries: 0,
    });

    expect(decision.apply).toBe(false);
    expect(decision.code).toBe(0);
    expect(decision.lines.join('\n')).toContain(ROOT);
  });

  it('fails an absent tree when entries are already projected', () => {
    const decision = decideProjection({
      root: ROOT,
      tree: tree({ revision: 'absent' }),
      projectedEntries: 3,
    });

    // The seed wrote the rows, the projector resolved a different (or missing) root: a green exit
    // here is how a path disagreement becomes "the product has no variables".
    expect(decision.apply).toBe(false);
    expect(decision.code).toBe(1);
    expect(decision.lines.join('\n')).toContain('3 catalog entries are projected');
  });

  it("names the unprojected entries instead of repeating M03's per-file refusal", () => {
    // The state a restored tree meets a fresh database in: three documents on disk, zero
    // `catalog_entry` rows. `applySchemas` refuses each one with "repair catalog/<KEY>.json first",
    // which points at a document that is perfectly valid and says nothing about the missing step.
    const decision = decideProjection({
      root: ROOT,
      tree: tree({ documents: [{} as CatalogEntry], envSchemas: [declaration()] }),
      projectedEntries: 0,
    });

    expect(decision.apply).toBe(false);
    expect(decision.code).toBe(1);
    expect(decision.lines[0]).toContain('the tree declares 1 entries but none are projected');
    // Both recoveries are named, and the one an operator can run from this step comes first: the
    // bootstrap runs before the API exists, so `POST /catalog/reload` alone is not an instruction
    // they can follow while `pnpm dev` is stopped here.
    expect(decision.lines.join('\n')).toContain('pnpm db:seed');
    expect(decision.lines.join('\n')).toContain('POST /catalog/reload');
    expect(decision.lines.join('\n')).toContain('needs the API up with an R1 session');
  });

  it('accepts a tree that declares no environment at all', () => {
    const decision = decideProjection({ root: ROOT, tree: tree(), projectedEntries: 3 });

    expect(decision.apply).toBe(false);
    expect(decision.code).toBe(0);
    expect(decision.lines[0]).toContain('no environment declarations');
  });

  it('applies a tree that declares variables, and names the revision it will stamp', () => {
    const decision = decideProjection({
      root: ROOT,
      tree: tree({ envSchemas: [declaration('D01-01'), declaration('D07-01')] }),
      projectedEntries: 3,
    });

    expect(decision.apply).toBe(true);
    expect(decision.code).toBe(0);
    expect(decision.lines[0]).toBe(
      'content-0123456789abcdef: 0 entries, 2 environment declarations',
    );
  });
});

describe('projectionReceipt', () => {
  const empty: ReloadEnvironmentResult = {
    added: 0,
    changed: 0,
    removed: 0,
    refused: [],
    applied: [],
  };

  it('reports each entry that moved', () => {
    const receipt = projectionReceipt({
      ...empty,
      added: 30,
      applied: [{ key: 'D01-01', added: 30, changed: 0, removed: 0 }],
    });

    expect(receipt.code).toBe(0);
    expect(receipt.lines).toEqual(['  D01-01: 30 added, 0 changed, 0 removed']);
  });

  it('says so when the projection is already current', () => {
    // The second boot of the same stack: one hash per file, no write, no audit row.
    const receipt = projectionReceipt(empty);

    expect(receipt.code).toBe(0);
    expect(receipt.lines).toEqual(['  already current: 0 added, 0 changed, 0 removed']);
  });

  it('fails the run when a file was refused, naming the variable when there is one', () => {
    const receipt = projectionReceipt({
      ...empty,
      refused: [
        { key: 'D01-01', name: 'ESPOCRM_SITE_URL', reason: 'instance core-crm stores a value' },
        { key: 'D09-01', name: null, reason: 'no catalog entry "D09-01" is projected' },
      ],
    });

    // A refusal means the projection is behind the tree; the next deploy would plan against the
    // stale declaration, so a startup step must not report success.
    expect(receipt.code).toBe(1);
    expect(receipt.lines).toEqual([
      '  refused D01-01 (ESPOCRM_SITE_URL): instance core-crm stores a value',
      '  refused D09-01: no catalog entry "D09-01" is projected',
    ]);
  });
});

describe('describeFailure', () => {
  it('reads a pooled connection failure out of the aggregate, which has no message of its own', () => {
    // The failure that produced a blank line: `pg` rejects with one error per address it tried, and
    // `AggregateError.message` is empty, so `error.message` alone reported nothing at all.
    const failure = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED ::1:5432'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
      ],
      '',
    );
    Object.assign(failure, { code: 'ECONNREFUSED' });

    const described = describeFailure(failure);

    expect(described).toContain('aggregate failure (ECONNREFUSED)');
    expect(described).toContain('connect ECONNREFUSED ::1:5432');
    expect(described).toContain('connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('keeps an aggregate that names itself, and omits a code it does not have', () => {
    const failure = new AggregateError([new Error('one probe failed')], 'connect failed');

    expect(describeFailure(failure)).toBe('connect failed; one probe failed');
  });

  it('falls back to the error name when the message is empty', () => {
    expect(describeFailure(new Error(''))).toBe('Error');
  });

  it('keeps the code next to the message', () => {
    expect(describeFailure(Object.assign(new Error('open failed'), { code: 'ENOENT' }))).toBe(
      'open failed (ENOENT)',
    );
  });

  it('passes through anything that is not an error', () => {
    expect(describeFailure('catalog/env/D01-01.json is missing')).toBe(
      'catalog/env/D01-01.json is missing',
    );
    expect(describeFailure({ code: 42 })).toBe('[object Object]');
  });
});

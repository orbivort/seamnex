import { describe, expect, it } from 'vitest';
import {
  compileHash,
  PolicyCompiler,
} from '../../../../src/modules/m09-access-control/policy.compiler';
import { fakeDb, type Row } from '../../../support/fakes';

const HASH = compileHash();

function db(
  options: {
    existing?: Row[];
    active?: Row[];
    inserted?: Row[];
  } = {},
) {
  return fakeDb([
    ['pg_advisory_xact_lock', []],
    ['SELECT version FROM policy_version WHERE source_hash', options.existing ?? []],
    ['SELECT is_active FROM policy_version WHERE version', options.active ?? []],
    ['UPDATE policy_version SET is_active = false WHERE is_active', []],
    ['UPDATE policy_version SET is_active = true WHERE version', []],
    ['INSERT INTO policy_version', options.inserted ?? [{ version: 4 }]],
  ]);
}

describe('compileHash', () => {
  it('is deterministic across calls, so a redeploy reuses the stored version', () => {
    expect(compileHash()).toBe(compileHash());
    expect(compileHash()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PolicyCompiler', () => {
  it('inserts a new version when the source hash is unseen, and activates it', async () => {
    const fake = db({ inserted: [{ version: 4 }] });
    const compiler = new PolicyCompiler(fake.pool);

    const compiled = await compiler.compile();

    expect(compiled).toEqual({ version: 4, sourceHash: HASH });
    expect(compiler.activeVersion).toBe(4);
    expect(compiler.sourceHash).toBe(HASH);
    expect(fake.calls.some((call) => call.sql.includes('SET is_active = false'))).toBe(true);
    const insert = fake.calls.find((call) => call.sql.includes('INSERT INTO policy_version'));
    expect(insert?.params?.[1]).toBe(HASH);
    expect(String(insert?.params?.[0])).toContain('capabilityMatrix');
  });

  it('reuses the stored version for an unchanged source', async () => {
    const fake = db({ existing: [{ version: 2 }], active: [{ is_active: true }] });
    const compiler = new PolicyCompiler(fake.pool);

    await expect(compiler.compile()).resolves.toEqual({ version: 2, sourceHash: HASH });
    expect(fake.calls.some((call) => call.sql.includes('INSERT INTO policy_version'))).toBe(false);
    expect(fake.calls.some((call) => call.sql.includes('SET is_active = true'))).toBe(false);
  });

  it('re-activates a stored version that had been superseded', async () => {
    const fake = db({ existing: [{ version: 2 }], active: [{ is_active: false }] });
    const compiler = new PolicyCompiler(fake.pool);

    await compiler.compile();

    expect(fake.calls.some((call) => call.sql.includes('SET is_active = true'))).toBe(true);
  });

  it('treats a missing is_active row as inactive', async () => {
    const fake = db({ existing: [{ version: 2 }], active: [] });
    await new PolicyCompiler(fake.pool).compile();
    expect(fake.calls.some((call) => call.sql.includes('SET is_active = true'))).toBe(true);
  });

  it('fails the boot when the insert returns no row', async () => {
    const fake = db({ inserted: [] });
    await expect(new PolicyCompiler(fake.pool).compile()).rejects.toThrow(
      'policy_version insert returned no row',
    );
  });

  it('refuses to report a version before the boot compile', () => {
    const compiler = new PolicyCompiler(db().pool);
    expect(() => compiler.activeVersion).toThrow(/has not been compiled/);
    expect(() => compiler.sourceHash).toThrow(/has not been compiled/);
  });

  it('compiles on application bootstrap', async () => {
    const compiler = new PolicyCompiler(db({ inserted: [{ version: 1 }] }).pool);
    await compiler.onApplicationBootstrap();
    expect(compiler.activeVersion).toBe(1);
  });

  it('releases the advisory lock with the transaction, so a crash cannot pin policy', async () => {
    const fake = db({ inserted: [{ version: 1 }] });
    await new PolicyCompiler(fake.pool).compile();
    const lock = fake.calls.find((call) => call.sql.includes('pg_advisory_xact_lock'));
    expect(lock).toBeDefined();
    expect(fake.calls.some((call) => call.sql === 'COMMIT')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';

/**
 * Two `src` files exist only to declare types: the role definition and the operation handler
 * contract. They ship no runtime statement, but they are still the vocabulary every role and every
 * handler is written against, so the compiler erases them and the coverage provider reports an
 * unloaded file as 0 %. Loading them makes the report say what is true — there is nothing to
 * execute — and keeps the per-file gate honest for the files that do have code.
 */
describe('type-only modules', () => {
  it('the role definition module is importable and empty', async () => {
    const module: Record<string, unknown> = await import('../../src/roles/role');
    expect(Object.keys(module)).toEqual([]);
  });

  it('the operation handler contract module is importable and empty', async () => {
    const module: Record<string, unknown> = await import('../../src/contract/operation-handler');
    expect(Object.keys(module)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { ApiOperation } from '@seamnex/domain';
import { AppError } from '../../../../src/common/problem/app-error';
import { validateRequest } from '../../../../src/common/http/validate-request';

/**
 * The remaining arms of the boundary rule: what happens to a query value that is not a scalar at
 * all, and what the coercion does to spellings a client actually sends (`007`, `-3`, a bare `1`).
 *
 * A transport that hands `null` or a nested object to `query` is not a client error the validator
 * can name — the key was not declared with a shape, so it is dropped rather than refused. That
 * distinction matters: refusing it would answer 422 for a parameter the operation never asked for,
 * while letting it through would put a non-string in a `Record<string, string>`.
 */
function operation(overrides: Record<string, unknown>): ApiOperation {
  return {
    method: 'GET',
    path: '/test',
    summary: 'test',
    tag: 'jobs',
    policyKey: 'jobs.read',
    ...overrides,
  } as unknown as ApiOperation;
}

function failure(run: () => unknown): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the validation to refuse the request');
}

const QUERY = operation({
  query: [
    { name: 'limit', type: 'integer', description: 'n' },
    { name: 'dryRun', type: 'boolean', description: 'flag' },
    { name: 'name', type: 'string', description: 'free text' },
    { name: 'env', type: 'string', prefix: true, description: 'family' },
    { name: 'label', type: 'string', prefix: true, description: 'second family' },
  ],
});

describe('non-scalar query values', () => {
  it('drops a null-valued key instead of coercing it to the string "null"', () => {
    const input = validateRequest(QUERY, { query: { name: null, limit: '5' }, body: undefined });

    expect(input.query).toEqual({ limit: '5' });
    expect(Object.hasOwn(input.query, 'name')).toBe(false);
  });

  it('drops a nested object under a declared key without reporting it', () => {
    const input = validateRequest(QUERY, {
      query: { name: { first: 'a' }, dryRun: 'false' },
      body: undefined,
    });

    // The shape was never declared, so there is no contract to report a violation against.
    expect(input.query).toEqual({ dryRun: 'false' });
  });

  it('drops an undeclared key whose value is not a scalar rather than calling it unrecognized', () => {
    const input = validateRequest(QUERY, { query: { ghost: null }, body: undefined });

    expect(input.query).toEqual({});
    expect(input.families).toEqual({});
  });
});

describe('coercion of the spellings a client sends', () => {
  it('normalises an integer with leading zeros and a sign', () => {
    const input = validateRequest(QUERY, { query: { limit: '007' }, body: undefined });

    expect(input.query.limit).toBe('7');
  });

  it('keeps a negative integer negative', () => {
    const input = validateRequest(QUERY, { query: { limit: '-3' }, body: undefined });

    expect(input.query.limit).toBe('-3');
  });

  it('coerces a raw number and a raw boolean before applying the declared type', () => {
    const input = validateRequest(QUERY, { query: { limit: 25, dryRun: 1 }, body: undefined });

    expect(input.query).toEqual({ limit: '25', dryRun: 'true' });
  });
});

describe('prefix families', () => {
  it('keeps the dots inside a suffix, so a nested key stays one entry', () => {
    const input = validateRequest(QUERY, { query: { 'env.MAIL.HOST': 'smtp' }, body: undefined });

    expect(input.families).toEqual({ env: { 'MAIL.HOST': 'smtp' } });
  });

  it('routes each key to the family whose prefix it names, not the first prefix declared', () => {
    const input = validateRequest(QUERY, {
      query: { 'label.team': 'core', 'env.MAIL_HOST': 'smtp' },
      body: undefined,
    });

    expect(input.families).toEqual({ env: { MAIL_HOST: 'smtp' }, label: { team: 'core' } });
  });

  it('does not treat a key that merely contains the prefix as part of the family', () => {
    const error = failure(() =>
      validateRequest(QUERY, { query: { environment: 'prod' }, body: undefined }),
    );

    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'environment', code: 'unrecognized_key' }),
    ]);
  });
});

describe('body parsing alongside the query', () => {
  it('reports every schema issue against its own dotted path, not just the first', () => {
    const op = operation({
      method: 'POST',
      path: '/x',
      request: {
        safeParse: () => ({
          success: false,
          error: {
            issues: [
              { path: ['source'], code: 'invalid_enum_value', message: 'bad source' },
              { path: ['content'], code: 'too_small', message: 'empty' },
            ],
          },
        }),
      },
    });

    const error = failure(() => validateRequest(op, { query: {}, body: { source: 'yaml' } }));

    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'source', code: 'invalid_enum_value' }),
      expect.objectContaining({ field: 'content', code: 'too_small' }),
    ]);
  });
});

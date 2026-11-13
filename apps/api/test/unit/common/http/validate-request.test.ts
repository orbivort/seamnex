import { describe, expect, it } from 'vitest';
import { API_OPERATIONS, operationKey, type ApiOperation } from '@seamnex/domain';
import { z } from 'zod';
import { AppError } from '../../../../src/common/problem/app-error';
import { validateRequest } from '../../../../src/common/http/validate-request';

/**
 * The boundary rule this file proves: a handler only ever receives a body the contract declared.
 *
 * Before it, an operation without a `request` schema handed the raw body through, so a handler's
 * `input.body as { … }` was the only validation an operation had — and deleting `request:` from the
 * contract changed nothing at runtime.
 */
const BODYLESS = operation('POST /jobs/:id/cancel');
const WITH_SCHEMA = operation('POST /catalog/:key/env-import');

function operation(key: string): ApiOperation {
  const found = API_OPERATIONS.find((candidate) => operationKey(candidate) === key);
  if (found === undefined) throw new Error(`no declared operation ${key}`);
  return found;
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

describe('request validation', () => {
  it('refuses a body sent to an operation that declares no request schema', () => {
    const error = failure(() =>
      validateRequest(BODYLESS, { query: {}, body: { justification: 'restore it' } }),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.status).toBe(422);
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'body', code: 'unexpected_body' }),
    ]);
  });

  it('accepts an absent or empty body for the same operation', () => {
    for (const body of [undefined, null, {}]) {
      const input = validateRequest(BODYLESS, { query: {}, body });
      expect(input.body).toBeUndefined();
    }
  });

  it('refuses a non-object body when the operation declares no schema', () => {
    for (const body of ['text', 42, true, [1]]) {
      const error = failure(() => validateRequest(BODYLESS, { query: {}, body }));
      expect(error.fieldErrors[0]?.code).toBe('unexpected_body');
    }
  });

  it('returns the parsed body when the operation declares a schema', () => {
    const input = validateRequest(WITH_SCHEMA, {
      query: {},
      body: { source: 'dotenv', content: 'MAIL_HOST=smtp.example.test' },
    });

    expect(input.body).toMatchObject({ source: 'dotenv' });
  });

  it('reports a declared body that does not match its schema', () => {
    const error = failure(() =>
      validateRequest(WITH_SCHEMA, { query: {}, body: { source: 'yaml', content: '' } }),
    );

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.fieldErrors.some((issue) => issue.field.startsWith('source'))).toBe(true);
  });

  it('reports a root-level schema issue against the body field', () => {
    const op = fakeOperation({
      method: 'POST',
      path: '/x',
      request: z.string().min(5, 'too short'),
    });
    const error = failure(() => validateRequest(op, { query: {}, body: 'abc' }));
    expect(error.fieldErrors).toEqual([expect.objectContaining({ field: 'body' })]);
  });

  it('parses an absent body as an empty object for a schema that accepts one', () => {
    const op = fakeOperation({ method: 'POST', path: '/x', request: z.object({}) });
    expect(validateRequest(op, { query: {}, body: undefined }).body).toEqual({});
  });
});

describe('query coercion', () => {
  const op = fakeOperation({
    method: 'GET',
    path: '/x',
    query: [
      { name: 'limit', type: 'integer', description: 'n' },
      { name: 'dryRun', type: 'boolean', description: 'flag' },
      { name: 'state', type: 'string', values: ['ready', 'failed'], description: 'state' },
      { name: 'name', type: 'string', description: 'free text' },
      { name: 'env', type: 'string', prefix: true, description: 'family' },
      { name: 'requiredOne', type: 'string', required: true, description: 'needed' },
    ],
  });

  it('coerces integers, booleans and enum values, and keeps free text', () => {
    const input = validateRequest(op, {
      query: { limit: '25', dryRun: '1', state: 'ready', name: 'anything', requiredOne: 'x' },
      body: undefined,
    });
    expect(input.query).toEqual({
      limit: '25',
      dryRun: 'true',
      state: 'ready',
      name: 'anything',
      requiredOne: 'x',
    });
  });

  it('normalises every accepted boolean spelling', () => {
    const spellings: Array<[string, string]> = [
      ['true', 'true'],
      ['1', 'true'],
      ['false', 'false'],
      ['0', 'false'],
    ];
    for (const [raw, expected] of spellings) {
      const input = validateRequest(op, {
        query: { dryRun: raw, requiredOne: 'x' },
        body: undefined,
      });
      expect(input.query.dryRun).toBe(expected);
    }
  });

  it('refuses a non-integer and a non-boolean', () => {
    for (const query of [{ limit: 'ten' }, { dryRun: 'yes' }]) {
      const error = failure(() =>
        validateRequest(op, { query: { ...query, requiredOne: 'x' }, body: undefined }),
      );
      expect(error.fieldErrors[0]?.code).toBe('invalid_type');
    }
  });

  it('refuses a value outside the declared closed set', () => {
    const error = failure(() =>
      validateRequest(op, { query: { state: 'running', requiredOne: 'x' }, body: undefined }),
    );
    expect(error.fieldErrors[0]).toEqual(
      expect.objectContaining({ field: 'state', code: 'invalid_enum_value' }),
    );
  });

  it('refuses an undeclared query key', () => {
    const error = failure(() =>
      validateRequest(op, { query: { unknown: '1', requiredOne: 'x' }, body: undefined }),
    );
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'unknown', code: 'unrecognized_key' }),
    ]);
  });

  it('refuses a missing required parameter', () => {
    const error = failure(() => validateRequest(op, { query: {}, body: undefined }));
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'requiredOne', code: 'required' }),
    ]);
  });

  it('does not require a missing prefix family', () => {
    expect(validateRequest(op, { query: { requiredOne: 'x' }, body: undefined }).families).toEqual(
      {},
    );
  });

  it('groups prefixed keys into their family', () => {
    const input = validateRequest(op, {
      query: { 'env.MAIL_HOST': 'smtp', 'env.MAIL_PORT': '25', requiredOne: 'x' },
      body: undefined,
    });
    expect(input.families).toEqual({ env: { MAIL_HOST: 'smtp', MAIL_PORT: '25' } });
  });

  it('refuses a prefix with no name after it', () => {
    const error = failure(() =>
      validateRequest(op, { query: { 'env.': 'x', requiredOne: 'x' }, body: undefined }),
    );
    expect(error.fieldErrors).toEqual([
      expect.objectContaining({ field: 'env.', code: 'invalid_key' }),
    ]);
  });

  it('uses the first element of a repeated query parameter', () => {
    const input = validateRequest(op, {
      query: { requiredOne: ['first', 'second'] },
      body: undefined,
    });
    expect(input.query.requiredOne).toBe('first');
  });

  it('skips a value that is not a scalar', () => {
    const input = validateRequest(op, {
      query: {
        requiredOne: 'x',
        name: [42 as unknown as string],
      },
      body: undefined,
    });
    expect(input.query.name).toBeUndefined();
  });

  it('accepts a numeric raw value by stringifying it', () => {
    const input = validateRequest(op, { query: { requiredOne: 'x', limit: 7 }, body: undefined });
    expect(input.query.limit).toBe('7');
  });

  it('collects every failure in one refusal', () => {
    const error = failure(() =>
      validateRequest(op, {
        query: { unknown: '1', limit: 'ten', state: 'running' },
        body: undefined,
      }),
    );
    expect(error.fieldErrors.map((issue) => issue.field)).toEqual(
      expect.arrayContaining(['unknown', 'limit', 'state', 'requiredOne']),
    );
  });

  it('returns empty maps when nothing was declared', () => {
    const bare = fakeOperation({ method: 'GET', path: '/bare' });
    expect(validateRequest(bare, { query: {}, body: undefined })).toEqual({
      query: {},
      families: {},
      body: undefined,
    });
  });
});

function fakeOperation(overrides: Record<string, unknown>): ApiOperation {
  return {
    method: 'GET',
    path: '/test',
    summary: 'test',
    tag: 'jobs',
    policyKey: 'jobs.read',
    ...overrides,
  } as unknown as ApiOperation;
}

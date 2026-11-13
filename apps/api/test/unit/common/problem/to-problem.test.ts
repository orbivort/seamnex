import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  codeForStatus,
  GENERIC_500_DETAIL,
  httpDetail,
  toProblem,
} from '../../../../src/common/problem/to-problem';
import { AppError } from '../../../../src/common/problem/app-error';

describe('codeForStatus', () => {
  it.each([
    [400, 'VALIDATION_FAILED'],
    [422, 'VALIDATION_FAILED'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [405, 'METHOD_NOT_ALLOWED'],
    [409, 'STATE_CONFLICT'],
    [410, 'GONE'],
    [412, 'PRECONDITION_FAILED'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [429, 'RATE_LIMITED'],
    [503, 'UNAVAILABLE'],
  ] as const)('maps %i to %s', (status, code) => {
    expect(codeForStatus(status)).toBe(code);
  });

  it('maps every 5xx to INTERNAL_ERROR and any other 4xx to VALIDATION_FAILED', () => {
    for (const status of [500, 502, 504]) expect(codeForStatus(status)).toBe('INTERNAL_ERROR');
    for (const status of [402, 418]) expect(codeForStatus(status)).toBe('VALIDATION_FAILED');
  });
});

describe('httpDetail', () => {
  it('uses a string response unchanged', () => {
    expect(httpDetail(new HttpException('plain', 400))).toBe('plain');
  });

  it('joins an array message', () => {
    const exception = new HttpException({ message: ['first', 'second'] }, 400);
    expect(httpDetail(exception)).toBe('first; second');
  });

  it('stringifies an object message', () => {
    expect(httpDetail(new HttpException({ message: 'text' }, 400))).toBe('text');
  });

  it('falls back to the exception message when the response carries none', () => {
    expect(httpDetail(new HttpException({ error: 'Bad Request' }, 400))).toBe('Http Exception');
  });

  it('falls back for a response that is neither string nor object', () => {
    const exception = new HttpException('x', 400);
    // `getResponse` is the contract `httpDetail` relies on; overriding it isolates the fallback.
    Object.assign(exception, { getResponse: () => 42 });
    expect(httpDetail(exception)).toBe('x');
  });
});

describe('AppError', () => {
  it('keeps a cause for the operator while never rendering it to the client', () => {
    const cause = new Error('root cause with pg://user:pw@db');
    const withCause = new AppError({ code: 'INTERNAL_ERROR', detail: 'wrapped', cause });

    expect(withCause.cause).toBe(cause);
    expect(JSON.stringify(toProblem(withCause))).not.toContain('pw@db');

    const withoutCause = new AppError({ code: 'NOT_FOUND', detail: 'gone' });
    expect(withoutCause.cause).toBeUndefined();
    expect(withoutCause.name).toBe('AppError');
    expect(withoutCause.fieldErrors).toEqual([]);
  });
});

describe('toProblem', () => {
  it('keeps the caller status, detail, field errors and remediation of an AppError', () => {
    const problem = toProblem(
      new AppError({
        code: 'STATE_CONFLICT',
        status: 409,
        detail: 'cannot cancel',
        remediation: 'wait',
        fieldErrors: [{ field: 'state', code: 'invalid', message: 'bad' }],
      }),
    );

    expect(problem).toMatchObject({
      code: 'STATE_CONFLICT',
      status: 409,
      detail: 'cannot cancel',
      remediation: 'wait',
      fieldErrors: [{ field: 'state', code: 'invalid', message: 'bad' }],
    });
  });

  it('keeps the catalogue remediation when the AppError supplies none', () => {
    const problem = toProblem(new AppError({ code: 'NOT_FOUND', detail: 'gone' }));
    expect(problem.remediation).toBe('Check the identifier. A deleted resource is not readable.');
  });

  it('degrades an uncatalogued AppError code to a generic 500', () => {
    const problem = toProblem(new AppError({ code: 'NO_SUCH_CODE', detail: 'secret detail' }));
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).toBe(GENERIC_500_DETAIL);
    expect(JSON.stringify(problem)).not.toContain('secret detail');
  });

  it('maps a ZodError issue with an empty path to the body field', () => {
    const parsed = z.string().min(3).safeParse('x');
    if (parsed.success) throw new Error('expected the parse to fail');
    const problem = toProblem(parsed.error);
    expect(problem.code).toBe('VALIDATION_FAILED');
    expect(problem.fieldErrors?.[0]?.field).toBe('body');
  });

  it('hides a 5xx HttpException message', () => {
    const problem = toProblem(new HttpException('pg://user:pw@db', 503));
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(problem)).not.toContain('pw@db');
  });

  it('keeps a 4xx HttpException message', () => {
    const problem = toProblem(new NotFoundException('no such instance'));
    expect(problem).toMatchObject({ code: 'NOT_FOUND', status: 404, detail: 'no such instance' });
  });

  it('maps a Fastify-style plain error object by its statusCode', () => {
    expect(toProblem({ statusCode: 413, message: 'body too large' })).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
      detail: 'body too large',
    });
  });

  it('defaults the detail of a plain error with no message', () => {
    expect(toProblem({ statusCode: 400 })).toMatchObject({
      code: 'VALIDATION_FAILED',
      detail: 'The request was refused.',
    });
  });

  it('ignores a 5xx statusCode on a plain object and answers the generic 500', () => {
    const problem = toProblem({ statusCode: 502, message: 'upstream' });
    expect(problem.code).toBe('INTERNAL_ERROR');
    expect(problem.detail).toBe(GENERIC_500_DETAIL);
  });

  it('answers an unknown throwable with the generic 500', () => {
    for (const thrown of [new Error('boom'), 'text', 42]) {
      expect(toProblem(thrown)).toMatchObject({
        code: 'INTERNAL_ERROR',
        status: 500,
        detail: GENERIC_500_DETAIL,
      });
    }
  });

  it('accepts a 400 HttpException produced by Nest', () => {
    expect(toProblem(new BadRequestException(['a', 'b']))).toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 400,
      detail: 'a; b',
    });
  });
});

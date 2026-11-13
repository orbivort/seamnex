import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { NotFoundController } from '../../../../src/common/problem/not-found.controller';
import { AppError } from '../../../../src/common/problem/app-error';

describe('NotFoundController', () => {
  it('answers a path that is not a declared operation as NOT_FOUND', () => {
    const controller = new NotFoundController();
    const request = { method: 'GET', url: '/api/v1/nope' } as FastifyRequest;

    let error: unknown;
    try {
      controller.notFound(request);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('NOT_FOUND');
    expect((error as AppError).status).toBe(404);
    expect((error as AppError).detail).toBe('GET /api/v1/nope is not a declared operation.');
  });

  it('names the method of the missing route', () => {
    let error: unknown;
    try {
      new NotFoundController().notFound({ method: 'DELETE', url: '/x' } as FastifyRequest);
    } catch (caught) {
      error = caught;
    }
    expect((error as AppError).detail).toContain('DELETE');
  });
});

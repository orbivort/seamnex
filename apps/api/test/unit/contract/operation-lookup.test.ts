import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { operationForRequest } from '../../../src/contract/operation-lookup';
import { operationOf } from '../../support/operation-input';

function request(overrides: Record<string, unknown>): FastifyRequest {
  return { method: 'GET', ...overrides } as unknown as FastifyRequest;
}

describe('operationForRequest', () => {
  it('finds the declared operation behind a prefixed route template', () => {
    const found = operationForRequest(
      request({ method: 'GET', routeOptions: { url: '/api/v1/jobs' } }),
    );
    expect(found).toBe(operationOf('GET /jobs'));
  });

  it('finds an operation whose template carries a path parameter', () => {
    const found = operationForRequest(
      request({ method: 'GET', routeOptions: { url: '/api/v1/jobs/:id/logs' } }),
    );
    expect(found).toBe(operationOf('GET /jobs/:id/logs'));
  });

  it('normalises the method to upper case', () => {
    const found = operationForRequest(
      request({ method: 'post', routeOptions: { url: '/api/v1/jobs/:id/cancel' } }),
    );
    expect(found).toBe(operationOf('POST /jobs/:id/cancel'));
  });

  it('accepts a template that already omits the api prefix', () => {
    expect(
      operationForRequest(request({ method: 'GET', routeOptions: { url: '/jobs/:id' } })),
    ).toBe(operationOf('GET /jobs/:id'));
  });

  it('returns undefined when the route template is absent or not a string', () => {
    expect(operationForRequest(request({}))).toBeUndefined();
    expect(operationForRequest(request({ routeOptions: {} }))).toBeUndefined();
    expect(operationForRequest(request({ routeOptions: { url: 42 } }))).toBeUndefined();
  });

  it('returns undefined for a route that is not declared', () => {
    expect(
      operationForRequest(request({ method: 'GET', routeOptions: { url: '/api/v1/healthz' } })),
    ).toBeUndefined();
    expect(
      operationForRequest(request({ method: 'PUT', routeOptions: { url: '/api/v1/jobs' } })),
    ).toBeUndefined();
  });

  it('matches the template, not a concrete URL', () => {
    // A real id in the URL is not a declared template, so nothing is found and no guard applies.
    expect(
      operationForRequest(
        request({ method: 'GET', routeOptions: { url: '/api/v1/jobs/abc/logs' } }),
      ),
    ).toBeUndefined();
  });
});

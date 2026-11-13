import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProblemDetail } from '@seamnex/domain';
import {
  ApiError,
  configureTransport,
  lastKnownStatusAt,
  request,
  resetTransport,
  toProblem,
} from '../../src/http';
import type { Transport } from '../../src/transport';

/**
 * The pipeline's job is to turn every failure into a renderable `ProblemDetail`, because a screen
 * that receives `undefined` shows nothing at all. These cases go through the same `request` entry
 * point the screens use, with only the transport replaced — that seam exists for exactly this.
 */

afterEach(() => {
  // The transport is module state; a test that installed one must not leak it into the next.
  resetTransport();
});

function respond(response: Response): Transport {
  return async () => response;
}

function throwTransport(error: unknown): Transport {
  return async () => {
    throw error;
  };
}

/** Runs a request that must fail and returns the problem it was normalised to. */
async function problemOf(promise: Promise<unknown>): Promise<ProblemDetail> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error.problem;
    throw error;
  }
  throw new Error('expected the request to be rejected');
}

const problemDocument: ProblemDetail = {
  type: 'https://platform.seamnex.local/problems/rate-limited',
  title: 'Too many requests',
  status: 429,
  detail: 'The sign-in throttle is open.',
  code: 'RATE_LIMITED',
  fieldErrors: [],
  remediation: 'Wait a moment, then try again.',
};

describe('operation registry', () => {
  it('rejects a path the contract does not declare', async () => {
    const problem = await problemOf(request('/not-a-declared-route', {}));
    expect(problem.code).toBe('UNKNOWN_OPERATION');
    // A contract defect, not a user error: it must not render as a 4xx the operator can fix.
    expect(problem.status).toBe(500);
  });

  it('rejects a query parameter no operation declares', async () => {
    const problem = await problemOf(request('/instances?bogus=1', {}));
    expect(problem.code).toBe('REQUEST_CONTRACT');
    expect(problem.fieldErrors.map((entry) => entry.field)).toEqual(['bogus']);
  });

  it('rejects a body that does not satisfy the declared request schema', async () => {
    const problem = await problemOf(request('/instances', { method: 'POST', body: {} }));
    expect(problem.code).toBe('REQUEST_CONTRACT');
    expect(problem.fieldErrors.length).toBeGreaterThan(0);
  });
});

describe('failure normalisation', () => {
  it('turns a transport rejection into a retryable network problem', async () => {
    configureTransport(throwTransport(new TypeError('fetch failed')));
    const problem = await problemOf(request('/instances', {}));
    expect(problem.code).toBe('NETWORK_ERROR');
    expect(problem.status).toBe(503);
  });

  it('distinguishes a timeout from an unreachable API', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    configureTransport(throwTransport(timeout));
    const problem = await problemOf(request('/instances', {}));
    expect(problem.code).toBe('REQUEST_TIMEOUT');
    expect(problem.status).toBe(504);
  });

  it('keeps an abort an abort, so a cancelled request is not shown as a failure', async () => {
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    configureTransport(throwTransport(aborted));
    await expect(request('/instances', {})).rejects.toBe(aborted);
  });

  it('normalises an error response that is not problem+json', async () => {
    configureTransport(
      respond(new Response('gateway down', { status: 502, statusText: 'Bad Gateway' })),
    );
    const problem = await problemOf(request('/instances', {}));
    expect(problem.code).toBe('UNEXPECTED_RESPONSE');
    expect(problem.status).toBe(502);
    expect(problem.title).toBe('Bad Gateway');
  });

  it('passes a problem document through and keeps Retry-After', async () => {
    configureTransport(
      respond(
        new Response(JSON.stringify(problemDocument), {
          status: 429,
          headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '5' },
        }),
      ),
    );

    const error = await request('/instances', {}).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).problem).toEqual(problemDocument);
    expect((error as ApiError).retryAfterMs).toBe(5_000);
  });

  it('reports a JSON response that breaks its schema instead of returning it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    configureTransport(
      respond(new Response(JSON.stringify({ unexpected: true }), { status: 200 })),
    );

    const problem = await problemOf(
      request('/instances', { schema: z.object({ ok: z.boolean() }) }),
    );
    expect(problem.code).toBe('RESPONSE_CONTRACT');
    expect(problem.status).toBe(500);
    expect(logged).toHaveBeenCalledOnce();
  });
});

describe('success paths', () => {
  it('parses a response through the caller schema', async () => {
    configureTransport(respond(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    await expect(request('/instances', { schema: z.object({ ok: z.boolean() }) })).resolves.toEqual(
      {
        ok: true,
      },
    );
  });

  it('treats a 204 as an empty success rather than a contract failure', async () => {
    configureTransport(respond(new Response(null, { status: 204 })));
    await expect(request('/instances', {})).resolves.toBeUndefined();
  });
});

describe('storage-unavailable guards', () => {
  it('reports no last-success mark on a runtime without sessionStorage', () => {
    // Node has no `sessionStorage`; the guard is what keeps a browser-only API from throwing.
    expect(lastKnownStatusAt()).toBeNull();
  });

  it('narrows anything thrown to a problem', () => {
    expect(toProblem(new Error('boom')).code).toBe('NETWORK_ERROR');
    expect(toProblem('a string').code).toBe('NETWORK_ERROR');
  });
});

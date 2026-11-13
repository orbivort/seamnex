import { HttpException } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ProblemDetailSchema } from '@seamnex/domain';
import { AppError } from '../../src/common/problem/app-error';
import { problemFor } from '../../src/common/problem/problem-catalog';
import {
  problemHeadersFor,
  requestIdFor,
  sendProblem,
} from '../../src/common/problem/send-problem';
import { requestStore } from '../../src/common/logging/logger';

/**
 * One writer for every problem document: the filter, the contract dispatcher and the health
 * endpoints. There used to be two — the filter's and the dispatcher's — and they already disagreed
 * on how a request id is found. These tests pin the properties that made sharing worthwhile.
 */

type Captured = { status: number; headers: Record<string, string>; body: unknown };

function reply(): { reply: FastifyReply; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: undefined };
  const fake = {
    status(code: number) {
      captured.status = code;
      return fake;
    },
    header(name: string, value: string) {
      captured.headers[name] = value;
      return fake;
    },
    send(body: unknown) {
      captured.body = body;
      return fake;
    },
  };
  return { reply: fake as unknown as FastifyReply, captured };
}

describe('sendProblem', () => {
  it('writes the status, the problem media type and the request id', () => {
    const { reply: fake, captured } = reply();
    sendProblem(fake, {
      problem: problemFor('NOT_FOUND', { detail: 'No such job.' }),
      requestId: 'rid-1',
    });

    expect(captured.status).toBe(404);
    expect(captured.headers['content-type']).toContain('application/problem+json');
    expect(captured.headers['x-request-id']).toBe('rid-1');
    expect(ProblemDetailSchema.safeParse(captured.body).success).toBe(true);
  });

  it('carries the caller-computed headers — a throttle must reach the client with Retry-After', () => {
    const { reply: fake, captured } = reply();
    sendProblem(fake, {
      problem: problemFor('RATE_LIMITED', { detail: 'Too many attempts.' }),
      requestId: 'rid-2',
      headers: { 'retry-after': '42' },
    });

    expect(captured.status).toBe(429);
    expect(captured.headers['retry-after']).toBe('42');
  });

  it('takes response metadata off the error, and off nothing else', () => {
    const throttled = new AppError({
      code: 'RATE_LIMITED',
      detail: 'slow down',
      headers: { 'retry-after': '7' },
    });
    expect(problemHeadersFor(throttled)).toEqual({ 'retry-after': '7' });

    // A foreign HttpException has nowhere to put a header, which is why AppError.headers exists.
    expect(problemHeadersFor(new HttpException('nope', 403))).toEqual({});
    expect(problemHeadersFor(new Error('boom'))).toEqual({});
  });

  it('prefers the request id Fastify minted, then the ALS store, then the inbound header', () => {
    expect(requestIdFor({ requestId: 'rid-3', headers: {} })).toBe('rid-3');

    const fromStore = requestStore.run({ requestId: 'rid-store', role: 'api' }, () =>
      requestIdFor({ headers: {} }),
    );
    expect(fromStore).toBe('rid-store');

    expect(requestIdFor({ headers: { 'x-request-id': 'rid-4' } })).toBe('rid-4');
    expect(requestIdFor({ headers: {} })).toBe('unknown');
  });

  it('ignores a non-string request id and an empty one', () => {
    expect(requestIdFor({ requestId: 42, headers: { 'x-request-id': 'rid-5' } })).toBe('rid-5');
    expect(requestIdFor({ requestId: '', headers: { 'x-request-id': 'rid-6' } })).toBe('rid-6');
  });
});

import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX } from '../../../src/config/config';
import { RouteTableService } from '../../../src/contract/route-table';
import { operationOf, testContext } from '../../support/operation-input';

/**
 * The dispatcher's untaken arms: a Fastify request that carries no `query`/`params` object at all
 * (a route mounted without a schema leaves them undefined), an operation that declares no response
 * schema, and a non-Error fault raised after an SSE handler has already taken the socket.
 */
type Mounted = {
  method: string;
  url: string;
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

/**
 * A plain struct, deliberately not `FastifyReply & …`: `FastifyReply.sent` is a `boolean`, and
 * intersecting it with the double's `sent` array (`boolean & unknown[]`) reduces the whole type to
 * `never`. The Fastify surface the dispatcher writes through is re-asserted at the one call site.
 */
type ReplyDouble = {
  readonly headers: Record<string, unknown>;
  readonly statuses: number[];
  readonly sent: unknown[];
  raw: { headersSent: boolean };
};

function replyDouble(): ReplyDouble {
  const headers: Record<string, unknown> = {};
  const statuses: number[] = [];
  const sent: unknown[] = [];
  const reply = {
    headers,
    statuses,
    sent,
    raw: { headersSent: false },
    status(code: number) {
      statuses.push(code);
      return reply;
    },
    header(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    send(payload?: unknown) {
      sent.push(payload);
      return reply;
    },
  } as unknown as ReplyDouble;
  return reply;
}

/** A request with no `query` and no `params`: the shape Fastify leaves when nothing declared them. */
function bareRequest(): FastifyRequest {
  return {
    method: 'GET',
    url: '/api/v1/jobs',
    requestId: 'rid-bare',
    headers: {},
    body: undefined,
  } as unknown as FastifyRequest;
}

function harness(handler: (input: Record<string, unknown>) => Promise<unknown>) {
  const routes: Mounted[] = [];
  const server = { route: (route: Mounted) => routes.push(route) };
  const handlers = { size: 1, get: () => handler };
  const guards = {
    run: (_input: unknown, fn: (context: ReturnType<typeof testContext>) => Promise<unknown>) =>
      fn(testContext()),
  };
  const config = {
    isProduction: false,
    SESSION_COOKIE_NAME: 'seamnex_session',
    CSRF_COOKIE_NAME: 'seamnex_csrf',
    SESSION_COOKIE_SECURE: true,
    SESSION_COOKIE_DOMAIN: undefined,
  };

  const service = new RouteTableService(
    { httpAdapter: { getInstance: () => server } } as never,
    handlers as never,
    guards as never,
    config as never,
  );
  service.onModuleInit();

  async function dispatch(
    key: string,
    request: FastifyRequest = bareRequest(),
    reply: ReplyDouble = replyDouble(),
  ): Promise<ReplyDouble> {
    const operation = operationOf(key);
    const route = routes.find(
      (candidate) =>
        candidate.method === operation.method &&
        candidate.url === `/${API_PREFIX}${operation.path}`,
    );
    if (route === undefined) throw new Error(`${key} was not mounted`);
    // The double carries `status`/`header`/`send`/`raw` at runtime; the assertion is the single
    // place where it is handed to the dispatcher as a Fastify reply.
    await route.handler(request, reply as unknown as FastifyReply);
    return reply;
  }

  return { routes, dispatch };
}

describe('dispatch of a request without a declared surface', () => {
  it('reads an absent query and an absent params object as empty, not as a crash', async () => {
    const handler = vi.fn().mockResolvedValue({ kind: 'noContent' });
    const { dispatch } = harness(handler);

    const reply = await dispatch('GET /jobs/:id', bareRequest());

    const [input] = handler.mock.calls[0] as [{ query: unknown; params: unknown }];
    expect(input.query).toEqual({});
    expect(input.params).toEqual({});
    expect(reply.statuses).toEqual([204]);
  });
});

describe('an operation with no response schema', () => {
  it('writes the handler body untouched when the contract declares none', async () => {
    // `DELETE /workflows/:id` is `noContent`: had this arm returned a problem, a handler that
    // answers with a body would have been reported as a contract violation that has no schema.
    const body = { released: ['trigger-1', 'trigger-2'] };
    const { dispatch } = harness(async () => ({ kind: 'body', body }));

    const reply = await dispatch('DELETE /workflows/:id');

    expect(reply.statuses).toEqual([200]);
    expect(reply.sent[0]).toBe(body);
  });
});

describe('an error raised after the response started', () => {
  it('logs the string form of a non-Error fault and writes nothing', () => {
    const logged = vi.spyOn(Logger.prototype, 'error');
    const { dispatch } = harness(async () => {
      throw 'stream died';
    });
    const reply = replyDouble();
    reply.raw.headersSent = true;

    return dispatch('GET /jobs/:id/stream', bareRequest(), reply).then(() => {
      // The head is already on the wire: the only truthful place left for the fault is the log.
      expect(reply.statuses).toEqual([]);
      expect(reply.sent).toEqual([]);
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ err: 'stream died' }));
    });
  });
});

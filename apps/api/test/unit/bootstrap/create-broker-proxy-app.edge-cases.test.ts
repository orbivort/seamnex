import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import type {
  EgressRequest,
  EgressResponse,
  WorkflowEgressService,
} from '../../../src/modules/m25-workflow-egress/egress.contract';

/**
 * The broker listener's translations that an HTTP client cannot produce.
 *
 * `create-broker-proxy-app.test.ts` drives the listener through a real socket, which is the honest
 * path for everything a caller can send. Two shapes are unreachable that way and still matter: a
 * repeated header arrives from Fastify as an array, and a body parser registered by a later
 * deployment may hand back something that is neither bytes nor text. Neither may reach the egress
 * request as a guess, so the handler is captured here and driven directly.
 */
type Handler = (request: never, reply: never) => Promise<unknown>;

const h = vi.hoisted(() => {
  const handlers = new Map<string, Handler>();
  const app = {
    addContentTypeParser: vi.fn(),
    all: vi.fn((path: string, handler: Handler) => {
      handlers.set(path, handler);
    }),
    get: vi.fn(),
  };
  return { handlers, app };
});

vi.mock('fastify', () => ({ default: vi.fn(() => h.app) }));

const { createBrokerProxyApp } = await import('../../../src/bootstrap/create-broker-proxy-app');

const ROUTE = '/broker/:entryKey/:operation';

type FakeReply = {
  readonly headers: Record<string, string>;
  status?: number;
  sent?: unknown;
  header: (name: string, value: string) => FakeReply;
  code: (status: number) => FakeReply;
  send: (body: unknown) => FakeReply;
};

function fakeReply(): FakeReply {
  const reply: FakeReply = {
    headers: {},
    header(name, value) {
      reply.headers[name] = value;
      return reply;
    },
    code(status) {
      reply.status = status;
      return reply;
    },
    send(body) {
      reply.sent = body;
      return reply;
    },
  };
  return reply;
}

function egress(result: Partial<EgressResponse> = {}) {
  const forward = vi.fn(async (_input: EgressRequest): Promise<EgressResponse> => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from('{}', 'utf8'),
    ...result,
  }));
  return { forward, service: { forward, discoverFields: vi.fn() } as never };
}

function request(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    params: { entryKey: 'D07-01', operation: 'employees.read' },
    url: '/broker/D07-01/employees.read',
    method: 'GET',
    headers: {},
    body: undefined,
    ...over,
  };
}

async function dispatch(over: Record<string, unknown> = {}) {
  const handler = h.handlers.get(ROUTE);
  if (handler === undefined) throw new Error('the broker route was not registered');
  const reply = fakeReply();
  await handler(request(over) as never, reply as never);
  return reply;
}

beforeEach(() => {
  h.handlers.clear();
  h.app.all.mockClear();
});

describe('broker proxy header and body translation', () => {
  it('takes the first value of a repeated header', async () => {
    const { forward, service } = egress();
    createBrokerProxyApp(service as WorkflowEgressService, {} as AppConfig);

    await dispatch({
      headers: {
        authorization: ['Bearer first-token', 'Bearer second-token'],
        'content-type': ['application/json', 'text/plain'],
        accept: ['application/json', 'text/plain'],
      },
      body: Buffer.from('{}', 'utf8'),
    });

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'first-token',
        contentType: 'application/json',
        accept: 'application/json',
      }),
    );
  });

  it('sends no body when a parser hands back something it cannot relay as bytes', async () => {
    const { forward, service } = egress();
    createBrokerProxyApp(service as WorkflowEgressService, {} as AppConfig);

    await dispatch({ method: 'POST', body: { parsed: true } });

    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ body: null }));
  });

  it('refuses to invent a path when the router could not fill a parameter', async () => {
    const { forward, service } = egress();
    createBrokerProxyApp(service as WorkflowEgressService, {} as AppConfig);

    await dispatch({ params: {} });

    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ entryKey: '', operation: '' }));
  });

  it('answers an empty product body without a payload', async () => {
    const { service } = egress({ status: 204, headers: {}, body: null });
    createBrokerProxyApp(service as WorkflowEgressService, {} as AppConfig);

    const reply = await dispatch();

    expect(reply.status).toBe(204);
    expect(reply.sent).toBeUndefined();
  });
});

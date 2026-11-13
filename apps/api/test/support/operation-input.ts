import type { ApiOperation } from '@seamnex/domain';
import { API_OPERATIONS, operationKey } from '@seamnex/domain';
import type { FastifyReply } from 'fastify';
import type { OperationInput, OperationResult } from '../../src/contract/operation-handler';
import type { RequestContext } from '../../src/common/identity/request-context';

/**
 * Builds the value an `OperationHandler` receives, so a handler group can be tested as a plain
 * object graph: the group's constructor takes its services, `handlers()` returns the map, and each
 * entry is called with this input. No HTTP server, no Nest container.
 */
export function operationOf(key: string): ApiOperation {
  const found = API_OPERATIONS.find((candidate) => operationKey(candidate) === key);
  if (found === undefined) throw new Error(`no declared operation ${key}`);
  return found;
}

export function testContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: 'rid-test',
    processRole: 'api',
    subject: { idpId: 'sub-1', username: 'alice' },
    role: 'platform-admin',
    actorType: 'user',
    sessionId: 'sess-1',
    instanceId: null,
    scopes: [],
    mfaSatisfied: true,
    mfaMethod: 'totp',
    mfaAsserted: true,
    sessionExpiresAt: null,
    sessionIdleExpiresAt: null,
    csrfToken: 'csrf-token',
    groups: [],
    ...overrides,
  } as RequestContext;
}

export function operationInput(
  key: string,
  overrides: Partial<OperationInput> = {},
): OperationInput {
  return {
    operation: operationOf(key),
    params: {},
    query: {},
    families: {},
    body: undefined,
    headers: {},
    cookies: {},
    context: testContext(),
    requestId: 'rid-test',
    reply: replyDouble(),
    ...overrides,
  };
}

export type ReplyDouble = FastifyReply & {
  readonly statuses: number[];
  readonly headers: Record<string, string>;
  readonly written: string[];
};

/** Records what a streaming handler does to the reply instead of hijacking a real socket. */
export function replyDouble(): ReplyDouble {
  const statuses: number[] = [];
  const headers: Record<string, string> = {};
  const written: string[] = [];
  const reply = {
    statuses,
    headers,
    written,
    status: (code: number) => {
      statuses.push(code);
      return reply;
    },
    header: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    raw: {
      writeHead: (code: number, values: Record<string, string> = {}) => {
        statuses.push(code);
        for (const [name, value] of Object.entries(values)) headers[name.toLowerCase()] = value;
        return reply.raw;
      },
      write: (chunk: string) => {
        written.push(chunk);
        return true;
      },
      end: () => undefined,
      on: () => undefined,
      destroy: () => undefined,
      writableEnded: false,
    },
    send: (payload: unknown) => {
      written.push(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return reply;
    },
    hijack: () => undefined,
  } as unknown as ReplyDouble;
  return reply;
}

/** Calls one handler from a group and asserts it exists. */
export async function callHandler(
  handlers: ReadonlyMap<string, (input: OperationInput) => Promise<OperationResult>>,
  key: string,
  input: OperationInput = operationInput(key),
): Promise<OperationResult> {
  const handler = handlers.get(key);
  if (handler === undefined) throw new Error(`${key} is not implemented by this group`);
  return handler(input);
}

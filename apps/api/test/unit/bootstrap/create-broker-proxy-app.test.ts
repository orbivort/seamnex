import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config';
import type {
  EgressRequest,
  EgressResponse,
  WorkflowEgressService,
} from '../../../src/modules/m25-workflow-egress/egress.contract';
import { createBrokerProxyApp } from '../../../src/bootstrap/create-broker-proxy-app';

/**
 * AD-10 / 4E.4 — the only listener n8n can reach.
 *
 * The compiled node carries an operation id and a token, nothing else: the entry key and the
 * operation are path segments, and the payload is relayed as the bytes the previous node produced.
 * Re-serialising it here would be a second, silent representation of the item the author mapped, so
 * these tests assert the bytes, not a parsed object.
 */
const apps: { close: () => Promise<void> }[] = [];

function makeService(result?: Partial<EgressResponse>) {
  const forward = vi.fn(async (_input: EgressRequest): Promise<EgressResponse> => ({
    status: 200,
    headers: {},
    body: null,
    ...result,
  }));
  const service: WorkflowEgressService = {
    forward,
    discoverFields: vi.fn(),
  } as unknown as WorkflowEgressService;
  return { service, forward };
}

const CONFIG = {} as unknown as AppConfig;

function build(service: WorkflowEgressService) {
  const app = createBrokerProxyApp(service, CONFIG);
  apps.push(app);
  return app;
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('broker proxy listener', () => {
  it('turns the path, headers and bytes into one egress request', async () => {
    const { service, forward } = makeService();
    const app = build(service);
    const payload = '{"emailAddress":"ops@northwind.example","custom":{"n":1}}';

    await app.inject({
      method: 'POST',
      url: '/broker/D01-01/contacts.write?select=emailAddress',
      headers: {
        authorization: 'Bearer seamnex_token',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      payload,
    });

    expect(forward).toHaveBeenCalledWith({
      token: 'seamnex_token',
      entryKey: 'D01-01',
      operation: 'contacts.write',
      method: 'POST',
      query: '?select=emailAddress',
      contentType: 'application/json',
      accept: 'application/json',
      body: Buffer.from(payload, 'utf8'),
    });
  });

  it('sends no query, no body and no token when the caller carried none', async () => {
    const { service, forward } = makeService();
    const app = build(service);

    await app.inject({ method: 'GET', url: '/broker/D07-01/employees.read' });

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({
        token: null,
        query: '',
        contentType: null,
        accept: null,
        body: null,
      }),
    );
  });

  it('does not read a non-Bearer authorization header as a token', async () => {
    const { service, forward } = makeService();
    const app = build(service);

    await app.inject({
      method: 'GET',
      url: '/broker/D07-01/employees.read',
      headers: { authorization: 'Basic YWRtaW46c2VjcmV0' },
    });

    expect(forward).toHaveBeenCalledWith(expect.objectContaining({ token: null }));
  });

  it('relays a text body as UTF-8 bytes even though the parser hands it a string', async () => {
    const { service, forward } = makeService();
    const app = build(service);

    await app.inject({
      method: 'POST',
      url: '/broker/D09-01/work_packages.write',
      headers: { 'content-type': 'text/plain' },
      payload: 'subject=hello',
    });

    expect(forward).toHaveBeenCalledWith(
      expect.objectContaining({ body: Buffer.from('subject=hello', 'utf8') }),
    );
  });

  it('answers with the product status, its headers and its body', async () => {
    const { service } = makeService({
      status: 201,
      headers: { 'content-type': 'application/json', 'x-product': 'espo' },
      body: Buffer.from('{"id":"1"}', 'utf8'),
    });
    const app = build(service);

    const response = await app.inject({ method: 'POST', url: '/broker/D01-01/contacts.write' });

    expect(response.statusCode).toBe(201);
    expect(response.headers['x-product']).toBe('espo');
    expect(response.body).toBe('{"id":"1"}');
  });

  it('answers an empty body without inventing one', async () => {
    const { service } = makeService({ status: 204, body: null });
    const app = build(service);

    const response = await app.inject({
      method: 'DELETE',
      url: '/broker/D09-01/work_packages.delete',
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('relays a refused call unchanged so the run panel can show the product answer', async () => {
    const { service } = makeService({
      status: 403,
      headers: { 'content-type': 'application/problem+json' },
      body: Buffer.from('{"code":"FORBIDDEN"}', 'utf8'),
    });
    const app = build(service);

    const response = await app.inject({ method: 'GET', url: '/broker/D07-01/employees.read' });

    expect(response.statusCode).toBe(403);
    expect(response.body).toBe('{"code":"FORBIDDEN"}');
  });

  it('answers a health probe without calling the broker', async () => {
    const { service, forward } = makeService();
    const app = build(service);

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(forward).not.toHaveBeenCalled();
  });
});

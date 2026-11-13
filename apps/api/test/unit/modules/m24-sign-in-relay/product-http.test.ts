import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { productFetch } from '../../../../src/modules/m24-sign-in-relay/product-http';

/**
 * The transport exists because `fetch` silently drops the caller's `Host` (a forbidden request
 * header) and regenerates it from the URL. Measured on OpenProject 17.9.6: with the container alias
 * as the host, Apache serves its `_default_` vhost — `404` for `/api/v3` and a placeholder page for
 * `/login` — so nothing the relay does can reach the product. These tests pin the behaviour that
 * fixes it, against a real socket rather than a stubbed fetch.
 */
let server: Server | null = null;

afterEach(async () => {
  const running = server;
  server = null;
  if (running !== null) await new Promise<void>((resolve) => running.close(() => resolve()));
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function serve(
  handler: Handler,
): Promise<{ origin: string; seen: { host: string | null; path: string }[] }> {
  const seen: { host: string | null; path: string }[] = [];
  const instance = createServer((request, response) => {
    seen.push({ host: request.headers.host ?? null, path: request.url ?? '' });
    handler(request, response);
  });
  server = instance;
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
  const address = instance.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { origin: `http://127.0.0.1:${address.port}`, seen };
}

describe('productFetch', () => {
  it('sends the Host the caller asked for', async () => {
    const { origin, seen } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('body');
    });

    await productFetch(`${origin}/login`, {
      method: 'GET',
      redirect: 'manual',
      headers: { host: 'openproject.localhost', accept: 'text/html' },
    });

    expect(seen[0]?.host).toBe('openproject.localhost');
  });

  it('returns a redirect instead of following it, with every Set-Cookie kept', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(302, {
        location: '/after',
        'set-cookie': ['a=1; Path=/; HttpOnly', 'b=2; Path=/'],
      });
      response.end();
    });

    const response = await productFetch(`${origin}/login`, { method: 'GET', redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/after');
    expect(response.headers.getSetCookie()).toEqual(['a=1; Path=/; HttpOnly', 'b=2; Path=/']);
  });

  it('reads the body and the status a caller classifies on', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(422, { 'content-type': 'text/html' });
      response.end('<form data-test-selector="user-login--form"></form>');
    });

    const response = await productFetch(`${origin}/login`, {
      method: 'POST',
      body: new URLSearchParams({ username: 'someone' }),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });

    expect(response.status).toBe(422);
    expect(await response.text()).toContain('user-login--form');
  });

  it('accepts a URL object and defaults the method to GET', async () => {
    const { origin, seen } = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });

    const response = await productFetch(new URL(`${origin}/healthz`));

    expect(response.status).toBe(200);
    expect(seen[0]?.path).toBe('/healthz');
  });

  it('writes a string body and derives its length when the caller did not', async () => {
    const lengths: (string | undefined)[] = [];
    const { origin, seen } = await serve((request, response) => {
      lengths.push(request.headers['content-length'] as string | undefined);
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });

    const response = await productFetch(`${origin}/api/v3/users`, {
      method: 'POST',
      body: JSON.stringify({ login: 'jdoe' }),
      headers: { 'content-type': 'application/json' },
    });

    expect(await response.json()).toEqual({ ok: true });
    expect(lengths[0]).toBe(String(Buffer.byteLength('{"login":"jdoe"}', 'utf8')));
    expect(seen[0]?.path).toBe('/api/v3/users');
  });

  it('writes a binary body without re-encoding it', async () => {
    const bodies: string[] = [];
    const { origin } = await serve((request, response) => {
      request.on('data', (chunk: Buffer) => bodies.push(chunk.toString('utf8')));
      request.on('end', () => {
        response.writeHead(204);
        response.end();
      });
    });

    const response = await productFetch(`${origin}/upload`, {
      method: 'POST',
      body: new Uint8Array(Buffer.from('bytes', 'utf8')),
    });

    expect(response.status).toBe(204);
    expect(bodies.join('')).toBe('bytes');
  });

  it('refuses a body type it cannot encode', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    // The two callers send form bodies only; anything else is a programming error worth hearing.
    await expect(
      productFetch(`${origin}/login`, { method: 'POST', body: 42 as unknown as string }),
    ).rejects.toThrow(TypeError);
  });

  it('reads a Headers instance and an array of header pairs', async () => {
    const hosts: (string | undefined)[] = [];
    const { origin } = await serve((request, response) => {
      hosts.push(request.headers.host);
      response.writeHead(200);
      response.end();
    });

    await productFetch(`${origin}/one`, { headers: new Headers({ host: 'first.localhost' }) });
    await productFetch(`${origin}/two`, { headers: [['host', 'second.localhost']] });

    expect(hosts).toEqual(['first.localhost', 'second.localhost']);
  });

  it('answers a bodyless status with an empty response body', async () => {
    const { origin } = await serve((_request, response) => {
      response.writeHead(204);
      response.end();
    });

    const response = await productFetch(`${origin}/users/9`, { method: 'PATCH' });

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe('');
  });

  it('rejects an already-aborted signal without opening a connection', async () => {
    const { origin, seen } = await serve((_request, response) => {
      response.writeHead(200);
      response.end();
    });

    await expect(
      productFetch(`${origin}/login`, { signal: AbortSignal.abort() }),
    ).rejects.toThrow();

    expect(seen).toHaveLength(0);
  });

  it('destroys an in-flight request when the caller aborts', async () => {
    const { origin } = await serve(() => {
      // Deliberately never answers: the point is the abort, not the response.
    });
    const controller = new AbortController();

    const pending = productFetch(`${origin}/slow`, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toThrow();
  });

  it('surfaces a transport failure instead of inventing a response', async () => {
    // Plain HTTP on the other end of an `https:` URL: the handshake fails, and the caller must see
    // that as a thrown error rather than as an empty 200.
    const { origin } = await serve((_request, response) => {
      response.writeHead(200);
      response.end('plain');
    });

    await expect(productFetch(origin.replace('http:', 'https:'))).rejects.toThrow();
  });
});

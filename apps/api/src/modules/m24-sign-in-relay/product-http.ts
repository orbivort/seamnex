import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * A `fetch` that actually sends the `Host` header.
 *
 * `globalThis.fetch` is undici, and the Fetch standard lists `Host` as a *forbidden request header*:
 * the value is dropped and the header is regenerated from the URL. Both calls in this module exist
 * only because the platform reaches the product by its container alias (`http://openproject:80`)
 * while the product answers exclusively for its public name (`OPENPROJECT_HOST__NAME`), so the two
 * cannot be the same string — and with the alias as the host Apache serves its `_default_` vhost,
 * which answers `404` for `/api/v3` and a "currently expects to be reached on the following domain"
 * placeholder for `/login`.
 *
 * Measured on 17.9.6: `Host: openproject.localhost` → `401` from `/api/v3`; `Host: openproject` →
 * `404` from the same path, and `fetch` with `headers: { host: 'openproject.localhost' }` sends
 * `Host: 127.0.0.1:9099`. Nothing in the caller can override a forbidden header, so the transport
 * is replaced instead of the header being passed more emphatically.
 *
 * The surface is `fetch`-shaped on purpose: the driver and the API client already speak it, their
 * tests inject a stub through `DriverOptions.fetch`, and this file stays the only place that knows
 * how the bytes leave the process.
 */
export const productFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const target = new URL(typeof input === 'string' ? input : input.toString());
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;

  const method = init?.method ?? 'GET';
  const body = encodeBody(init?.body);
  // Read as a plain object: `Headers` is where the forbidden-header rule lives, and rebuilding the
  // caller's headers through it would drop the one header that matters.
  const headers = plainHeaders(init?.headers);
  if (body !== null && headers['content-length'] === undefined) {
    headers['content-length'] = String(body.byteLength);
  }

  const signal = init?.signal ?? null;
  const response = await new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: Buffer;
  }>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException('This operation was aborted', 'AbortError'));
      return;
    }
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method,
        headers,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          });
        });
        incoming.on('error', reject);
      },
    );
    const abort = (): void => {
      request.destroy(new DOMException('This operation was aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    request.on('close', () => signal?.removeEventListener('abort', abort));
    request.on('error', reject);
    if (body !== null) request.write(body);
    request.end();
  });

  const responseHeaders = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    // `set-cookie` is an array and the handoff re-emits each cookie verbatim, so appending one by
    // one is what keeps `getSetCookie()` faithful.
    if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
    else responseHeaders.append(name, value);
  }

  const bodyless = response.status === 204 || response.status === 304 || response.body.length === 0;
  return new Response(bodyless ? null : response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}) as unknown as typeof globalThis.fetch;

function encodeBody(body: RequestInit['body']): Buffer | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  // The two callers send form bodies only; anything else is a programming error worth hearing.
  throw new TypeError('productFetch accepts a string or URLSearchParams body');
}

function plainHeaders(headers: RequestInit['headers']): Record<string, string> {
  if (headers === undefined || headers === null) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

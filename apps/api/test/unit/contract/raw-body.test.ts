import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { captureRawBody, rawBodyOf } from '../../../src/contract/raw-body';

/**
 * FR-5.4: the signature covers the bytes that arrived, so the capture has to be exact and
 * transparent. Two failure modes matter more than any other: the tee eating the body (the parser
 * then sees nothing, and the request fails for the wrong reason) and the copy drifting from what the
 * parser read (every signature would mismatch, for ever, with nothing to blame).
 */
function hook(request: object, payload: Readable, limit?: number) {
  return new Promise<{ chunks: Buffer[]; raw: Buffer | null }>((resolve, reject) => {
    const handler = captureRawBody(limit);
    // The hook's parameters are Fastify's; this test drives only the request, the payload and the
    // callback, which is the whole contract the route table relies on.
    const done = (error: Error | null, stream: Readable): void => {
      if (error) {
        reject(error);
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve({ chunks, raw: rawBodyOf(request as never) }));
    };
    // The hook is typed as a method of the Fastify instance; it reads none of it.
    handler.call({} as never, request as never, {} as never, payload, done as never);
  });
}

describe('captureRawBody', () => {
  it('passes the bytes through untouched and keeps an identical copy', async () => {
    const body = Buffer.from('{"order":1,"note":"café"}', 'utf8');

    const { chunks, raw } = await hook({}, Readable.from([body]));

    // The parser must receive exactly what the sender wrote: no re-serialisation, no re-encoding.
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
    expect(raw?.equals(body)).toBe(true);
  });

  it('reassembles a body that arrives in several chunks', async () => {
    const body = Buffer.from('{"a":1,"b":2}', 'utf8');
    const parts = [body.subarray(0, 3), body.subarray(3, 9), body.subarray(9)];

    const { raw } = await hook({}, Readable.from(parts));

    expect(raw?.toString('utf8')).toBe('{"a":1,"b":2}');
  });

  it('records nothing but still forwards a body past the ceiling', async () => {
    const body = Buffer.from('0123456789', 'utf8');

    const { chunks, raw } = await hook({}, Readable.from([body]), 4);

    // Truncating would produce a signature mismatch that blames the sender; Fastify's own 413 is the
    // answer for an oversized body. The handler's `rawBody ?? empty` then fails the HMAC closed.
    expect(raw).toBeNull();
    expect(Buffer.concat(chunks).toString('utf8')).toBe('0123456789');
  });

  it('propagates a source failure to the parser instead of hanging', async () => {
    const payload = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });

    await expect(hook({}, payload)).rejects.toThrow('connection reset');
  });

  it('leaves a request it never saw without a capture', () => {
    expect(rawBodyOf({} as never)).toBeNull();
  });

  it('keeps the copy of each request to itself', async () => {
    const first = {};
    const second = {};

    await Promise.all([
      hook(first, Readable.from([Buffer.from('one')])),
      hook(second, Readable.from([Buffer.from('two')])),
    ]);

    expect(rawBodyOf(first as never)?.toString('utf8')).toBe('one');
    expect(rawBodyOf(second as never)?.toString('utf8')).toBe('two');
  });
});

/**
 * The route table attaches the capture as a route-level `preParsing` hook. If Fastify did not run it
 * — or ran it after the JSON parser had already drained the stream — the delivery handler would get
 * `null` and every signature would fail. This is the one assertion that proves the wiring works in a
 * real server, not just against a stubbed hook signature.
 */
describe('captureRawBody in a mounted route', () => {
  it('gives the parser the document and the handler the original bytes', async () => {
    const server = Fastify();
    const seen: { raw?: Buffer | null; body?: unknown } = {};

    server.route({
      method: 'POST',
      url: '/delivery',
      preParsing: captureRawBody(),
      handler: async (request) => {
        seen.raw = rawBodyOf(request);
        seen.body = request.body;
        return { ok: true };
      },
    });

    // Deliberately not canonical JSON: whitespace and key order are exactly what a sender signs,
    // and exactly what re-serialising the parsed body would destroy.
    const payload = '{"order":1,  "note":"café"}';
    const response = await server.inject({
      method: 'POST',
      url: '/delivery',
      payload,
      headers: { 'content-type': 'application/json' },
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(seen.raw?.toString('utf8')).toBe(payload);
    expect(seen.body).toEqual({ order: 1, note: 'café' });
  });

  it('leaves a route that did not declare it without a capture', async () => {
    const server = Fastify();

    server.route({
      method: 'POST',
      url: '/plain',
      handler: async (request) => ({ captured: rawBodyOf(request) !== null }),
    });

    const response = await server.inject({
      method: 'POST',
      url: '/plain',
      payload: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    });
    await server.close();

    expect(response.json()).toEqual({ captured: false });
  });
});

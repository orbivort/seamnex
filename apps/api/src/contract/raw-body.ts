import { Transform, type TransformCallback } from 'node:stream';
import type { FastifyRequest, preParsingHookHandler } from 'fastify';

/**
 * FR-5.4 delivery authentication: a webhook signature is computed over the bytes that arrived, so
 * the handler cannot be given the parsed body and asked to sign it. Re-serialising a parsed object
 * changes key order and whitespace, so the signature would never match — and a sender has no way to
 * know which of the two forms the platform used.
 *
 * Only operations that declare `rawBody: true` get this hook. A global content-type parser would
 * change body handling (and error documents) for every JSON route in the product.
 */

/**
 * The ceiling matches the route table's `bodyLimit` (1 MiB), so a payload that would be truncated
 * here is refused by Fastify with `413` before it gets this far. Keeping the value explicit means a
 * future increase to `bodyLimit` cannot silently turn a large delivery into a truncated buffer and
 * a "signature mismatch" that blames the sender.
 */
export const RAW_BODY_LIMIT_BYTES = 1_048_576;

const captured = new WeakMap<FastifyRequest, Buffer>();

/** The bytes this request arrived with, or `null` when nothing was captured. */
export function rawBodyOf(request: FastifyRequest): Buffer | null {
  return captured.get(request) ?? null;
}

/**
 * A route-level `preParsing` hook that tees the stream: the parser still receives every byte, and a
 * copy is kept for the handler. The copy is taken in `_transform`, i.e. *while* the parser pulls,
 * not from a `data` listener — a listener would switch the stream to flowing mode and consume the
 * body before Fastify's JSON parser ever saw it.
 */
export function captureRawBody(limit = RAW_BODY_LIMIT_BYTES): preParsingHookHandler {
  return (request, _reply, payload, done) => {
    const tee = new RawBodyTee(limit, (body) => captured.set(request, body));
    payload.on('error', (error: Error) => tee.destroy(error));
    payload.pipe(tee);
    done(null, tee);
  };
}

class RawBodyTee extends Transform {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  private overflowed = false;

  constructor(
    private readonly limit: number,
    private readonly onCaptured: (body: Buffer) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.size += chunk.length;
    /*
     * Past the ceiling the copy is abandoned rather than truncated: a truncated buffer produces a
     * signature mismatch, and the handler answers one indistinguishable 401 instead of implying the
     * sender's payload was too large (Fastify's own `413` is the answer for that, and it happens
     * first). The bytes still flow, so parsing and the response are unaffected.
     */
    if (this.size <= this.limit) this.chunks.push(Buffer.from(chunk));
    else this.overflowed = true;
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    if (!this.overflowed) this.onCaptured(Buffer.concat(this.chunks));
    callback();
  }
}

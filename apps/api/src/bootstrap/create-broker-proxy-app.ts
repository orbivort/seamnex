import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/config';
import type { WorkflowEgressService } from '../modules/m25-workflow-egress/egress.contract';

/**
 * 4E.4 — the broker listener, owned by the `broker-proxy` role.
 *
 * Not part of the `/api/v1` contract: the caller is n8n, the credential is a workflow token, and
 * mounting it under the product API surface would let a browser reach the same door with a cookie.
 *
 * The path is the operation, never a URL: `/broker/{entryKey}/{operation}`. A compiled node that
 * named its own host would be a node that can be pointed anywhere — the two failures this endpoint
 * exists to remove (`$json.baseUrl`, `$json.credentialId`) were exactly that.
 */
export function createBrokerProxyApp(
  service: WorkflowEgressService,
  _config: AppConfig,
): FastifyInstance {
  const app = Fastify({ logger: false, disableRequestLogging: true, bodyLimit: 5 * 1024 * 1024 });

  /*
   * JSON is kept as bytes: n8n built this body from the previous node's item, and re-serialising it
   * here would be a second, silent representation of the payload the author mapped (FR-5.5).
   */
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) =>
    done(null, body),
  );

  app.all('/broker/:entryKey/:operation', async (request, reply) => {
    const params = request.params as { entryKey?: string; operation?: string };
    const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    const contentType = headerValue(request.headers['content-type']);
    const authorization = headerValue(request.headers.authorization);

    const result = await service.forward({
      token: bearer(authorization),
      entryKey: params.entryKey ?? '',
      operation: params.operation ?? '',
      method: request.method,
      query,
      contentType: contentType ?? null,
      accept: headerValue(request.headers.accept) ?? null,
      body: request.body === undefined || request.body === null ? null : bodyBuffer(request.body),
    });

    for (const [name, value] of Object.entries(result.headers)) reply.header(name, value);
    return reply.code(result.status).send(result.body === null ? undefined : result.body);
  });

  app.get('/healthz', async (_request, reply) => reply.code(200).send({ status: 'ok' }));

  return app;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function bearer(value: string | undefined): string | null {
  if (value === undefined) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * The bytes n8n sent. The JSON parser above keeps them verbatim; form and text bodies arrive as
 * strings. Anything else is a caller the broker has no reason to reshape, so it is refused by the
 * product's own `content-type` handling rather than guessed at.
 */
function bodyBuffer(body: unknown): Buffer | null {
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return null;
}

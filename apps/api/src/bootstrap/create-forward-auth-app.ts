import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/config';
import type { ForwardAuthService } from '../modules/m11-forward-auth/forward-auth.contract';
import { parseCookies } from '../common/http/cookies';
import { handleLaunchBootstrap, LAUNCH_BOOTSTRAP_PATH } from '../common/launch/bootstrap';

/** The edge talks to a fixed port on the internal network, not to the public API. */
export const FORWARD_AUTH_PORT = 8090;

/**
 * 4D.4 - the forward-auth listener, owned by the `auth-gateway` role.
 *
 * It is deliberately **not** part of the `/api/v1` contract: it is an edge protocol (Traefik's
 * forwardAuth), not a platform operation, and mounting it inside the API would let a browser call it
 * and let the route-parity guard treat an infrastructure endpoint as product surface.
 *
 * The response is Traefik's contract, not `application/problem+json`: `2xx` plus identity headers, or
 * `401` with no body. Anything else makes the edge return `500` and looks like a platform outage.
 */
export function createForwardAuthApp(
  service: ForwardAuthService,
  config: AppConfig,
): FastifyInstance {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  app.get('/verify', async (request, reply) => {
    const host =
      headerValue(request.headers['x-forwarded-host']) ?? headerValue(request.headers.host) ?? '';
    const path = headerValue(request.headers['x-forwarded-uri']) ?? request.url;
    const cookie = parseCookies(request.headers.cookie)[config.SESSION_COOKIE_NAME] ?? null;

    const decision = await service.decide({ host, path, sessionId: cookie });

    if (!decision.allow) {
      // A body would be rendered by the product's error page; the reason goes to the edge log instead.
      request.log.warn({ host, path, reason: decision.reason }, 'forward-auth denied');
      return reply.code(401).send();
    }
    for (const [name, value] of Object.entries(decision.headers)) {
      reply.header(name, value);
    }
    return reply.code(204).send();
  });

  /*
   * The launch bootstrap: `/__seamnex/session?ticket=…` on a product host. It is the one request on a
   * gated route that cannot be forward-authenticated — the whole point is that the browser does not
   * yet hold the cookie — so the projection routes it straight here (no auth middleware).
   *
   * The hop itself lives in `common/launch/bootstrap` because the relay role serves the same request
   * with one extra step (ADR-BE-22). A deployment that never enables the relay still reaches this
   * handler, and its behaviour is the same: plant `seamnex_session`, redirect to the product root.
   */
  app.get(LAUNCH_BOOTSTRAP_PATH, async (request, reply) => {
    const host =
      headerValue(request.headers['x-forwarded-host']) ?? headerValue(request.headers.host) ?? '';
    const query = (request.query ?? {}) as { ticket?: unknown };
    const ticket = typeof query.ticket === 'string' ? query.ticket : '';

    return handleLaunchBootstrap(reply, {
      ticket,
      host,
      cookieName: config.SESSION_COOKIE_NAME,
      cookieSecure: config.SESSION_COOKIE_SECURE,
      redeem: (input) => service.redeem(input),
    });
  });

  app.get('/healthz', async (_request, reply) => reply.code(200).send({ status: 'ok' }));

  return app;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

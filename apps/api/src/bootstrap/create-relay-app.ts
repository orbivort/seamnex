import { Logger } from '@nestjs/common';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '../config/config';
import type { ForwardAuthService } from '../modules/m11-forward-auth/forward-auth.contract';
import type { SignInRelay } from '../modules/m24-sign-in-relay/relay.contract';
import { publicOriginFor } from '../modules/m24-sign-in-relay/relay-origin';
import { handleLaunchBootstrap, LAUNCH_BOOTSTRAP_PATH } from '../common/launch/bootstrap';

/**
 * ADR-BE-22 — the launch hop with the sign-in relay in it, owned by the `relay` role.
 *
 * It serves the *same* path as the auth gateway (`/__seamnex/session`), and that is the point: the
 * route projection names one bootstrap origin per deployment, and switching it from
 * `http://auth-gateway:8090` to `http://relay:8091` is the whole wiring change. A deployment that
 * does not set the relay up keeps the gateway, where the hop behaves exactly as it always has.
 *
 * The relay step is allowed to do nothing or to fail. Either way the browser receives
 * `seamnex_session` and is redirected to the product root, so the worst outcome is the login page
 * the user sees today — never a broken launch.
 */
export function createRelayApp(
  service: ForwardAuthService,
  relay: SignInRelay,
  config: AppConfig,
  logger: Logger = new Logger('m24-relay-launch'),
): FastifyInstance {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  app.get(LAUNCH_BOOTSTRAP_PATH, async (request, reply) => {
    const host =
      headerValue(request.headers['x-forwarded-host']) ?? headerValue(request.headers.host) ?? '';
    const query = (request.query ?? {}) as { ticket?: unknown };
    const ticket = typeof query.ticket === 'string' ? query.ticket : '';

    /*
     * A refused launch returns the same `401` whatever the reason, so the response cannot say why.
     * Without a log line a replayed or expired ticket — and a launch hop pointed at the wrong role —
     * left no trace at all (NFR-4.8). The ticket value is never logged: it is a single-use
     * credential, and a log is a copy of it.
     */
    if (ticket.length === 0) {
      logger.warn({ host, status: 401 }, 'launch hop was called without a ticket');
    }

    return handleLaunchBootstrap(reply, {
      ticket,
      host,
      cookieName: config.SESSION_COOKIE_NAME,
      cookieSecure: config.SESSION_COOKIE_SECURE,
      redeem: async (input) => {
        const redemption = await service.redeem(input);
        if (redemption === null) {
          logger.warn(
            { host: input.host, status: 401 },
            'launch ticket was refused: unknown, expired or bound to another route',
          );
        }
        return redemption;
      },
      relay: async ({ redemption, host: routeHost }) => {
        const outcome = await relay.attempt({
          instanceId: redemption.instanceId,
          subjectIdpId: redemption.subjectIdpId,
          routeHost,
          publicOrigin: publicOriginFor(config, routeHost),
        });
        // `relayed` and `reused` carry cookies; `skipped` and `failed` carry the fallback. The
        // reason is already audited by the service; nothing about it belongs in the response.
        return outcome.kind === 'relayed' || outcome.kind === 'reused' ? outcome.cookies : [];
      },
    });
  });

  app.get('/healthz', async (_request, reply) => reply.code(200).send({ status: 'ok' }));

  return app;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

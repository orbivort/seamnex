import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppModule } from '../app.module';
import { API_PREFIX, type AppConfig } from '../config/config';
import { resolveRequestId } from '../common/request-id';
import { createLogger, type Logger } from '../common/logging/logger';
import { pinoAdapter } from '../common/logging/nest-logger';
import { maskDeep } from '../common/logging/masking';
import { METRICS } from '../common/metrics/metrics';
import type { Metrics } from '../common/metrics/metrics';

type RequestWithId = FastifyRequest & { requestId?: string; startedAt?: bigint };

export { API_PREFIX };

/**
 * The metric label for a request.
 *
 * `request.routeOptions.url` is Fastify's own route template (`/api/v1/jobs/:id/stream`), which is
 * bounded by the contract. The first version normalised `request.url` by hand: it caught UUIDs and
 * nothing else, so the `@All('*')` catch-all turned every request to `/api/v1/<anything>` into a
 * new label value on two metrics — unbounded cardinality, sized by anonymous traffic.
 */
export function routeTemplate(request: FastifyRequest): string {
  const template = (request as FastifyRequest & { routeOptions?: { url?: string } }).routeOptions
    ?.url;
  // A request that never reached a route is labelled once, not per URL. The previous version
  // passed `request.url` through a UUID-only normaliser, so anonymous traffic to
  // `/api/v1/<random>` minted a new label value per request.
  return template ?? '(unmatched)';
}

export async function createApplication(
  config: AppConfig,
  processLogger?: Logger,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    logger: false,
    // `X-Forwarded-For` is attacker-controlled unless the peer is the edge (ADR-BE-13). Trusting it
    // unconditionally let any client mint a fresh rate-limit bucket per request, which is exactly
    // the control the sign-in endpoint depends on.
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    // Fastify's own logger is off: request logging is the `onResponse` hook below, which carries
    // the request id, the route template and the latency in one structured line.
  });

  const logger =
    processLogger ?? createLogger({ level: config.LOG_LEVEL, role: config.SEAMNEX_ROLE });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    // `abortOnError: false` hands the failure back to the caller. Nest's own handler calls
    // `process.exit(1)` from inside `initialize()`, which made the role lifecycle's fatal log and
    // exit-code contract unreachable for the two most likely boot failures.
    abortOnError: false,
    logger: pinoAdapter(logger),
  });

  const metrics: Metrics = app.get(METRICS);

  app.setGlobalPrefix(API_PREFIX);
  // The global filter, interceptor and guard are `APP_*` providers in `AppModule`, so they are
  // built by the container. `useGlobalFilters(new …)` could not inject anything, which is why the
  // interceptor had to be handed the role by hand — and why the missing `@Inject` on it went
  // unnoticed until the `seamnex/explicit-inject` rule was added.
  // No `enableShutdownHooks()`: it registers its own SIGTERM/SIGINT handlers, which close the
  // container independently of (and before) the role lifecycle's ordered drain. `app.close()` runs
  // the lifecycle hooks, so one owner is enough.

  const server = app.getHttpAdapter().getInstance() as FastifyInstance;

  server.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const withId = request as RequestWithId;
    withId.requestId = resolveRequestId(request.headers['x-request-id']);
    withId.startedAt = process.hrtime.bigint();
    void reply.header('x-request-id', withId.requestId);
  });

  // The API can be reached without Traefik (development, probes), so the headers cannot live only
  // at the edge. There is no HTML and no script on this origin, so these are cheap and absolute.
  server.addHook(
    'onSend',
    async (_request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      void reply.header('x-content-type-options', 'nosniff');
      void reply.header('x-frame-options', 'DENY');
      void reply.header('referrer-policy', 'no-referrer');
      /*
       * Only in production: HSTS is a promise the scheme can keep, and the development stack is
       * plain HTTP on localhost. Sending it there would be ignored at best — and a host that later
       * terminates TLS would carry a policy nobody chose (ADR-BE-13 §13).
       *
       * No `includeSubDomains`: this origin is the control plane, and the platform publishes
       * customer products under `<slug>.<SEAMNEX_INGRESS_DOMAIN>`. Whether those may ever answer on
       * HTTP is the edge's decision, not something a two-year browser pin should settle from here.
       */
      if (config.isProduction) {
        void reply.header('strict-transport-security', 'max-age=31536000');
      }
      // Every response is derived from the caller's session or is a protected read; a shared cache
      // must never store one. The session payload also carries the CSRF token, so a cached copy is
      // a token a stranger can read (ADR-BE-13).
      void reply.header('cache-control', 'no-store');
      return payload;
    },
  );

  server.addHook('onResponse', async (request: FastifyRequest, reply: FastifyReply) => {
    const withId = request as RequestWithId;
    const durationMs =
      withId.startedAt === undefined
        ? 0
        : Number(process.hrtime.bigint() - withId.startedAt) / 1_000_000;
    const route = routeTemplate(request);

    metrics.httpRequests.labels(request.method, route, String(reply.statusCode)).inc();
    metrics.httpDuration.labels(request.method, route).observe(durationMs / 1_000);

    logger.info(
      maskDeep({
        requestId: withId.requestId,
        method: request.method,
        route,
        status: reply.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
      'request',
    );
  });

  return app;
}

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  API_OPERATIONS,
  JobAcceptedSchema,
  operationKey,
  type ApiOperation,
} from '@seamnex/domain';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { API_PREFIX, type AppConfig } from '../config/config';
import { APP_CONFIG } from '../config/config.module';
import type { RequestContext } from '../common/identity/request-context';
import { validateRequest } from '../common/http/validate-request';
import { headerValue, parseCookies, sessionCookieHeaders } from '../common/http/cookies';
import { AppError } from '../common/problem/app-error';
import { problemHeadersFor, requestIdFor, sendProblem } from '../common/problem/send-problem';
import { toProblem } from '../common/problem/to-problem';
import { deferredProblem } from './deferred-operations';
import { OperationGuardChain } from './guards/operation-guard.chain';
import type { OperationResult } from './operation-handler';
import { OperationHandlers } from './operation-handlers';

/**
 * Deliverable 2.1 — the route table is the contract.
 *
 * Every declared operation is mounted by iterating `API_OPERATIONS`, so router↔registry parity
 * holds by construction: there is no second list to keep in step and no way to mount an
 * undeclared route. Registration happens in `onModuleInit` (during `app.init()`), which means
 * `server.hasRoute`, the parity test and `listen()` all see the same table.
 *
 * What used to live here — rate limit, identity, cross-site, policy, problem rendering — now lives
 * in `contract/guards` and `common/problem/send-problem`, because inline it was reachable from
 * exactly one route source. This class keeps the three things that really are about this
 * dispatcher: mounting the table, validating against the declared surface, and writing the result.
 */
@Injectable()
export class RouteTableService implements OnModuleInit {
  private readonly logger = new Logger('route-table');

  constructor(
    // Explicit token: the runtime compiles TypeScript without `emitDecoratorMetadata` (ADR-BE-17),
    // so an undecorated parameter has no `design:paramtypes` entry and resolves to `undefined`.
    @Inject(HttpAdapterHost) private readonly adapterHost: HttpAdapterHost,
    @Inject(OperationHandlers) private readonly handlers: OperationHandlers,
    @Inject(OperationGuardChain) private readonly guards: OperationGuardChain,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    // Eight of the nine roles build this module graph without an HTTP server. `adapterHost` is
    // present but its `httpAdapter` is null in an application context, so the mount is skipped
    // rather than dereferenced — that dereference is what made every non-HTTP role exit fatally at
    // boot, leaving the queue unconsumed and every deployment stuck in `queued`.
    const adapter = this.adapterHost?.httpAdapter;
    if (adapter === null || adapter === undefined) {
      this.logger.log({ msg: 'no HTTP adapter in this role; contract routes not mounted' });
      return;
    }

    const server = adapter.getInstance<FastifyInstance>();
    let mounted = 0;

    for (const operation of API_OPERATIONS) {
      const key = operationKey(operation);
      server.route({
        method: operation.method,
        url: `/${API_PREFIX}${operation.path}`,
        handler: (request, reply) => this.handle(operation, key, request, reply),
      });
      mounted += 1;
    }

    this.logger.log({
      msg: 'contract routes mounted',
      operations: mounted,
      handlers: this.handlers.size,
      anonymous: API_OPERATIONS.filter((operation) => operation.anonymous === true).length,
    });
  }

  private async handle(
    operation: ApiOperation,
    key: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      const cookies = parseCookies(headerValue(request.headers, 'cookie'));

      // Order: rate limit → identity → cross-site → policy → validation → handler.
      await this.guards.run({ operation, request, cookies }, async (context: RequestContext) => {
        const input = validateRequest(operation, {
          query: (request.query ?? {}) as Record<string, unknown>,
          body: request.body,
        });

        const handler = this.handlers.get(key);
        if (handler === undefined) throw deferredProblem(key);

        this.renewSessionCookies(context, reply);

        const result = await handler({
          operation,
          params: (request.params ?? {}) as Record<string, string>,
          query: input.query,
          families: input.families,
          body: input.body,
          headers: request.headers,
          cookies,
          context,
          requestId: context.requestId,
          reply,
        });

        this.respond(operation, result, request, reply);
      });
    } catch (error) {
      this.respondProblem(error, request, reply);
    }
  }

  /**
   * Sliding renewal (ADR-BE-13).
   *
   * `Max-Age` is fixed when a cookie is written, so a session cookie issued at sign-in expires at
   * the first idle deadline even for a user who never stops working — the server keeps touching
   * `lastSeen`, the browser never learns. Re-emitting the pair with the remaining idle lifetime on
   * every authenticated response makes the cookie follow the session instead of outliving it in the
   * wrong direction.
   *
   * A handler that owns the cookie (sign-in, sign-out) writes `set-cookie` afterwards and replaces
   * this value, so a renewal can never resurrect a session the handler just ended.
   */
  private renewSessionCookies(context: RequestContext, reply: FastifyReply): void {
    if (context.actorType !== 'user') return;
    if (context.sessionId === null || context.csrfToken === null) return;
    if (context.sessionIdleExpiresAt === null) return;
    if (reply.getHeader('set-cookie') !== undefined) return;

    const remainingSeconds = Math.floor(
      (Date.parse(context.sessionIdleExpiresAt) - Date.now()) / 1_000,
    );
    if (!Number.isFinite(remainingSeconds) || remainingSeconds < 1) return;

    reply.header(
      'set-cookie',
      sessionCookieHeaders(this.config, {
        sid: context.sessionId,
        csrfToken: context.csrfToken,
        maxAgeSeconds: remainingSeconds,
      }),
    );
  }

  private respond(
    operation: ApiOperation,
    result: OperationResult,
    request: FastifyRequest,
    reply: FastifyReply,
  ): void {
    const requestId = requestIdFor(request);

    if (result.kind === 'stream') return;

    if (result.kind === 'noContent') {
      void reply.status(204).header('x-request-id', requestId).send();
      return;
    }

    if (result.kind === 'accepted') {
      const body = this.validateBody(
        operation,
        {
          jobId: result.jobId,
          links: {
            self: `/${API_PREFIX}/jobs/${result.jobId}`,
            logs: `/${API_PREFIX}/jobs/${result.jobId}/logs`,
          },
        },
        JobAcceptedSchema,
      );
      void reply.status(202).header('x-request-id', requestId).send(body);
      return;
    }

    /*
     * The validator is published by the read that supplies it (`etag: true`) as well as by the
     * conditional write that validates it. Gating only on `conditional` meant no GET ever carried
     * an `ETag`, so the client replays no `If-Match` and `PUT /admin/settings` — which requires one
     * — answered 412 to every save.
     */
    if ((operation.etag === true || operation.conditional === true) && result.etag !== undefined) {
      void reply.header('etag', result.etag);
    }
    for (const [name, value] of Object.entries(result.headers ?? {})) {
      void reply.header(name, value);
    }
    const body = this.validateBody(operation, result.body, operation.response);
    void reply
      .status(result.status ?? 200)
      .header('x-request-id', requestId)
      .send(body);
  }

  /**
   * The response is parsed with the same zod schema the client validates against, so a handler
   * that adds, drops or retypes a field fails the test suite (exit criterion 6) instead of
   * surprising a screen. Production skips the second parse: the contract is already exercised by
   * the test gates.
   */
  private validateBody(
    operation: ApiOperation,
    body: unknown,
    schema: ApiOperation['response'],
  ): unknown {
    if (schema === undefined) return body;
    const parsed = schema.safeParse(body);
    if (parsed.success) return parsed.data;
    if (this.config.isProduction) return body;

    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    this.logger.error({
      msg: 'handler response violates the contract',
      operation: operationKey(operation),
      detail,
    });
    throw new AppError({
      code: 'INTERNAL_ERROR',
      detail: `The response for ${operationKey(operation)} does not match its declared schema.`,
      remediation: 'This is a defect in the handler, not in the request.',
    });
  }

  /**
   * The dispatcher's half of the error path. `sendProblem` is the writer; this only decides what to
   * log, because a raw Fastify route never reaches the Nest exception filter and both must produce
   * a byte-identical document.
   */
  private respondProblem(error: unknown, request: FastifyRequest, reply: FastifyReply): void {
    // An SSE handler hijacks the reply and writes the head itself; an error after that point can
    // only be logged, because the client already received a 200.
    if (reply.raw.headersSent) {
      this.logger.error({
        msg: 'error after the response started',
        route: request.url,
        err: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const problem = toProblem(error);
    if (problem.status >= 500) {
      this.logger.error({
        msg: 'contract request failed',
        route: request.url,
        code: problem.code,
        err: error instanceof Error ? error.message : String(error),
      });
    }

    sendProblem(reply, {
      problem,
      requestId: requestIdFor(request),
      headers: problemHeadersFor(error),
    });
  }
}

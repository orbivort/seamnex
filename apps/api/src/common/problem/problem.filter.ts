import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { maskDeep } from '../logging/masking';
import { problemHeadersFor, requestIdFor, sendProblem } from './send-problem';
import { toProblem } from './to-problem';

/**
 * Exit criterion 4: *any* thrown error becomes `application/problem+json` with `type`, `title`,
 * `status`, `detail` and `code`, and the request id is echoed.
 *
 * An unknown error is logged with its stack and answered with a generic 500: leaking an internal
 * message is how a stack trace or a connection string reaches a browser.
 *
 * Registered as an `APP_FILTER` provider rather than through `useGlobalFilters(new ProblemFilter())`
 * — the imperative form cannot receive providers, so it could never carry a masked logger or an
 * audit sink. The writer itself is `sendProblem`, shared with the contract dispatcher, which is a
 * raw Fastify route and never reaches a Nest filter.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('problem');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<FastifyReply>();
    const request = http.getRequest<FastifyRequest & { requestId?: string }>();

    // The `onRequest` hook is the source of truth: it mints or accepts the id before routing, so
    // even a 404 carries one. The ALS value and the inbound header are the fallbacks for a filter
    // invoked outside the interceptor's scope.
    const requestId = requestIdFor(request);
    const problem = toProblem(exception);

    if (problem.status >= 500) {
      this.logger.error(
        {
          requestId,
          code: problem.code,
          path: request.url,
          err: maskDeep(exception instanceof Error ? exception.message : exception),
        },
        'request failed',
      );
    }

    sendProblem(response, { problem, requestId, headers: problemHeadersFor(exception) });
  }
}

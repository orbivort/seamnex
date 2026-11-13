import { All, Controller, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from './app-error';

/**
 * Exit criterion 4 applies to paths that do not exist, too.
 *
 * Fastify's built-in 404 body (`{ statusCode, error, message }`) is not a problem document, and
 * Nest 12 installs its own not-found handler before we could replace it — so the 404 is a Nest
 * handler registered last, which also means it inherits the global filter (and the request id).
 */
@Controller()
export class NotFoundController {
  // Fastify's router requires the wildcard to be the final character, so `*splat` (Nest's
  // path-to-regexp spelling) is rejected once the global prefix is applied.
  @All('*')
  notFound(@Req() request: FastifyRequest): never {
    throw new AppError({
      code: 'NOT_FOUND',
      status: 404,
      detail: `${request.method} ${request.url} is not a declared operation.`,
    });
  }
}

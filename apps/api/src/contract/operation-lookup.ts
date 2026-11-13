import { API_OPERATIONS, operationKey, type ApiOperation } from '@seamnex/domain';
import type { FastifyRequest } from 'fastify';
import { API_PREFIX } from '../config/config';

/**
 * The declared operation behind a request, found from Fastify's route template rather than the
 * raw URL — a template is bounded by the contract, a URL is whatever the caller sent.
 *
 * This is what lets a Nest guard cover a controller route without a second registry: attach the
 * guard globally and it protects any route whose path is declared, and no route that is not.
 */
const BY_KEY = new Map<string, ApiOperation>(
  API_OPERATIONS.map((operation) => [operationKey(operation), operation]),
);

const PREFIX = `/${API_PREFIX}`;

export function operationForRequest(request: FastifyRequest): ApiOperation | undefined {
  const route = (request as FastifyRequest & { routeOptions?: { url?: string } }).routeOptions?.url;
  if (typeof route !== 'string') return undefined;

  const path = route.startsWith(PREFIX) ? route.slice(PREFIX.length) : route;
  return BY_KEY.get(`${request.method.toUpperCase()} ${path}`);
}

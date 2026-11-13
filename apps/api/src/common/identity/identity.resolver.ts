import type { ApiOperation } from '@seamnex/domain';
import type { FastifyRequest } from 'fastify';
import type { RequestContext } from './request-context';

export const IDENTITY_RESOLVER = Symbol('seamnex.identity.resolver');

/**
 * The only place a `RequestContext` is constructed (ADR-BE-06).
 *
 * The operation is passed so an explicitly anonymous operation can be answered without a
 * credential. Every other operation must resolve a session or a machine client, or the resolver
 * throws `UNAUTHORIZED` / `SESSION_EXPIRED` with a problem document.
 */
export interface IdentityResolver {
  resolve(
    request: FastifyRequest & { requestId?: string },
    operation: Pick<ApiOperation, 'anonymous'>,
  ): Promise<RequestContext>;
}

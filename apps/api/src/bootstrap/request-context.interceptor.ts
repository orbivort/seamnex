import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { Inject, Injectable } from '@nestjs/common';
import { defer, type Observable } from 'rxjs';
import type { FastifyRequest } from 'fastify';
import { APP_CONFIG } from '../config/config.module';
import type { AppConfig } from '../config/config';
import { requestStore } from '../common/logging/logger';

/**
 * Binds the request id (and the process role) to every asynchronous continuation started by a
 * handler, so a service three calls deep can log and audit with the same id without receiving it
 * as a parameter.
 *
 * Registered as an `APP_INTERCEPTOR` provider, not `useGlobalInterceptors(new …)`: the role now
 * comes from the container instead of being passed by hand. That change also removed the reason this
 * class could get away with an undecorated constructor parameter — it was instantiated with `new`,
 * so nothing resolved it. Under the container it needs `@Inject`, which is what `seamnex/explicit-inject`
 * enforces for every Nest-managed class (ADR-BE-17).
 *
 * `defer` — not `new Observable(subscriber => …)` — because the store must be entered per
 * subscription, and nothing has to be torn down: `AsyncLocalStorage.run` restores the previous
 * context when its callback's async graph completes.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest & { requestId?: string }>();
    const requestId = request.requestId ?? 'unknown';
    const role = this.config.SEAMNEX_ROLE;

    return defer(() => requestStore.run({ requestId, role }, () => next.handle()));
  }
}

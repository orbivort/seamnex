import { Inject, Injectable } from '@nestjs/common';
import { assertAllowedOrigin, assertCsrf, isUnsafeMethod } from '../../common/http/csrf';
import { headerValue } from '../../common/http/cookies';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import type { OperationGuard, OperationGuardContext } from './operation-guard';

/**
 * Origin and token checks for cookie-authenticated unsafe requests.
 *
 * Machine bearer calls cannot be forged by a browser, so they are exempt: they carry no csrfToken.
 * `POST /auth/session` is exempt for a different reason — it is the operation that *replaces* the
 * session, so the token it would be checked against belongs to the credential being retired, and a
 * signed-in user switching identity would be refused by their own old session. It is not
 * unprotected: the handler runs the same login-CSRF origin check (plus `Sec-Fetch-Site`) before it
 * touches the provider, which is the check that matters for an operation that grants a session
 * rather than exercising one. That check stays in the handler because it is a different rule.
 */
@Injectable()
export class CsrfGuard implements OperationGuard {
  readonly phase = 'after-context' as const;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  // Synchronous by nature — both checks are pure comparisons — but the guard contract is async so
  // a later guard can await I/O without the chain changing shape.
  canActivate({ operation, request, cookies, context }: OperationGuardContext): Promise<void> {
    if (context === undefined) return Promise.resolve();
    if (context.actorType !== 'user') return Promise.resolve();
    if (!isUnsafeMethod(operation.method)) return Promise.resolve();

    const replacesSession = operation.method === 'POST' && operation.path === '/auth/session';
    if (replacesSession) return Promise.resolve();

    assertAllowedOrigin({
      origin: headerValue(request.headers, 'origin'),
      allowedOrigins: this.config.allowedOrigins,
      secFetchSite: headerValue(request.headers, 'sec-fetch-site'),
    });
    assertCsrf({
      headerToken: headerValue(request.headers, 'x-seamnex-csrf'),
      cookieToken: cookies[this.config.CSRF_COOKIE_NAME],
      sessionToken: context.csrfToken ?? '',
    });
    return Promise.resolve();
  }
}

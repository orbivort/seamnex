import { Inject, Injectable, Logger } from '@nestjs/common';
import { instanceNetwork } from '../../common/docker/naming';
import { postProductJson } from '../../common/exec/http-call';
import { run } from '../../common/exec/exec';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { SECRETS_SERVICE, type SecretsService } from '../m15-secrets/secrets.contract';
import type {
  IdentityPushInput,
  IdentityPushPort,
  IdentityPushResult,
} from './identity-push.contract';

/**
 * FR-2.4 — push one subject's product role into a product that has no identity client of its own.
 *
 * Three properties this adapter is built around:
 *
 *   - **It never guesses.** The path, the field and the credential name all come from the entry's
 *     verified onboarding record. Without a declared `rolePush` the worker does not call this at all.
 *   - **It never leaks the token.** The secret is opened through M15 (which audits the read) and
 *     passed to the helper on stdin; neither the token nor the request body reaches argv, the
 *     container environment or a log line.
 *   - **It reports, it does not throw.** A product that answers 500 or nothing at all leaves the
 *     entitlement `pending` with the status line recorded, so the next cycle retries and the operator
 *     sees the reason instead of a silently applied grant.
 */
@Injectable()
export class ProductIdentityPushService implements IdentityPushPort {
  private readonly logger = new Logger('identity-push');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(SECRETS_SERVICE) private readonly secrets: SecretsService,
  ) {}

  async push(input: IdentityPushInput): Promise<IdentityPushResult> {
    if (!this.config.SEAMNEX_IDENTITY_PUSH_ENABLED) {
      return {
        ok: false,
        detail: 'product role push is disabled (SEAMNEX_IDENTITY_PUSH_ENABLED)',
      };
    }

    const secret = await this.secrets.find('instance', input.instanceId, input.secretName);
    if (secret === null) {
      return {
        ok: false,
        detail: `instance secret "${input.secretName}" is not stored, so the role was not pushed`,
      };
    }

    let token: string;
    try {
      token = await this.secrets.open(secret.id, 'identity role push', {
        scope: 'instance',
        ownerId: input.instanceId,
      });
    } catch {
      return { ok: false, detail: `instance secret "${input.secretName}" could not be opened` };
    }

    const target = targetOf(input.baseUrl, input.slug);
    const payload = JSON.stringify({
      [input.roleField]: input.productRole,
      subject: input.subjectIdpId,
      email: input.email,
    });

    const result = await postProductJson({
      runCli: (file, args, options) => run(file, args, options),
      network: instanceNetwork(input.slug),
      host: target.host,
      port: target.port,
      path: joinPath(target.pathPrefix, input.path),
      bearerToken: token,
      payload,
      timeoutMs: this.config.SEAMNEX_IDENTITY_PUSH_TIMEOUT_MS,
    });

    this.logger.log({
      msg: 'product role push',
      instanceId: input.instanceId,
      subject: input.subjectIdpId,
      productRole: input.productRole,
      ok: result.ok,
      // The status line only: a response body may echo the request, and the request is a credential.
      detail: result.detail,
    });

    return result;
  }
}

/**
 * The address a push goes to.
 *
 * A verified `apiBaseUrl` describing the product *inside* its network wins because onboarding
 * recorded it against the running product. A URL that names an external host (the public route) is
 * not reachable from an instance network, so only the host and port are taken and the scheme is
 * forced to `http`: the helper speaks plain HTTP to a service on the bridge.
 */
function targetOf(
  baseUrl: string | null,
  slug: string,
): { host: string; port: number; pathPrefix: string } {
  if (baseUrl !== null && baseUrl.trim().length > 0) {
    try {
      const url = new URL(baseUrl.trim());
      const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : 80;
      return {
        host: url.hostname,
        port: Number.isFinite(port) && port > 0 ? port : 80,
        pathPrefix: url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''),
      };
    } catch {
      // An unparseable base URL falls back to the platform's own addressing rather than failing the
      // cycle: the product is still reachable as `<slug>` on its network.
    }
  }
  return { host: slug, port: 80, pathPrefix: '' };
}

function joinPath(prefix: string, path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${prefix}${suffix}`;
}

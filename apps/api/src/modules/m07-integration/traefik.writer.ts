import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { stringify } from 'yaml';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { ensureDir, writeFileAtomic } from '../../common/fs/files';
import { requireAdapters } from '../../common/adapters';
import { LAUNCH_BOOTSTRAP_PATH } from '../../common/launch/bootstrap';

export type RouterSpec = {
  readonly slug: string;
  readonly host: string;
  readonly pathPrefix: string | null;
  readonly upstream: string;
  readonly published: boolean;
  readonly forwardAuthAddress: string;
  /** Origin of the auth gateway, which also answers the launch bootstrap. */
  readonly bootstrapAddress: string;
  /** Guarantee class of the instance. Only the `fa_*` classes are gated at the edge. */
  readonly authMode: 'native' | 'fa_header' | 'fa_delegated' | 'fa_gate';
};

/**
 * 4D.2 - route projection into Traefik's file provider.
 *
 * One file per instance, written to a sibling temp file and renamed into place, because the provider
 * watches the directory and would otherwise read a half-written document. A gated or unpublished
 * route emits **no router at all**: re-opening the gate is then a single projection rather than a
 * remembered previous state.
 */
@Injectable()
export class TraefikRouteWriter {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  write(spec: RouterSpec): void {
    requireAdapters(this.config, 'traefik');
    if (!spec.published) {
      this.remove(spec.slug);
      return;
    }

    const hostRule = `Host(\`${spec.host}\`)`;
    const productRule =
      spec.pathPrefix === null || spec.pathPrefix === '/'
        ? hostRule
        : `${hostRule} && PathPrefix(\`${spec.pathPrefix}\`)`;

    // A `native` product authenticates against its own IdP client: gating it at the edge would put
    // the platform's forward-auth in front of the product's own login page, which is both wrong
    // (the guarantee class says the product is the authority) and unreachable (no auth gateway is
    // deployed for a native instance). Only the `fa_*` classes get the middleware.
    const gated = spec.authMode !== 'native';
    /**
     * Identity headers are for the one class that consumes them.
     *
     * `fa_header` means the product reads `X-Platform-User` and friends and signs the user in from
     * them. A proxy gate and a delegated sign-in do not: the first leaves the product its own
     * login, the second authenticates against the directory. Forwarding a person's login name and
     * group paths to an application that only logs request headers is unnecessary exposure, and it
     * is what made a gate look like injected identity. Measured on OpenProject 17.9.6: no consumer
     * of any forwarded header exists in the image (ADR-BE-15).
     */
    const forwardsIdentityHeaders = spec.authMode === 'fa_header';

    const document = {
      http: {
        routers: {
          /*
           * The launch bootstrap must be matched before the product router and must not carry the
           * forward-auth middleware — it exists to establish the very cookie that middleware reads.
           * Priority 200 wins over the product's 100 for the same host.
           */
          ...(gated
            ? {
                [`${spec.slug}-session`]: {
                  rule: `${hostRule} && Path(\`${LAUNCH_BOOTSTRAP_PATH}\`)`,
                  entryPoints: ['web'],
                  service: `${spec.slug}-session`,
                  middlewares: ['security-headers'],
                  priority: 200,
                },
              }
            : {}),
          [`${spec.slug}-product`]: {
            rule: productRule,
            entryPoints: ['web'],
            service: `${spec.slug}-product`,
            middlewares: gated ? [`${spec.slug}-auth`, 'security-headers'] : ['security-headers'],
            priority: 100,
          },
        },
        services: {
          ...(gated
            ? {
                [`${spec.slug}-session`]: {
                  loadBalancer: { servers: [{ url: spec.bootstrapAddress }] },
                },
              }
            : {}),
          [`${spec.slug}-product`]: { loadBalancer: { servers: [{ url: spec.upstream }] } },
        },
        // The key is omitted, never written as an empty map: Traefik's file provider rejects the
        // whole document with "middlewares cannot be a standalone element", which silently drops
        // the router as well. One invalid key loses the route.
        ...(gated
          ? {
              middlewares: {
                [`${spec.slug}-auth`]: {
                  forwardAuth: {
                    address: spec.forwardAuthAddress,
                    // The caller's own `X-Platform-*` values must never reach the decision: only the
                    // gateway may set them.
                    trustForwardHeader: false,
                    ...(forwardsIdentityHeaders
                      ? {
                          authResponseHeaders: [
                            'X-Platform-User',
                            'X-Platform-Groups',
                            'X-Platform-Instance',
                          ],
                        }
                      : {}),
                  },
                },
              },
            }
          : {}),
      },
    };

    ensureDir(this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR);
    writeFileAtomic(this.fileFor(spec.slug), stringify(document));
  }

  remove(slug: string): void {
    try {
      unlinkSync(this.fileFor(slug));
    } catch {
      // Absent is the desired state.
    }
  }

  private fileFor(slug: string): string {
    return join(this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR, `instance-${slug}.yml`);
  }
}

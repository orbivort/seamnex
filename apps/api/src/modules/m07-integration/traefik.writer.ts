import { readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { stringify } from 'yaml';
import { APP_CONFIG } from '../../config/config.module';
import type { AppConfig } from '../../config/config';
import { ensureDir, writeFileAtomic } from '../../common/fs/files';
import { requireAdapters } from '../../common/adapters';
import { LAUNCH_BOOTSTRAP_PATH } from '../../common/launch/bootstrap';

/**
 * The name the edge's static configuration gives the ACME resolver
 * (`certificatesResolvers.seamnex` in `docker/traefik/traefik.yml`). It is a constant because the
 * two halves are one contract: a router that names a resolver the edge does not declare is dropped
 * with the rest of its document, and the product 404s with nothing in the platform log.
 */
const CERTIFICATE_RESOLVER = 'seamnex';

/**
 * A year, which is the longest a browser honours. NFR-4.1 requires TLS on every external route, so
 * there is no downgrade to keep possible: `max-age=0` would instruct the browser to forget the
 * policy it was given the visit before.
 */
const HSTS_SECONDS = 31_536_000;

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
  /**
   * Certificate mode projected from `instance_route.tls_mode` (NFR-4.1, ISSUE-07). `acme` asks the
   * edge's resolver for a certificate for this host; `internal` serves the edge's own, which is what
   * the development stack does because no laptop name can satisfy a public CA.
   */
  readonly tlsMode: 'acme' | 'internal';
};

/**
 * 4D.2 - route projection into Traefik's file provider.
 *
 * One file per instance, written to a sibling temp file and renamed into place, because the provider
 * watches the directory and would otherwise read a half-written document. A gated or unpublished
 * route emits **no router at all**: re-opening the gate is then a single projection rather than a
 * remembered previous state.
 *
 * Every router is published on `websecure` and carries its own TLS and security-header
 * configuration. Both used to be borrowed: the entrypoint was `web` (plain HTTP) and the headers came
 * from a middleware defined only in the development stack's static dynamic file, so a deployment
 * that mounted its own dynamic directory lost the router — the file provider rejects a document
 * whose middleware reference cannot be resolved, and it rejects the whole document, not one key
 * (ISSUE-07).
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

    /**
     * `{}` is not "no TLS": Traefik reads an empty `tls` block as "terminate here with the default
     * certificate". Only the resolver name differs between the two modes.
     *
     * A fresh object per router, not a shared constant: the serialiser would emit one anchored node
     * and two aliases, which is valid YAML but made the generated file read as if the routers were
     * coupled.
     */
    const tls = () => (spec.tlsMode === 'acme' ? { certResolver: CERTIFICATE_RESOLVER } : {});

    /**
     * The headers live in this document rather than in a shared one, because the generated file and
     * the middleware it names have to travel together: the platform writes routes into a dynamic
     * directory the operator mounts, and any definition that is not in that directory does not exist
     * as far as Traefik is concerned.
     */
    const headersMiddleware = `${spec.slug}-headers`;

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
                  entryPoints: ['websecure'],
                  service: `${spec.slug}-session`,
                  middlewares: [headersMiddleware],
                  tls: tls(),
                  priority: 200,
                },
              }
            : {}),
          [`${spec.slug}-product`]: {
            rule: productRule,
            entryPoints: ['websecure'],
            service: `${spec.slug}-product`,
            middlewares: gated ? [`${spec.slug}-auth`, headersMiddleware] : [headersMiddleware],
            tls: tls(),
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
        middlewares: {
          [headersMiddleware]: {
            headers: {
              // NFR-4.1 / AC-42: TLS on every route, and the browser told to insist on it.
              stsSeconds: HSTS_SECONDS,
              stsIncludeSubdomains: true,
              contentTypeNosniff: true,
              frameDeny: true,
              browserXssFilter: true,
            },
          },
          // An ungated route gets no `-auth` key at all. The map is never empty (the headers entry
          // above is unconditional), because Traefik rejects the whole document — router included —
          // for an empty `middlewares:` block ("middlewares cannot be a standalone element").
          ...(gated
            ? {
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
              }
            : {}),
        },
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

  /**
   * Deletes every generated document the caller did not just write (ISSUE-07).
   *
   * Writing alone is not reconciliation: a route removed from the database leaves its file behind,
   * and the edge keeps serving it — after ADR-BE-39 those leftovers are worse than dead, because they
   * were written before the TLS change and still name the `web` entrypoint, which no longer has a
   * published port. Nothing in the platform ever re-reads such a file, so it survives every restart.
   * Only `instance-<slug>.yml` is considered: the hand-written documents in the same directory
   * (`routes.yml`, a future restore gate) are not the projection's to delete.
   */
  prune(keep: ReadonlySet<string>): void {
    let names: string[];
    try {
      names = readdirSync(this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR);
    } catch {
      // No directory means no projection either; `write` reports that failure where it happens.
      return;
    }

    for (const name of names) {
      const match = /^instance-(.+)\.ya?ml$/i.exec(name);
      if (match === null || match[1] === undefined) continue;
      if (keep.has(match[1])) continue;
      try {
        unlinkSync(join(this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR, name));
      } catch {
        // A concurrent projection won the race; the next pass sees the outcome.
      }
    }
  }

  private fileFor(slug: string): string {
    return join(this.config.SEAMNEX_TRAEFIK_DYNAMIC_DIR, `instance-${slug}.yml`);
  }
}

/**
 * The launch bootstrap — how a gated product receives the platform session.
 *
 * A forward-auth route reads the session from a `seamnex_session` cookie on the product's own host, and
 * a browser cannot be handed that cookie from another hostname: the portal is `localhost`, the
 * product is `shop.localhost`, and Chromium stores a `Domain=localhost` cookie for `localhost` only.
 * In production the same shape appears whenever products publish on their own domains.
 *
 * The portal therefore asks for a single-use ticket and opens `<product>/__seamnex/session?ticket=…`.
 * The edge routes that path to the auth gateway (no forward-auth in front of it), which redeems the
 * ticket, sets `seamnex_session` on the product's host and redirects to the product root. Everything
 * after that request is an ordinary gated request.
 *
 * Both ends read the path and the key from here: a typo in one of them would be a two-place bug
 * that only shows up as "the product asks me to sign in again".
 */
import { serializeCookie } from '../http/cookies';

export const LAUNCH_BOOTSTRAP_PATH = '/__seamnex/session';

const LAUNCH_TICKET_PREFIX = 'seamnex:launch:';

export type LaunchTicketPayload = {
  /** The session the ticket is worth; never the cookie value itself. */
  readonly sessionId: string;
  /** The instance the ticket was minted for; a ticket is not usable on another route. */
  readonly instanceId: string;
};

export function launchTicketKey(ticket: string): string {
  return `${LAUNCH_TICKET_PREFIX}${ticket}`;
}

/** The URL the browser opens. The origin comes from the product URL, so a subpath route still bootstraps at the host root. */
export function launchBootstrapUrl(productUrl: string, ticket: string): string {
  const origin = new URL(productUrl).origin;
  return `${origin}${LAUNCH_BOOTSTRAP_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

/** What `redeem` hands back. `instanceId`/`subjectIdpId` are absent on a deployment without a relay. */
export type RedeemedTicket = {
  readonly sessionId: string;
  readonly instanceId?: string;
  readonly subjectIdpId?: string;
};

/**
 * The minimum of Fastify's reply that the hop uses. Naming it keeps this file free of the framework:
 * the handler is shared by two listeners and is unit-tested through a stand-in.
 */
export type LaunchReply = {
  readonly header: (name: string, value: string | string[]) => unknown;
  readonly code: (statusCode: number) => { readonly send: (payload?: string) => unknown };
  readonly redirect: (url: string, statusCode?: number) => unknown;
};

export type LaunchBootstrapOptions = {
  readonly ticket: string;
  readonly host: string;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly redeem: (input: { ticket: string; host: string }) => Promise<RedeemedTicket | null>;
  /**
   * ADR-BE-22: optional. Returns the product's own `Set-Cookie` values to plant beside
   * `seamnex_session`. It may reject — a relay failure is a fallback, never a failed launch.
   */
  readonly relay?: (input: {
    redemption: RedeemedTicket & { instanceId: string; subjectIdpId: string };
    host: string;
  }) => Promise<readonly string[]>;
};

/**
 * The one launch hop. Both listeners serve it: `auth-gateway` for every deployment, and `relay`
 * for a deployment whose bootstrap URL points at the relay role.
 *
 * The platform cookie is always planted first, and a missing product cookie never changes the
 * answer: the user lands on the product exactly as they did before this existed.
 */
export async function handleLaunchBootstrap(
  reply: LaunchReply,
  options: LaunchBootstrapOptions,
): Promise<unknown> {
  if (options.ticket.length === 0) return reply.code(401).send();

  const redemption = await options.redeem({ ticket: options.ticket, host: options.host });
  if (redemption === null) return reply.code(401).send();

  const cookies: string[] = [
    serializeCookie(options.cookieName, redemption.sessionId, {
      httpOnly: true,
      secure: options.cookieSecure,
      sameSite: 'Lax',
    }),
  ];

  const { instanceId, subjectIdpId } = redemption;
  if (options.relay !== undefined && instanceId !== undefined && subjectIdpId !== undefined) {
    const planted = await options
      .relay({ redemption: { ...redemption, instanceId, subjectIdpId }, host: options.host })
      .catch(() => [] as string[]);
    for (const value of planted) {
      // A product must not be able to shadow the platform's own cookie on its host. It sees that
      // cookie in every gated request anyway, so refusing to let it rewrite it costs nothing and
      // removes one way a compromised container could pin a session of its choosing.
      if (cookieNameOf(value) === options.cookieName) continue;
      cookies.push(plantableCookie(value));
    }
  }

  reply.header('set-cookie', cookies);
  return reply.redirect('/', 302);
}

/**
 * A product cookie, made plantable on the product's host.
 *
 * Two edits and no more: `Domain` is dropped (it names the product's own public name, and a
 * browser would reject or widen it from this response), and a missing `Path` becomes `/`. Without
 * the second, a browser defaults the path to the bootstrap URL's directory — `/__seamnex` — and
 * never sends the cookie to the product at all.
 */
/** The name from a `Set-Cookie` value: everything before the first `=`. */
export function cookieNameOf(value: string): string {
  const end = value.indexOf('=');
  return (end === -1 ? value : value.slice(0, end)).trim();
}

export function plantableCookie(value: string): string {
  const parts = value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^domain=/i.test(part));
  if (!parts.some((part) => /^path=/i.test(part))) parts.push('Path=/');
  return parts.join('; ');
}

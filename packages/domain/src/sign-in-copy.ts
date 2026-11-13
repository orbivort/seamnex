/**
 * The one sentence the launch dialog prints about *this* product's sign-in path.
 *
 * It used to be written once, for the general case: "one redirect, no second password". EspoCRM
 * does not work that way — it renders its own sign-in card, and the click there opens the identity
 * provider in a popup that closes itself when the product accepts the response — so the sentence
 * promised a shape the user never sees. Copy that outlives the truth is worse than no copy: the
 * dialog is where a person decides whether to trust the platform's labels.
 *
 * Keyed by catalogue entry, because the differences are per-product facts. The API resolves the
 * shape and the entry; the copy lives with the rest of the shared presentation vocabulary so the
 * portal and the console cannot print two different promises for one product.
 */

import { resolveKey } from './schemas/common';

export type SignInShape = 'forwarded' | 'native-oidc' | 'local';

export type SignInPath = {
  readonly note: string;
  /** Navigations the user must perform after pressing "Open": 0 when the edge forwards identity. */
  readonly clicks: number;
};

const GENERIC: Readonly<Record<SignInShape, SignInPath>> = {
  forwarded: {
    note: 'The platform forwards the authenticated session at the edge; the product asks for nothing.',
    clicks: 0,
  },
  'native-oidc': {
    note: 'The product signs you in through the platform identity provider: one redirect, and no second password if you are already signed in there.',
    clicks: 1,
  },
  local: {
    note: 'The product has its own credential, provisioned outside the platform. The platform never stores it.',
    clicks: 1,
  },
};

const PER_ENTRY: Readonly<Record<string, Partial<Record<SignInShape, SignInPath>>>> = {
  // EspoCRM's OIDC entry point is a popup flow: the sign-in card is the product's own, and the
  // password form behind the chevron stays usable for administrators as the break-glass path.
  D1: {
    'native-oidc': {
      note: 'EspoCRM shows its own "Sign in" card first; that click opens the identity provider in a popup, which closes once EspoCRM accepts the response. Administrators can still use a local password if the provider is unavailable; other users cannot.',
      clicks: 2,
    },
  },
  /*
   * OrangeHRM — the second relayed product. Same mechanism as D9, and two product facts belong in the
   * sentence a person reads before clicking: the account has no administrative role (the platform
   * never creates one, and the ESS role is the least privilege that can sign in), and it is an
   * employee record inside the HR system, so it is visible in that product's people directory.
   */
  D7: {
    local: {
      note: 'The platform signs you in to OrangeHRM with an account it created for you, so OrangeHRM does not ask for a second password. The account is non-administrative, one per person, rotated monthly and deleted when your access ends. It is not your single sign-on password and it grants nothing outside this product.',
      clicks: 2,
    },
  },
  /*
   * OpenProject. The image ships an `openid_connect` module, but its OmniAuth strategy is
   * registered only when the Enterprise token allows `sso_auth_providers` (`auth_plugin.rb`); a
   * Community deployment answers with its own login form no matter what the platform forwards.
   * ADR-BE-15 records the measurement; ADR-BE-22 records what replaces it.
   *
   * The sentence changed with the mechanism. It used to say the platform "does not hold, reset or
   * pass on that password" — true then, false now. The relay signs the user in to OpenProject's own
   * form with an account the platform created for them, so the honest sentence says the credential
   * is the platform's, per user, rotated and removed with the access that justified it. It is not
   * the user's identity-provider password and it opens nothing outside this product.
   *
   * `clicks` stays 2 — the tile is still a gated route the portal opens in a new tab, and the relay
   * is opt-in per deployment. The second *password prompt* is what disappears, not the navigation,
   * and the label above the tile remains "Sign-in required".
   */
  D9: {
    local: {
      note: 'The platform signs you in and gates the route, then signs you in to OpenProject with an account it created for you, so OpenProject does not ask for a second password. That credential belongs to the platform — one per person, rotated monthly and deleted when your access ends. It is not your single sign-on password and it grants nothing outside this product.',
      clicks: 2,
    },
    // Written now, printed the day the entry's class flips to `native`: the button is the only
    // redirect, and the account is provisioned on first use.
    'native-oidc': {
      note: 'OpenProject offers "Sign in with Keycloak"; that click is the only redirect, and the account is created on first use. Administrators keep a local password as the break-glass path if the provider is unavailable.',
      clicks: 2,
    },
  },
};

/**
 * The table is written in the legacy grammar (`D9`), while a live `instance.entry_key` carries the
 * composed one (`D09-01`, ADR-BE-20). Keying the lookup on the raw string made every override
 * unreachable on the dev stack: OpenProject printed the generic "provisioned outside the platform"
 * sentence that ADR-BE-22 says must be rewritten, and the unit test kept passing because it asked
 * with the legacy spelling. Every published spelling now resolves to the same row.
 */
type EntryCopy = Partial<Record<SignInShape, SignInPath>>;

const PER_ENTRY_BY_KEY: ReadonlyMap<string, EntryCopy> = new Map(
  Object.entries(PER_ENTRY).flatMap(([key, value]): [string, EntryCopy][] => [
    [key, value],
    [resolveKey(key), value],
  ]),
);

export function signInPathFor(entryKey: string, shape: SignInShape): SignInPath {
  const override =
    PER_ENTRY_BY_KEY.get(entryKey) ?? PER_ENTRY_BY_KEY.get(resolveKey(entryKey.toUpperCase()));
  return override?.[shape] ?? GENERIC[shape];
}

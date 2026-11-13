/**
 * ADR-BE-22 — the sign-in relay, and the per-user product accounts it signs in with.
 *
 * Two facts shape this interface:
 *
 *   1. The relay is an **addition to a launch hop**, never a gate. It is allowed to decline
 *      (`skipped`) and allowed to fail (`failed`), and in both cases the caller does exactly what
 *      the platform does today: plant `seamnex_session` and redirect. Nothing here may throw a
 *      launch away.
 *   2. A `relayed` outcome is not single sign-on. The D9 entry stays `fa_gate`, the tile keeps
 *      saying "Sign-in required", and the audit records the relay under its own actions so a report
 *      cannot add the two together.
 */

export const SIGN_IN_RELAY = Symbol('seamnex.m24.sign-in-relay');
export const PRODUCT_ACCOUNT_SERVICE = Symbol('seamnex.m24.product-account');
export const ADMIN_CREDENTIAL_SERVICE = Symbol('seamnex.m24.admin-credential');

/**
 * Why an attempt stopped. Fixed strings, not prose: a metric label and an audit field must not
 * change wording when a sentence is edited.
 *
 * None of these is recoverable by retrying in the same launch. That is the point — the product locks
 * an account after 20 failed logins for 30 minutes, so an over-eager retry locks a real person out.
 */
export type RelayFailure =
  | 'form_changed'
  | 'credential_rejected'
  /**
   * The store would not hand over the credential (wrong scope or owner, missing row, root key
   * unavailable). Kept separate from `credential_rejected`: the product never saw a password, so
   * this must not count towards its brute-force lock or trip the relay's own breaker.
   */
  | 'credential_unavailable'
  | 'csrf_stale'
  | 'product_unavailable'
  | 'human_challenge'
  | 'force_password_change'
  | 'session_unconfirmed'
  | 'account_missing'
  | 'admin_credential_missing'
  /**
   * The mapping is not usable yet, is terminally bad, or was switched off deliberately. Three codes
   * rather than one: the ADR asks for a failure-reason breakdown, and "pending provisioning" and
   * "the product rejected the credential three times" call for different operator actions.
   */
  | 'account_pending'
  | 'account_failed'
  | 'account_disabled';

export type RelayOutcome =
  | { readonly kind: 'relayed'; readonly cookies: readonly string[] }
  | { readonly kind: 'reused'; readonly cookies: readonly string[] }
  | {
      readonly kind: 'skipped';
      /**
       * `in_flight` is the single-flight guard: another tab is already signing this subject in, and
       * a second parallel login is exactly what trips the product's brute-force counter.
       *
       * `no_adapter` is the gated, allow-listed entry the platform has no login adapter for: the
       * launch is fine and the product's own form answers, but nothing was planted. It is separate
       * from `not_gated` on purpose — an operator who allow-lists an entry without an adapter should
       * see that difference rather than a silent "nothing to do".
       */
      readonly reason: 'disabled' | 'not_gated' | 'no_adapter' | 'no_mapping' | 'in_flight';
    }
  | { readonly kind: 'failed'; readonly reason: RelayFailure };

export type RelayAttemptInput = {
  readonly instanceId: string;
  readonly subjectIdpId: string;
  /** The route host as `instance_route.host` stores it, e.g. `openproject.localhost`. */
  readonly routeHost: string;
  /** The origin a browser uses (`http://openproject.localhost:8020`), for `Origin`/`Referer`. */
  readonly publicOrigin: string;
};

/**
 * Whether a person has something to be signed in as, as far as a launch can tell.
 *
 * Deliberately three values and no reason. `preparing` is the one the portal could not show before:
 * the mapping is on its way — the deployment just asked for it, or the launch itself did — so the
 * product's login form is a temporary state rather than a misconfiguration. The *why* stays in the
 * audit chain; a launch card is not the place to explain `login_collision` to an end user.
 */
export type RelayAccountState = 'ready' | 'preparing' | 'unavailable';

/**
 * Who asked for a pass, for the audit row it writes.
 *
 * The sweep and the deployment event are the platform acting on its own (`service`); the admin route
 * is a person (`user`). Without this the one privileged entry point in M24 would be the only one
 * whose audit rows cannot name an actor — and a pass can create accounts, reset a password, or fail
 * with `login_collision`, all of which an operator needs to attribute.
 */
export type ProvisionActor = {
  readonly type: 'service' | 'user';
  readonly id: string;
};

/**
 * What one provisioning pass did.
 *
 * Metadata only: counts, never an account name or a credential.
 *
 * Three zeroes are distinguished because they need three different human responses: `enabled: false`
 * is a deployment that never opted into the relay; `configured: false` is one that opted in without
 * an allow-list (so nothing is ever selected); `configured: true` with `considered: 0` is the honest
 * "the configuration is right and nobody was eligible". Earlier the report could only say `0`, which
 * is precisely the ambiguity the increment set out to remove from the launcher.
 */
export type ProvisionReport = {
  readonly instanceId: string;
  /** False when the relay is disabled for this deployment: every count is then zero. */
  readonly enabled: boolean;
  /** False when no entry is allow-listed, so no pass can ever select a candidate. */
  readonly configured: boolean;
  /** People the pass selected: entitled, enabled in the IdP, and allow-listed by entry. */
  readonly considered: number;
  readonly provisioned: number;
  readonly failed: number;
};

export interface SignInRelay {
  /** Best-effort by contract: `skipped` and `failed` both mean "let the browser see the login form". */
  attempt(input: RelayAttemptInput): Promise<RelayOutcome>;
  /**
   * Drops cached product sessions. `instanceId` omitted means every instance for that subject;
   * called on platform sign-out, revocation and rotation, never on the request path.
   */
  invalidate(input: { subjectIdpId: string; instanceId?: string }): Promise<void>;
  /**
   * Read model for the launch card, and the only thing M10 may ask about a mapping.
   *
   * A single-row read on the request path, because the alternative is a portal that cannot tell a
   * launch that will relay from one that will not — which is how "auto sign-in does not work" was
   * reported with no way to answer it from the UI.
   */
  accountState(input: { instanceId: string; subjectIdpId: string }): Promise<RelayAccountState>;
}

/** What the relay needs to know about a mapping; never carries the credential. */
export type ProductAccountView = {
  readonly id: string;
  readonly login: string;
  readonly secretRef: string;
  readonly state: 'pending' | 'active' | 'disabled' | 'failed';
};

export interface ProductAccountService {
  /**
   * One pass: provision what is missing on eligible instances, rotate what is due. Idempotent and
   * safe to run on the scheduler's cadence.
   */
  sweep(): Promise<void>;
  /**
   * The same provisioning path, aimed at the instance a caller already knows about.
   *
   * The cadence is not a lifecycle event: a deployment that has just finished and a launch that
   * found no mapping are both "now", and waiting for the next sweep meant a fresh install showed
   * the product's own login form — with a scheduler restart as the only way to shorten it.
   * `subjectIdpId` narrows the pass to one person, so a launch never pays for the others. `actor`
   * defaults to the platform itself, which is what the sweep and the deployment event are.
   *
   * Not a second writer: it runs the sweep's own selection and provisioning, and the sweep stays
   * the safety net. Idempotent; never throws for a per-candidate failure.
   */
  provisionInstance(
    instanceId: string,
    subjectIdpId?: string,
    actor?: ProvisionActor,
  ): Promise<ProvisionReport>;
  /** Offboarding: disable the product account, delete the mapping and the secret. Never throws. */
  deprovision(subjectIdpId: string): Promise<void>;
}

/**
 * ADR-BE-22 §Credentials — the operator surface for the token the sweep cannot derive.
 *
 * The sweep needs an administrator credential in the product. Two of the three shapes need nothing
 * from an operator: a `password` product reuses the administrator login its installer created, and
 * an entry with no adapter never provisions at all. A `bearer` product (OpenProject) accepts only a
 * personal access token, and a token exists only inside an authenticated session the platform must
 * not enter — the seeded administrator is the break-glass account. So the token is operator-supplied,
 * and this is the one interface that writes it.
 *
 * Deliberately narrow: one fixed secret name per deployment, one `instance` scope, and a refusal for
 * any entry that does not provision with a token. It is not a general secret-writing API.
 */
export interface AdminCredentialService {
  /** Metadata only. Never returns, logs or audits the token. */
  status(instanceId: string): Promise<AdminCredentialView>;
  /**
   * Stores a new version of the token and records who did it, in one transaction. The value is
   * never echoed back; the caller receives the same metadata `status` would report.
   *
   * `actor` distinguishes an operator paste from the sweep deriving the token from the seeded
   * administrator; the audit chain keeps the two apart because the console presents them
   * differently ("you supplied this" versus "the platform minted this from the deploy's account").
   */
  store(
    instanceId: string,
    token: string,
    actor: AdminCredentialActor,
  ): Promise<AdminCredentialView>;
}

export type AdminCredentialActor = {
  readonly type: 'user' | 'service';
  readonly id: string;
};

export type AdminCredentialView = {
  /** How the entry provisions, not what is stored. `none` = no adapter, accounts are hand-made. */
  readonly kind: 'bearer' | 'password' | 'none';
  readonly required: boolean;
  readonly configured: boolean;
  readonly name: string;
  readonly version: number | null;
};

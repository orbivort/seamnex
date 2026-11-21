# D06-01 — ERPNext (vendored upstream tree)

| | |
| --- | --- |
| Product | ERPNext 16.53.0 |
| Repository | <https://github.com/frappe/erpnext> (application only — ships no Compose file) |
| Packaging reference | <https://github.com/frappe/frappe_docker> `compose.yaml`, `compose.mariadb.yaml`, `compose.redis.yaml` |
| Image | `frappe/erpnext:v16.53.0` (public, multi-arch, pinned by tag) |
| Product port | `8080` (nginx in the image, `NGINX_LISTEN_PORT`) |
| Shared with | D05-01 — ERPNext Accounts runs on this same deployment |

## Why this tree exists

The catalog entry for D06-01 declares `packaging: compose`, but
`github.com/frappe/erpnext` contains only the application: there is no
`docker-compose.yml` at any tag. The resolver inspects the tree and picks
`docker-compose.yml`, `compose.yml`, then a `Dockerfile`; none of them exists in
the application repository, so a clone-based resolution ends in an empty tree
and the deployment fails at `resolve` with "no compose file and no Dockerfile".

The definition therefore lives here, next to the entry, exactly like D01-01, D04-01 and
D07-01. The resolver copies this directory (`cpSync`, recursive) into
`<SEAMNEX_INSTANCE_DATA_DIR>/<id>/source/<ts>/` and reads
`docker-compose.yml` from it; `SOURCE_REVISION` is what the instance records as
`source_revision`, so "what was deployed" is provable without the Git host.

## What the definition contains

| Service | Role | Notes |
| --- | --- | --- |
| `erpnext` | nginx, exposes `8080` | The primary service: carries the instance network alias `<slug>`, and is what the route and the readiness probe address. |
| `erpnext-backend` | gunicorn `:8000` + first-boot bootstrap | Creates the site and installs the `erpnext` app on first start, then `exec`s the image's `start.sh`. |
| `erpnext-websocket` | socket.io `:9000` | Required, not optional: the nginx template declares it as an upstream, and nginx refuses to start when an upstream host does not resolve. |
| `erpnext-worker-short` / `erpnext-worker-long` | RQ workers | Run queued jobs (email, reports, imports). |
| `erpnext-scheduler` | `bench schedule` | Long-running loop (`frappe.utils.scheduler.start_scheduler`), so it satisfies the platform's "all containers running" rule. |
| `erpnext-db` | MariaDB 11.4 | `utf8mb4` + `utf8mb4_unicode_ci`; `bench new-site` fails its first migration without them. |
| `erpnext-redis-cache` / `erpnext-redis-queue` | Redis 7 | No persistence: the state is rebuildable and a replayed queue is worse than an empty one. |

## Deliberate differences from the reference layout

1. **No `configurator` service.** The reference runs a one-shot container
   (`service_completed_successfully`) to write `common_site_config.json`. The
   platform requires *every* container of an instance to be `running`, so a
   service that exits — successfully or not — makes `verify` time out. The same
   configuration is written by the backend's start-up script.
2. **`bench new-site` is part of the definition.** Upstream documents it as a
   manual `docker compose exec` step. Left manual, a fresh deployment starts
   nginx in front of an empty `sites` volume and every request answers
   "site not found" — a deployment that reports `ready` without deploying.
3. **`FRAPPE_SITE_NAME_HEADER` is a literal site name.** The image uses that
   value as `server_name`, as the `X-Frappe-Site-Name` upstream header and as
   the `try_files` prefix. Pin it to `ERPNEXT_SITE_NAME` so a single-site
   deployment resolves the same site whatever host the edge used, and keep
   `ERPNEXT_SITE_NAME` equal to the route host (`<slug>.<SEAMNEX_INGRESS_DOMAIN>`)
   so the absolute URLs the product builds are followable.
4. **No `pull_policy: always`, no `platform:` pin.** Both are host-policy
   decisions the platform owns (pinned tag, socket proxy with `BUILD=0`
   semantics for the application path), not properties of the product.

## First start, in order

```text
mariadb healthy
      │
      ▼
erpnext-backend (running as bootstrap bash)
      ├─ sites/apps.txt, common_site_config.json (db/redis/socketio)
      ├─ bench new-site --install-app erpnext          (several minutes)
      ├─ sites/currentsite.txt, .seamnex-ready
      ├─ host_name <- ERPNEXT_SITE_ORIGIN              (on every start, not only the first)
      ├─ Social Login Key <- ERPNEXT_SSO_*             (on every start; skipped without a secret)
      └─ exec start.sh                                 (gunicorn :8000)
      │  healthcheck: sites/<site>/.seamnex-ready
      ▼
erpnext-websocket · workers · scheduler (depends_on: service_healthy)
      ▼
erpnext (nginx :8080) — depends_on backend healthy, websocket started
```

`SEAMNEX_VERIFY_TIMEOUT_MS` must cover the install. The platform default is 300 s;
a first ERPNext install on a laptop takes longer, so the host sets
`SEAMNEX_VERIFY_TIMEOUT_MS=1200000` (20 min) before the first deployment. A reconfigure reuses the
marker and completes in well under a minute. A per-entry `verifyTimeoutMs` in the catalog entry is
the proper fix and is not implemented yet, which is why the setting is a `.env` value rather than
something this entry can declare.

## Single sign-on

### What the product actually supports

Read from `frappe/frappe` (`version-16`, the branch the pinned `v16.53.0` image is built from), not
from documentation:

| Capability | Status | Evidence |
| --- | --- | --- |
| OAuth 2.0 / OpenID Connect | **native**, per site | `Social Login Key` doctype; `social_login_provider` offers `Keycloak`, `Custom`, Google, GitHub, Facebook, Office 365, Salesforce, Frappe, fairlogin |
| Keycloak as a first-class provider | **yes** | `login_via_keycloak` in `frappe/integrations/oauth2_logins.py` |
| SAML 2.0 | **no** | the doctype has no SAML fields; `oauth2_logins.py` exposes only OAuth 2.0 entry points |
| OIDC discovery | **no** | `frappe/utils/oauth.py` reads `authorize_url` / `access_token_url` / `api_endpoint` from the record and fetches nothing |
| PKCE | **no** | no `code_challenge` on the authorize request, no verifier on the exchange |
| ID-token signature verification | **no** on the social-login path | `login_via_oauth2_id_token` decodes with `verify_signature: False`; the userinfo call is the trust anchor |
| Claim → role mapping | **no** | roles come only from `Portal Settings.default_role`, on creation |
| Back-channel / RP-initiated logout | **no** | neither implemented |

The earlier `SAML 2.0 (Frappe social login)` label on this entry was therefore wrong: the only native
path is OIDC, and it is what the definition now wires.

### How the platform configures it

Frappe keeps identity configuration in a **site-database row**, not in the environment — the one
structural difference from EspoCRM. The platform injects declared variables into the container, and
the browser-facing half has to be written into the site by something that can talk to Frappe's own
API. That something is the last step of the backend bootstrap: a short Python block that opens a
site context (`frappe.init` + `frappe.connect`), upserts the row, applies the two single-value
settings and commits. It runs on every start, which is what makes `redirect_url` follow the route,
and it is skipped entirely when `ERPNEXT_SSO_ENABLED` is false or no client secret exists.

`bench execute --kwargs` was rejected for it: the client secret arrives in the environment, and
serialising it into a shell-quoted argument is how secrets end up in a process listing.

**The secret has to be in the environment *before* the container is created.** The bootstrap reads
`ERPNEXT_SSO_CLIENT_SECRET` and exits without writing anything when it is empty — deliberately, because
a button for a provider whose secret the site cannot decrypt is worse than no button. The platform's
side of that contract is `ensureIdentitySecret`: it mints (or reuses) the value and stores it as an
`instance_env_value` row *before* the render set is produced, so `apply` injects it and the first boot
already has it. It runs there rather than in `registerIdentity` because the client registration needs
the route, and `registerIdentity` therefore runs after `apply` — a secret minted there would only arrive
at the next deployment. That is exactly what happened on the first deployment of this entry: registered
client, successful code exchange, no `Social Login Key` on the site, and a green "single sign-on" label
in the portal.

### The document must be named `keycloak`

`Social Login Key.autoname` is `frappe.scrub(provider_name)`, and Frappe's `login_via_keycloak` entry
point calls `login_via_oauth2("keycloak", …)`. Everything downstream resolves the provider by that
document name: `get_oauth2_providers()` is keyed by it, and `get_oauth_keys`, `get_redirect_uri`,
`provider_allows_signup` and `update_oauth_user` all look the same key up in the database. A document
named anything else is reachable from the sign-in button (which is built from the document) and not
from the callback (which is hardcoded), so the browser returns with a code and the site answers a 500.
`provider_name = "Keycloak"` is what produces that name; the bootstrap deletes a row left by an earlier
version because `provider_name` and `social_login_provider` are `set_only_once` and cannot be corrected
in place.

### The site database account follows the container

`bench new-site` does not create `'user'@'%'`. `DbManager.create_user` defaults the host to
`SELECT user()` of the connection that ran it, so the site's account is bound to the address the
backend container happened to have at install time. Recreating that container — a reconfigure, an
upgrade, a route change, anything `apply` does — gives it a new address on the instance network, and
from then on every request answers `Access denied for user '…'@'…'` even though the database is
untouched and intact. Nothing re-runs `bench new-site`, because `.seamnex-ready` exists.

The bootstrap therefore converges that account on **every** start, for whatever address the container
has now, with the same `ALL PRIVILEGES` on the site's own schema that `DbManager.grant_all_privileges`
issues, and the password `bench new-site` generated, read back from `site_config.json`. This is also
why `ERPNEXT_DATABASE_ROOT_PASSWORD` is read on every start rather than once.

### Identity provider setup

The platform registers the client itself at deploy time (`registerIdentity`), so nothing here is
hand-made:

| Keycloak client field | Value |
| --- | --- |
| client id | `seamnex-<slug>` — derived, and the value the site stores as `client_id` |
| protocol | `openid-connect`, confidential, standard flow only, no direct grants |
| redirect URI | `<route origin>/api/method/frappe.integrations.oauth2_logins.login_via_keycloak` |
| back-channel logout URL | **not** registered — Frappe has no endpoint, and a URL that answers 404 is not revocation support |
| access token lifespan | 300 s (platform default) |
| PKCE requirement | none — Frappe cannot send a challenge, so requiring one would break every login |

### Service provider metadata

| Frappe `Social Login Key` field | Source | Value |
| --- | --- | --- |
| document name | `autoname` of `provider_name` | `keycloak` |
| `provider_name` (title) | constant | `Keycloak` |
| `social_login_provider` | constant | `Keycloak` |
| `client_id` | `ERPNEXT_SSO_CLIENT_ID` | `seamnex-<slug>` (derived) |
| `client_secret` | `ERPNEXT_SSO_CLIENT_SECRET` | platform-minted when left empty |
| `base_url` | `ERPNEXT_SSO_BASE_URL` | `http://keycloak:8080/realms/seamnex` — internal issuer; also the truthiness gate `www/login.py` uses before rendering a provider button |
| `authorize_url` | `ERPNEXT_SSO_AUTHORIZE_URL` | published IdP origin — **browser** leg |
| `access_token_url` | `ERPNEXT_SSO_TOKEN_URL` | internal origin — **server** leg |
| `api_endpoint` | `ERPNEXT_SSO_USERINFO_URL` | internal origin |
| `redirect_url` | derived | `<ERPNEXT_SITE_ORIGIN>` + the callback path above |
| `auth_url_data` | `ERPNEXT_SSO_SCOPE` | `{"scope": "openid profile email"}` |
| `user_id_property` | `ERPNEXT_SSO_USER_ID_PROPERTY` | `sub` |
| `custom_base_url` | constant | `0` — the three endpoints are absolute, so nothing is prefixed |

The authorize and token endpoints deliberately point at different origins: the browser must reach the
IdP on its published port, the container must reach it on the instance network. EspoCRM's declaration
splits them for the same reason, and collapsing them is the mistake that produces a login page that
never loads or a token exchange that times out.

### Attribute mapping

| Frappe user field | Source in the userinfo response | Overridable |
| --- | --- | --- |
| account identity / lookup | `email`, falling back to `upn` then `unique_name`, lowercased | no — hardcoded chain |
| `first_name` | `given_name`, `name`, or `login` | no |
| `last_name` | `family_name` | no |
| provider subject | `user_id_property` (`sub`) | yes — and it should stay `sub`, because the value is written once and never reconciled |
| roles | `Portal Settings.default_role` | yes, one role, creation only |
| `groups` claim | **not mapped** | Frappe has no declarative mapping; see the deviation |

### User provisioning and role mapping

- A first sign-in with `sign_ups = Allow` creates the `User` from the userinfo response, enabled,
  with a random password and `user_type = Website User`; `Deny` answers a 403 page (*Sorry. Signup
  from Website is disabled*) instead. An existing **disabled** user is refused, never re-enabled.
- The only role a social login confers is `Portal Settings.default_role`, applied when the record is
  created. A `Website User` cannot open `/app` (Desk) at all, so an ERP operator needs
  `user_type = System User` plus roles — an in-product action, or an `on_social_login` hook. This is
  the largest gap against EspoCRM, whose `oidcGroupClaim` + `oidcSyncTeams` map IdP groups onto
  teams declaratively.
- The platform's own role push does not fill it either: ERPNext declares no `integration.rolePush`,
  and for a `native` product on `oidc` the sync worker records the entitlement as `applied` because
  the claim travels in the token — which for this product is only true once something reads it.

### Session handling and fallback

| Decision | Setting | Default | Why |
| --- | --- | --- | --- |
| session lifetime | `System Settings.session_expiry`, `HH:MM:SS` | `08:00:00` | Frappe's only session-length setting; the entry's `sessionMaxMinutes: 480` is a claim until this agrees with it. The product default is `240:00:00` — four weeks of idle time. |
| local password form | `System Settings.disable_user_pass_login` | `false` | the fallback: an IdP outage must not lock out the administrator repairing the site |
| account creation | `Social Login Key.sign_ups` | `Allow` | mirrors EspoCRM's `OIDC_CREATE_USER` |
| provider switched off | `ERPNEXT_SSO_ENABLED=false` | `true` | bootstrap writes nothing; the site keeps the installer's password login |
| no client secret | skipped | — | no button is rendered for a key whose secret does not decrypt, so writing the row would only mislead |

Single logout stays unsupported: `sloSupported` is `false`, no back-channel URL is registered, and a
sign-out at the platform leaves the ERPNext session alive until `session_expiry` expires it.

### Validation

Inside a running instance — replace the site and container names with the deployment's own:

```powershell
# 1. the row exists, is enabled, and carries the redirect URI the platform registered
docker exec seamnex-erpnext-erpnext-backend-1 bench --site erpnext.seamnex.localhost `
  execute frappe.client.get_value --kwargs "{'doctype':'Social Login Key','filters':{'provider_name':'Keycloak'},'fieldname':['enable_social_login','client_id','redirect_url','sign_ups']}"

# 2. the sign-in page offers the provider (needs client_id, base_url and a decryptable secret)
docker exec seamnex-erpnext-erpnext-backend-1 bench --site erpnext.seamnex.localhost `
  execute frappe.integrations.doctype.social_login_key.social_login_key.get_oauth_keys --kwargs "{'provider':'keycloak'}"

# 2b. the page the browser receives carries the provider button; the same literal the platform's
#     `sso_login` check greps for, so this prints a number and not an empty answer
curl.exe -sSk https://erpnext.seamnex.localhost:8443/login | Select-String "login_via_keycloak" -AllMatches

# 3. the session claim agrees with the entry
docker exec seamnex-erpnext-erpnext-backend-1 bench --site erpnext.seamnex.localhost `
  execute frappe.get_system_settings --kwargs "{'key':'session_expiry'}"
```

Then, from a workstation: open `https://erpnext.seamnex.localhost:8443/login`, click the provider
button, sign in at Keycloak, and confirm the browser returns to `/app` with a session. A first-time
user proves provisioning; a disabled user proves refusal; `ERPNEXT_SSO_DISABLE_LOCAL_LOGIN=true`
proves the fallback switch by hiding the password form.

The platform's own `sso_login` check walks the same path from inside the instance network — discovery,
the client secret applied to the instance, the product's own `/login` page carrying the provider
button, then the authorize redirect and an optional token exchange with claim validation. Every stage
is needed: the first two say the wiring exists, the third says the *product* offers it, and the last
two say the provider accepts it. A check that stopped before the third passed for a site with no
`Social Login Key` at all.

## Sanity check

The host below is the instance's route, `<slug>.<SEAMNEX_INGRESS_DOMAIN>`. `erpnext` is the slug the
entry's `integration.apiBaseUrl` and its `ERPNEXT_SITE_NAME` default both name, and it is what the
deployment wizard derives from the product name, so an unrenamed deployment is exactly this. A
deployment under another slug derives its own site name and origin, and the commands move with it.
The dev edge serves the route on `:8443` with its own certificate, which is why the request is
`https` with `-k`.

```powershell
# container view (the platform publishes no host port)
docker ps --filter "label=seamnex.entry=D06-01" --format "table {{.Names}}\t{{.Status}}"

# the product through the edge, exactly as a browser reaches it
curl.exe -sSk -o NUL -w "%{http_code}`n" https://erpnext.seamnex.localhost:8443/login

# the site is installed, not merely served
docker exec seamnex-erpnext-erpnext-backend-1 bench --site erpnext.seamnex.localhost list-apps
```

Expected: eight containers `Up`, `200` from `/login`, and `frappe` + `erpnext`
in `list-apps`.

## Images

| Image | Digest |
| --- | --- |
| `frappe/erpnext:v16.53.0` | `sha256:b961d69ed3265f44f712f40be58a3e6a22c8662f61a7e1a8097765534e3e9be2` — the multi-arch index digest, read from the registry (`docker buildx imagetools inspect frappe/erpnext:v16.53.0`) and identical to the catalog entry's `imageDigest`. That field is the single authority: a deployment compares the digest of the manifest it pulled against it. This table used to carry a second, different value that no artefact agreed with — `SOURCE_REVISION` holds no digest at all. |
| `mariadb:11.4` | inherited from D01-01/D04-01/D07-01 — same tag, already on the host |
| `redis:7-alpine` | inherited from the platform stack — same tag, already on the host |

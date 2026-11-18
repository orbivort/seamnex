# Vendored render set — D07-01 OrangeHRM 5.9

The platform resolves a source in this order: this vendored tree, then a `git clone` of the repository
named in the catalog. The tree exists because a deployment host may have no route to the git server
(air-gapped SMB, filtered corporate network, frozen audit baseline) and "the network is down" is not
an acceptable reason to be unable to deploy a pinned revision.

Provenance: the root `Dockerfile` of `orangehrm/orangehrm` at tag `v5.9`
(`56e23b3b09e7af29317a0943523b825843fff527`), which builds `php:8.3-apache-bookworm`, verifies the
release archive's MD5 and unpacks `orangehrm-5.9.zip` from SourceForge. Upstream publishes **no
image** and no Compose file, so both are supplied here.

## Deviations from upstream, each recorded rather than hidden

| Deviation | Why |
|---|---|
| `database` service added (`mariadb:11.4`, named volume, healthcheck) | OrangeHRM cannot run without MySQL: every screen past the login form reads a schema. The catalog entry has always declared `database` as a dependency; without a service in the render set the deployment reached the product's *installer* and stopped — a deployment that reports ready with nothing behind it. The installer creates the schema itself and **refuses a database that already exists**, so `MARIADB_DATABASE` is deliberately not set. |
| `VOLUME ["/var/www/html"]` removed | It declares the whole application — including the `lib/confs` configuration an install writes — as an anonymous volume. Compose materialises that on first run, so the installed tree is shadowed by an empty one and every restart presents a fresh, uninstalled application. Only `lib/confs` is mounted, which is what the product persists. |
| First-boot install (`seamnex-bootstrap.sh`, `seamnex-install-once.php`) | Upstream expects a human to walk through the web installer. The platform declares the database and admin values that installer asks for, so the install runs once, at boot, against the mounted `lib/confs` marker (`Config::isInstalled`). A restart never reinstalls; a failed install still starts Apache so the product's own web installer is reachable with the reason in the log. |
| `HTTPS` derived from `X-Forwarded-Proto` (`/etc/apache2/conf-enabled/seamnex-forwarded-proto.conf`) | The edge terminates TLS and forwards plain HTTP, so `$_SERVER['HTTPS']` was unset and every absolute URL the product built — the installer redirect, the post-login location, password-reset links — was emitted as `http://`. Same host, scheme nothing listens on. Scoped to the header rather than to an address because the edge's address on the instance network is dynamic. |
| Application image declared as a local build (`build:` + `pull_policy: never`, tag `seamnex/orangehrm:5.9`) | Upstream publishes no image, so the artefact has to come from this tree — and it has to come from it *during the deployment*, not from a host chore nobody checks. The tag is deliberately **not** under `orangehrm/…`: a reference in the product's namespace can only resolve to a third party's repackaging, which is exactly what ran (`entrypoint=docker-php-entrypoint`, no `Conf.php`) when the local build was missing. `docker.io/seamnex` is allow-listed, and `IMAGE-LICENCES.md` records the terms. |
| Licence evidence in the image (`IMAGE-LICENCES.md`, OCI labels) | An image is a distribution of three bodies of code under three sets of terms. The label states the platform's `GPL-3.0-only` and names the product's licence as an unverified reference rather than as a fact; the file that travels with the image says which part is unverified. |

Three notes for whoever edits this tree:

- the install runs as root because it writes `installer/cli_install_config.yaml` — a directory the
  application must not be able to modify at runtime — and hands `lib/confs`, `src/cache`, `src/log`
  and `src/config` back to `www-data` afterwards;
- `installer/cli_install.php` is deprecated upstream in favour of
  `installer/console install:on-new-database`, which refuses to run without a TTY. The deprecated
  entry point is the only supported way to install without a human at a prompt; it deletes its own
  config file once the install succeeds.
- **Nothing here patches the product.** Every difference is a file beside it, an entrypoint, a
  web-server rule or an OCI label. The first `sed` against a PHP file would make this a modified
  version under GPL-3.0 §5 — with an obligation to state and publish the change — and would break the
  "unmodified upstream archive" claim the `md5sum -c` line makes.

## Built by the deployment, never published

The `orangehrm` service declares `build:`, so the platform builds this tree during every deployment, in
its own `build` stage — after admission, before anything starts. Nothing is pushed, and nothing is
pulled: `pull_policy: never` makes an absent image an error rather than a download, so the tag
`seamnex/orangehrm:5.9` can only ever name an image this host produced from this tree.

The build is issued against the platform's BuildKit daemon (`buildkit` in `docker/compose.dev.yml`),
never through the socket proxy: a build session is a hijacked connection and the proxy's allow-list
answers it `403` (ADR-BE-40 §7). `--load` returns the image to the host daemon over the allow-listed
image endpoints, which is what lets the `apply` stage start it.

What each stage proves, in order:

| Stage | Proof |
| --- | --- |
| `build` | `docker compose build` ran from the resolved tree; the id it produced is recorded in the job log and the run state |
| `apply`, before `up` | the tag still resolves to that id — a retag or a substitution is refused with `IMAGE_DIGEST_MISMATCH` |
| `apply`, after `up` | the tag still resolves to that id, so the containers are running the artefact this deployment built |
| `record` | `instance_service.image_digest` holds the id, which is what a later deploy compares against |

**The first deploy of an instance is trust-on-first-use**: with no recorded id yet, the build's id is
recorded and logged (`is this instance's first local build`). Later deploys compare against it and
report a change as drift in the job log. Drift is not refused, because rebuilding an unchanged
definition legitimately produces a new id when the layer cache is gone or the base image moved;
refusing there would tie redeployment to build reproducibility this platform does not have. What *is*
refused is a tag that no longer resolves to what this run built — which is the substitution the whole
mechanism exists to stop.

The digest in `platform/default-catalog/D07-01.json` is reference data for this entry, not the pin: the
enforced baseline lives on the instance, because it is a property of the host that built the artefact.

An image that lives only on one host has two consequences worth stating:

- **Every host that may run the container builds its own copy.** There is nothing to pull, so a second
  node needs the deployment (or "Prefetch images") to run there too.
- **An export carries the image.** `docker save seamnex/orangehrm:5.9` belongs in an appliance export;
  a restore on another host cannot re-fetch it.

## Open actions — a licence review cannot pass until these close

Recorded here because they are properties of the artefact, not of the code that deploys it:

1. **Read the archive's licence.** `docker run --rm --entrypoint cat seamnex/orangehrm:5.9
   /var/www/html/LICENSE` (or `license/`, depending on the release). The catalogue says `GPL-3.0`;
   nothing in this tree proves it. `GPL-2.0-only` would make this image non-conveyable under a
   `GPL-3.0-only` platform (see `IMAGE-LICENCES.md` and `THIRD-PARTY-NOTICES.md` §7).
2. **Inventory the bundled components** from `composer.json` and `vendor/composer/installed.json`, and
   add a row per obligation-carrying licence to `IMAGE-LICENCES.md`.
3. **Record the licence review** in the register for the instance (`license_record`), which is what
   lifts the hosted-service gate.

## What the operator must supply

The catalog entry `D07-01` declares these variables (`env_schema_var`), so the values are injected by the
platform and never live in this tree:

- `ORANGEHRM_DATABASE_ROOT_PASSWORD` — secret, **required**: the MariaDB root password the installer
  uses to create the schema and the application's own database user. It has no fallback value on
  purpose; a well-known default would give every instance the same superuser password.
- `ORANGEHRM_DATABASE_PASSWORD` — secret: the password of the `orangehrm` database user the
  installer creates with rights on one schema. The application never runs as root.
- `ORANGEHRM_ADMIN_USERNAME` / `ORANGEHRM_ADMIN_PASSWORD` — the first administrator account, used
  only by the installer.
- `ORANGEHRM_ADMIN_EMAIL`, `ORANGEHRM_ADMIN_FIRST_NAME`, `ORANGEHRM_ADMIN_LAST_NAME`,
  `ORANGEHRM_ORGANIZATION_NAME`, `ORANGEHRM_ORGANIZATION_COUNTRY` — instance identity written into
  the schema. The country is an ISO 3166-1 alpha-2 code (`DE`, not `Germany`): the installer stores
  it in a two-character column.
- `ORANGEHRM_REGISTRATION_CONSENT` — whether the installer may register the instance with
  OrangeHRM's service. Defaults to `false`: the platform does not phone home on the operator's behalf.
- `ORANGEHRM_INSTALLER_LICENSE_AGREED` — whether an operator has read the release archive's licence and
  accepts it (`license.agree` in the installer config). Defaults to `false`, and the install refuses
  until it is `true`: a licence acceptance is the operator's to give, not something a deployment script
  can tick on their behalf. Apache still starts, so the product's own installer remains reachable with
  the reason in the log.

`ORANGEHRM_DATABASE_HOST`, `ORANGEHRM_DATABASE_PORT`, `ORANGEHRM_DATABASE_NAME` and
`ORANGEHRM_DATABASE_USER` are honoured when set and otherwise default to the service names in
`docker-compose.yml` (`orangehrm-db:3306`, schema `orangehrm`, user `orangehrm`).

To update the product, bump `SOURCE_REVISION`, the `OHRM_VERSION`/`OHRM_MD5` build arguments, the
image tag and the catalog's `imageRef` in the same commit, then deploy: the `build` stage rebuilds and
re-tags, and the next `record` writes the new id. Nothing is published, so there is no digest to push
anywhere — a version bump without a deploy changes nothing on the host, which is the point of the
`imageRef`/tag move being a reviewable commit.

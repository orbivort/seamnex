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
| Application image built from this tree | There is no published image to pin. Build it once on the deployment host and let the platform pin the tag: `docker build -t orangehrm/orangehrm:5.9 platform/upstream/D07-01`. The render set references the tag; the platform records the resulting digest on the instance. |
| Image tag `orangehrm/orangehrm:5.9` | Recorded here rather than as an upstream reference: the tag is *this tree's* artefact. A floating tag would be refused by the compose policy anyway. |

Two notes for whoever edits this tree:

- the install runs as root because it writes `installer/cli_install_config.yaml` — a directory the
  application must not be able to modify at runtime — and hands `lib/confs`, `src/cache`, `src/log`
  and `src/config` back to `www-data` afterwards;
- `installer/cli_install.php` is deprecated upstream in favour of
  `installer/console install:on-new-database`, which refuses to run without a TTY. The deprecated
  entry point is the only supported way to install without a human at a prompt; it deletes its own
  config file once the install succeeds.

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

`ORANGEHRM_DATABASE_HOST`, `ORANGEHRM_DATABASE_PORT`, `ORANGEHRM_DATABASE_NAME` and
`ORANGEHRM_DATABASE_USER` are honoured when set and otherwise default to the service names in
`docker-compose.yml` (`orangehrm-db:3306`, schema `orangehrm`, user `orangehrm`).

To update the product, bump `SOURCE_REVISION`, the `OHRM_VERSION`/`OHRM_MD5` build arguments, the
image tag and the catalog's `imageRef` in the same commit, then deploy again; the render set is
content-addressed, so the change is visible as a new set rather than an in-place mutation.

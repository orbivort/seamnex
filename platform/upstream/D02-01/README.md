# D02-01 — Mautic, vendored render set

`docker-compose.yml` in this directory is the reviewed source of truth for a D02-01 deployment when the
resolver cannot clone `https://github.com/mautic/mautic` (no route to the git host, or an air-gapped
host). The resolver copies this tree into the per-attempt source directory and records
`SOURCE_REVISION` as the source revision, so "what was deployed" is provable without the network.

| Concern | Rule |
| --- | --- |
| Images | `mautic/mautic:7.2.2-apache` (base, pinned) and `mariadb:11.4`. The application is a thin layer over the base tag and is pinned as `seamnex/mautic:7.2.2`; a floating tag is refused by the compose policy (`unpinned_image`) before anything is applied. |
| Host ports | No `ports:` at all: the platform publishes none, the edge reaches the container on the instance network, and `expose: ['80']` is what the catalog `httpPort` refers to. |
| Database | Added here. Mautic's installer creates tables but neither the schema nor the account, so the MariaDB container creates both (`MARIADB_DATABASE`, `MARIADB_USER`) and a healthcheck gates the application on `--innodb_initialized`, not merely on a socket. |
| Build | The wrapper image is built **on the host**, once: `docker build -t seamnex/mautic:7.2.2 platform/upstream/D02-01`. The compose file references the tag and carries no `build:` section, because the executor's BuildKit session is refused by the scoped socket proxy (`unable to upgrade to tcp, received 403`) — a `build:` section made the apply fail at step 4 with that line as its only diagnostic. |
| First boot | `seamnex-bootstrap.sh` runs `bin/console mautic:install` once, then delegates to the image's own `/entrypoint.sh`. The image ships the product uninstalled and only starts Apache — a deployment that reported ready on that state would be a deployment of nothing. |
| Marker | `/var/www/html/config/local.php` with a `db_driver` and a `site_url`, the same test the image uses in `wait_for_mautic_install.sh`. A restart never reinstalls. |
| Cron | A second container with `DOCKER_MAUTIC_ROLE=mautic_cron`. Campaign and segment mail is sent from scheduled commands; without it the product looks healthy and sends nothing. |
| Bounded waits | The image's cron entrypoint waits for an installation *forever*, so a failed install left a "running" container that never worked. The wrapper bounds the wait and exits, which turns the failure into a visible restart loop. |
| Volumes | `mautic-config`, `mautic-media`, `mautic-logs`, `mautic-db`. `/var/www/html/var` as a whole is **not** mounted: `var/cache/prod` ships pre-built in the image and an empty volume would shadow it. |

## What the operator must supply

The catalog entry `D02-01` declares the variables this file reads (`env_schema_var`), so the values are
injected by the platform and never live in this tree:

- `MAUTIC_SITE_URL` — the published route including the edge port, e.g. `http://marketing.localhost:8020`.
  Mautic builds every absolute URL in an e-mail from it, so a container-name value produces
  unsubscribe and tracking links nobody can open.
- `MAUTIC_ADMIN_USERNAME` / `MAUTIC_ADMIN_PASSWORD` / `MAUTIC_ADMIN_EMAIL` — read once, by the install.
- `MAUTIC_DB_PASSWORD` — secret; the application account the database container creates.
- `MAUTIC_DATABASE_ROOT_PASSWORD` — secret and required: the file has no `${...:-root}` fallback,
  because that default is how every instance of every product ends up sharing a superuser password.
- `MAUTIC_DB_TABLE_PREFIX` — locked to empty. The 7.2.2 installer writes the prefix into `local.php`
  but creates the schema unprefixed, so `mautic_` produced a schema-less installation whose very
  next migration failed on `Table 'mautic.mautic_email_stats' doesn't exist`.

## Recovering a failed installation

The installer refuses a schema whose tables already exist, so a half-finished install is repaired by
removing the database volume and deploying again — not by re-running the installer against the old
schema:

```bash
docker volume rm seamnex-marketing_mautic-db
```

## Updating

Bump the base tag in `Dockerfile` and the `image:` name in `docker-compose.yml`, refresh
`SOURCE_REVISION`, rebuild (`docker build -t seamnex/mautic:<version> platform/upstream/D02-01`), then
update `imageRef` in `platform/catalog/env/D02-01.json` in the same commit. The render set is
content-addressed, so the change is visible as a new set rather than an in-place mutation of the
previous one.

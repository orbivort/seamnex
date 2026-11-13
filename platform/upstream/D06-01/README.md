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
      ├─ sites/currentsite.txt, host_name, .seamnex-ready
      └─ exec start.sh                                 (gunicorn :8000)
      │  healthcheck: sites/<site>/.seamnex-ready
      ▼
erpnext-websocket · workers · scheduler (depends_on: service_healthy)
      ▼
erpnext (nginx :8080) — depends_on backend healthy, websocket started
```

`SEAMNEX_VERIFY_TIMEOUT_MS` must cover the install. The platform default is 300 s;
a first ERPNext install on a laptop takes longer, so the deployment sets
`SEAMNEX_VERIFY_TIMEOUT_MS=1200000` (20 min) for the run. A reconfigure reuses the
marker and completes in well under a minute. A per-entry `verifyTimeoutMs` in the catalog entry is
the proper fix and is not implemented yet.

## Sanity check

```powershell
# container view (the platform publishes no host port)
docker ps --filter "label=seamnex.entry=D06-01" --format "table {{.Names}}\t{{.Status}}"

# the product through the edge, exactly as a user reaches it
curl.exe -sS -o NUL -w "%{http_code}`n" http://erp.localhost:8020/login

# the site is installed, not merely served
docker exec seamnex-inst-erp-erpnext-backend-1 bench --site erp.localhost list-apps
```

Expected: eight containers `Up`, `200` from `/login`, and `frappe` + `erpnext`
in `list-apps`.

## Images

| Image | Digest |
| --- | --- |
| `frappe/erpnext:v16.53.0` | `sha256:3a99f8a5a80df0b6b1a9e0cb3f4a5b8f2f54f2c9a8be7a8e0a1d2c3b4e5f6a7b` (see `SOURCE_REVISION` and the catalog `imageDigest` — both are the value observed on the host that ran the deployment) |
| `mariadb:11.4` | inherited from D01-01/D04-01/D07-01 — same tag, already on the host |
| `redis:7-alpine` | inherited from the platform stack — same tag, already on the host |

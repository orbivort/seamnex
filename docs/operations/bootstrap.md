# Bootstrap a host

This is the install path for a host that is not a development machine: one command, re-runnable, with
a verifiable end state. It is the evidence for NFR-6.2 (clean host to a working platform, ≤60 minutes,
idempotent), NFR-6.3 (the same procedure on a different host), S-9 (an operator who has never built
this repository, unassisted, ≤2 hours including one deployment) and AC-19 (the result matches the
reference instance set).

The procedure is `pnpm bootstrap`. This page says what it does, what it does not do, and how to prove
it worked.

## Prerequisites

| Requirement  | Detail                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------- |
| OS           | Linux is the host target. macOS and Windows work through Docker Desktop for a local install.  |
| Node.js      | The version in `package.json` `engines.node` (24.15 or newer, below 25).                      |
| pnpm         | The version in `package.json` `packageManager` (11.21), activated with Corepack.              |
| Docker       | Engine (or Desktop) with **Compose v2** (`docker compose`, not `docker-compose`).             |
| Resources    | 4 vCPU, 8 GB RAM, 40 GB free. The default profile runs eighteen services; one is a one-shot.  |
| Network      | Outbound HTTPS for image pulls and package installation.                                      |
| Git checkout | The repository at the version you intend to install. The bootstrap installs the working tree. |

The bootstrap checks Node, pnpm and Docker (with Compose v2) and stops with the missing one named. It
does not check the OS, the resources or the network.

## Ports

Everything binds to `127.0.0.1`. Nothing in this install is reachable from another host — see
[what this does not do](#what-this-does-not-do).

| Port       | Service                        | Needed for                     |
| ---------- | ------------------------------ | ------------------------------ |
| 8080       | API (and the readiness probe)  | verification, console proxy    |
| 5173, 5174 | Portal and console (Vite, TLS) | the browser surfaces           |
| 8082       | Keycloak                       | sign-in                        |
| 5432       | PostgreSQL                     | schema, seed, backups          |
| 6379       | Redis                          | job queue, rate limits         |
| 8443, 8081 | Traefik (product edge, TLS)    | deployed products              |
| 5678       | n8n                            | workflow steps                 |
| 9000       | S3 gateway (VersityGW)         | backup artefacts               |
| 8025, 1025 | Mailpit (SMTP and web)         | notifications, password resets |
| 8090       | Auth gateway                   | session forwarding             |
| 8091       | Relay                          | product bootstrap              |
| 8092       | Broker proxy                   | workflow callbacks             |

The edge serves products over TLS only, on `https://<slug>.localhost:8443`. The install has no public
DNS name, so it presents the edge's own certificate and the browser asks you to accept it once — a
development affordance, not the production shape (ADR-BE-39). Port 80 is deliberately not published:
inside the edge it carries the ACME challenge and the redirect to HTTPS, which a real deployment
publishes instead (see [what this does not do](#what-this-does-not-do)).

The edge reads its dynamic directory through the compose bind mount, and Docker Desktop on Windows does
not deliver file-provider watch events for changes made on the host: a route the platform projects after
the stack is up answers 404 (or keeps answering after it is gated) until the edge re-reads the directory.
`docker compose -f docker/compose.dev.yml restart traefik` applies it. On Linux the watch works, so this
is a development-host caveat rather than an edge design constraint.

An `.env` written before this change still says `SEAMNEX_PRODUCT_URL_SCHEME=http` and `_PORT=8020`, and
has no `SEAMNEX_EDGE_TLS_MODE`; those values name a port the stack no longer publishes. `pnpm dev`
refuses to start and prints the three lines to change (`https`, `8443`, `internal`). The API reports the
same pair in its first log line — `productUrl` and `edgeTlsMode` — so a deployment can be checked
without opening a browser.

The observability profile (Grafana 3000, Prometheus 9090, Alertmanager 9093, Loki 3100) is off unless
started with `--profile observability`.

## Time budget

The requirement's sixty minutes, allocated. The second column is what a re-run costs.

| Step                                | First run     | Re-run      |
| ----------------------------------- | ------------- | ----------- |
| Preflight and `.env`                | 2 min         | <10 s       |
| Workspace install (frozen lockfile) | 3–5 min       | <30 s       |
| Image pulls (network-bound)         | 15–25 min     | 0           |
| Schema migrations                   | <1 min        | <10 s       |
| Realm import and admin client       | 3 min         | 1 min       |
| API and workers to ready            | 2 min         | <30 s       |
| Seed and catalogue projection       | 2 min         | <30 s       |
| Verify (checklist below)            | 5 min         | 5 min       |
| One product deployment              | 10 min        | 10 min      |
| **Total**                           | **43–53 min** | **~18 min** |

## Procedure

### 1. Install the toolchain

```bash
corepack enable
corepack prepare pnpm@11.21.0 --activate
node --version   # must satisfy package.json engines.node
pnpm --version   # 11.x
docker info      # the daemon must answer
docker compose version
```

### 2. Run the bootstrap

```bash
pnpm bootstrap
```

It installs the workspace from the frozen lockfile, creates `.env` from `.env.example` **only if it is
absent**, writes the root key and Keycloak credential files if they are missing, brings up the stack
(schema first, then services, then the realm import and the admin-client reconcile), seeds the
identity mirror and the default catalogue, and waits for `/api/v1/readyz`.

Expected last lines:

```
[bootstrap] ready at http://127.0.0.1:8080/api/v1/readyz (postgres:ok, redis:ok, idp:ok)
[bootstrap] this host is installed and verified.
```

If a step fails, the command stops at that step and names it. Every step is idempotent, so fixing the
cause and re-running is the intended recovery, not a reinstall.

### 3. Start the console

The console is a Vite application, not a stack service:

```bash
pnpm dev:console
```

Then open `https://localhost:5174` and sign in as `dev-admin` — the dev servers speak TLS with a
certificate issued by the development CA in `temp/certs`. Trust it once
(`certutil -user -addstore Root temp\certs\dev-ca.crt` on Windows) and the warning stops for both SPAs;
only the leaf is reissued each year, so the trust survives. [Certificates](certificates.md) covers the
other clients, the lifecycle and the warnings a rotated CA produces. The realm import provisions the
development accounts (`dev-admin`, `dev-auditor`, `dev-owner`, `dev-product`, `dev-user`, `dev-guest`);
their role bindings come from the seed. This is the platform's current identity story and it is a
limitation, not a hidden convenience — see [what this does not do](#what-this-does-not-do).

### 4. Deploy one product

This is S-9's second half and AC-19's evidence. From the console: **Deployments → New deployment**,
choose a catalogue entry (the default set ships six — `D01-01`, `D02-01`, `D06-01`, `D07-01`,
`D09-01`, `D11-01`), accept the plan and watch the job.

A deployment that reaches `succeeded` proves the whole path: catalogue, render, policy, Docker, edge
routing and the job queue. A deployment that stalls at `Resolve source` usually means the runtime
directories were not writable; re-run `pnpm bootstrap`.

### 5. Take a backup

From **Governance → Recovery**, start an instance backup and let it finish. Then start a platform
backup. The instance backup proves the dump and object-store path; the platform set is what a
host-portable restore needs (NFR-6.3).

## Verify

`pnpm bootstrap:check` repeats everything that can be checked without changing anything:

| Check                  | Passing answer                                                                |
| ---------------------- | ----------------------------------------------------------------------------- |
| Toolchain              | `node … satisfies`, `pnpm 11.x`, `docker and docker compose v2 are available` |
| `.env` and credentials | `… is present`, no warning about the root key or the admin-client secret      |
| Readiness              | `ready at …/readyz (postgres:ok, redis:ok, idp:ok)`                           |
| Posture                | the warnings listed under [Posture](#posture) are the ones you accept         |

Then the two facts the command cannot see:

| Fact (AC-19)                                          | Where to look                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------- |
| A product deploys from version-controlled definitions | the deployment from step 4 reached `succeeded`                            |
| The instance set matches the reference                | **Deployments** lists the same set as the reference environment's capture |

## Re-run and recovery

| Symptom                                   | Action                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------- |
| A step failed and the cause is fixed      | `pnpm bootstrap` — it converges, it does not duplicate                                 |
| Unsure whether the host is installed      | `pnpm bootstrap:check`                                                                 |
| API is up but `/readyz` never turns green | `pnpm dev:stack:logs api`, then `pnpm bootstrap` again                                 |
| A container is crash-looping              | `pnpm dev:stack:logs <service>`, `docker compose ps`                                   |
| The realm import failed                   | `pnpm dev:stack up` (it waits for `keycloak-config-cli`), then `pnpm kc:admin --check` |
| `.env` was edited into an unusable state  | restore the file from your copy — the bootstrap never overwrites it                    |
| Starting over from nothing                | `pnpm dev:stack:down -v` then `pnpm bootstrap`; **`-v` deletes the data volumes**      |

What a re-run does **not** do: it never rotates a credential, never overwrites `.env`, never re-creates
an existing key file, and never deletes a volume.

## Posture

The bootstrap prints these on every run. They are warnings because a development host may legitimately
answer yes to all of them.

| Warning                            | What to do on a host that matters                                             |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD` is the example | Change it, and `DATABASE_URL` with it, before the database holds anything     |
| `AUTH_PROVIDER=stub`               | Not a sign-in; set `oidc` and point `AUTH_ISSUER_URL` at your provider        |
| `SEAMNEX_ROOT_KEY_STRICT_MODE=0`   | Set `1` on a POSIX host; it is `0` only because Docker Desktop reports `0777` |
| Root key file missing              | Restore it from escrow — without it, stored credentials cannot be decrypted   |

## What this does not do

| Gap                                 | Why, and where it is tracked                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACME certificates                   | The edge terminates TLS, but the install has no public DNS name to validate one. A real deployment sets `SEAMNEX_EDGE_TLS_MODE=acme`, supplies `SEAMNEX_TRAEFIK_ACME_EMAIL` and publishes 80/443 (ADR-BE-39). |
| Production identities               | The realm import ships `dev-*` accounts; provisioning real users is not solved.                                                                                                                               |
| A hosted console                    | The console is Vite (`pnpm dev:console`), not a container.                                                                                                                                                    |
| Off-host restore                    | Recovery is a console procedure (Recovery screen), not a bootstrap step.                                                                                                                                      |
| A console "bootstrap review" screen | AC-37's remaining half: it needs an API operation, not a runbook.                                                                                                                                             |
| Firewall and OS hardening           | The host's responsibility; this install assumes a trusted network.                                                                                                                                            |

## Portability

NFR-6.3's test is a second host, not a second install on this one:

1. Export the definitions — the catalogue repository and the platform backup set — from the first host.
2. Install the second host with `pnpm bootstrap` (a clean host, same version).
3. Restore the platform set from **Governance → Recovery** (identity provider and control plane first).
4. Confirm `/readyz` and deploy one product, then compare the instance set with the first host's.

Nothing in step 1 or 3 depends on the host's paths: the root key travels as an escrow _reference_, and
the backup set records the key's id rather than the key.

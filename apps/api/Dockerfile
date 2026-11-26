# One image, nine roles (ADR-BE-03). The role is chosen by the entrypoint, never by the build.
#
# The API runs on tsx against TypeScript sources because `@seamnex/domain` is source-only on purpose
# (ADR-BE-02 amendment): one copy of the contract schemas is loaded by the browser, the tests and
# the server. Phase 6 may add a bundled build; this image is sized for correctness, not bytes.
#
# The tag names the patch `.nvmrc` pins and CI installs, so the image and the tests run the same
# Node; the digest is the manifest index for every architecture, so a re-push of the tag cannot
# change what a release was built on. Both move in one commit, as the compose pins do
# (`docker/compose.dev.yml`). The version has to stay inside `engines.node` (`>=24.15.0 <25`):
# `engineStrict: true` turns a violation into a failed install at the `pnpm install` below, but it
# cannot see a floor that moved after the image was built, so the pin is what keeps the two in step.
#
# Two stages. `deps` resolves the production tree; `runtime` copies it. The split is not about the
# TypeScript -- it stays uncompiled, per the paragraph above -- it is about the build's own tooling:
# the `pnpm` bootstrap, npm's cache and the package store exist in `deps` and cannot reach the
# artefact. Nothing a build needs is allowed to ship.
#
# The reference is written out three times -- one per stage, because a stage cannot inherit a `FROM`,
# and once more in the `base.digest` label -- and all three are one reference that moves in one
# commit. A digest that disagrees between the lines is an image containing two Node patch levels; a
# label that disagrees is a provenance claim that is not true.
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS deps

# Manifests first: a source change must not invalidate the dependency layer. `--chown` on the copy
# avoids a recursive chown over node_modules, which dominates build time.
#
# `/app`, `/app/apps` and `/app/packages` are created and owned before the copy for the same
# reason: `pnpm` writes a `node_modules` inside every workspace package it installs, and a
# root-owned parent would fail the install with EACCES three packages deep. The five leaf
# directories are created too, rather than left to `COPY`: `--chown` governs the files it copies,
# and a `RUN` as an unprivileged user cannot rely on what it did to an implicitly created directory.
WORKDIR /app
RUN mkdir -p /app/apps/api /app/packages/config /app/packages/domain /app/packages/db && \
    chown -R node:node /app

COPY --chown=node:node pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY --chown=node:node packages/config/package.json packages/config/
COPY --chown=node:node packages/domain/package.json packages/domain/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node apps/api/package.json apps/api/

# Corepack is deprecated: it is no longer bundled from Node 25 on, and this image has to keep
# building after that. The version is read from `packageManager` rather than repeated here, so the
# image, CI (`pnpm/action-setup` reads the same field) and a contributor checkout cannot disagree.
#
# `--registry` reaches this bootstrap as well as the install below: a host that needs `NPM_REGISTRY`
# to fetch a dependency needs it to fetch `pnpm` itself, and without the flag the build died here
# before the argument was ever in scope. Never pass a mirror URL carrying credentials -- a build
# argument is recorded in the image's history and provenance; a credentialed mirror belongs in
# `--mount=type=secret,id=npmrc,target=/root/.npmrc`.
ARG NPM_REGISTRY=
RUN set -eu; \
    version="$(sed -n 's/.*"packageManager":[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' package.json)"; \
    test -n "$version"; \
    registry=; \
    if [ -n "$NPM_REGISTRY" ]; then registry="--registry=$NPM_REGISTRY"; fi; \
    npm install -g --cache /tmp/npm "pnpm@$version" $registry; \
    rm -rf /tmp/npm; \
    pnpm --version

# `--prod`: the runtime is tsx over sources, and `tsx` is a production dependency of both
# `@seamnex/api` and `@seamnex/db`. Without it the image carried vitest, typescript and @types/*.
#
# `@seamnex/config` is a production dependency of `@seamnex/api` for the same reason, even though it only
# ships tsconfig/eslint presets: `apps/api/tsconfig.json` extends `@seamnex/config/tsconfig/node.json`,
# and the runtime loader reads that file. As a devDependency it was dropped here, the `extends`
# stopped resolving, and the loader fell back to defaults without `experimentalDecorators` — the
# entrypoint died on the first parameter decorator. Its own dependencies are devDependencies, so
# nothing else comes in with it.
#
# `NPM_REGISTRY` is `APK_MIRROR`'s counterpart for the dependency layer: registry.npmjs.org is
# reachable from most build hosts, but not from all of them, and a machine that already points `pnpm`
# at a mirror should not have to remember that the image installs from somewhere else. It defaults to
# empty, so CI keeps the public registry.
#
# The override is a flag on this one command, not an `.npmrc` and not an `ENV`: the lockfile stores
# integrity hashes rather than tarball URLs (`lockfileVersion: '9.0'`), so `--registry` really does
# move every fetch, and config written into the image would outlive the build that needed it -- the
# same rule `APK_MIRROR` follows in the stage below.
#
# Runs as `node`. The tree this stage produces is therefore already owned by the user that reads it,
# so `runtime` copies it without `--chown` and without a second pass over node_modules. The store is
# a cache mount: it survives the layer without entering the image, so an edited manifest re-resolves
# instead of re-downloading. BuildKit only -- `docker build` (23+) and compose v2 both are.
#
# None of it ships. `runtime` copies `/app` and nothing else from this stage, so the `pnpm` bootstrap
# and the store are gone with it; every `pnpm <script>` a document names in this package has a
# `node --import tsx <script>` equivalent that needs neither. Adding `pnpm` back to the runtime stage
# would mean adding npm's cache back with it, which is what this stage exists to keep out.
USER node
RUN --mount=type=cache,id=pnpm-store,target=/home/node/.local/share/pnpm/store,sharing=locked,uid=1000,gid=1000 \
    set -eu; \
    registry=; \
    if [ -n "$NPM_REGISTRY" ]; then registry="--registry=$NPM_REGISTRY"; fi; \
    pnpm install --frozen-lockfile --prod --filter @seamnex/api... $registry

# ---------------------------------------------------------------------------------------------------
FROM node:24.22.1-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime

# Provenance (OCI image spec). CI passes the commit it built from, so an image that is running
# somewhere can be traced back to a review; a local build says so instead of inventing a value.
ARG GIT_SHA=unknown
# The release tag this build came from. `0.0.0` is the workspace placeholder, so an image built from
# an untagged checkout says exactly that instead of advertising a release that does not exist. CI
# derives it from the ref; nothing reads it from a manifest, because no manifest carries a version.
ARG SEAMNEX_BUILD_VERSION=0.0.0
LABEL org.opencontainers.image.title="Seamnex control plane" \
      org.opencontainers.image.description="Seamnex — self-hosted FOSS domain platform: portal BFF, operator console API and the nine process roles" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/orbivort/seamnex" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${SEAMNEX_BUILD_VERSION}" \
      org.opencontainers.image.base.name="node:24.22.1-alpine" \
      org.opencontainers.image.base.digest="sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53"

# Phase 4 tooling (ADR-BE-12). The Engine API covers containers, networks, volumes and logs, but
# BuildKit and `docker save` are CLI-only, `age` encrypts backups and `zstd` compresses volumes.
# `docker-cli-compose` applies a rendered project; every call is argv-only with `shell: false`.
#
# `apk` reads one origin, dl-cdn.alpinelinux.org (Fastly). On a build host whose egress filters that
# CDN the TCP connection opens and then stalls inside the TLS handshake: this layer sat for four
# minutes and died with "TLS: unspecified error" followed by "no such package" for every name it was
# asked for. `APK_MIRROR` repoints the two branch repositories at a mirror the *build host* can reach.
# It defaults to empty on purpose: CI and a clean machine keep upstream, and the mirror is a fact
# about the network, not about the image. The branch comes from the image's own release file, so a
# mirror can never drift the base to a different Alpine major or minor. The original file is put back
# before the layer commits, so the rewrite is scoped to this RUN: an image built on a mirrored host
# does not advertise that host's internal URL, and does not carry it into a later `apk` call.
#
# The retry loop is not decoration either: the same CDN drops individual fetches on a healthy
# network, a failed `apk add` leaves no layer behind, so a retry costs seconds where a rebuild costs
# minutes. Three attempts, then the repositories the base image ships, then a loud failure rather than
# an image missing `tini` or `docker-cli`. The fallback is the mirror's own failure mode: it publishes
# one index per branch, and a mirror that is mid-sync serves an index naming files it has not copied
# yet — on 2026-11-25 `mirrors.tuna.tsinghua.edu.cn/alpine/v3.24/main` listed `libexpat-2.11.0-r0`
# while the tarball answered `404`, so every retry re-read the same index and only upstream carried
# the file. A mirror is a fact about the network and is allowed to be broken; it is not allowed to be
# the only origin.
#
# Two additions to the same layer. The runtime state directories are created here and owned by
# `node`, because a deployment that mounts an unnamed volume (a `docker run -v`, a Kubernetes
# emptyDir) inherits the image directory's ownership: without them the first `mkdir` under
# /var/lib/seamnex fails with EACCES, which is how the scan tree once stopped at IMAGE_SCAN_BLOCKED.
# And the resolved package set is printed, so a rebuild of the same commit that silently moved
# `docker-cli` or `age` is a visible diff in the log rather than a fact discovered at deploy time.
ARG APK_MIRROR=
RUN set -eu; \
    packages="tini git docker-cli docker-cli-compose docker-cli-buildx age zstd"; \
    if [ -n "$APK_MIRROR" ]; then \
      cp /etc/apk/repositories /tmp/alpine-repositories; \
      branch="v$(cut -d. -f1,2 /etc/alpine-release)"; \
      mirror="${APK_MIRROR%/}"; \
      printf '%s/%s/main\n%s/%s/community\n' "$mirror" "$branch" "$mirror" "$branch" > /etc/apk/repositories; \
    fi; \
    attempt=1; \
    while ! apk add --no-cache $packages; do \
      if [ "$attempt" -ge 3 ] && [ -f /tmp/alpine-repositories ]; then \
        echo "apk add failed $attempt times against $APK_MIRROR; trying the repositories the base image ships" >&2; \
        mv /tmp/alpine-repositories /etc/apk/repositories; \
        apk add --no-cache $packages; \
        break; \
      fi; \
      if [ "$attempt" -ge 3 ]; then echo "apk add failed after $attempt attempt(s)" >&2; exit 1; fi; \
      attempt=$((attempt + 1)); \
      echo "apk add failed, retrying (attempt $attempt/3)" >&2; \
      sleep 5; \
    done; \
    if [ -f /tmp/alpine-repositories ]; then mv /tmp/alpine-repositories /etc/apk/repositories; fi; \
    mkdir -p /var/lib/seamnex/instances /var/lib/seamnex/backups /var/lib/seamnex/age \
             /var/lib/seamnex/scans /var/lib/seamnex/trivy-cache \
             /var/lib/seamnex/prometheus-targets /var/lib/seamnex/catalog-repo; \
    chown -R node:node /var/lib/seamnex; \
    apk info -v | sort

WORKDIR /app

# The production tree from `deps`, symlinks and all. pnpm's isolated linker writes *relative* links
# into `node_modules/.pnpm`, so the tree is valid as long as both stages keep the same absolute path
# (`/app`) -- do not rename it on one side. Ownership is carried over from the source stage, which is
# why no `--chown` and no recursive pass is needed here.
COPY --from=deps /app /app

COPY --chown=node:node packages/config packages/config
COPY --chown=node:node packages/domain packages/domain
COPY --chown=node:node packages/db packages/db
COPY --chown=node:node apps/api apps/api
COPY --chown=node:node docs/openapi.json docs/openapi.json
# GPL-3.0 §4/§6: an image conveys object code and the sources it was built from, so the licence and
# the notices travel with it rather than staying behind in the repository. `.dockerignore` keeps
# `**/*.md` out of the context and makes an explicit exception for the notices file this needs.
COPY --chown=node:node LICENSE THIRD-PARTY-NOTICES.md ./

# Non-root, and by id rather than by name: a runtime that enforces `runAsNonRoot` verifies the
# number, and a base image that ever renames the account must not change what this line means. Same
# 1000:1000 the official image gives `node`, so the `--chown` copies above still match.
#
# The root key is mounted, never baked in; the workspace is read-only at runtime.
USER 1000:1000

# The build identity is an `ENV`, not only a label: `GET /api/v1/healthz` reports it, which is the
# one place an operator can read the release without registry access (`docker inspect` needs a host).
ENV NODE_ENV=production \
    SEAMNEX_ROLE=api \
    SEAMNEX_BUILD_VERSION=${SEAMNEX_BUILD_VERSION} \
    SEAMNEX_BUILD_REVISION=${GIT_SHA} \
    PORT=8080 \
    HOST=0.0.0.0

# The default command's port only. One image serves nine roles and three of the other roles bind
# their own listener -- `auth-gateway` 8090, `relay` `SEAMNEX_RELAY_PORT` (8091), `broker-proxy`
# `SEAMNEX_BROKER_PORT` (8092) -- but publishing those for the `api` role would advertise sockets
# nothing listens on, so they are named here and not declared.
EXPOSE 8080

# No `HEALTHCHECK` in this file, on purpose. The probe is a property of the *role*, and the image
# cannot know which role it will be asked to run: a check that exits 0 for a worker reports a green
# container for a process that consumes nothing, and a check that fetches 8080 marks eight of nine
# roles unhealthy forever. `docker/compose.dev.yml` therefore declares the `api` probe and disables
# it for the rest; a production orchestrator owns the same decision. The endpoints are split for
# that: `/api/v1/healthz` is liveness (no dependency call) and `/api/v1/readyz` is readiness
# (Postgres and Redis), so a probe is never made to restart a healthy process over an outage.

# `tini` reaps zombies and forwards signals, which is what makes graceful shutdown reliable when
# a worker is mid-step.
ENTRYPOINT ["/sbin/tini", "--"]

# The runtime resolves `--import tsx` the way Node resolves any bare specifier: upwards from the
# *current working directory*. pnpm's isolated linker links `tsx` into `apps/api/node_modules` (it
# is a dependency of that package, not of the workspace root — the root only holds `.pnpm`), so
# running from `/app` threw `ERR_MODULE_NOT_FOUND: Cannot find package 'tsx'` and the container
# restart-looped. Start inside the package that declares it, so the entry path is package-relative.
WORKDIR /app/apps/api

CMD ["node", "--import", "tsx", "src/main-api.ts"]

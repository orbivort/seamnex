# One image, nine roles (ADR-BE-03). The role is chosen by the entrypoint, never by the build.
#
# The API runs on tsx against TypeScript sources because `@seamnex/domain` is source-only on purpose
# (ADR-BE-02 amendment): one copy of the contract schemas is loaded by the browser, the tests and
# the server. Phase 6 may add a bundled build; this image is sized for correctness, not bytes.
FROM node:24-alpine

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
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.version="${SEAMNEX_BUILD_VERSION}"

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
# mirror can never drift the base to a different Alpine major or minor.
#
# The retry loop is not decoration either: the same CDN drops individual fetches on a healthy
# network, a failed `apk add` leaves no layer behind, so a retry costs seconds where a rebuild costs
# minutes. Three attempts, then fail loudly rather than ship an image missing `tini` or `docker-cli`.
ARG APK_MIRROR=
RUN set -eu; \
    if [ -n "$APK_MIRROR" ]; then \
      branch="v$(cut -d. -f1,2 /etc/alpine-release)"; \
      mirror="${APK_MIRROR%/}"; \
      printf '%s/%s/main\n%s/%s/community\n' "$mirror" "$branch" "$mirror" "$branch" > /etc/apk/repositories; \
    fi; \
    attempt=1; \
    while true; do \
      if apk add --no-cache tini git docker-cli docker-cli-compose docker-cli-buildx age zstd; then break; fi; \
      if [ "$attempt" -ge 3 ]; then echo "apk add failed after $attempt attempt(s)" >&2; exit 1; fi; \
      attempt=$((attempt + 1)); \
      echo "apk add failed, retrying (attempt $attempt/3)" >&2; \
      sleep 5; \
    done

WORKDIR /app

# Manifests first: a source change must not invalidate the dependency layer.
# `--chown` on the copy avoids a recursive chown over node_modules, which dominates build time.
COPY --chown=node:node pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Corepack is deprecated: it is no longer bundled from Node 25 on, and this image has to keep
# building after that. The version is read from `packageManager` rather than repeated here, so the
# image, CI (`pnpm/action-setup` reads the same field) and a contributor checkout cannot disagree.
RUN set -eu; \
    version="$(sed -n 's/.*"packageManager":[[:space:]]*"pnpm@\([^"]*\)".*/\1/p' package.json)"; \
    test -n "$version"; \
    npm install -g "pnpm@$version"; \
    pnpm --version

COPY --chown=node:node packages/config/package.json packages/config/
COPY --chown=node:node packages/domain/package.json packages/domain/
COPY --chown=node:node packages/db/package.json packages/db/
COPY --chown=node:node apps/api/package.json apps/api/

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
# move every fetch, and a mirror written into the image's config would follow the container into
# runtime, where `pnpm` may run on behalf of a deploy step.
ARG NPM_REGISTRY=
RUN set -eu; \
    registry=; \
    if [ -n "$NPM_REGISTRY" ]; then registry="--registry=$NPM_REGISTRY"; fi; \
    pnpm install --frozen-lockfile --prod --filter @seamnex/api... $registry

COPY --chown=node:node packages/config packages/config
COPY --chown=node:node packages/domain packages/domain
COPY --chown=node:node packages/db packages/db
COPY --chown=node:node apps/api apps/api
COPY --chown=node:node docs/openapi.json docs/openapi.json
# GPL-3.0 §4/§6: an image conveys object code and the sources it was built from, so the licence and
# the notices travel with it rather than staying behind in the repository. `.dockerignore` keeps
# `**/*.md` out of the context and makes an explicit exception for the notices file this needs.
COPY --chown=node:node LICENSE THIRD-PARTY-NOTICES.md ./

# Non-root. The root key is mounted, never baked in; the workspace is read-only at runtime.
USER node

# The build identity is an `ENV`, not only a label: `GET /api/v1/healthz` reports it, which is the
# one place an operator can read the release without registry access (`docker inspect` needs a host).
ENV NODE_ENV=production \
    SEAMNEX_ROLE=api \
    SEAMNEX_BUILD_VERSION=${SEAMNEX_BUILD_VERSION} \
    SEAMNEX_BUILD_REVISION=${GIT_SHA} \
    PORT=8080 \
    HOST=0.0.0.0

EXPOSE 8080

# One image, nine roles: only the HTTP role serves a probe. A worker that reported on a port it
# does not open would be unhealthy forever, so the check is honest about which role it is running.
HEALTHCHECK --interval=30s --timeout=4s --start-period=20s --retries=3 \
  CMD ["node", "-e", "if(process.env.SEAMNEX_ROLE!=='api')process.exit(0);fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

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

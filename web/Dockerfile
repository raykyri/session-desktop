# syntax=docker/dockerfile:1
#
# The image Fly runs (`docs/13-deployment-fly.md` §3). Build context is `web/`.
#
#   docker build -f web/Dockerfile web
#
# Three stages: `deps` installs the workspace, `build` compiles the client
# bundle and the server bundle, `runtime` carries production `node_modules`,
# the two bundles, the migrations, the fonts the artifact origin serves,
# `tini`, and Litestream. No agent CLIs, no browsers, no per-user OS accounts.

ARG NODE_IMAGE=node:22-bookworm-slim
# Pinned by version and checksum: an unpinned release download is an
# unreviewed binary in the boot path of the process that holds the database.
ARG LITESTREAM_VERSION=0.5.17
ARG LITESTREAM_SHA256_AMD64=cfb371176d164437ae869f8351cfde49bd1804ae71c61923f75c9cba9c9c006d
ARG LITESTREAM_SHA256_ARM64=f8ca4a050095c1efbda2c4365172e61bf9d955ea0d9ac42f448b52e51819baa5

# ── deps ─────────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# Only the manifests, so a source-only change reuses this layer.
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/shared/package.json packages/shared/package.json

# `better-sqlite3` ships prebuilt binaries for linux/amd64 and linux/arm64, so
# the common case needs no toolchain. The fallback installs one and retries
# rather than making every build pay for python3/g++.
RUN npm ci --no-audit --no-fund \
  || ( apt-get update \
       && apt-get install -y --no-install-recommends python3 make g++ \
       && rm -rf /var/lib/apt/lists/* \
       && npm ci --no-audit --no-fund )

# Verify native module compilation during image build to prevent runtime boot failures.
RUN node -e "require('better-sqlite3'); console.log('better-sqlite3 ok')"

# ── build ────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /app
COPY . .
# The Vite client bundle and the esbuild server bundle — the two artifacts the
# image needs. `npm run build` at the root would also run `tsc -b`, which
# typechecks the test files; types are CI's `check` job (`12` §4), and an image
# that cannot be built because a test file is mid-edit is not a useful gate.
#
# The server bundle inlines `@session/db` and `@session/shared` (they publish
# TypeScript sources) and leaves every npm package external, so
# `better-sqlite3`, `unpdf`, `mammoth`, and `linkedom` are resolved from
# `node_modules` at runtime rather than bundled.
RUN npm run build --workspace @session/client --workspace @session/server
RUN node -e "const s=require('node:fs').statSync('packages/server/dist/server.mjs'); if (s.size < 1000) throw new Error('empty server bundle')"

# ── prod-deps ────────────────────────────────────────────────────────────────
# The runtime needs the server workspace's production dependencies and nothing
# else: the client ships as static files, so React, Mermaid, and d3 have no
# business in the image (`npm prune --omit=dev` at the root would keep them,
# and doubles the layer).
FROM deps AS prod-deps
WORKDIR /app
RUN npm ci --omit=dev --workspace @session/server --include-workspace-root --no-audit --no-fund
RUN node -e "require('better-sqlite3'); console.log('better-sqlite3 ok (production tree)')"

# ── runtime ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime
ARG LITESTREAM_VERSION
ARG LITESTREAM_SHA256_AMD64
ARG LITESTREAM_SHA256_ARM64

# `tini` reaps orphans and forwards SIGTERM; `ca-certificates` is what every
# provider call needs.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "$arch" in \
    amd64) asset="litestream-${LITESTREAM_VERSION}-linux-x86_64.tar.gz"; sha="${LITESTREAM_SHA256_AMD64}" ;; \
    arm64) asset="litestream-${LITESTREAM_VERSION}-linux-arm64.tar.gz"; sha="${LITESTREAM_SHA256_ARM64}" ;; \
    *) echo "no pinned Litestream build for $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/litestream.tar.gz \
    "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/${asset}"; \
  echo "${sha}  /tmp/litestream.tar.gz" | sha256sum -c -; \
  tar -C /usr/local/bin -xzf /tmp/litestream.tar.gz litestream; \
  rm /tmp/litestream.tar.gz; \
  litestream version

# uid 1000 in the base image is `node`; the app runs as `session` at the same
# uid so a volume written by one image is readable by the next.
RUN userdel -r node \
  && groupadd -g 1000 session \
  && useradd -u 1000 -g 1000 -m -d /home/session -s /bin/sh session

WORKDIR /app
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/packages/client/package.json ./packages/client/package.json
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/client/dist/app ./packages/client/dist/app
COPY --from=build /app/packages/server/dist/server.mjs ./packages/server/dist/server.mjs
COPY --from=build /app/packages/server/assets ./packages/server/assets
# Resolved as `../../db/migrations` from the server bundle (`main.ts`).
COPY --from=build /app/packages/db/migrations ./packages/db/migrations
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/litestream.yml /etc/litestream.yml

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    SESSION_DATA_DIR=/data

# The Fly volume mounts over this; the entrypoint fixes its ownership on the
# first boot, which is the one thing that has to happen as root.
RUN mkdir -p /data && chown session:session /data

EXPOSE 8080

# `tini` is PID 1 so SIGTERM reaches the server (or Litestream, which forwards
# it) and the drain runs inside `kill_timeout`.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/entrypoint.sh"]

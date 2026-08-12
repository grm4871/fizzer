# syntax=docker/dockerfile:1

# Client bundle: isolated install keeps Electron and Playwright out of the server image.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS client-build
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY client/ ./
RUN npm run build

# The native QMD semantic worker remains a supervised specialization beneath
# the Elixir service. Keep its exact pinned production dependency tree.
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS qmd-deps
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json ./client/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# Compile an OTP release with ERTS included so the runtime image does not need
# Mix, Hex, source code, or a host Elixir installation.
FROM elixir:1.17.3-slim@sha256:7531e5b6ee74fa49546960f4fa3cb24d85b3476d799f1787e81addd03bc16917 AS elixir-build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      build-essential ca-certificates git
ENV MIX_ENV=prod
WORKDIR /build/backend_elixir
RUN mix local.hex --force && mix local.rebar --force
COPY backend_elixir/mix.exs backend_elixir/mix.lock ./
RUN --mount=type=cache,target=/root/.hex \
    --mount=type=cache,target=/root/.cache/rebar3 \
    mix deps.get --only prod && mix deps.compile
COPY backend_elixir/ ./
RUN mix compile --warnings-as-errors && mix release

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS runner
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libstdc++6 libssl3 libncurses6

WORKDIR /app
ARG CASCADE_REVISION=uncommitted
LABEL org.opencontainers.image.revision="${CASCADE_REVISION}" \
      io.cascade.backend="elixir" \
      io.cascade.release-policy="verify-then-promote"
ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CASCADE_NETWORK_MODE=1 \
    CASCADE_NODE_ROOT=/app \
    CASCADE_CLIENT_DIST_DIR=/app/client/dist \
    CASCADE_VAULTS_BASE_DIR=/data/.cascade/vaults \
    CASCADE_QMD_DIR=/data/.cascade/qmd \
    HOME=/data \
    RELEASE_DISTRIBUTION=none

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --from=qmd-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=elixir-build /build/backend_elixir/_build/prod/rel/cascade_elixir ./release
COPY --chown=node:node --from=client-build /client/dist ./client/dist
COPY --chown=node:node scripts/check-elixir-data-compat.mjs ./scripts/check-elixir-data-compat.mjs
COPY --chown=node:node loadtest_elixir ./loadtest_elixir
COPY --chown=node:node deploy/preflight-client.mjs ./deploy/preflight-client.mjs
COPY --chown=node:node deploy/authenticated-live-smoke.mjs ./deploy/authenticated-live-smoke.mjs
COPY --chown=node:node deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER node
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
CMD ["start"]

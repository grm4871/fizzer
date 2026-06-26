# syntax=docker/dockerfile:1

# Client bundle: isolated install avoids hoisting Electron/Playwright from the monorepo root.
# Uses a standalone client/package-lock.json (generated outside the npm workspace) so
# `npm ci` pins exact versions — builds are reproducible and bundle hashes are stable
# across machines instead of drifting with every `npm install`.
FROM node:22-bookworm-slim AS client-build
WORKDIR /client
COPY client/package.json client/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY client/ ./
RUN npm run build

# Server: production deps only, plus TypeScript for tsc.
FROM node:22-bookworm-slim AS server-build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++
WORKDIR /build
COPY package.json package-lock.json ./
COPY client/package.json ./client/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
RUN --mount=type=cache,target=/root/.npm npm install --no-save -D typescript
COPY tsconfig.json index.ts ./
COPY server ./server
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node client/package.json ./client/
COPY --chown=node:node --from=server-build /build/node_modules ./node_modules
COPY --chown=node:node --from=server-build /build/dist ./dist
COPY --chown=node:node --from=client-build /client/dist ./client/dist
COPY --chown=node:node deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER node
ENV HOME=/data
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
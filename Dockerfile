# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++
WORKDIR /build
COPY package.json package-lock.json ./
COPY client/package.json ./client/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json index.ts ./
COPY server ./server
COPY client ./client
RUN npm run build:vps

FROM node:22-bookworm-slim AS runner
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends python3 make g++
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY client/package.json ./client/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev
COPY --from=build /build/dist ./dist
COPY --from=build /build/client/dist ./client/dist
COPY deploy/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R node:node /app

USER node
ENV HOME=/data
EXPOSE 3000
ENTRYPOINT ["/entrypoint.sh"]
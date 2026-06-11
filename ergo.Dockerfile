FROM ghcr.io/ergochat/ergo:stable
USER root
RUN apk add --no-cache nodejs npm
COPY server/irc/auth-script.js /opt/auth/auth-script.js
WORKDIR /opt/auth
RUN npm init -y && npm install --omit=dev pg bcryptjs && npm pkg set type=module
WORKDIR /ircd

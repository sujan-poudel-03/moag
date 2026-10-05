# MOAG hosted Product Owner server.
#
#   docker build -t moag-server .
#   docker run --init --rm -p 8080:8080 -v moag-data:/data \
#     -e MOAG_PUBLIC_URL=https://moag.example.com \
#     -e MOAG_BOOTSTRAP_TOKEN=<24+ random characters> \
#     moag-server
#
# See docs/server.md for TLS (reverse proxy), the master key, backups,
# installing engine CLIs, and the threat model. CI is deliberately NOT set:
# with CI=true the server refuses to run agents (it would auto-approve ship gates).

# ─── Build ───
FROM node:20-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run compile:ext && rm -rf out/test

# ─── Runtime ───
FROM node:20-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /src/out ./out
COPY web ./web

RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin moag \
  && mkdir -p /data/workspaces \
  && chown -R moag:moag /data \
  && chmod 700 /data
USER moag
VOLUME /data

ENV NODE_ENV=production \
    MOAG_DATA_DIR=/data \
    MOAG_PROJECTS_ROOT=/data/workspaces \
    MOAG_HOST=0.0.0.0 \
    MOAG_PORT=8080

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "require('http').get('http://127.0.0.1:' + (process.env.MOAG_PORT || 8080) + '/healthz', (r) => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]

CMD ["node", "out/server/main.js"]

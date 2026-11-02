# KidsWay API container.
# - Official Node 22 image on Alpine (small attack surface)
# - No npm install step: the app has zero third-party runtime dependencies
# - Runs as the unprivileged "node" user, never root
FROM node:22.18-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    TRUST_PROXY=1 \
    DB_PATH=/data/kidsway.db \
    SECURITY_LOG_FILE=/logs/security.log

WORKDIR /app
COPY --chown=root:root package.json ./
COPY --chown=root:root src ./src
COPY --chown=root:root public ./public

RUN mkdir -p /data /logs && chown node:node /data /logs
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.ts"]

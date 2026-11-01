FROM node:24.2.0-bookworm-slim@sha256:b30c143a092c7dced8e17ad67a8783c03234d4844ee84c39090c9780491aaf89
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && mkdir -p /data && chown 1000:1000 /data && chmod 0700 /data
COPY src/ ./src/
COPY deploy/healthcheck.mjs ./deploy/healthcheck.mjs
COPY deploy/licenses/ ./licenses/
USER 1000:1000
STOPSIGNAL SIGTERM
ENTRYPOINT ["node", "src/cli.mjs"]
CMD ["serve", "--config", "/config/relay.json"]

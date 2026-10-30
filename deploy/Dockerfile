# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && \
    rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma.config.ts tsconfig.json next.config.ts postcss.config.mjs ./
COPY prisma/mysql ./prisma/mysql
COPY src ./src
COPY scripts ./scripts
COPY deploy/entrypoint.mjs deploy/healthcheck.mjs ./deploy/
# Build-only placeholders. Production secrets are never build arguments or files.
RUN DATABASE_URL=mysql://build_runtime:unused_build_value@127.0.0.1:3306/billing_build \
    APP_ENV=production APP_URL=https://bills.voltronix.ae \
    INTEGRATION_TEST_MODE=false INTEGRATION_NETWORK_ENABLED=false \
    ZOHO_BOOKS_NETWORK_ENABLED=false ZOHO_BOOKS_WRITE_ENABLED=false \
    ZOHO_BOOKS_LIVE_ENABLED=false OCR_PROVIDER=disabled npm run build
RUN npm run check:release

# Explicit, one-shot operator image. Migrations are never run during startup.
FROM build AS migration
ENV NODE_ENV=production APP_ENV=production
USER node
ENTRYPOINT ["node", "deploy/entrypoint.mjs"]
CMD ["migrate"]

FROM build AS runtime-dependencies
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*
COPY --from=runtime-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json /app/tsconfig.json /app/next.config.ts ./
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/deploy ./deploy
RUN mkdir -p /var/lib/voltronix/uploads /app/.next/cache && \
    chown -R node:node /var/lib/voltronix /app/.next/cache
USER node
EXPOSE 3000
ENTRYPOINT ["node", "deploy/entrypoint.mjs"]
CMD ["web"]

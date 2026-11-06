FROM node:22.23.4-bookworm-slim AS base
LABEL org.opencontainers.image.source="https://github.com/jetkvm/cloud-api"
WORKDIR /usr/src/app

# Prisma needs OpenSSL at runtime; tini forwards SIGTERM to node as PID 1
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
# Type errors fail the build here instead of crashing the container at startup
RUN npx prisma generate \
  && npm run build \
  && npm prune --omit=dev

FROM base
ENV NODE_ENV=production
ENV PORT=3000
COPY package.json ./
COPY prisma ./prisma
COPY --from=build /usr/src/app/node_modules ./node_modules
COPY --from=build /usr/src/app/dist ./dist

USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://localhost:' + process.env.PORT + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]

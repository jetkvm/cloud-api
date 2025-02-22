# Base Stage
FROM node:21.1.0-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./

# Deps Stage
FROM base AS deps
RUN npm ci

# Build / Dev Stage
FROM deps AS dev
COPY . .
RUN npx prisma generate
RUN npm run build:prod
CMD ["sh", "-c", "npm run dev"]

# Production Stage 
FROM node:21.1.0-alpine AS prod
WORKDIR /app
COPY --from=dev /app/dist ./dist
COPY --from=dev /app/prisma ./prisma
COPY --from=dev /app/package.json ./
COPY --from=dev /app/package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev
USER node
EXPOSE 3000
CMD ["node", "./dist/index.js"]

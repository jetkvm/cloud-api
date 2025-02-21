    FROM node:21.1.0-alpine AS base

    ARG NODE_ENV=production
    ENV NODE_ENV=${NODE_ENV}
    
    WORKDIR /app
    
    RUN apk add --no-cache libc6-compat
    
    COPY package.json package-lock.json ./
    
    # Development Stage
    FROM base AS dev
    
    RUN npm install
    
    COPY . .
    
    RUN npx prisma generate
    
    RUN chown -R node:node /app
    
    USER node
    
    EXPOSE 3000
    
    # Run development server
    CMD ["sh", "-c", "npx prisma migrate dev && npm run dev"]
    
    #Production Stage
    FROM base AS prod
    
    ENV NODE_ENV=production
    
    RUN npm ci --omit=dev
    
    COPY --from=dev /app/node_modules ./node_modules
    COPY --from=dev /app/prisma ./prisma
    COPY --from=dev /app/src ./src
    COPY --from=dev /app/package.json ./
    
    RUN npx prisma generate
    
    RUN chown -R node:node /app
    
    USER node
    
    EXPOSE 3000
    
    # Run Prisma migrations & start the app in production mode
    CMD ["sh", "-c", "npx prisma migrate deploy && exec npm run start"]
    
FROM node:22.22.0-alpine AS packages
WORKDIR /usr/src/app

COPY LICENSE /usr/src/app/
COPY package.json /usr/src/app/
COPY package-lock.json /usr/src/app/

RUN npm install

FROM packages AS builder
WORKDIR /usr/src/app

COPY . /usr/src/app/
RUN npx prisma generate
RUN npm run build

FROM packages AS app
LABEL org.opencontainers.image.source="https://github.com/jetkvm/cloud-api"
WORKDIR /usr/src/app

COPY --from=builder /usr/src/app/prisma /usr/src/app/prisma
COPY --from=builder /usr/src/app/node_modules/.prisma /usr/src/app/node_modules/.prisma
COPY --from=builder /usr/src/app/dist /usr/src/app/dist
COPY .env.example ./.env

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "./dist/index.js"]

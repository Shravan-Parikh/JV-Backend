# JV Enterprises API — container image for Google Cloud Run.
#
# Cloud Run injects PORT (8080) and terminates TLS for us, so the app only ever
# needs to listen on $PORT over plain HTTP. Config comes from environment
# variables set on the Cloud Run service — never bake .env into the image.

FROM node:22-alpine

ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first so this layer caches across source-only changes.
# `npm ci` needs package-lock.json and installs exactly what's locked.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

# Drop root — the base image ships an unprivileged `node` user.
USER node

# Documentation only; Cloud Run routes to whatever $PORT the process binds.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/index.js"]

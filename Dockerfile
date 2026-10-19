# BOUSOL Prepaid Fuel: API + web app in one container.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build -w web

FROM node:22-slim
WORKDIR /app
# Set by the image build (CI passes the commit): shown by /api/health so you can see what is running.
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    PORT=8787 \
    DB_PATH=/data/bousol.db \
    APP_VERSION=$APP_VERSION \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/web/dist ./web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8787
USER node
# Docker marks the container unhealthy when the database stops answering or backups go stale.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "server/src/index.ts"]

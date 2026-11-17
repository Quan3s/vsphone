# Root Dockerfile — Railway neu tro service root vao repo root (/).
# App nam o vsphone-register/, nen COPY tu thu muc do.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    UV_THREADPOOL_SIZE=1 \
    PORT=8080

WORKDIR /app

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY vsphone-register/package.json vsphone-register/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY vsphone-register/config.json ./
COPY vsphone-register/src ./src

EXPOSE 8080

CMD ["sh", "-c", "export DATABASE_URL=\"${progeSQL_URl:-${DATABASE_URL:-}}\"; exec node src/server.js --port \"${PORT:-8080}\""]

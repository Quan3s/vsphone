# Dockerfile for Railway — Debian (stable, Playwright chay on dinh hon Alpine).
# - API key: dat bien API_KEY (hoac API_KEYS) tren Railway (uu tien hon config.json).
# - DB: dat bien progeSQL_URl tren Railway, Dockerfile map sang DATABASE_URL.
# - 1 luong: server hard-code 1 login worker, khong nhan --login-workers.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    UV_THREADPOOL_SIZE=1 \
    PORT=8080

WORKDIR /app

# Cai deps he thong cho Chromium + download browser (ban headless shell nhe).
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npx playwright install --with-deps chromium \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

COPY config.json ./
COPY src ./src

EXPOSE 8080

# Railway truyen progeSQL_URl -> map sang DATABASE_URL ma app doc.
# API_KEY / API_KEYS doc truc tiep tu env (khong hardcode).
CMD ["sh", "-c", "export DATABASE_URL=\"${progeSQL_URl:-${DATABASE_URL:-}}\"; exec node src/server.js --port \"${PORT:-8080}\""]

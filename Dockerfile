# ==============================================================================
# PictaBot Altare Edition — Dockerfile de Produccion (Node 22 + ffmpeg/unzip/tar)
# ==============================================================================
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json ./
COPY package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY . .
RUN npm run build

# Imagen final ligera con binarios requeridos por /unir (multiPartDiskAssembler)
FROM node:22-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    unzip \
    tar \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV TELEGRAM_MODE=polling
ENV PICTA_STATE_DIR=/app/data/bot_state
ENV PICTA_SCRATCH_DIR=/app/data/scratch
ENV PICTA_DISK_BUDGET_GB=10
ENV MTPROTO_SAFE_PARALLEL_WORKERS=6
ENV MTPROTO_TCP_POOL_SIZE=6
ENV MAX_PREFETCH_LOOKAHEAD=1

COPY package.json ./
COPY package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server.js ./server.js

# Directorios persistentes fuera de /tmp con permisos compatibles con contenedores Altare
RUN mkdir -p /app/data/bot_state /app/data/scratch && chmod -R 777 /app/data

VOLUME ["/app/data"]

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || process.env.SERVER_PORT || 3000) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]

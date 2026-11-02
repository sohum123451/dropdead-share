# Stage 1: Builder
FROM node:20-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json tsconfig.json ./
RUN npm ci --legacy-peer-deps

COPY src/ ./src/
RUN npm run build

# Stage 2: Production Runner
FROM node:20-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

COPY package*.json ./
RUN npm ci --only=production --legacy-peer-deps && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Create dedicated non-root user and data volume directory
RUN groupadd -g 10001 nodejs && \
    useradd -u 10001 -g nodejs -s /bin/bash appuser && \
    mkdir -p /app/data && \
    chown -R appuser:nodejs /app

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]


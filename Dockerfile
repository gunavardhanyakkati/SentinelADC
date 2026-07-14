# ─── SentinelADC Gateway Dockerfile ──────────────────────────────────────────
# Multi-stage build for smaller production image

FROM node:20-alpine AS base
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy source
COPY src/ ./src/

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/status/ping || exit 1

EXPOSE 3000
CMD ["node", "src/index.js"]

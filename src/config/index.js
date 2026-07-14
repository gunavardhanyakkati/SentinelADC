/**
 * ─── SentinelADC Centralized Configuration ──────────────────────────────────
 *
 * WHY THIS EXISTS:
 * In production ADCs like F5 BIG-IP, configuration is centralized to ensure
 * consistency across all modules. A single source of truth prevents config
 * drift and makes the system easier to reason about.
 *
 * DESIGN DECISIONS:
 * - All config is derived from environment variables with sensible defaults
 * - Config is frozen (immutable) after initialization to prevent runtime mutation
 * - Structured by domain (server, backends, health, cache, security, etc.)
 *
 * TRADE-OFFS:
 * - We use env vars instead of a config file (simpler for Docker/12-factor apps)
 * - No hot-reload of config (would need a watcher + event bus in production)
 *
 * PRODUCTION DIFFERENCE:
 * F5 BIG-IP uses a dedicated config daemon (mcpd) with transactional config
 * changes, rollback support, and config sync across HA pairs. Our approach
 * is simpler but demonstrates the same principle of centralized configuration.
 *
 * INTERVIEW QUESTIONS:
 * - Why centralize configuration instead of scattering env reads across modules?
 * - How does the 12-factor app methodology influence config management?
 * - What are the trade-offs between config files vs environment variables?
 * - How would you implement hot-reload of configuration in production?
 */

import dotenv from 'dotenv';

// Load .env file (no-op if not present, e.g., in Docker with env vars)
dotenv.config();

/**
 * Parse a comma-separated string into a trimmed array.
 * @param {string} value - Comma-separated string
 * @param {string[]} fallback - Default array
 * @returns {string[]}
 */
function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

const config = {
  // ─── Server ─────────────────────────────────────────────────────────────
  server: {
    port: parseInt(process.env.PORT, 10) || 3000,
    env: process.env.NODE_ENV || 'development',
    get isDev() { return this.env === 'development'; },
    get isProd() { return this.env === 'production'; },
  },

  // ─── Logging ────────────────────────────────────────────────────────────
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    format: process.env.LOG_FORMAT || 'json',  // 'json' or 'simple'
  },

  // ─── Backend Pool ──────────────────────────────────────────────────────
  backends: parseList(process.env.BACKENDS, [
    'http://localhost:4001',
    'http://localhost:4002',
    'http://localhost:4003',
  ]),

  // ─── Load Balancing ────────────────────────────────────────────────────
  loadBalancing: {
    algorithm: process.env.LB_ALGORITHM || 'round-robin',
    stickySession: process.env.STICKY_SESSION === 'true',
  },

  // ─── Health Monitoring ─────────────────────────────────────────────────
  health: {
    interval: parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 5000,
    timeout: parseInt(process.env.HEALTH_CHECK_TIMEOUT, 10) || 3000,
    path: process.env.HEALTH_CHECK_PATH || '/health',
    unhealthyThreshold: parseInt(process.env.UNHEALTHY_THRESHOLD, 10) || 3,
    healthyThreshold: parseInt(process.env.HEALTHY_THRESHOLD, 10) || 2,
  },

  // ─── Redis / Cache ────────────────────────────────────────────────────
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },
  cache: {
    enabled: process.env.CACHE_ENABLED !== 'false',
    ttl: parseInt(process.env.CACHE_TTL, 10) || 60,       // seconds
  },

  // ─── MongoDB ──────────────────────────────────────────────────────────
  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/sentinel-adc',
    retentionDays: parseInt(process.env.ANALYTICS_RETENTION_DAYS, 10) || 7,
  },

  // ─── Security ─────────────────────────────────────────────────────────
  security: {
    jwtSecret: process.env.JWT_SECRET || 'sentinel-adc-secret-change-in-production',
    jwtExpiry: process.env.JWT_EXPIRY || '1h',
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
      maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 100,
    },
  },

  // ─── CORS / Dashboard ────────────────────────────────────────────────
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  },
};

// Freeze top-level and nested objects to prevent accidental mutation
Object.keys(config).forEach((key) => {
  if (typeof config[key] === 'object' && config[key] !== null) {
    Object.freeze(config[key]);
  }
});
Object.freeze(config);

export default config;

/**
 * ─── Express Application Factory ───────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * The app factory creates and configures the Express application. It registers
 * middleware in the correct order — this ordering is critical for a reverse proxy.
 *
 * MIDDLEWARE ORDER (this matters!):
 * 1. Response Timer     — must be first to measure total processing time
 * 2. Correlation IDs    — generate IDs before anything else logs (Milestone 8)
 * 3. Request Logger     — log every incoming request with IDs
 * 4. Security headers   — Helmet, CORS
 * 5. Body parsing       — only for API routes (not proxied requests)
 * 6. Security engine    — rate limit, JWT, WAF (Milestone 6)
 * 7. Cache              — serve cached responses before proxying (Milestone 5)
 * 8. API routes         — /api/* handled here, NOT proxied
 * 9. Proxy              — everything else is forwarded to backends
 * 10. Error handler     — catch-all error handling
 *
 * DESIGN DECISIONS:
 * - Factory function (not a class) so it's easy to create test instances
 * - API routes are mounted under /api and handled by Express directly
 * - Everything else falls through to the proxy middleware
 * - Middleware order follows the "pipeline" pattern (like NGINX phases)
 *
 * PRODUCTION DIFFERENCE:
 * NGINX processes requests through numbered phases (access, rewrite, content, log).
 * Express uses a sequential middleware chain which is conceptually similar
 * but less formal. HAProxy uses a frontend→backend model.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import config from './config/index.js';
import responseTimer from './middleware/responseTimer.js';
import requestLogger from './middleware/requestLogger.js';
import errorHandler from './middleware/errorHandler.js';
import statusRoutes from './api/statusRoutes.js';
import routingEngine from './routing/routingEngine.js';
import createProxyMiddleware_ from './proxy/proxyMiddleware.js';
import correlationIdMiddleware from './middleware/correlationId.js';

import adminRoutes from './api/adminRoutes.js';
import healthRoutes from './health/healthRoutes.js';
import metricsRoutes from './metrics/metricsRoutes.js';
import cacheRoutes from './cache/cacheRoutes.js';
import cacheMiddleware from './cache/cacheMiddleware.js';

import ipBlocklist from './security/ipBlocklist.js';
import headerValidator from './security/headerValidator.js';
import rateLimiter from './security/rateLimiter.js';
import wafMiddleware from './security/wafMiddleware.js';
import jwtMiddleware from './security/jwtMiddleware.js';
import securityRoutes from './security/securityRoutes.js';

import analyticsCollector from './analytics/analyticsCollector.js';
import analyticsRoutes from './analytics/analyticsRoutes.js';

/**
 * Create and configure the Express application.
 * @returns {import('express').Application}
 */
export default function createApp() {
  const app = express();

  // ─── 1. Response Timer (must be first) ──────────────────────────────────
  app.use(responseTimer());

  // ─── 2. Correlation Tracing Context (AsyncLocalStorage wrapper) ─────────
  app.use(correlationIdMiddleware());

  // ─── 3. Analytics Telemetry Collector ───────────────────────────────────
  app.use(analyticsCollector());

  // ─── 3. Firewall Filter (IP blocklist & basic header checks) ────────────
  app.use(ipBlocklist.middleware());
  app.use(headerValidator());

  // ─── 4. Request Logger ──────────────────────────────────────────────────
  app.use(requestLogger());

  // ─── 4. Security Headers ────────────────────────────────────────────────
  app.use(helmet({
    // Disable CSP for API gateway (backends control their own CSP)
    contentSecurityPolicy: false,
  }));

  app.use(cors({
    origin: config.cors.origin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID', 'X-Correlation-ID'],
    exposedHeaders: [
      'X-Response-Time',
      'X-Request-ID',
      'X-Backend-ID',
      'X-LB-Algorithm',
      'X-LB-Reason',
      'X-Cache',
    ],
    credentials: true,
  }));

  // ─── 5. Rate Limiter (protect against DOS/brute-force) ──────────────────
  app.use(rateLimiter.middleware());

  // ─── 6. Body Parsing (API routes only) ──────────────────────────────────
  // We only parse JSON for our /api routes. Proxied requests pass through raw.
  app.use('/api', express.json({ limit: '10mb' }));
  app.use('/api', express.urlencoded({ extended: true }));

  // ─── 7. Web Application Firewall (inspects query, path, and parsed body) ─
  app.use(wafMiddleware());

  // ─── 8. API Routes (handled by Express, NOT proxied) ────────────────────
  app.use('/api', statusRoutes);
  app.use('/api/admin', jwtMiddleware(), adminRoutes); // Protect all administration endpoints
  app.use('/api/health', healthRoutes);
  app.use('/api/metrics', metricsRoutes);
  app.use('/api/cache', cacheRoutes);
  app.use('/api/security', securityRoutes);
  app.use('/api/analytics', jwtMiddleware(), analyticsRoutes);

  // Placeholder for future API routes (will be added in later milestones):
  // app.use('/api/observability', observabilityRoutes); // M8: logs & traces

  // ─── 9. Cache Middleware (GET requests only) ────────────────────────────
  app.use(cacheMiddleware());

  // ─── 10. Reverse Proxy (everything not /api goes to backends) ───────────
  const proxyMiddleware = createProxyMiddleware_(routingEngine);

  // Only proxy non-API requests
  app.use((req, res, next) => {
    // Skip if the request is for our API
    if (req.path.startsWith('/api')) {
      return next();
    }
    return proxyMiddleware(req, res, next);
  });

  // ─── 11. Centralized Error Handler ──────────────────────────────────────
  app.use(errorHandler);

  return app;
}

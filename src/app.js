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
import tlsRedirect from './middleware/tlsRedirect.js';

import adminRoutes from './api/adminRoutes.js';
import healthRoutes from './health/healthRoutes.js';
import metricsRoutes from './metrics/metricsRoutes.js';
import cacheRoutes from './cache/cacheRoutes.js';
import cacheMiddleware from './cache/cacheMiddleware.js';

import ipBlocklist from './security/ipBlocklist.js';
import headerValidator from './security/headerValidator.js';
import rateLimiter from './security/rateLimiter.js';
import anomalyDetector from './security/anomalyDetector.js';
import wafMiddleware from './security/wafMiddleware.js';
import jwtMiddleware from './security/jwtMiddleware.js';
import securityRoutes from './security/securityRoutes.js';

import analyticsCollector from './analytics/analyticsCollector.js';
import analyticsRoutes from './analytics/analyticsRoutes.js';
import resilienceRoutes from './resilience/resilienceRoutes.js';

/**
 * Create and configure the Express application.
 * @returns {import('express').Application}
 */
export default function createApp() {
  const app = express();

  // ─── 1. Response Timer (must be first to measure total pipeline duration) ──
  app.use(responseTimer());

  // ─── 2. TLS / HTTPS Redirection (when TLS_REDIRECT=true) ────────────────
  app.use(tlsRedirect());

  // ─── 3. Correlation Tracing Context (AsyncLocalStorage wrapper) ─────────
  app.use(correlationIdMiddleware());

  // ─── 4. Analytics Telemetry Collector ───────────────────────────────────
  app.use(analyticsCollector());

  // ─── 5. Request Logger ──────────────────────────────────────────────────
  app.use(requestLogger());

  // ─── 5. L3/L4 Firewall Filter (IP blocklist & basic header checks) ──────
  app.use(ipBlocklist.middleware());
  app.use(headerValidator());

  // ─── 6. Security Headers & CORS ────────────────────────────────────────
  app.use(helmet({
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

  // ─── 7. Rate Limiter (protect against DOS/brute-force early) ────────────
  app.use(rateLimiter.middleware());

  // ─── 8. Statistical Anomaly Detector (EWMA & Z-Score Baselining) ─────────
  app.use(anomalyDetector.middleware());

  // ─── 9. Web Application Firewall (inspects query & path before cache) ───
  app.use(wafMiddleware());

  // ─── 9. Cache Middleware (Serve GET cache hits after WAF & security) ────
  app.use(cacheMiddleware());

  // ─── 10. Body Parsing (API routes only) ─────────────────────────────────
  app.use('/api', express.json({ limit: '10mb' }));
  app.use('/api', express.urlencoded({ extended: true }));

  // ─── 11. Gateway API Routes ─────────────────────────────────────────────
  app.use('/api', statusRoutes);
  app.use('/api/admin', jwtMiddleware(), adminRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/metrics', metricsRoutes);
  app.use('/api/cache', cacheRoutes);
  app.use('/api/security', securityRoutes);
  app.use('/api/analytics', jwtMiddleware(), analyticsRoutes);
  app.use('/api/resilience', resilienceRoutes);

  // ─── 12. Reverse Proxy (everything not /api goes to backends) ───────────
  const proxyMiddleware = createProxyMiddleware_(routingEngine);

  app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
      return next();
    }
    return proxyMiddleware(req, res, next);
  });

  // ─── 11. Centralized Error Handler ──────────────────────────────────────
  app.use(errorHandler);

  return app;
}

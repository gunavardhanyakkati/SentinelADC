/**
 * ─── Reverse Proxy Middleware ───────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * This is the CORE of SentinelADC. Every request that isn't handled by an
 * API route gets forwarded to an upstream backend server. The proxy middleware
 * uses http-proxy-middleware to handle the low-level HTTP proxying, and plugs
 * into the routing engine to dynamically select which backend to forward to.
 *
 * DESIGN DECISIONS:
 * - Uses http-proxy-middleware (built on node-http-proxy) for battle-tested proxying
 * - Dynamic target selection via the routing engine (not hardcoded)
 * - Hooks into onProxyReq/onProxyRes for header rewriting and metrics
 * - Provides a router function that http-proxy-middleware calls per request
 *
 * HOW IT WORKS INTERNALLY:
 * 1. Request arrives at Express
 * 2. Routing engine selects a backend (based on algorithm + health)
 * 3. Backend URL is attached to req._targetBackend
 * 4. http-proxy-middleware reads the target from the router function
 * 5. Request is forwarded, response is streamed back
 * 6. onProxyReq/onProxyRes hooks add headers and collect metrics
 *
 * TRADE-OFFS:
 * - We use a middleware approach (one proxy instance with dynamic router)
 *   instead of creating separate proxy instances per backend
 * - This is simpler but means we can't have per-backend proxy settings
 *
 * PRODUCTION DIFFERENCE:
 * NGINX uses an event loop with epoll/kqueue for proxying, handling thousands
 * of concurrent connections with minimal memory. Node.js uses its own event
 * loop which is efficient but single-threaded. Production ADCs also support
 * connection pooling, keep-alive tuning, and buffer management.
 *
 * INTERVIEW QUESTIONS:
 * - How does a reverse proxy differ from a forward proxy?
 * - What is the role of the Host header in proxying?
 * - How does http-proxy handle WebSocket upgrades?
 * - What happens when the upstream server is slower than the client?
 */

import http from 'node:http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { createChildLogger } from '../observability/logger.js';
import { addProxyHeaders, addResponseHeaders } from './proxyUtils.js';
import { TIMEOUTS } from '../utils/constants.js';
import { collectProxyResponse, collectProxyError } from '../metrics/metricsCollector.js';
import circuitBreakerManager from '../resilience/circuitBreakerManager.js';

const log = createChildLogger({ module: 'proxy' });

// Persistent HTTP Agent with Keep-Alive to avoid TCP connection overhead on every proxied request
const keepAliveAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 1000,
  maxFreeSockets: 256,
  timeout: TIMEOUTS.PROXY_TIMEOUT,
});

/**
 * Create the reverse proxy middleware.
 * The routing engine must be passed in to avoid circular dependencies.
 *
 * @param {Object} routingEngine - The routing engine instance
 * @returns {import('express').RequestHandler} Express middleware
 */
/**
 * Calculate exponential backoff delay with full jitter.
 * @param {number} attempt - Current attempt (1, 2)
 * @param {number} baseMs - Base backoff (default 50ms)
 * @param {number} maxMs - Max backoff ceiling (default 500ms)
 * @returns {number} Delay in milliseconds
 */
export function calculateBackoffJitter(attempt, baseMs = 50, maxMs = 500) {
  const cap = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * cap);
}

/**
 * Handle proxy error with idempotent retry logic.
 */
export async function handleProxyError(err, req, res, proxyInstance) {
  collectProxyError(req, err);

  const failedBackendId = req._backendId;
  if (failedBackendId) {
    req._failedBackends = req._failedBackends || new Set();
    req._failedBackends.add(failedBackendId);
    circuitBreakerManager.recordFailure(failedBackendId, err.code || err.message);
  }

  const method = (req.method || 'GET').toUpperCase();
  const isIdempotent = ['GET', 'HEAD', 'OPTIONS'].includes(method);
  const MAX_RETRIES = 2; // Allow up to 2 retries (3 total attempts)
  req._attempts = req._attempts || 1;

  log.error('Proxy error', {
    error: err.message,
    code: err.code,
    backend: failedBackendId,
    path: req.originalUrl,
    attempt: req._attempts,
    isIdempotent,
  });

  // Idempotent Retry Logic (GET/HEAD/OPTIONS only)
  if (isIdempotent && req._attempts <= MAX_RETRIES && !res.headersSent) {
    req._attempts++;
    const delayMs = calculateBackoffJitter(req._attempts);

    log.warn(`🔄 Retrying idempotent request [${method} ${req.originalUrl}] (Attempt #${req._attempts}/${MAX_RETRIES + 1}). Failed backend: ${failedBackendId}. Backoff delay: ${delayMs}ms`);

    // Reset target backend so router selects a new healthy target
    delete req._targetBackend;
    delete req._backendId;
    delete req._lbAlgorithm;

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    if (proxyInstance) {
      return proxyInstance(req, res, (retryErr) => {
        if (!res.headersSent) {
          res.status(502).json({
            error: {
              message: 'Bad Gateway — upstream server unavailable',
              statusCode: 502,
              backend: failedBackendId,
            },
            timestamp: new Date().toISOString(),
          });
        }
      });
    }
  }

  // Non-idempotent methods or retries exhausted: send HTTP 502
  if (!res.headersSent) {
    const reason = !isIdempotent
      ? `Non-idempotent request [${method}] failed (retries disabled to prevent double-writes)`
      : 'Bad Gateway — upstream server unavailable';

    res.status(502).json({
      error: {
        message: reason,
        statusCode: 502,
        backend: failedBackendId,
        attempts: req._attempts,
      },
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Create the reverse proxy middleware.
 * The routing engine must be passed in to avoid circular dependencies.
 *
 * @param {Object} routingEngine - The routing engine instance
 * @returns {import('express').RequestHandler} Express middleware
 */
export default function createProxyMiddleware_(routingEngine) {
  let proxyInstance;

  proxyInstance = createProxyMiddleware({
    agent: keepAliveAgent,

    // Dynamic target: the router function is called for every request
    router: (req) => {
      // The routing engine should have already attached the target
      // via a preceding middleware. Fallback to the routing engine here.
      if (req._targetBackend) {
        return req._targetBackend.url;
      }

      // If no backend was pre-selected, select one now
      const backend = routingEngine.selectBackend(req);
      if (!backend) {
        log.error('No healthy backend available');
        return null;
      }

      req._targetBackend = backend;
      req._backendId = backend.id;
      req._lbAlgorithm = routingEngine.getCurrentAlgorithm();
      req._lbReason = req._lbReason || 'dynamic-selection';

      // Increment active connections for least-connections tracking
      backend.activeConnections = (backend.activeConnections || 0) + 1;
      let decremented = false;
      const decrement = () => {
        if (!decremented) {
          decremented = true;
          backend.activeConnections = Math.max(0, (backend.activeConnections || 1) - 1);
          log.debug(`Connection closed/finished. Active connections for ${backend.id}: ${backend.activeConnections}`);
          if (backend.onDrainComplete && backend.activeConnections === 0) {
            backend.onDrainComplete();
          }
        }
      };
      req.res?.on('finish', decrement);
      req.res?.on('close', decrement);

      return backend.url;
    },

    // Change origin to the target URL (required for virtual hosts)
    changeOrigin: true,

    // Timeout for the proxy request
    proxyTimeout: TIMEOUTS.PROXY_TIMEOUT,

    // ─── Lifecycle Hooks ──────────────────────────────────────────────────

    on: {
      proxyReq: (proxyReq, req, res) => {
        addProxyHeaders(proxyReq, req);

        log.debug('Proxying request', {
          method: req.method,
          path: req.originalUrl,
          target: req._targetBackend?.url,
          backend: req._backendId,
        });
      },

      /**
       * Called when the proxy response is received from upstream.
       * Add response headers for observability.
       */
      proxyRes: (proxyRes, req, res) => {
        addResponseHeaders(proxyRes, req, res);
        collectProxyResponse(req, proxyRes);

        if (req._backendId) {
          if (proxyRes.statusCode >= 500) {
            circuitBreakerManager.recordFailure(req._backendId, `HTTP ${proxyRes.statusCode}`);
          } else if (proxyRes.statusCode < 400) {
            circuitBreakerManager.recordSuccess(req._backendId);
          }
        }

        log.debug('Proxy response received', {
          status: proxyRes.statusCode,
          backend: req._backendId,
          path: req.originalUrl,
        });
      },

      /**
       * Called when a proxy error occurs (e.g., backend unreachable).
       * Retries idempotent requests (GET/HEAD/OPTIONS) on healthy alternate backends.
       */
      error: (err, req, res) => handleProxyError(err, req, res, proxyInstance),
    },

    // Don't log to console (we use our own logger)
    logger: {
      info: (msg) => log.debug(msg),
      warn: (msg) => log.warn(msg),
      error: (msg) => log.error(msg),
    },
  });

  return function proxyMiddlewareWithRetry(req, res, next) {
    req._attempts = req._attempts || 1;
    req._failedBackends = req._failedBackends || new Set();
    return proxyInstance(req, res, next);
  };
}

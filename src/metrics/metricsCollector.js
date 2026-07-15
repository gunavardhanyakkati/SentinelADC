/**
 * ─── Metrics Collector ────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Intercepts proxy response and error lifecycles, calculates exact response times
 * using high-resolution start times from `res.locals`, and logs data points into
 * the Metrics Store.
 *
 * DESIGN DECISIONS:
 * - Decouples metrics recording logic from the core proxy engine.
 * - Extracts latency in milliseconds from high-resolution timers.
 * - Rejects non-backend transactions (e.g. gateway status routes) from statistics.
 */

import metricsStore from './metricsStore.js';
import { elapsedMs } from '../utils/helpers.js';

/**
 * Log a successful proxy transaction.
 * @param {import('express').Request} req - The original Express request
 * @param {import('http').IncomingMessage} proxyRes - Upstream server response
 */
export function collectProxyResponse(req, proxyRes) {
  const backendId = req._backendId;
  const startTime = req.res?.locals?.startTime;

  if (!backendId || !startTime) return;

  const duration = elapsedMs(startTime);
  const isError = proxyRes.statusCode >= 500; // Counts HTTP 5xx as backend errors

  metricsStore.recordTransaction(backendId, duration, isError);
}

/**
 * Log a failed proxy transaction (connection timeout, dns failure, etc.).
 * @param {import('express').Request} req - The original request
 * @param {Error} err - The proxy error
 */
export function collectProxyError(req, err) {
  const backendId = req._backendId;
  const startTime = req.res?.locals?.startTime;

  if (!backendId || !startTime) return;

  const duration = elapsedMs(startTime);

  // Connection errors count as server failures (100% error penalty)
  metricsStore.recordTransaction(backendId, duration, true);
}

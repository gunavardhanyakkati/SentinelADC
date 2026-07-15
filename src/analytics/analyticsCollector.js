/**
 * ─── Analytics Traffic Collector Middleware ─────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Automatically captures request/response metrics for every transaction passing
 * through the gateway, inserting them as JSON records into MongoDB.
 *
 * DESIGN DECISIONS:
 * - Runs on the response `finish` event so telemetry recording happens entirely
 *   out-of-band and never delays downstream client bytes.
 * - Extracts rich transactional metadata (status codes, selected backends, cache
 *   states, request sizes, and custom correlation metrics).
 *
 * INTERVIEW QUESTIONS:
 * - Why log transactions after the response finishes rather than before?
 *   (Doing it on response finish prevents metrics database latency from impacting
 *   client request latencies, and guarantees we have accurate response status codes)
 * - How do you measure request payload size in Express/Node.js?
 *   (By reading the Content-Length response header. If it's a chunked transfer, we
 *   can buffer chunks or use stream length listeners)
 */

import analyticsDb from './analyticsDb.js';
import { elapsedMs } from '../utils/helpers.js';
import { getClientIp } from '../utils/helpers.js';
import { SENTINEL_HEADERS } from '../utils/constants.js';

export default function analyticsCollector() {
  return (req, res, next) => {
    const startTime = process.hrtime.bigint();

    // Listen for response completion
    res.on('finish', () => {
      recordTransaction(req, res, startTime);
    });

    next();
  };
}

/**
 * Build request record and write to database.
 */
async function recordTransaction(req, res, startTime) {
  if (!analyticsDb.isActive()) return;

  const latency = elapsedMs(startTime);
  const clientIp = getClientIp(req);

  const logRecord = {
    requestId: res.getHeader(SENTINEL_HEADERS.REQUEST_ID) || req.headers[SENTINEL_HEADERS.REQUEST_ID] || null,
    timestamp: new Date(),
    ip: clientIp,
    method: req.method,
    path: req.path,
    url: req.originalUrl,
    statusCode: res.statusCode,
    latencyMs: latency,
    // Extract selected backend metadata
    backendId: res.getHeader(SENTINEL_HEADERS.BACKEND_ID) || (req.selectedBackend ? req.selectedBackend.id : null),
    backendUrl: req.selectedBackend ? req.selectedBackend.url : null,
    // Extract caching state
    cacheStatus: res.getHeader(SENTINEL_HEADERS.CACHE_STATUS) || null,
    // Payload sizing
    payloadSizeBytes: parseInt(res.getHeader('Content-Length'), 10) || 0,
    userAgent: req.headers['user-agent'] || 'unknown',
    referer: req.headers['referer'] || null,
  };

  // Fire and forget insert into MongoDB logs collection
  analyticsDb.insertOne('request_logs', logRecord);
}

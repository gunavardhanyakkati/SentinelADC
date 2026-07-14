/**
 * ─── Request Logger Middleware ───────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Every production reverse proxy logs incoming requests. This provides
 * visibility into traffic patterns, debugging information, and audit trails.
 * We use Morgan for the HTTP log line and Winston as the transport to ensure
 * all logs go through our structured logging pipeline.
 *
 * DESIGN DECISIONS:
 * - Custom Morgan token format that includes our custom headers
 * - Streams Morgan output into Winston (not stdout) for unified logging
 * - Different verbosity in dev vs production
 */

import morgan from 'morgan';
import logger from '../observability/logger.js';
import { SENTINEL_HEADERS } from '../utils/constants.js';

// Create a write stream that feeds into Winston
const stream = {
  write: (message) => {
    // Morgan adds a newline, trim it
    logger.info(message.trim(), { module: 'http' });
  },
};

// ─── Custom Morgan Tokens ───────────────────────────────────────────────────

// Request ID token
morgan.token('request-id', (req) => req.headers[SENTINEL_HEADERS.REQUEST_ID] || '-');

// Backend that served the request
morgan.token('backend', (req) => req.headers[SENTINEL_HEADERS.BACKEND_ID] || '-');

// Cache status
morgan.token('cache', (req, res) => res.getHeader(SENTINEL_HEADERS.CACHE_STATUS) || '-');

// ─── Format ─────────────────────────────────────────────────────────────────

/**
 * Custom format:
 * :method :url :status :response-time ms | req-id: :request-id | backend: :backend | cache: :cache
 */
const FORMAT = ':method :url :status :response-time ms | rid::request-id | be::backend | cache::cache';

/**
 * Create and return the Morgan middleware.
 * Uses custom format with Winston as the transport.
 */
export default function requestLogger() {
  return morgan(FORMAT, { stream });
}

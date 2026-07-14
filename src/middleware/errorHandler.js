/**
 * ─── Centralized Error Handler ──────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Express requires a 4-argument middleware to catch errors. Without a centralized
 * handler, each route would need its own try/catch, leading to inconsistent
 * error responses. This middleware ensures every error gets:
 * - A structured JSON response
 * - Proper HTTP status code
 * - Logging for debugging
 * - No stack trace leakage in production
 *
 * DESIGN DECISIONS:
 * - Always respond with JSON (this is an API gateway, not a website)
 * - Include request ID in error response for traceability
 * - Log full error details server-side, send sanitized response to client
 *
 * INTERVIEW QUESTIONS:
 * - Why does Express need exactly 4 parameters for error middleware?
 * - How do you prevent stack trace leakage in production?
 * - What is the difference between operational and programmer errors?
 */

import logger from '../observability/logger.js';
import { HTTP_STATUS, SENTINEL_HEADERS } from '../utils/constants.js';

/**
 * Express error-handling middleware.
 * Must have exactly 4 parameters (err, req, res, next) for Express to
 * recognize it as an error handler.
 */
// eslint-disable-next-line no-unused-vars
export default function errorHandler(err, req, res, next) {
  // Determine status code
  const statusCode = err.statusCode || err.status || HTTP_STATUS.INTERNAL_SERVER_ERROR;

  // Get request ID if available (set by correlation ID middleware)
  const requestId = req.headers[SENTINEL_HEADERS.REQUEST_ID] || 'unknown';

  // Log the error with full context
  logger.error('Request error', {
    error: err.message,
    stack: err.stack,
    statusCode,
    method: req.method,
    path: req.originalUrl,
    requestId,
    ip: req.ip,
  });

  // Send structured error response
  res.status(statusCode).json({
    error: {
      message: statusCode >= 500 ? 'Internal Server Error' : err.message,
      statusCode,
      requestId,
      // Include stack trace only in development
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
    timestamp: new Date().toISOString(),
  });
}

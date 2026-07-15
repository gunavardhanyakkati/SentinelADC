/**
 * ─── Correlation ID Middleware ───────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Binds a unique `X-Correlation-ID` to every HTTP request entering the gateway.
 * Forwards this trace identifier to all subsequent internal middlewares,
 * asynchronous tasks, and down to the target upstream backend server headers,
 * facilitating end-to-end distributed transaction tracing.
 *
 * DESIGN DECISIONS:
 * - Reads client-provided `X-Correlation-ID` or `X-Request-ID` headers to preserve
 *   trace chains from upstream proxies, generating a new UUIDv4 if missing.
 * - Wraps the request lifecycle execution in an `AsyncLocalStorage` boundary via
 *   `runWithContext`, so any module logging operations automatically print the active ID.
 */

import { v4 as uuidv4 } from 'uuid';
import { runWithContext } from '../observability/traceContext.js';
import { SENTINEL_HEADERS } from '../utils/constants.js';

export default function correlationIdMiddleware() {
  return (req, res, next) => {
    // Extract incoming correlation ID or request ID, or generate a new UUIDv4
    const correlationId = 
      req.headers[SENTINEL_HEADERS.CORRELATION_ID] ||
      req.headers[SENTINEL_HEADERS.REQUEST_ID] ||
      req.headers['x-request-id'] ||
      uuidv4();

    req.correlationId = correlationId;
    
    // Set tracing header on the client response
    res.setHeader(SENTINEL_HEADERS.CORRELATION_ID, correlationId);

    // Bind this execution thread to the trace store context
    runWithContext(correlationId, () => {
      next();
    });
  };
}

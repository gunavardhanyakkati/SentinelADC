/**
 * ─── Proxy Utilities ────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * When a reverse proxy forwards a request, it needs to rewrite headers
 * so the upstream server knows about the original client. These utilities
 * handle the standard proxy protocol headers (X-Forwarded-For, X-Real-IP, etc.)
 * and provide hooks for metrics collection.
 *
 * DESIGN DECISIONS:
 * - Follow the established X-Forwarded-* header convention
 * - Add custom SentinelADC headers for observability
 * - Strip hop-by-hop headers that shouldn't be forwarded
 *
 * INTERVIEW QUESTIONS:
 * - What is the purpose of X-Forwarded-For and why is it a chain?
 * - What is the difference between X-Forwarded-For and X-Real-IP?
 * - Why must hop-by-hop headers be stripped by a proxy?
 * - How does X-Forwarded-Proto affect HTTPS redirect logic on backends?
 */

import { SENTINEL_HEADERS } from '../utils/constants.js';
import { getClientIp } from '../utils/helpers.js';

/**
 * Add standard proxy headers to the outgoing request.
 * Called in the onProxyReq hook of http-proxy-middleware.
 *
 * @param {import('http').ClientRequest} proxyReq - The outgoing proxy request
 * @param {import('express').Request} req - The original incoming request
 */
export function addProxyHeaders(proxyReq, req) {
  const clientIp = getClientIp(req);

  // X-Forwarded-For: Append the client IP to the chain
  const existingForwarded = req.headers['x-forwarded-for'];
  const forwardedFor = existingForwarded
    ? `${existingForwarded}, ${clientIp}`
    : clientIp;
  proxyReq.setHeader('X-Forwarded-For', forwardedFor);

  // X-Real-IP: The original client (first in the chain)
  proxyReq.setHeader('X-Real-IP', clientIp);

  // X-Forwarded-Proto: Protocol used by the original client
  proxyReq.setHeader('X-Forwarded-Proto', req.protocol);

  // X-Forwarded-Host: Original Host header
  proxyReq.setHeader('X-Forwarded-Host', req.headers.host || '');

  // Pass through our request ID for distributed tracing
  const requestId = req.requestId || req.headers[SENTINEL_HEADERS.REQUEST_ID];
  if (requestId) {
    proxyReq.setHeader(SENTINEL_HEADERS.REQUEST_ID, requestId);
  }

  // Pass through correlation ID for end-to-end trace context propagation
  const correlationId = req.correlationId || req.headers[SENTINEL_HEADERS.CORRELATION_ID];
  if (correlationId) {
    proxyReq.setHeader(SENTINEL_HEADERS.CORRELATION_ID, correlationId);
  }
}

/**
 * Add custom response headers from the proxy to the client.
 * Called in the onProxyRes hook.
 *
 * @param {import('http').IncomingMessage} proxyRes - The upstream response
 * @param {import('express').Request} req - The original request
 * @param {import('express').Response} res - The outgoing response
 */
export function addResponseHeaders(proxyRes, req, res) {
  // Tag which backend served this request
  if (req._backendId) {
    res.setHeader(SENTINEL_HEADERS.BACKEND_ID, req._backendId);
  }

  // Tag which algorithm was used
  if (req._lbAlgorithm) {
    res.setHeader(SENTINEL_HEADERS.LB_ALGORITHM, req._lbAlgorithm);
  }

  // Tag why this backend was selected
  if (req._lbReason) {
    res.setHeader(SENTINEL_HEADERS.LB_REASON, req._lbReason);
  }
}

/**
 * Hop-by-hop headers that should NOT be forwarded by a proxy.
 * Per RFC 2616 Section 13.5.1
 */
export const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

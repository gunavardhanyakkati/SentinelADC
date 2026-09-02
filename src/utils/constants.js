/**
 * ─── Application Constants ──────────────────────────────────────────────────
 *
 * Centralized constants prevent magic numbers and strings throughout the codebase.
 * Every constant has a clear name and purpose.
 */

// ─── HTTP Status Codes (commonly used) ──────────────────────────────────────
export const HTTP_STATUS = {
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504,
};

// ─── Backend Health Statuses ────────────────────────────────────────────────
export const HEALTH_STATUS = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy',
};

// ─── Load Balancing Algorithms ──────────────────────────────────────────────
export const LB_ALGORITHMS = {
  ROUND_ROBIN: 'round-robin',
  LEAST_CONNECTIONS: 'least-connections',
  WEIGHTED_ROUND_ROBIN: 'weighted-round-robin',
  IP_HASH: 'ip-hash',
  CONSISTENT_HASH: 'consistent-hash',
};

// ─── Cache Headers ──────────────────────────────────────────────────────────
export const CACHE_HEADERS = {
  HIT: 'HIT',
  MISS: 'MISS',
  BYPASS: 'BYPASS',
};

// ─── Custom Headers ─────────────────────────────────────────────────────────
export const SENTINEL_HEADERS = {
  REQUEST_ID: 'x-request-id',
  CORRELATION_ID: 'x-correlation-id',
  TRACE_ID: 'x-trace-id',
  BACKEND_ID: 'x-backend-id',
  BACKEND_LATENCY: 'x-backend-latency',
  CACHE_STATUS: 'x-cache',
  LB_ALGORITHM: 'x-lb-algorithm',
  LB_REASON: 'x-lb-reason',
};

// ─── Security Event Types ───────────────────────────────────────────────────
export const SECURITY_EVENTS = {
  RATE_LIMIT: 'rate-limit',
  JWT_INVALID: 'jwt-invalid',
  JWT_EXPIRED: 'jwt-expired',
  SQL_INJECTION: 'sql-injection',
  XSS_DETECTED: 'xss-detected',
  IP_BLOCKED: 'ip-blocked',
  HEADER_INVALID: 'header-invalid',
  BODY_INVALID: 'body-invalid',
};

// ─── Default Timeouts ───────────────────────────────────────────────────────
export const TIMEOUTS = {
  PROXY_TIMEOUT: 30000,        // 30 seconds
  HEALTH_CHECK: 3000,          // 3 seconds
  CACHE_LOOKUP: 500,           // 500 ms
};

/**
 * ─── Utility Helpers ────────────────────────────────────────────────────────
 *
 * Small, pure utility functions used across modules.
 * Each function has a single responsibility and no side effects.
 */

/**
 * Get the real client IP from a request, respecting proxy headers.
 * In production, X-Forwarded-For may contain a chain of IPs.
 * We take the first (leftmost) as the original client.
 *
 * @param {import('express').Request} req
 * @returns {string} Client IP address
 */
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For: client, proxy1, proxy2
    return forwarded.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '0.0.0.0';
}

/**
 * Measure elapsed time from a high-resolution start time.
 * Uses process.hrtime.bigint() for nanosecond precision.
 *
 * @param {bigint} startTime - process.hrtime.bigint() value
 * @returns {number} Elapsed time in milliseconds (2 decimal places)
 */
export function elapsedMs(startTime) {
  const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6;
  return Math.round(elapsed * 100) / 100;
}

/**
 * Generate a simple hash from a string.
 * Used for IP hashing in load balancing.
 *
 * @param {string} str - Input string
 * @returns {number} Non-negative integer hash
 */
export function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Format bytes to human-readable string.
 * @param {number} bytes
 * @returns {string} e.g., "1.5 MB"
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * Sleep for a given number of milliseconds.
 * Useful for simulating latency in tests.
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safely parse JSON without throwing.
 * @param {string} str
 * @returns {{ data: any, error: Error | null }}
 */
export function safeJsonParse(str) {
  try {
    return { data: JSON.parse(str), error: null };
  } catch (error) {
    return { data: null, error };
  }
}

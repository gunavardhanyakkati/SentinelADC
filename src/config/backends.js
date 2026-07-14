/**
 * ─── Backend Pool Definition ────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * The backend pool is the list of upstream servers that SentinelADC forwards
 * traffic to. Each backend has an ID, URL, weight (for weighted algorithms),
 * and a mutable health status.
 *
 * DESIGN DECISIONS:
 * - Backends are initialized from config and stored as mutable objects
 *   (health status changes at runtime as health checks run)
 * - Each backend gets a unique ID derived from its index for easy reference
 * - Weight defaults to 1 (equal distribution) and can be changed at runtime
 *
 * PRODUCTION DIFFERENCE:
 * F5 BIG-IP maintains pool members in a persistent config store (bigip.conf)
 * with support for priority groups, connection limits, and slow-ramp time.
 * Our implementation keeps it simple but structurally similar.
 */

import config from './index.js';

/**
 * @typedef {Object} Backend
 * @property {string}  id        - Unique identifier (e.g., "backend-1")
 * @property {string}  url       - Full URL of the upstream server
 * @property {number}  weight    - Weight for weighted round-robin (default: 1)
 * @property {boolean} healthy   - Current health status
 * @property {string}  status    - 'healthy' | 'degraded' | 'unhealthy'
 */

/**
 * Create the backend pool from configuration.
 * This is a factory function so the pool can be recreated if needed.
 * @returns {Backend[]}
 */
export function createBackendPool() {
  return config.backends.map((url, index) => ({
    id: `backend-${index + 1}`,
    url: url.replace(/\/+$/, ''),  // Strip trailing slashes
    weight: index === 0 ? 3 : index === 1 ? 2 : 1, // Staggered weights (3, 2, 1) for testing
    healthy: true,
    status: 'healthy',             // 'healthy' | 'degraded' | 'unhealthy'
    activeConnections: 0,          // Tracked for least-connections algorithm
  }));
}

// Singleton pool instance used across the application
const backendPool = createBackendPool();

export default backendPool;

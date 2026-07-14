/**
 * ─── Least Connections Load Balancing Strategy ──────────────────────────────
 *
 * WHY THIS EXISTS:
 * Least Connections is a dynamic load balancing algorithm. It routes incoming
 * requests to the backend server with the lowest number of active concurrent
 * connections. This is ideal when requests have highly variable processing
 * times (e.g., long-lived queries vs. simple health checks).
 *
 * DESIGN DECISIONS:
 * - Scans healthy backends to find the minimum connection count.
 * - If multiple backends have the same minimum connection count, it picks the
 *   first one or does a secondary round-robin among them to distribute load.
 *
 * INTERVIEW QUESTIONS:
 * - When is Least Connections superior to Round Robin? (Variable latency / long requests)
 * - How does our proxy track active connections? (Increment on routing, decrement on res finish/close)
 * - What are the disadvantages? (Needs state tracking, slightly more CPU cycles than RR)
 */

export default class LeastConnectionsStrategy {
  /**
   * Select a backend from the list of healthy backends.
   * @param {import('../../config/backends.js').Backend[]} backends
   * @param {import('express').Request} req
   * @returns {import('../../config/backends.js').Backend}
   */
  select(backends, req) {
    let minConnections = Infinity;
    let selectedBackends = [];

    // Find backends with the lowest connection count
    for (const backend of backends) {
      const active = backend.activeConnections || 0;
      if (active < minConnections) {
        minConnections = active;
        selectedBackends = [backend];
      } else if (active === minConnections) {
        selectedBackends.push(backend);
      }
    }

    // If multiple backends are tied, pick one (e.g. random or first)
    // First is simple and predictable for educational demos
    const selected = selectedBackends[0];
    
    req._lbReason = `least-connections (active connections: ${minConnections})`;
    return selected;
  }
}

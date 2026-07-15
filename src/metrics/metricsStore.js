/**
 * ─── Metrics Store ────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Collects and aggregates real-time performance metrics (response times,
 * request counts, error rates, and connection states) over a sliding window
 * of live traffic. This data is used to calculate a dynamic "health/performance score"
 * for each backend, enabling the routing engine to make intelligent decisions.
 *
 * DESIGN DECISIONS:
 * - Employs an in-memory sliding window (last 60 seconds or last 100 requests)
 *   to ensure metrics represent current conditions, not stale historical averages.
 * - Computes a performance score out of 100 for each backend.
 * - Scores penalize high latency, active concurrency, and HTTP/connection errors.
 *
 * INTERVIEW QUESTIONS:
 * - How is the backend score calculated?
 *   (Base score of 100 is penalized proportionally by average latency, error rate,
 *   and current concurrent connection count)
 * - How do you optimize sliding window structures in high-throughput proxies?
 *   (Use atomic counter rings, bucketing by second/minute, or thread-safe circular buffers
 *   rather than expanding and slicing raw arrays on every transaction)
 */

import backendPool from '../config/backends.js';

class MetricsStore {
  constructor() {
    this.pool = backendPool;
    this.windowMs = 60000; // 60 seconds sliding window
    this.historyLimit = 100; // Max requests to keep per backend in window
    
    // Store request metrics: backendId -> Array of { latency, error, timestamp }
    this.history = {};

    for (const backend of this.pool) {
      this.history[backend.id] = [];
    }
  }

  /**
   * Record metrics from a completed transaction.
   * @param {string} backendId
   * @param {number} latency - Latency in ms
   * @param {boolean} error - Whether the transaction failed (e.g. status >= 500)
   */
  recordTransaction(backendId, latency, error) {
    const list = this.history[backendId];
    if (!list) return;

    list.push({
      latency,
      error,
      timestamp: Date.now(),
    });

    // Clean up stale or oversized history
    this.cleanup(backendId);
  }

  /**
   * Remove records older than the sliding window or exceeding history limits.
   */
  cleanup(backendId) {
    const list = this.history[backendId];
    if (!list) return;

    const cutoff = Date.now() - this.windowMs;
    
    // Filter out old entries
    let filtered = list.filter(item => item.timestamp > cutoff);

    // Caps the array to the last N entries
    if (filtered.length > this.historyLimit) {
      filtered = filtered.slice(filtered.length - this.historyLimit);
    }

    this.history[backendId] = filtered;
  }

  /**
   * Compute aggregated metrics and score for a single backend.
   * @param {string} backendId
   */
  getBackendMetrics(backendId) {
    this.cleanup(backendId);
    
    const backend = this.pool.find(b => b.id === backendId);
    const list = this.history[backendId];
    
    if (!backend || !list) return null;

    const requestCount = list.length;
    let averageLatency = 0;
    let errorRate = 0;

    if (requestCount > 0) {
      const totalLatency = list.reduce((sum, item) => sum + item.latency, 0);
      averageLatency = Math.round((totalLatency / requestCount) * 100) / 100;

      const totalErrors = list.filter(item => item.error).length;
      errorRate = Math.round((totalErrors / requestCount) * 10000) / 100;
    }

    const activeConnections = backend.activeConnections || 0;
    const score = this.calculateScore(backend, averageLatency, errorRate, activeConnections);

    return {
      id: backendId,
      url: backend.url,
      healthy: backend.healthy,
      status: backend.status,
      requestCount,
      averageLatency,
      errorRate,
      activeConnections,
      score,
    };
  }

  /**
   * Calculate a performance score from 0 to 100.
   */
  calculateScore(backend, avgLatency, errorRate, activeConnections) {
    if (!backend.healthy) return 0;

    let score = 100;

    // 1. Latency Penalty: -1 point for every 10ms of average response time (capped at -40)
    const latencyPenalty = Math.min(40, avgLatency / 10);
    score -= latencyPenalty;

    // 2. Error Penalty: -50 points for 100% error rate, scaled down proportionally
    const errorPenalty = (errorRate / 100) * 50;
    score -= errorPenalty;

    // 3. Concurrency Penalty: -5 points per active connection (capped at -30)
    const connPenalty = Math.min(30, activeConnections * 5);
    score -= connPenalty;

    return Math.max(0, Math.round(score));
  }

  /**
   * Get metrics and scores for all backends in the pool.
   */
  getAllMetrics() {
    return this.pool.map(b => this.getBackendMetrics(b.id));
  }
}

const metricsStore = new MetricsStore();
export default metricsStore;

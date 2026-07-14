/**
 * ─── Health Store ────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * In-memory registry that tracks detailed health status and historical check
 * results for each backend. Having a dedicated store separates the state of
 * the backends from the active scanning loop (healthMonitor) and the proxy routing.
 *
 * DESIGN DECISIONS:
 * - Keeps an in-memory window of the last 20 health check results per backend.
 * - Dynamically calculates success rate, average latency, and uptime.
 * - Maps results to 'healthy', 'degraded', or 'unhealthy' statuses.
 * - Mutates the main backend pool objects' `healthy` and `status` fields directly
 *   so the routing engine automatically picks up health updates without polling.
 *
 * INTERVIEW QUESTIONS:
 * - How would you scale the health store in a multi-process or clustered gateway environment?
 *   (Use a shared Redis instance to publish/subscribe to health events or store state,
 *   rather than keeping it purely local in-process)
 * - How do success rates over a rolling window help prevent flapping?
 *   (Prevents a server from continuously joining and leaving the pool if it is
 *   intermittently failing—also known as flap dampening)
 */

import backendPool from '../config/backends.js';
import { HEALTH_STATUS } from '../utils/constants.js';

class HealthStore {
  constructor() {
    this.pool = backendPool;
    this.historyLimit = 20; // Keep last 20 check results
    this.stats = {};

    // Initialize stats structure for each backend
    for (const backend of this.pool) {
      this.stats[backend.id] = {
        checks: [], // Array of { success: boolean, latency: number, timestamp: Date }
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        totalChecks: 0,
        successfulChecks: 0,
        averageLatency: 0,
        uptimePercentage: 100,
        lastCheckTime: null,
      };
    }
  }

  /**
   * Record a health check result.
   * @param {string} backendId - ID of the backend
   * @param {boolean} success - Whether the health check succeeded
   * @param {number} latency - Response time in ms
   */
  recordResult(backendId, success, latency) {
    const stats = this.stats[backendId];
    if (!stats) return;

    const timestamp = new Date();
    stats.totalChecks++;
    stats.lastCheckTime = timestamp;

    if (success) {
      stats.successfulChecks++;
      stats.consecutiveFailures = 0;
      stats.consecutiveSuccesses++;
    } else {
      stats.consecutiveFailures++;
      stats.consecutiveSuccesses = 0;
    }

    // Add to sliding window history
    stats.checks.push({ success, latency, timestamp });
    if (stats.checks.length > this.historyLimit) {
      stats.checks.shift();
    }

    // Recalculate metrics
    const recentChecks = stats.checks;
    const successfulRecent = recentChecks.filter(c => c.success).length;
    stats.successRate = (successfulRecent / recentChecks.length) * 100;

    const totalLatency = recentChecks.reduce((sum, c) => sum + (c.latency || 0), 0);
    stats.averageLatency = Math.round((totalLatency / recentChecks.length) * 100) / 100;

    stats.uptimePercentage = Math.round((stats.successfulChecks / stats.totalChecks) * 10000) / 100;

    // Determine backend status and update backend pool object
    const backend = this.pool.find(b => b.id === backendId);
    if (backend) {
      this.updateBackendHealthState(backend, stats);
    }
  }

  /**
   * Update the backend's status and health flags based on collected statistics.
   * Uses simple thresholds and sliding success rates.
   */
  updateBackendHealthState(backend, stats) {
    if (backend.adminDisabled) {
      backend.healthy = false;
      backend.status = HEALTH_STATUS.UNHEALTHY;
      return;
    }

    const prevHealthy = backend.healthy;

    // Rule 1: Too many consecutive failures -> Unhealthy (Remove from pool)
    if (stats.consecutiveFailures >= 3) {
      backend.healthy = false;
      backend.status = HEALTH_STATUS.UNHEALTHY;
    }
    // Rule 2: Consecutive successes -> Rejoin pool
    else if (stats.consecutiveSuccesses >= 2 && !backend.healthy) {
      backend.healthy = true;
      backend.status = HEALTH_STATUS.HEALTHY;
    }
    // Rule 3: Degraded if success rate drops or we have some consecutive failures but less than threshold
    else if (stats.consecutiveFailures > 0 || stats.successRate < 90) {
      backend.status = HEALTH_STATUS.DEGRADED;
      // Remain in pool unless consecutiveFailures hits threshold
      backend.healthy = stats.consecutiveFailures < 3;
    } else {
      backend.healthy = true;
      backend.status = HEALTH_STATUS.HEALTHY;
    }
  }

  /**
   * Get health metrics for a single backend.
   * @param {string} backendId
   */
  getBackendHealth(backendId) {
    const stats = this.stats[backendId];
    const backend = this.pool.find(b => b.id === backendId);
    if (!stats || !backend) return null;

    return {
      id: backend.id,
      url: backend.url,
      healthy: backend.healthy,
      status: backend.status,
      weight: backend.weight,
      activeConnections: backend.activeConnections,
      ...stats,
    };
  }

  /**
   * Get overall gateway health status: green, yellow, red.
   */
  getGatewayOverallHealth() {
    const healthyCount = this.pool.filter(b => b.healthy && b.status === HEALTH_STATUS.HEALTHY).length;
    const totalCount = this.pool.length;

    if (healthyCount === totalCount) {
      return 'green'; // All systems normal
    } else if (healthyCount > 0) {
      return 'yellow'; // Degraded - some backends down/degraded
    } else {
      return 'red'; // Critical - all backends down
    }
  }

  /**
   * Get health metrics for all backends.
   */
  getAllBackendHealth() {
    return this.pool.map(b => this.getBackendHealth(b.id));
  }
}

const healthStore = new HealthStore();
export default healthStore;

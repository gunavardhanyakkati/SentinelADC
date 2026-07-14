/**
 * ─── Health Monitor ──────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Performs active periodic health checks against all upstream backend servers
 * in the pool. It runs asynchronously in the background, updating the health
 * status store so the routing engine doesn't route traffic to offline servers.
 *
 * DESIGN DECISIONS:
 * - Uses standard Node.js native `fetch` (with `AbortController` for request timeouts).
 * - Periodically schedules checks using `setInterval` based on configuration.
 * - Updates the health store with results, latency, and success/failure flags.
 *
 * INTERVIEW QUESTIONS:
 * - How do you implement a request timeout with native Fetch? (Using AbortController)
 * - How does active health monitoring compare to passive health monitoring?
 *   (Active monitoring pings servers at set intervals. Passive monitoring observes
 *   live traffic errors. Passive has zero background traffic overhead, but active
 *   can catch failures before real users hit them)
 * - What are the CPU/network trade-offs of checking too frequently?
 *   (Frequent checks waste bandwidth and CPU on both the ADC and backends, while
 *   infrequent checks leave the pool vulnerable to routing requests to dead servers for longer)
 */

import healthStore from './healthStore.js';
import config from '../config/index.js';
import { createChildLogger } from '../observability/logger.js';

const log = createChildLogger({ module: 'health-monitor' });

class HealthMonitor {
  constructor() {
    this.intervalId = null;
  }

  /**
   * Start the periodic health monitoring loop.
   */
  start() {
    if (this.intervalId) return;

    log.info(`Starting active health monitor. Interval: ${config.health.interval}ms, Timeout: ${config.health.timeout}ms, Path: ${config.health.path}`);

    // Run first check immediately
    this.checkAll();

    // Schedule subsequent checks
    this.intervalId = setInterval(() => {
      this.checkAll();
    }, config.health.interval);
  }

  /**
   * Stop the health monitoring loop.
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info('Health monitor stopped');
    }
  }

  /**
   * Run health checks on all backends in the pool concurrently.
   */
  async checkAll() {
    const backends = healthStore.pool;
    const checks = backends.map((backend) => this.checkBackend(backend));
    await Promise.all(checks);
  }

  /**
   * Check a single backend's health.
   */
  async checkBackend(backend) {
    const healthUrl = `${backend.url}${config.health.path}`;
    const startTime = process.hrtime.bigint();
    
    // Create abort controller for request timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, config.health.timeout);

    try {
      const response = await fetch(healthUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'SentinelADC-HealthMonitor/1.0',
        },
      });

      const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6; // Convert nanoseconds to milliseconds
      clearTimeout(timeoutId);

      if (response.ok) {
        healthStore.recordResult(backend.id, true, elapsed);
        log.debug(`Health check passed for ${backend.id} (${backend.url}) in ${elapsed.toFixed(2)}ms`);
      } else {
        healthStore.recordResult(backend.id, false, elapsed);
        log.warn(`Health check failed for ${backend.id} (${backend.url}) with status: ${response.status}`);
      }
    } catch (error) {
      const elapsed = Number(process.hrtime.bigint() - startTime) / 1e6;
      clearTimeout(timeoutId);

      const isTimeout = error.name === 'AbortError';
      const errorMessage = isTimeout ? 'Request timeout' : error.message;

      healthStore.recordResult(backend.id, false, elapsed);
      log.error(`Health check error for ${backend.id} (${backend.url}): ${errorMessage}`);
    }
  }
}

const healthMonitor = new HealthMonitor();
export default healthMonitor;

/**
 * ─── Routing Engine ─────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * The routing engine is the brain of the load balancer. It decides which
 * backend server receives each incoming request. It:
 * 1. Filters out unhealthy backends
 * 2. Applies the selected load balancing algorithm
 * 3. Attaches selection metadata to the request for observability
 *
 * In Milestone 1, we implement a simple round-robin. In Milestone 2,
 * we'll add the strategy pattern with 4 interchangeable algorithms.
 *
 * DESIGN DECISIONS:
 * - The routing engine is a standalone module, not coupled to the proxy
 * - It works with the backend pool and health store
 * - Selection metadata (algorithm, reason) is attached for the dashboard
 */

import backendPool from '../config/backends.js';
import config from '../config/index.js';
import { createChildLogger } from '../observability/logger.js';
import strategyFactory from './strategyFactory.js';

import circuitBreakerManager from '../resilience/circuitBreakerManager.js';

const log = createChildLogger({ module: 'routing' });

class RoutingEngine {
  constructor() {
    this._algorithm = config.loadBalancing.algorithm;
    this._strategy = strategyFactory.getStrategy(this._algorithm);
    this._pool = backendPool;
  }

  /**
   * Get the list of currently healthy backends.
   * Filters out backends marked unhealthy or in an OPEN circuit breaker state.
   * @returns {import('../config/backends.js').Backend[]}
   */
  getHealthyBackends() {
    return this._pool.filter((b) => b.healthy && circuitBreakerManager.canExecute(b.id));
  }

  /**
   * Select a backend for the given request.
   * Returns null if no healthy backend is available.
   *
   * @param {import('express').Request} req
   * @returns {import('../config/backends.js').Backend | null}
   */
  selectBackend(req) {
    let healthy = this.getHealthyBackends();

    // Filter out backends that already failed during retry attempts for this request
    if (req && req._failedBackends && req._failedBackends.size > 0) {
      const candidates = healthy.filter((b) => !req._failedBackends.has(b.id));
      if (candidates.length > 0) {
        healthy = candidates;
      }
    }

    if (healthy.length === 0) {
      log.error('No healthy backends available');
      return null;
    }

    // Use current strategy to select backend
    const backend = this._strategy.select(healthy, req);

    // Attach selection metadata to the request
    req._targetBackend = backend;
    req._backendId = backend.id;
    req._lbAlgorithm = this._algorithm;
    // req._lbReason is already set by the strategy's select method

    log.debug('Selected backend', {
      backend: backend.id,
      url: backend.url,
      algorithm: this._algorithm,
      reason: req._lbReason,
      healthyCount: healthy.length,
    });

    return backend;
  }

  /**
   * Get the current algorithm name.
   * @returns {string}
   */
  getCurrentAlgorithm() {
    return this._algorithm;
  }

  /**
   * Set the algorithm at runtime.
   * @param {string} algorithm
   */
  setAlgorithm(algorithm) {
    try {
      const strategy = strategyFactory.getStrategy(algorithm);
      this._strategy = strategy;
      this._algorithm = algorithm;
      log.info(`Load balancing algorithm dynamically switched to: ${algorithm}`);
      return true;
    } catch (error) {
      log.error(`Failed to switch load balancing algorithm: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get the full backend pool (for API responses).
   * @returns {import('../config/backends.js').Backend[]}
   */
  getPool() {
    return this._pool;
  }
}

// Singleton instance
const routingEngine = new RoutingEngine();
export default routingEngine;

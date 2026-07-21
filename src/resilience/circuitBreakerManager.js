/**
 * ─── Upstream Circuit Breaker Manager ─────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * When an upstream backend service experiences cascading failures (database timeouts,
 * process crashes, high 5xx rates), continuing to send requests increases latency,
 * exhausts connection pools, and delays failover.
 *
 * A Circuit Breaker acts as a fast-failing safety valve with 3 states:
 * - CLOSED: Normal operation. All requests pass through to the backend.
 * - OPEN: Backend is failing. All requests fast-fail or bypass this backend instantly.
 * - HALF_OPEN: Cooldown expired. Allows a trial probe request to test backend recovery.
 *
 * DESIGN DECISIONS:
 * - Shared Pool State: When a breaker trips OPEN, it sets `backend.healthy = false`
 *   to remove it from the load balancer pool immediately.
 * - Dual-Path Recovery: A backend transitions back from HALF_OPEN to CLOSED if EITHER
 *   a live HALF_OPEN probe request succeeds OR the background health checker's `/health` probe passes.
 * - Fast Failure Triggers: 5xx HTTP responses, connection refused (ECONNREFUSED), and socket timeouts.
 *
 * INTERVIEW QUESTIONS:
 * - How does the Circuit Breaker reconcile with the Health Checker?
 *   (The Circuit Breaker is the fast reactive path per-request; the Health Checker is the
 *   slow proactive path running every 5s. Both update the same underlying `backend.healthy`
 *   state in the load balancer pool)
 * - Why use HALF_OPEN probing instead of instantly restoring full traffic?
 *   (If a recovering backend is bombarded with full traffic upon coming back up, it may
 *   relapse immediately due to thundering herd effect. HALF_OPEN throttles recovery traffic)
 */

import EventEmitter from 'node:events';
import backendPool from '../config/backends.js';
import config from '../config/index.js';
import securityLogger from '../security/securityLogger.js';
import { createChildLogger } from '../observability/logger.js';

const log = createChildLogger({ module: 'circuit-breaker' });

export const CIRCUIT_STATE = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
};

class CircuitBreakerManager extends EventEmitter {
  constructor() {
    super();
    this.enabled = config.security.circuitBreaker.enabled;
    this.failureThreshold = config.security.circuitBreaker.failureThreshold;
    this.cooldownMs = config.security.circuitBreaker.cooldownMs;
    this.halfOpenMaxProbes = config.security.circuitBreaker.halfOpenMaxProbes;

    // Map: backendId -> { state, consecutiveFailures, lastStateChange, probeCount, lastError }
    this.breakers = new Map();

    this.initBreakers();
  }

  /**
   * Initialize breaker state for all registered backends.
   */
  initBreakers() {
    backendPool.forEach((backend) => {
      this.breakers.set(backend.id, {
        backendId: backend.id,
        url: backend.url,
        state: CIRCUIT_STATE.CLOSED,
        consecutiveFailures: 0,
        lastStateChange: Date.now(),
        probeCount: 0,
        lastError: null,
      });
    });
  }

  /**
   * Get breaker record for a backend.
   * @param {string} backendId
   */
  getBreaker(backendId) {
    if (!this.breakers.has(backendId)) {
      this.breakers.set(backendId, {
        backendId,
        url: '',
        state: CIRCUIT_STATE.CLOSED,
        consecutiveFailures: 0,
        lastStateChange: Date.now(),
        probeCount: 0,
        lastError: null,
      });
    }
    return this.breakers.get(backendId);
  }

  /**
   * Check if a backend can accept a request.
   * @param {string} backendId
   * @returns {boolean}
   */
  canExecute(backendId) {
    if (!this.enabled) return true;

    const breaker = this.getBreaker(backendId);
    const now = Date.now();

    if (breaker.state === CIRCUIT_STATE.CLOSED) {
      return true;
    }

    if (breaker.state === CIRCUIT_STATE.OPEN) {
      // Check if cooldown period has elapsed
      if (now - breaker.lastStateChange >= this.cooldownMs) {
        this.transitionTo(breaker, CIRCUIT_STATE.HALF_OPEN, 'Cooldown period expired; entering HALF_OPEN probe state');
        breaker.probeCount = 1;
        return true;
      }
      return false; // Fast fail / skip
    }

    if (breaker.state === CIRCUIT_STATE.HALF_OPEN) {
      if (breaker.probeCount < this.halfOpenMaxProbes) {
        breaker.probeCount++;
        return true;
      }
      return false;
    }

    return true;
  }

  /**
   * Record a successful request or health check.
   * @param {string} backendId
   */
  recordSuccess(backendId) {
    if (!this.enabled) return;

    const breaker = this.getBreaker(backendId);
    breaker.consecutiveFailures = 0;

    if (breaker.state === CIRCUIT_STATE.HALF_OPEN || breaker.state === CIRCUIT_STATE.OPEN) {
      this.transitionTo(breaker, CIRCUIT_STATE.CLOSED, 'Successful request probe received');
    }
  }

  /**
   * Record a request failure (5xx HTTP status or socket connection error).
   * @param {string} backendId
   * @param {string | number} errorOrStatus
   */
  recordFailure(backendId, errorOrStatus) {
    if (!this.enabled) return;

    const breaker = this.getBreaker(backendId);
    breaker.consecutiveFailures++;
    breaker.lastError = String(errorOrStatus);

    log.warn(`Backend ${backendId} recorded failure #${breaker.consecutiveFailures}: ${errorOrStatus}`);

    if (breaker.state === CIRCUIT_STATE.HALF_OPEN) {
      this.transitionTo(breaker, CIRCUIT_STATE.OPEN, `HALF_OPEN probe failed (${errorOrStatus}). Re-tripping to OPEN.`);
      return;
    }

    if (breaker.state === CIRCUIT_STATE.CLOSED && breaker.consecutiveFailures >= this.failureThreshold) {
      this.transitionTo(breaker, CIRCUIT_STATE.OPEN, `${breaker.consecutiveFailures} consecutive failures reached threshold (${this.failureThreshold}).`);
    }
  }

  /**
   * State Transition Handler
   * @param {Object} breaker
   * @param {string} newState
   * @param {string} reason
   */
  transitionTo(breaker, newState, reason) {
    const oldState = breaker.state;
    if (oldState === newState) return;

    breaker.state = newState;
    breaker.lastStateChange = Date.now();

    log.info(`⚡ Circuit Breaker [${breaker.backendId}]: ${oldState} ➔ ${newState} (${reason})`);

    // Synchronize health state with unified backend pool state machine
    const backend = backendPool.find(b => b.id === breaker.backendId);

    if (newState === CIRCUIT_STATE.OPEN) {
      if (backend) {
        backend.healthy = false;
        backend.status = 'unhealthy';
      }
      securityLogger.logEvent('circuit-breaker-tripped', {
        path: breaker.backendId,
        headers: {},
        ip: 'SYSTEM',
      }, {
        backendId: breaker.backendId,
        url: breaker.url,
        failures: breaker.consecutiveFailures,
        reason,
      });
    } else if (newState === CIRCUIT_STATE.HALF_OPEN) {
      if (backend) {
        backend.healthy = false;
        backend.status = 'degraded';
      }
    } else if (newState === CIRCUIT_STATE.CLOSED) {
      if (backend) {
        backend.healthy = true;
        backend.status = 'healthy';
      }
      log.info(`✅ Circuit Breaker restored healthy status for ${breaker.backendId} in load balancer pool.`);
    }

    this.emit('state-change', {
      backendId: breaker.backendId,
      from: oldState,
      to: newState,
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get snapshots of all circuit breaker states.
   */
  getAllStates() {
    const list = [];
    const now = Date.now();

    for (const [id, breaker] of this.breakers.entries()) {
      const backend = backendPool.find(b => b.id === id);
      list.push({
        backendId: id,
        url: breaker.url || (backend ? backend.url : ''),
        state: breaker.state,
        consecutiveFailures: breaker.consecutiveFailures,
        lastStateChange: new Date(breaker.lastStateChange).toISOString(),
        cooldownRemainingMs: breaker.state === CIRCUIT_STATE.OPEN ? Math.max(0, this.cooldownMs - (now - breaker.lastStateChange)) : 0,
        lastError: breaker.lastError,
        healthyInPool: backend ? backend.healthy : false,
      });
    }

    return list;
  }

  /**
   * Reset a circuit breaker manually via admin API.
   * @param {string} backendId
   */
  reset(backendId) {
    const breaker = this.getBreaker(backendId);
    this.transitionTo(breaker, CIRCUIT_STATE.CLOSED, 'Manual admin reset');
    breaker.consecutiveFailures = 0;
    breaker.lastError = null;
    return this.getAllStates();
  }
}

const circuitBreakerManager = new CircuitBreakerManager();
export default circuitBreakerManager;

/**
 * ─── Connection Drain Manager (Maintenance Mode) ─────────────────────────────
 *
 * WHY THIS EXISTS:
 * When performing zero-downtime maintenance or rolling updates on upstream backends,
 * hard-killing a server causes abrupt connection drops for active users.
 *
 * Connection Draining ("Maintenance Mode"):
 * 1. Marks backend status as `draining` and sets `healthy = false`.
 * 2. Stops assigning NEW incoming requests to the draining backend.
 * 3. Monitors `activeConnections`. When in-flight requests finish (activeConnections === 0),
 *    the status transitions to `offline` cleanly.
 * 4. Includes a configurable safety deadline (default 30s) to force offline if connections stall.
 *
 * DESIGN DECISIONS:
 * - Event-driven completion: listens to connection decrement events.
 * - Supports dynamic cancellation via `undrainBackend(id)`.
 *
 * INTERVIEW QUESTIONS:
 * - What is Connection Draining / Maintenance Mode?
 *   (It allows zero-downtime deployments by allowing in-flight transactions to complete
 *   while routing all new ingress traffic away from the target server)
 * - What happens if a client holds an HTTP keep-alive connection open indefinitely during a drain?
 *   (The drain timeout deadline forces state transition to offline after N seconds to prevent stalling maintenance)
 */

import backendPool from '../config/backends.js';
import securityLogger from '../security/securityLogger.js';
import { createChildLogger } from '../observability/logger.js';

const log = createChildLogger({ module: 'connection-drain' });

class ConnectionDrainManager {
  constructor() {
    this.drainTimers = new Map(); // backendId -> Timeout
  }

  /**
   * Initiate connection draining for a backend.
   * @param {string} backendId
   * @param {number} timeoutSec - Timeout in seconds (default 30)
   */
  drainBackend(backendId, timeoutSec = 30) {
    const backend = backendPool.find(b => b.id === backendId);
    if (!backend) {
      throw new Error(`Backend with ID "${backendId}" not found`);
    }

    if (backend.status === 'draining') {
      return { message: `Backend ${backendId} is already draining`, backend };
    }

    log.info(`🧹 Starting connection drain for ${backendId} (${backend.url}). Active connections: ${backend.activeConnections || 0}, Timeout: ${timeoutSec}s`);

    // 1. Remove from new request routing rotation
    backend.healthy = false;
    backend.status = 'draining';
    backend.drainStartTime = new Date().toISOString();

    securityLogger.logEvent('backend-drain-started', {
      path: backendId,
      headers: {},
      ip: 'ADMIN',
    }, {
      backendId,
      activeConnections: backend.activeConnections,
      timeoutSec,
    });

    // 2. Check if already 0 active connections
    if (!backend.activeConnections || backend.activeConnections <= 0) {
      this.completeDrain(backend, 'Immediate drain (0 active connections)');
      return { message: `Backend ${backendId} had 0 active connections; transitioned directly to OFFLINE`, backend };
    }

    // 3. Set drain timeout deadline
    if (this.drainTimers.has(backendId)) {
      clearTimeout(this.drainTimers.get(backendId));
    }

    const timer = setTimeout(() => {
      if (backend.status === 'draining') {
        this.completeDrain(backend, `Drain timeout expired (${timeoutSec}s) with ${backend.activeConnections} remaining connections`);
      }
    }, timeoutSec * 1000);

    this.drainTimers.set(backendId, timer);

    // Attach completion callback to backend instance
    backend.onDrainComplete = () => {
      if (backend.status === 'draining' && (!backend.activeConnections || backend.activeConnections <= 0)) {
        this.completeDrain(backend, 'All in-flight connections completed cleanly');
      }
    };

    return { message: `Connection drain initiated for ${backendId}. Waiting for ${backend.activeConnections} active connections to finish (timeout: ${timeoutSec}s)`, backend };
  }

  /**
   * Complete connection drain and set backend status to OFFLINE.
   * @param {Object} backend
   * @param {string} reason
   */
  completeDrain(backend, reason) {
    if (this.drainTimers.has(backend.id)) {
      clearTimeout(this.drainTimers.get(backend.id));
      this.drainTimers.delete(backend.id);
    }

    backend.status = 'offline';
    backend.healthy = false;
    delete backend.onDrainComplete;

    log.info(`✅ Connection drain completed for ${backend.id}: ${reason}`);

    securityLogger.logEvent('backend-drain-completed', {
      path: backend.id,
      headers: {},
      ip: 'ADMIN',
    }, {
      backendId: backend.id,
      reason,
    });
  }

  /**
   * Cancel connection drain and restore backend to HEALTHY status.
   * @param {string} backendId
   */
  undrainBackend(backendId) {
    const backend = backendPool.find(b => b.id === backendId);
    if (!backend) {
      throw new Error(`Backend with ID "${backendId}" not found`);
    }

    if (this.drainTimers.has(backendId)) {
      clearTimeout(this.drainTimers.get(backendId));
      this.drainTimers.delete(backendId);
    }

    delete backend.onDrainComplete;
    delete backend.drainStartTime;

    backend.status = 'healthy';
    backend.healthy = true;

    log.info(`🔄 Undrained backend ${backendId}. Restored healthy status in pool.`);

    return { message: `Backend ${backendId} undrained successfully and restored to HEALTHY status in load balancer pool`, backend };
  }
}

const connectionDrainManager = new ConnectionDrainManager();
export default connectionDrainManager;

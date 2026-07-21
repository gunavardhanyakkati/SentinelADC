/**
 * ─── Resilience & Circuit Breaker API Routes ────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Exposes administration REST endpoints for inspecting circuit breaker state,
 * viewing failure counts, and manually resetting tripped circuit breakers.
 */

import { Router } from 'express';
import circuitBreakerManager from './circuitBreakerManager.js';
import { HTTP_STATUS } from '../utils/constants.js';
import jwtMiddleware from '../security/jwtMiddleware.js';

const router = Router();

// Protect all resilience routes below this line
router.use(jwtMiddleware());

/**
 * GET /api/resilience/circuit-breakers
 * Fetch status of all upstream backend circuit breakers.
 */
router.get('/circuit-breakers', (req, res) => {
  res.json({
    enabled: circuitBreakerManager.enabled,
    failureThreshold: circuitBreakerManager.failureThreshold,
    cooldownMs: circuitBreakerManager.cooldownMs,
    circuitBreakers: circuitBreakerManager.getAllStates(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/resilience/circuit-breakers/reset
 * Manually reset a tripped circuit breaker for a specific backend.
 */
router.post('/circuit-breakers/reset', (req, res) => {
  const { backendId } = req.body;

  if (!backendId) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Missing required parameter "backendId"',
    });
  }

  const updatedStates = circuitBreakerManager.reset(backendId);

  res.json({
    message: `Circuit breaker for backend "${backendId}" reset to CLOSED successfully.`,
    circuitBreakers: updatedStates,
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/resilience/circuit-breakers/reset-all
 * Manually reset all circuit breakers across the entire pool.
 */
router.post('/circuit-breakers/reset-all', (req, res) => {
  for (const breaker of circuitBreakerManager.getAllStates()) {
    circuitBreakerManager.reset(breaker.backendId);
  }

  res.json({
    message: 'All circuit breakers reset to CLOSED successfully.',
    circuitBreakers: circuitBreakerManager.getAllStates(),
    timestamp: new Date().toISOString(),
  });
});

export default router;

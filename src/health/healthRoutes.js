/**
 * ─── Health API Routes ───────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Exposes health monitoring data to the React dashboard or external monitoring
 * systems. It allows operators to check success rates, average latency, check
 * history, and manual administrative overrides.
 *
 * DESIGN DECISIONS:
 * - Direct queries to healthStore.
 * - POST endpoint to manually override server health (simulating pool member disable/enable).
 */

import { Router } from 'express';
import healthStore from './healthStore.js';
import { HTTP_STATUS } from '../utils/constants.js';

const router = Router();

/**
 * GET /api/health
 * Returns summary of all backends and overall gateway status (green/yellow/red).
 */
router.get('/', (req, res) => {
  res.json({
    status: healthStore.getGatewayOverallHealth(),
    backends: healthStore.getAllBackendHealth(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/health/:id
 * Returns detailed health information and rolling check history for a single backend.
 */
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const healthData = healthStore.getBackendHealth(id);

  if (!healthData) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({
      error: `Backend with ID "${id}" not found`,
    });
  }

  res.json(healthData);
});

/**
 * POST /api/health/:id/override
 * Allows an admin to manually force a backend pool member to be healthy or unhealthy.
 * Useful for maintenance operations.
 */
router.post('/:id/override', (req, res) => {
  const { id } = req.params;
  const { healthy } = req.body;

  if (typeof healthy !== 'boolean') {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Missing or invalid parameter "healthy" (must be boolean)',
    });
  }

  const backend = healthStore.pool.find(b => b.id === id);

  if (!backend) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({
      error: `Backend with ID "${id}" not found`,
    });
  }

  // Set health override and adminDisabled state
  backend.adminDisabled = !healthy;
  backend.healthy = healthy;
  backend.status = healthy ? 'healthy' : 'unhealthy';
  
  // Reset consecutive checks
  const stats = healthStore.stats[id];
  if (stats) {
    stats.consecutiveFailures = healthy ? 0 : 3;
    stats.consecutiveSuccesses = healthy ? 2 : 0;
  }

  res.json({
    message: `Backend "${id}" health manually overridden to ${healthy ? 'HEALTHY' : 'UNHEALTHY'} (Sticky override: ${!healthy})`,
    backend: healthStore.getBackendHealth(id),
  });
});

export default router;

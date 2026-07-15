/**
 * ─── Metrics API Routes ──────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Exposes live performance metrics and dynamic scoring data to the frontend
 * dashboard. Operators can see request rates, error rates, and server health scores.
 */

import { Router } from 'express';
import metricsStore from './metricsStore.js';
import { HTTP_STATUS } from '../utils/constants.js';

const router = Router();

/**
 * GET /api/metrics
 * Returns real-time metrics and health scores for all backend servers.
 */
router.get('/', (req, res) => {
  res.json({
    metrics: metricsStore.getAllMetrics(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /api/metrics/:id
 * Returns metrics and score for a single backend server.
 */
router.get('/:id', (req, res) => {
  const { id } = req.params;
  const metrics = metricsStore.getBackendMetrics(id);

  if (!metrics) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({
      error: `Backend with ID "${id}" not found`,
    });
  }

  res.json(metrics);
});

export default router;

/**
 * ─── Admin API Routes ────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Administrative APIs are critical for ADCs, enabling operators to modify routing
 * behavior, change server weights, and review statuses dynamically without
 * restarting the gateway.
 *
 * DESIGN DECISIONS:
 * - Direct mapping of PUT/GET requests to the routing engine.
 * - Validation of inputs (e.g. valid algorithm name, positive weight).
 *
 * INTERVIEW QUESTIONS:
 * - How does runtime algorithm switching affect in-flight requests?
 *   (In-flight requests are not aborted; the new routing decision is applied
 *   only to subsequent requests arriving after the switch)
 * - How would you secure this admin API in production?
 *   (Restricting by source IP, using client SSL certificates, or placing it behind
 *   strict OAuth2/JWT middleware)
 */

import { Router } from 'express';
import routingEngine from '../routing/routingEngine.js';
import strategyFactory from '../routing/strategyFactory.js';
import connectionDrainManager from '../admin/connectionDrainManager.js';
import { HTTP_STATUS } from '../utils/constants.js';

const router = Router();

/**
 * GET /api/admin/algorithm
 * Returns the current algorithm and list of available algorithms.
 */
router.get('/algorithm', (req, res) => {
  res.json({
    currentAlgorithm: routingEngine.getCurrentAlgorithm(),
    availableAlgorithms: strategyFactory.getAvailableAlgorithms(),
  });
});

/**
 * PUT /api/admin/algorithm
 * Changes the active load balancing algorithm.
 */
router.put('/algorithm', (req, res) => {
  const { algorithm } = req.body;

  if (!algorithm) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Missing required field: "algorithm"',
    });
  }

  try {
    routingEngine.setAlgorithm(algorithm);
    res.json({
      message: `Load balancing algorithm successfully switched to ${algorithm}`,
      currentAlgorithm: routingEngine.getCurrentAlgorithm(),
    });
  } catch (error) {
    res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: error.message,
    });
  }
});

/**
 * GET /api/admin/backends
 * Returns detailed status of the backend pool (including weights and active connections).
 */
router.get('/backends', (req, res) => {
  res.json({
    backends: routingEngine.getPool(),
  });
});

/**
 * PUT /api/admin/backends/:id/weight
 * Dynamically changes the weight of a backend.
 */
router.put('/backends/:id/weight', (req, res) => {
  const { id } = req.params;
  const weight = parseInt(req.body.weight, 10);

  if (isNaN(weight) || weight < 0) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Weight must be a non-negative integer',
    });
  }

  const pool = routingEngine.getPool();
  const backend = pool.find((b) => b.id === id);

  if (!backend) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({
      error: `Backend with ID "${id}" not found`,
    });
  }

  backend.weight = weight;
  res.json({
    message: `Successfully updated weight of ${id} to ${weight}`,
    backend,
  });
});

/**
 * POST /api/admin/backends/:id/drain
 * Initiate connection draining (maintenance mode) for a backend.
 */
router.post('/backends/:id/drain', (req, res) => {
  const { id } = req.params;
  const timeoutSec = parseInt(req.body.timeoutSec || req.query.timeoutSec, 10) || 30;

  try {
    const result = connectionDrainManager.drainBackend(id, timeoutSec);
    res.json(result);
  } catch (error) {
    res.status(HTTP_STATUS.NOT_FOUND).json({
      error: error.message,
    });
  }
});

/**
 * POST /api/admin/backends/:id/undrain
 * Cancel connection drain and restore backend to HEALTHY status.
 */
router.post('/backends/:id/undrain', (req, res) => {
  const { id } = req.params;

  try {
    const result = connectionDrainManager.undrainBackend(id);
    res.json(result);
  } catch (error) {
    res.status(HTTP_STATUS.NOT_FOUND).json({
      error: error.message,
    });
  }
});

export default router;

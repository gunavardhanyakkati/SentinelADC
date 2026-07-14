/**
 * ─── Status API Routes ──────────────────────────────────────────────────────
 *
 * System-level status endpoints that provide a quick overview of the
 * gateway's health and configuration. These are the first endpoints
 * the dashboard will consume.
 */

import { Router } from 'express';
import routingEngine from '../routing/routingEngine.js';

const router = Router();

/**
 * GET /api/status
 * Returns the gateway's overall status and configuration summary.
 */
router.get('/status', (req, res) => {
  const pool = routingEngine.getPool();
  const healthy = routingEngine.getHealthyBackends();

  res.json({
    gateway: {
      name: 'SentinelADC',
      version: '1.0.0',
      status: healthy.length > 0 ? 'operational' : 'degraded',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    loadBalancing: {
      algorithm: routingEngine.getCurrentAlgorithm(),
    },
    backends: {
      total: pool.length,
      healthy: healthy.length,
      unhealthy: pool.length - healthy.length,
      pool: pool.map((b) => ({
        id: b.id,
        url: b.url,
        status: b.status,
        healthy: b.healthy,
        weight: b.weight,
      })),
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage(),
    },
  });
});

/**
 * GET /api/status/ping
 * Simple health check for the gateway itself (not backends).
 * Used by Docker HEALTHCHECK and external monitors.
 */
router.get('/status/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;

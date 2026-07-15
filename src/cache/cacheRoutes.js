/**
 * ─── Cache API Routes ────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Exposes cache metrics, database connection status, and cache management APIs
 * to the dashboard. Operators can flush the cache or invalidate specific records.
 */

import { Router } from 'express';
import cacheService from './cacheService.js';
import { HTTP_STATUS } from '../utils/constants.js';

const router = Router();

/**
 * GET /api/cache/stats
 * Returns active cache statistics, hit ratios, and latency averages.
 */
router.get('/stats', (req, res) => {
  res.json({
    stats: cacheService.getStats(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * DELETE /api/cache
 * Clears the entire Redis cache database.
 */
router.delete('/', async (req, res) => {
  if (!cacheService.isActive()) {
    return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      error: 'Cache service is currently offline or disabled',
    });
  }

  await cacheService.flushAll();
  res.json({
    message: 'Cache database flushed successfully',
  });
});

/**
 * DELETE /api/cache/invalidate
 * Invalidates keys matching a wildcard pattern.
 * Query param: ?pattern=sentinel:cache:/api*
 */
router.delete('/invalidate', async (req, res) => {
  const { pattern } = req.query;

  if (!pattern) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Missing required query parameter "pattern"',
    });
  }

  if (!cacheService.isActive()) {
    return res.status(HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      error: 'Cache service is currently offline or disabled',
    });
  }

  const purgedCount = await cacheService.invalidatePattern(pattern);
  res.json({
    message: `Successfully invalidated cache keys matching pattern: "${pattern}"`,
    purgedCount,
  });
});

export default router;

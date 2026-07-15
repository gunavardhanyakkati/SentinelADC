/**
 * ─── Analytics API Routes ────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Exposes real-time throughput, latency distributions, backend workload splits,
 * and historical timeline timelines to the administration dashboard.
 */

import { Router } from 'express';
import analyticsDb from './analyticsDb.js';
import { HTTP_STATUS } from '../utils/constants.js';

const router = Router();

/**
 * GET /api/analytics/realtime
 * Aggregates logs from the last 5 minutes to return real-time health indicators.
 */
router.get('/realtime', async (req, res) => {
  if (!analyticsDb.isActive()) {
    return res.json({
      dbConnected: false,
      summary: {
        throughputRps: 0,
        averageLatencyMs: 0,
        successRate: 100,
        cacheHitRatio: 0,
        totalRequests: 0,
      },
    });
  }

  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    let stats;

    if (analyticsDb.useMemoryFallback) {
      stats = analyticsDb.aggregateRealtime(fiveMinutesAgo);
    } else {
      const db = analyticsDb.db;
      stats = await db.collection('request_logs').aggregate([
        {
          $match: {
            timestamp: { $gte: fiveMinutesAgo },
          },
        },
        {
          $group: {
            _id: null,
            totalRequests: { $sum: 1 },
            totalLatency: { $sum: '$latencyMs' },
            successCount: { $sum: { $cond: [{ $lt: ['$statusCode', 400] }, 1, 0] } },
            cacheHitCount: { $sum: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] }, 1, 0] } },
          },
        },
      ]).toArray();
    }

    if (!stats || stats.length === 0) {
      return res.json({
        dbConnected: true,
        summary: {
          throughputRps: 0,
          averageLatencyMs: 0,
          successRate: 100,
          cacheHitRatio: 0,
          totalRequests: 0,
        },
      });
    }

    const data = stats[0];
    const throughputRps = data.totalRequests / (5 * 60); // requests per second over 5 minutes
    const averageLatencyMs = data.totalLatency / data.totalRequests;
    const successRate = (data.successCount / data.totalRequests) * 100;
    const cacheHitRatio = (data.cacheHitCount / data.totalRequests) * 100;

    res.json({
      dbConnected: true,
      summary: {
        throughputRps: Math.round(throughputRps * 100) / 100,
        averageLatencyMs: Math.round(averageLatencyMs * 100) / 100,
        successRate: Math.round(successRate * 100) / 100,
        cacheHitRatio: Math.round(cacheHitRatio * 100) / 100,
        totalRequests: data.totalRequests,
      },
    });
  } catch (err) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: `Failed to query realtime metrics: ${err.message}`,
    });
  }
});

/**
 * GET /api/analytics/historical
 * Retrieves rollup minute aggregates to render historical timeline charts (last 60 mins).
 */
router.get('/historical', async (req, res) => {
  if (!analyticsDb.isActive()) {
    return res.json({
      dbConnected: false,
      timeline: [],
    });
  }

  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    let timeline;

    if (analyticsDb.useMemoryFallback) {
      timeline = analyticsDb.memoryAggregates
        .filter(a => a.timeBucket >= oneHourAgo)
        .sort((a, b) => a.timeBucket - b.timeBucket);
    } else {
      const db = analyticsDb.db;
      timeline = await db.collection('analytics_aggregates')
        .find({ timeBucket: { $gte: oneHourAgo } })
        .sort({ timeBucket: 1 })
        .toArray();
    }

    res.json({
      dbConnected: true,
      timeline,
    });
  } catch (err) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: `Failed to query historical timeline: ${err.message}`,
    });
  }
});

/**
 * GET /api/analytics/backends
 * Returns transactional split statistics per backend server.
 */
router.get('/backends', async (req, res) => {
  if (!analyticsDb.isActive()) {
    return res.json({
      dbConnected: false,
      backends: [],
    });
  }

  try {
    const halfHourAgo = new Date(Date.now() - 30 * 60 * 1000);
    let backendsData;

    if (analyticsDb.useMemoryFallback) {
      backendsData = analyticsDb.aggregateBackends(halfHourAgo);
    } else {
      const db = analyticsDb.db;
      backendsData = await db.collection('request_logs').aggregate([
        {
          $match: {
            timestamp: { $gte: halfHourAgo },
            backendId: { $ne: null },
          },
        },
        {
          $group: {
            _id: '$backendId',
            backendUrl: { $first: '$backendUrl' },
            requestCount: { $sum: 1 },
            totalLatency: { $sum: '$latencyMs' },
            errorCount: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
            cacheHitCount: { $sum: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] }, 1, 0] } },
          },
        },
        {
          $project: {
            backendId: '$_id',
            backendUrl: 1,
            requestCount: 1,
            averageLatencyMs: { $round: [{ $divide: ['$totalLatency', '$requestCount'] }, 2] },
            errorCount: 1,
            cacheHitCount: 1,
          },
        },
      ]).toArray();
    }

    res.json({
      dbConnected: true,
      backends: backendsData,
    });
  } catch (err) {
    res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json({
      error: `Failed to query backend workload split: ${err.message}`,
    });
  }
});

export default router;

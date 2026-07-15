/**
 * ─── Analytics Aggregation Worker ──────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Raw transaction log collections grow rapidly. Running complex queries (like
 * averaging millions of response times) directly in response to dashboard requests
 * causes interface lag and database locks. This background worker periodically
 * condenses raw transactions into unified 1-minute aggregations.
 *
 * DESIGN DECISIONS:
 * - Uses MongoDB's `$group` aggregate pipeline for optimized server-side summing/averaging.
 * - Performs upserts using a rounded minute date key (`timeBucket`) so that multiple
 *   scans in the same minute update the current bucket instead of spawning duplicates.
 * - Safely handles empty windows (no requests in the last interval).
 *
 * INTERVIEW QUESTIONS:
 * - What is data rollup/aggregation? Why do we do it?
 *   (rollup summarizes high-cardinality raw logs into pre-computed hourly or daily
 *   tables. It speeds up timeline rendering and saves disk space via TTL purges)
 * - How would you scale an aggregation worker in a multi-instance gateway cluster?
 *   (Ensure only one instance runs the worker using locks like Redlock, or run
 *   it as a dedicated service, or offload it to streaming tools like Spark/Flink)
 */

import analyticsDb from './analyticsDb.js';
import { createChildLogger } from '../observability/logger.js';

const log = createChildLogger({ module: 'aggregation-worker' });

class AggregationWorker {
  constructor() {
    this.intervalId = null;
    this.running = false;
    this.intervalMs = 10000; // Run rollup every 10 seconds
  }

  /**
   * Start the background aggregation timer loop.
   */
  start() {
    if (this.intervalId) return;

    log.info(`Starting background analytics rollup worker. Interval: ${this.intervalMs}ms`);
    this.intervalId = setInterval(() => this.runRollup(), this.intervalMs);
  }

  /**
   * Stop the worker loop.
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      log.info('Aggregation worker stopped.');
    }
  }

  /**
   * Run the aggregation aggregation logic.
   */
  async runRollup() {
    if (!analyticsDb.isActive() || this.running) return;

    this.running = true;
    const now = new Date();
    // Round down to the nearest minute to align timeline data buckets
    const timeBucket = new Date(Math.floor(now.getTime() / 60000) * 60000);
    const windowStart = new Date(timeBucket.getTime());
    const windowEnd = new Date(timeBucket.getTime() + 60000);

    try {
      let results;

      if (analyticsDb.useMemoryFallback) {
        results = analyticsDb.aggregateLogs(windowStart, windowEnd);
      } else {
        const db = analyticsDb.db;
        results = await db.collection('request_logs').aggregate([
          {
            $match: {
              timestamp: {
                $gte: windowStart,
                $lt: windowEnd,
              },
            },
          },
          {
            $group: {
              _id: null,
              requestCount: { $sum: 1 },
              totalLatency: { $sum: '$latencyMs' },
              minLatency: { $min: '$latencyMs' },
              maxLatency: { $max: '$latencyMs' },
              successCount: { $sum: { $cond: [{ $lt: ['$statusCode', 400] }, 1, 0] } },
              errorCount: { $sum: { $cond: [{ $gte: ['$statusCode', 400] }, 1, 0] } },
              cacheHitCount: { $sum: { $cond: [{ $eq: ['$cacheStatus', 'HIT'] }, 1, 0] } },
              bytesTransferred: { $sum: '$payloadSizeBytes' },
            },
          },
        ]).toArray();
      }

      if (results.length > 0) {
        const stats = results[0];
        const averageLatency = stats.requestCount > 0 ? stats.totalLatency / stats.requestCount : 0;
        const errorRate = stats.requestCount > 0 ? (stats.errorCount / stats.requestCount) * 100 : 0;
        const cacheHitRatio = stats.requestCount > 0 ? (stats.cacheHitCount / stats.requestCount) * 100 : 0;

        const rollupDocument = {
          timeBucket,
          requestCount: stats.requestCount,
          averageLatencyMs: Math.round(averageLatency * 100) / 100,
          minLatencyMs: Math.round(stats.minLatency * 100) / 100,
          maxLatencyMs: Math.round(stats.maxLatency * 100) / 100,
          errorRate: Math.round(errorRate * 100) / 100,
          cacheHitRatio: Math.round(cacheHitRatio * 100) / 100,
          bytesTransferred: stats.bytesTransferred,
          updatedAt: new Date(),
        };

        if (analyticsDb.useMemoryFallback) {
          await analyticsDb.insertOne('analytics_aggregates', rollupDocument);
        } else {
          const db = analyticsDb.db;
          await db.collection('analytics_aggregates').replaceOne(
            { timeBucket },
            rollupDocument,
            { upsert: true }
          );
        }

        log.debug(`Saved rollup metrics for window ${timeBucket.toISOString()}. Requests: ${stats.requestCount}`);
      }
    } catch (err) {
      log.error(`Analytics aggregation aggregation query failed: ${err.message}`);
    } finally {
      this.running = false;
    }
  }
}

const aggregationWorker = new AggregationWorker();
export default aggregationWorker;

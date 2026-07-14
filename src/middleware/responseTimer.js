/**
 * ─── Response Timer Middleware ───────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Latency measurement is the foundation of observability. Every request's
 * processing time is recorded using high-resolution timers (nanosecond precision).
 * This data feeds into:
 * - Metrics collection (Milestone 4)
 * - Analytics (Milestone 7)
 * - Dashboard latency charts (Milestone 9)
 *
 * DESIGN DECISIONS:
 * - Uses process.hrtime.bigint() for nanosecond precision (not Date.now())
 * - Attaches timing to res.locals so downstream middleware can access it
 * - Sets a response header so clients can see gateway processing time
 */

import { elapsedMs } from '../utils/helpers.js';

/**
 * Middleware that measures total request processing time.
 * Attaches start time to res.locals and sets X-Response-Time header on finish.
 */
export default function responseTimer() {
  return (req, res, next) => {
    const startTime = process.hrtime.bigint();

    // Attach start time for other middleware to use
    res.locals.startTime = startTime;

    // When the response finishes, calculate elapsed time
    res.on('finish', () => {
      const duration = elapsedMs(startTime);
      res.locals.responseTime = duration;
    });

    // Set the header before the response is sent
    const originalEnd = res.end;
    res.end = function (...args) {
      const duration = elapsedMs(startTime);
      if (!res.headersSent) {
        res.setHeader('X-Response-Time', `${duration}ms`);
      }
      originalEnd.apply(res, args);
    };

    next();
  };
}

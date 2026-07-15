/**
 * ─── Rate Limiter ────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Rate limiting prevents Denial of Service (DoS) attacks, brute-force login attempts,
 * and origin resource exhaustion by capping the number of requests a single client
 * IP can make within a configured time window.
 *
 * DESIGN DECISIONS:
 * - Dual-Mode Operation: Uses Redis (incr + expire atomic operations) if active
 *   for distributed rate limiting, falling back to a clean sliding-window array
 *   in RAM if Redis is offline (fail-safe offline support).
 * - Appends standard rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`,
 *   `X-RateLimit-Reset`) to the HTTP response.
 *
 * INTERVIEW QUESTIONS:
 * - What is the difference between Token Bucket, Leaking Bucket, and Fixed Window Rate Limiting?
 *   (Fixed Window counts requests in set time buckets—easy but vulnerable to traffic spikes
 *   at bucket boundaries. Token Bucket allows burst capacity and shapes traffic more smoothly)
 * - How does distributed rate limiting differ from local rate limiting?
 *   (Local rate limiting only throttles traffic on a single node. Distributed rate limiting
 *   uses a shared store like Redis to sync request states across multiple gateway instances)
 * - What are the race conditions in fixed-window limiters, and how do we solve them?
 *   (If get-and-set operations are not atomic, concurrent requests might bypass the limit.
 *   Solved in Redis using atomic `INCR` + `EXPIRE` transactions or Lua scripts)
 */

import cacheService from '../cache/cacheService.js';
import config from '../config/index.js';
import { HTTP_STATUS } from '../utils/constants.js';
import { getClientIp } from '../utils/helpers.js';
import securityLogger from './securityLogger.js';

class RateLimiter {
  constructor() {
    this.inMemoryStore = new Map();
    // Periodically clean up memory store to prevent leaks
    setInterval(() => this.cleanupMemoryStore(), 300000); // Clean every 5 mins
  }

  /**
   * Remove expired timestamps from local map.
   */
  cleanupMemoryStore() {
    const now = Date.now();
    const windowMs = config.security.rateLimit.windowMs;

    for (const [ip, timestamps] of this.inMemoryStore.entries()) {
      const active = timestamps.filter(t => now - t < windowMs);
      if (active.length === 0) {
        this.inMemoryStore.delete(ip);
      } else {
        this.inMemoryStore.set(ip, active);
      }
    }
  }

  /**
   * Express middleware to enforce rate limits.
   */
  middleware() {
    return async (req, res, next) => {
      const clientIp = getClientIp(req);
      const windowMs = config.security.rateLimit.windowMs;
      const maxRequests = config.security.rateLimit.maxRequests;
      
      const key = `sentinel:limit:${clientIp}`;
      const now = Date.now();

      // ─── Case 1: Redis Rate Limiting (Distributed) ─────────────────────────
      if (cacheService.isActive()) {
        try {
          const redis = cacheService.client;
          
          // Increment request counter atomically
          const current = await redis.incr(key);
          
          if (current === 1) {
            // Set expiration on first request in window
            await redis.pexpire(key, windowMs);
          }

          const ttl = await redis.pttl(key);
          const remaining = Math.max(0, maxRequests - current);

          // Set standard RFC rate limiting headers
          res.setHeader('X-RateLimit-Limit', maxRequests);
          res.setHeader('X-RateLimit-Remaining', remaining);
          res.setHeader('X-RateLimit-Reset', new Date(now + ttl).toISOString());

          if (current > maxRequests) {
            securityLogger.logEvent('rate-limit', req, {
              reason: `Rate limit exceeded (Redis). Limit: ${maxRequests}, Actual: ${current}`,
            });

            return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
              error: {
                message: 'Too Many Requests — Rate limit exceeded. Please try again later.',
                statusCode: HTTP_STATUS.TOO_MANY_REQUESTS,
                limit: maxRequests,
                retryAfter: `${Math.ceil(ttl / 1000)}s`,
              },
              timestamp: new Date().toISOString(),
            });
          }

          return next();
        } catch (err) {
          // Fall back to memory limiting on Redis failure
          securityLogger.logEvent('rate-limit-fallback', req, {
            reason: `Redis rate limiting failed (${err.message}). Falling back to memory.`,
          });
        }
      }

      // ─── Case 2: Memory Rate Limiting (Local Fallback) ─────────────────────
      const timestamps = this.inMemoryStore.get(clientIp) || [];
      const active = timestamps.filter(t => now - t < windowMs);

      const current = active.length + 1;
      const remaining = Math.max(0, maxRequests - current);
      const resetTime = now + windowMs;

      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', remaining);
      res.setHeader('X-RateLimit-Reset', new Date(resetTime).toISOString());

      if (current > maxRequests) {
        securityLogger.logEvent('rate-limit', req, {
          reason: `Rate limit exceeded (In-Memory). Limit: ${maxRequests}, Actual: ${current}`,
        });

        return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          error: {
            message: 'Too Many Requests — Rate limit exceeded. Please try again later.',
            statusCode: HTTP_STATUS.TOO_MANY_REQUESTS,
            limit: maxRequests,
            retryAfter: `${Math.ceil(windowMs / 1000)}s`,
          },
          timestamp: new Date().toISOString(),
        });
      }

      active.push(now);
      this.inMemoryStore.set(clientIp, active);
      next();
    };
  }
}

const rateLimiter = new RateLimiter();
export default rateLimiter;

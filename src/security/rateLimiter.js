/**
 * ─── Rate Limiter (Token Bucket with Redis Lua Scripting) ────────────────────
 *
 * WHY THIS EXISTS:
 * Rate limiting prevents Denial of Service (DoS) attacks, brute-force login attempts,
 * and origin resource exhaustion by capping client IP request rates.
 *
 * ALGORITHM: TOKEN BUCKET
 * - Each client IP has a bucket with a maximum `capacity` (burst limit) and a
 *   continuous `refillRate` (tokens per millisecond = maxRequests / windowMs).
 * - On each request, tokens are refilled based on elapsed time:
 *     tokens = min(capacity, tokens + elapsed * refillRate)
 * - If tokens >= cost (default 1), 1 token is consumed and the request proceeds.
 * - If tokens < cost, the request is throttled (HTTP 429) with a precise `Retry-After`.
 *
 * DESIGN DECISIONS:
 * - Redis Lua Script (`EVAL`): Executes token calculation and consumption atomically
 *   in single-threaded Redis, eliminating Time-of-Check to Time-of-Use (TOCTOU)
 *   race conditions without distributed locks.
 * - In-Memory Fallback: If Redis is offline, operates an in-memory JS Map implementing
 *   the identical Token Bucket algorithm (fail-safe operation).
 *
 * INTERVIEW QUESTIONS:
 * - Why Token Bucket over Fixed Window Rate Limiting?
 *   (Fixed window suffers from boundary burst vulnerability—e.g. 100 requests at 00:59
 *   and 100 requests at 01:00 = 200 requests in 2 seconds. Token Bucket smooths traffic
 *   refills continuously while permitting controlled burst capacity up to `capacity`).
 * - Why use a Redis Lua Script?
 *   (Lua scripts execute atomically inside Redis. Reading token count, calculating refill,
 *   updating tokens, and setting EXPIRE happens in a single atomic step, avoiding race conditions).
 * - How do you prevent stale key accumulation in Redis/RAM?
 *   (Redis keys auto-expire via EXPIRE after TTL = capacity/refillRate. Memory store periodically
 *   evicts inactive buckets).
 */

import cacheService from '../cache/cacheService.js';
import config from '../config/index.js';
import { HTTP_STATUS } from '../utils/constants.js';
import { getClientIp } from '../utils/helpers.js';
import securityLogger from './securityLogger.js';

// Lua script for atomic Token Bucket evaluation in Redis
const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])

if not tokens or not lastRefill then
  tokens = capacity
  lastRefill = now
else
  local elapsed = math.max(0, now - lastRefill)
  tokens = math.min(capacity, tokens + (elapsed * refillRate))
  lastRefill = now
end

local allowed = 0
local retryAfterMs = 0

if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
else
  allowed = 0
  retryAfterMs = math.ceil((cost - tokens) / refillRate)
end

local ttlSeconds = math.ceil(capacity / (refillRate * 1000)) + 60
redis.call('HMSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
redis.call('EXPIRE', key, ttlSeconds)

return { allowed, math.floor(tokens), retryAfterMs }
`;

class RateLimiter {
  constructor() {
    // Map: IP -> { tokens, lastRefill } for in-memory fallback
    this.memoryBuckets = new Map();
    this.penalizedIps = new Map(); // IP -> { maxRequests, expiresAt, reason }

    // Periodically clean up stale memory buckets
    setInterval(() => this.cleanupMemoryStore(), 300000);
  }

  /**
   * Apply an auto-enforced rate limit penalty to an IP.
   */
  applyPenalty(ip, maxRequests = 10, durationMs = 300000, reason = 'statistical-anomaly') {
    this.penalizedIps.set(ip, {
      maxRequests,
      expiresAt: Date.now() + durationMs,
      reason,
    });
  }

  /**
   * Remove rate limit penalty for an IP.
   */
  removePenalty(ip) {
    return this.penalizedIps.delete(ip);
  }

  /**
   * Remove expired memory buckets and penalties.
   */
  cleanupMemoryStore() {
    const now = Date.now();
    for (const [ip, bucket] of this.memoryBuckets.entries()) {
      if (now - bucket.lastRefill > 300000) {
        this.memoryBuckets.delete(ip);
      }
    }

    for (const [ip, item] of this.penalizedIps.entries()) {
      if (now > item.expiresAt) {
        this.penalizedIps.delete(ip);
      }
    }
  }

  /**
   * Evaluate Token Bucket in-memory (local fallback).
   */
  evalTokenBucketMemory(ip, capacity, refillRate, now, cost = 1) {
    let bucket = this.memoryBuckets.get(ip);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      this.memoryBuckets.set(ip, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.lastRefill);
      bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed * refillRate));
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs: 0,
      };
    } else {
      const missingTokens = cost - bucket.tokens;
      const retryAfterMs = Math.ceil(missingTokens / refillRate);
      return {
        allowed: false,
        remaining: Math.floor(bucket.tokens),
        retryAfterMs,
      };
    }
  }

  /**
   * Evaluate Token Bucket in Redis via atomic Lua script.
   */
  async evalTokenBucketRedis(ip, capacity, refillRate, now, cost = 1) {
    const key = `sentinel:tokenbucket:${ip}`;
    const redis = cacheService.client;

    const res = await redis.eval(
      TOKEN_BUCKET_LUA,
      1,
      key,
      capacity,
      refillRate,
      now,
      cost
    );

    const [allowed, remaining, retryAfterMs] = res;
    return {
      allowed: Boolean(allowed),
      remaining: Number(remaining),
      retryAfterMs: Number(retryAfterMs),
    };
  }

  /**
   * Express middleware to enforce Token Bucket rate limiting.
   */
  middleware() {
    return async (req, res, next) => {
      const clientIp = getClientIp(req);
      const windowMs = config.security.rateLimit.windowMs;
      
      let capacity = config.security.rateLimit.maxRequests;
      const penalized = this.penalizedIps.get(clientIp);
      if (penalized) {
        if (Date.now() < penalized.expiresAt) {
          capacity = penalized.maxRequests;
        } else {
          this.penalizedIps.delete(clientIp);
        }
      }

      const refillRate = capacity / windowMs; // Tokens per millisecond
      const now = Date.now();

      let result;

      // Case 1: Redis Distributed Token Bucket
      if (cacheService.isActive() && cacheService.client) {
        try {
          result = await this.evalTokenBucketRedis(clientIp, capacity, refillRate, now, 1);
        } catch (err) {
          securityLogger.logEvent('rate-limit-fallback', req, {
            reason: `Redis Token Bucket failed (${err.message}). Falling back to memory.`,
          });
          result = this.evalTokenBucketMemory(clientIp, capacity, refillRate, now, 1);
        }
      } else {
        // Case 2: In-Memory Token Bucket Fallback
        result = this.evalTokenBucketMemory(clientIp, capacity, refillRate, now, 1);
      }

      const resetTimestamp = new Date(now + Math.ceil((capacity - result.remaining) / refillRate)).toISOString();

      res.setHeader('X-RateLimit-Limit', capacity);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      res.setHeader('X-RateLimit-Reset', resetTimestamp);

      if (!result.allowed) {
        const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        res.setHeader('Retry-After', retryAfterSec);

        securityLogger.logEvent('rate-limit', req, {
          reason: `Token Bucket rate limit exceeded for IP ${clientIp}. Capacity: ${capacity}, Remaining: ${result.remaining}`,
        });

        return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json({
          error: {
            message: 'Too Many Requests — Rate limit bucket exhausted. Please try again later.',
            statusCode: HTTP_STATUS.TOO_MANY_REQUESTS,
            limit: capacity,
            remaining: result.remaining,
            retryAfter: `${retryAfterSec}s`,
          },
          timestamp: new Date().toISOString(),
        });
      }

      next();
    };
  }
}

const rateLimiter = new RateLimiter();
export default rateLimiter;

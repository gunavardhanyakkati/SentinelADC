/**
 * ─── Cache Service (Redis) ───────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * High-speed caching is one of the primary roles of an Application Delivery
 * Controller. Offloading static or repetitive GET queries to an in-memory cache
 * like Redis dramatically lowers backend server CPU load, decreases client
 * response times (sub-millisecond latency), and increases total gateway throughput.
 *
 * DESIGN DECISIONS:
 * - Uses `ioredis` to manage the TCP socket connection to the Redis server.
 * - Fails open: if Redis is offline, the gateway logs the error and gracefully
 *   bypasses cache lookup, forwarding queries to backends directly (no client disruption).
 * - Tracks hit/miss counts and cache-serving latencies in memory to display
 *   real-time Hit Ratios and latency savings on the dashboard.
 * - Stores structured objects containing status codes, headers (like Content-Type),
 *   and stringified body payloads to reconstruct exact downstream responses.
 *
 * INTERVIEW QUESTIONS:
 * - What does it mean for a cache to "fail open"? Why is this preferred in gateways?
 *   (It means if the cache layer fails, traffic flows through directly to the origin.
 *   This prevents cache service failures from causing overall system outages)
 * - How do you handle cache invalidation at scale?
 *   (Through short TTLs, explicit purging APIs, tag-based purging, or pub/sub eviction notifications)
 * - What is a Cache Stampede and how do you prevent it?
 *   (When a popular cache key expires and multiple concurrent requests try to fetch
 *   and cache it simultaneously, overloading backends. Prevented via locking or background refresh)
 */

import Redis from 'ioredis';
import config from '../config/index.js';
import { createChildLogger } from '../observability/logger.js';

const log = createChildLogger({ module: 'cache' });

class CacheService {
  constructor() {
    this.enabled = config.cache.enabled;
    this.client = null;
    this.useMemoryFallback = false;
    this.memoryCache = new Map(); // In-memory fallback map
    
    // In-memory real-time metrics
    this.stats = {
      hits: 0,
      misses: 0,
      totalHitLatency: 0, // Accumulator for avg latency calculations
      totalMissLatency: 0,
      totalBypasses: 0,
    };

    if (this.enabled) {
      this.connect();
    }
  }

  /**
   * Connect to the Redis instance.
   */
  connect() {
    try {
      this.client = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        // Reconnect settings
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) {
            log.warn('Redis connection failed. Falling back to in-memory cache.');
            this.useMemoryFallback = true;
            return null;
          }
          return Math.min(times * 100, 2000);
        },
      });

      this.client.on('connect', () => {
        this.useMemoryFallback = false;
        log.info(`Successfully connected to Redis at ${config.redis.host}:${config.redis.port}`);
      });

      this.client.on('error', (err) => {
        log.error(`Redis socket error: ${err.message}. Ensuring in-memory fallback is active.`);
        this.useMemoryFallback = true;
      });
    } catch (err) {
      log.error(`Failed to initialize Redis client: ${err.message}. Falling back to in-memory cache.`);
      this.useMemoryFallback = true;
    }
  }

  /**
   * Check if cache is active and operational.
   */
  isActive() {
    return this.enabled && (this.useMemoryFallback || (this.client && this.client.status === 'ready'));
  }

  /**
   * Retrieve a cached response.
   * @param {string} key
   * @returns {Promise<Object|null>}
   */
  async get(key) {
    if (!this.isActive()) return null;

    if (this.useMemoryFallback) {
      const record = this.memoryCache.get(key);
      if (!record) return null;
      if (Date.now() > record.expiresAt) {
        this.memoryCache.delete(key);
        return null;
      }
      return record.value;
    }

    try {
      const data = await this.client.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (err) {
      log.error(`Cache get error for key "${key}": ${err.message}`);
      return null;
    }
  }

  /**
   * Store a response in the cache.
   * @param {string} key
   * @param {Object} value - { status, headers, body }
   * @param {number} ttl - TTL in seconds
   */
  async set(key, value, ttl = config.cache.ttl) {
    if (!this.isActive()) return;

    if (this.useMemoryFallback) {
      this.memoryCache.set(key, {
        value,
        expiresAt: Date.now() + (ttl * 1000),
      });
      log.debug(`[In-Memory Cache] Cached payload stored. Key: "${key}", TTL: ${ttl}s`);
      return;
    }

    try {
      const stringified = JSON.stringify(value);
      await this.client.set(key, stringified, 'EX', ttl);
      log.debug(`Cached payload stored. Key: "${key}", TTL: ${ttl}s`);
    } catch (err) {
      log.error(`Cache set error for key "${key}": ${err.message}`);
    }
  }

  /**
   * Delete a specific cache key.
   * @param {string} key
   */
  async delete(key) {
    if (!this.isActive()) return;

    if (this.useMemoryFallback) {
      const exists = this.memoryCache.delete(key);
      if (exists) log.info(`[In-Memory Cache] Key explicitly invalidated: "${key}"`);
      return;
    }

    try {
      await this.client.del(key);
      log.info(`Cache key explicitly invalidated: "${key}"`);
    } catch (err) {
      log.error(`Cache delete error for key "${key}": ${err.message}`);
    }
  }

  /**
   * Purge cache keys matching a pattern.
   * @param {string} pattern - e.g., "sentinel:*"
   */
  async invalidatePattern(pattern) {
    if (!this.isActive()) return 0;

    if (this.useMemoryFallback) {
      // Simple wildcard converter: sentinel:* -> sentinel:.*
      const regexStr = '^' + pattern.replace(/\*/g, '.*') + '$';
      const regex = new RegExp(regexStr);
      let count = 0;
      for (const key of this.memoryCache.keys()) {
        if (regex.test(key)) {
          this.memoryCache.delete(key);
          count++;
        }
      }
      log.info(`[In-Memory Cache] Purged ${count} keys matching pattern: "${pattern}"`);
      return count;
    }

    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(...keys);
        log.info(`Purged ${keys.length} keys matching pattern: "${pattern}"`);
      }
      return keys.length;
    } catch (err) {
      log.error(`Cache pattern invalidation error for "${pattern}": ${err.message}`);
      return 0;
    }
  }

  /**
   * Purge all keys in the database.
   */
  async flushAll() {
    if (!this.isActive()) return;

    if (this.useMemoryFallback) {
      this.memoryCache.clear();
      log.info('[In-Memory Cache] Cache database flushed completely.');
      return;
    }

    try {
      await this.client.flushdb();
      log.info('Cache database flushed completely.');
    } catch (err) {
      log.error(`Cache flushdb error: ${err.message}`);
    }
  }

  /**
   * Increment hits and record serving latency.
   */
  recordHit(latency) {
    this.stats.hits++;
    this.stats.totalHitLatency += latency;
  }

  /**
   * Increment misses and record lookup latency.
   */
  recordMiss(latency) {
    this.stats.misses++;
    this.stats.totalMissLatency += latency;
  }

  /**
   * Increment bypass counts.
   */
  recordBypass() {
    this.stats.totalBypasses++;
  }

  /**
   * Calculate hit rates and latency saving statistics.
   */
  getStats() {
    const totalRequests = this.stats.hits + this.stats.misses;
    const hitRatio = totalRequests > 0 
      ? Math.round((this.stats.hits / totalRequests) * 10000) / 100 
      : 0;

    const averageCacheLatency = this.stats.hits > 0
      ? Math.round((this.stats.totalHitLatency / this.stats.hits) * 100) / 100
      : 0;

    const averageBackendLatency = this.stats.misses > 0
      ? Math.round((this.stats.totalMissLatency / this.stats.misses) * 100) / 100
      : 0;

    return {
      enabled: this.enabled,
      status: this.client ? this.client.status : 'disconnected',
      hits: this.stats.hits,
      misses: this.stats.misses,
      totalRequests,
      bypasses: this.stats.totalBypasses,
      hitRatio,
      averageCacheLatencyMs: averageCacheLatency,
      averageBackendLatencyMs: averageBackendLatency,
    };
  }
}

const cacheService = new CacheService();
export default cacheService;

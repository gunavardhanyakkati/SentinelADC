/**
 * ─── Cache Middleware ────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Intercepts HTTP GET requests. If a matching cached response exists in Redis,
 * it returns it immediately, bypassing routing and proxying. If not, it lets
 * the request flow to the backend, intercepts the streaming response, buffers
 * the payload, and saves it in Redis for subsequent requests.
 *
 * DESIGN DECISIONS:
 * - Intercepts the response by overriding Node.js standard `res.write` and `res.end`
 *   calls. This handles both local Express responses and proxied streams.
 * - Cache Key format: `sentinel:cache:<originalUrl>` to keep namespaces clear.
 * - Only caches successful HTTP 200 GET requests.
 * - Respects client cache-control requests (e.g., `Cache-Control: no-cache`).
 *
 * INTERVIEW QUESTIONS:
 * - How do you intercept and buffer a proxied stream in Express?
 *   (By wrapping/monkey-patching the standard res.write and res.end methods to collect
 *   chunks in memory before calling the original implementations)
 * - What headers must be cached alongside the body?
 *   (Content-Type is critical so the client browser knows how to parse it—others
 *   like Content-Length, Content-Encoding, and custom headers are also useful)
 * - Why do we skip caching for non-GET requests?
 *   (POST, PUT, DELETE mutate state on the server, so caching them would lead
 *   to stale states and violations of HTTP method semantics)
 */

import cacheService from './cacheService.js';
import { elapsedMs } from '../utils/helpers.js';
import { CACHE_HEADERS, SENTINEL_HEADERS } from '../utils/constants.js';
import { createChildLogger } from '../observability/logger.js';

const log = createChildLogger({ module: 'cache-mw' });

/**
 * Express middleware to manage GET request caching.
 */
export default function cacheMiddleware() {
  return async (req, res, next) => {
    // 1. Check if request is cacheable
    const isGet = req.method === 'GET';
    const isApi = req.originalUrl.startsWith('/api');
    const hasNoCacheHeader = req.headers['cache-control'] === 'no-cache' || req.headers['pragma'] === 'no-cache';

    if (!cacheService.isActive() || !isGet || isApi || hasNoCacheHeader) {
      cacheService.recordBypass();
      res.setHeader(SENTINEL_HEADERS.CACHE_STATUS, CACHE_HEADERS.BYPASS);
      return next();
    }

    const cacheKey = `sentinel:cache:${req.originalUrl}`;
    const startTime = process.hrtime.bigint();

    try {
      // 2. Attempt cache lookup
      const cached = await cacheService.get(cacheKey);

      if (cached) {
        // Cache Hit!
        const latency = elapsedMs(startTime);
        cacheService.recordHit(latency);

        // Apply cached headers
        if (cached.headers) {
          Object.entries(cached.headers).forEach(([name, value]) => {
            // Skip proxy hop headers
            if (name.toLowerCase() !== 'connection' && name.toLowerCase() !== 'content-length') {
              res.setHeader(name, value);
            }
          });
        }

        res.setHeader(SENTINEL_HEADERS.CACHE_STATUS, CACHE_HEADERS.HIT);
        res.setHeader('X-Cache-Latency', `${latency}ms`);
        res.status(cached.status || 200);
        return res.send(cached.body);
      }

      // Cache Miss!
      res.setHeader(SENTINEL_HEADERS.CACHE_STATUS, CACHE_HEADERS.MISS);

      // Overwrite write and end to intercept the response stream
      const originalWrite = res.write;
      const originalEnd = res.end;
      const chunks = [];

      res.write = function (chunk, encoding, callback) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
        }
        if (typeof encoding === 'function') {
          return originalWrite.call(res, chunk, encoding);
        }
        return originalWrite.call(res, chunk, encoding, callback);
      };

      res.end = function (chunk, encoding, callback) {
        if (chunk) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined));
        }

        const responseBody = Buffer.concat(chunks).toString('utf8');
        log.info(`[Cache Interceptor] res.end called. CacheKey: "${cacheKey}", Chunks: ${chunks.length}, Body length: ${responseBody.length}`);

        // Only cache successful 200 OK responses
        if (res.statusCode === 200) {
          const headersToCache = { ...res.getHeaders() };
          
          // Don't cache transient status headers
          delete headersToCache[SENTINEL_HEADERS.CACHE_STATUS.toLowerCase()];
          
          cacheService.set(cacheKey, {
            status: res.statusCode,
            headers: headersToCache,
            body: responseBody,
          });
          log.info(`[Cache Interceptor] Saved response to cache: ${cacheKey}`);
        }

        const latency = elapsedMs(startTime);
        cacheService.recordMiss(latency);

        // Safely invoke original end with correct arguments
        if (typeof encoding === 'function') {
          return originalEnd.call(res, chunk, encoding);
        }
        return originalEnd.call(res, chunk, encoding, callback);
      };

      next();
    } catch (err) {
      // Fail open: fallback to backend on caching errors
      cacheService.recordBypass();
      res.setHeader(SENTINEL_HEADERS.CACHE_STATUS, CACHE_HEADERS.BYPASS);
      next();
    }
  };
}

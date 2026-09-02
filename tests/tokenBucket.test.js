import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import rateLimiter from '../src/security/rateLimiter.js';

describe('Token Bucket Rate Limiter (Redis + In-Memory Fallback)', () => {
  beforeEach(() => {
    rateLimiter.memoryBuckets.clear();
    rateLimiter.penalizedIps.clear();
  });

  it('should initialize bucket with maximum capacity and allow requests within limit', () => {
    const ip = '192.168.1.50';
    const capacity = 5;
    const refillRate = 5 / 60000; // 5 tokens per 60 seconds
    const now = Date.now();

    // First request consumes 1 token from 5 -> 4 remaining
    const res1 = rateLimiter.evalTokenBucketMemory(ip, capacity, refillRate, now, 1);
    assert.strictEqual(res1.allowed, true);
    assert.strictEqual(res1.remaining, 4);

    // Consume remaining 4 tokens
    for (let i = 0; i < 4; i++) {
      const res = rateLimiter.evalTokenBucketMemory(ip, capacity, refillRate, now, 1);
      assert.strictEqual(res.allowed, true);
    }

    // 6th request when bucket is empty (0 tokens) -> disallowed with retryAfter
    const res6 = rateLimiter.evalTokenBucketMemory(ip, capacity, refillRate, now, 1);
    assert.strictEqual(res6.allowed, false);
    assert.strictEqual(res6.remaining, 0);
    assert.ok(res6.retryAfterMs > 0, 'Should return positive retryAfterMs when empty');
  });

  it('should refill tokens continuously over time elapsed', () => {
    const ip = '10.0.0.1';
    const capacity = 2;
    const windowMs = 1000; // 2 tokens per 1 second = 0.002 tokens/ms
    const refillRate = capacity / windowMs;
    let now = Date.now();

    // Exhaust capacity (2 tokens)
    rateLimiter.evalTokenBucketMemory(ip, capacity, refillRate, now, 1);
    rateLimiter.evalTokenBucketMemory(ip, capacity, refillRate, now, 1);

    const emptyRes = rateLimiter.evalTokenBucketMemory(ip, capacity, refillRate, now, 1);
    assert.strictEqual(emptyRes.allowed, false);

    // Advance time by 500ms (refills 1 token)
    now += 500;
    const refilledRes = rateLimiter.evalTokenBucketMemory(ip, capacity, refillRate, now, 1);
    assert.strictEqual(refilledRes.allowed, true);
    assert.strictEqual(refilledRes.remaining, 0); // Consumed the 1 refilled token
  });

  it('should enforce statistical anomaly penalties by tightening capacity', async () => {
    const ip = '172.16.0.5';
    rateLimiter.applyPenalty(ip, 2, 60000, 'test-anomaly');

    const middleware = rateLimiter.middleware();
    const req = { headers: { 'x-forwarded-for': ip }, socket: {} };
    
    let statusCode = null;
    let headers = {};
    let jsonBody = null;

    const res = {
      setHeader: (k, v) => { headers[k] = v; },
      status: (code) => {
        statusCode = code;
        return { json: (body) => { jsonBody = body; } };
      },
    };

    let nextCalled = false;
    const next = () => { nextCalled = true; };

    // Request 1: Allowed (Capacity 2)
    await middleware(req, res, next);
    assert.strictEqual(nextCalled, true);
    assert.strictEqual(headers['X-RateLimit-Limit'], 2);

    // Request 2: Allowed
    nextCalled = false;
    await middleware(req, res, next);
    assert.strictEqual(nextCalled, true);

    // Request 3: Throttled HTTP 429
    nextCalled = false;
    await middleware(req, res, next);
    assert.strictEqual(nextCalled, false);
    assert.strictEqual(statusCode, 429);
    assert.ok(headers['Retry-After']);
    assert.strictEqual(jsonBody.error.statusCode, 429);
  });
});

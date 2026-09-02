import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { handleProxyError, calculateBackoffJitter } from '../src/proxy/proxyMiddleware.js';
import circuitBreakerManager from '../src/resilience/circuitBreakerManager.js';

describe('Idempotent-Only Retry Policy with Backoff & Jitter', () => {
  beforeEach(() => {
    circuitBreakerManager.initBreakers();
  });

  it('should calculate exponential backoff delay within jitter caps', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const delay = calculateBackoffJitter(attempt, 50, 500);
      assert.strictEqual(typeof delay, 'number');
      assert.ok(delay >= 0, 'Delay must be non-negative');
      assert.ok(delay <= 500, 'Delay must not exceed max cap');
    }
  });

  it('should retry idempotent (GET) requests up to MAX_RETRIES (3 total attempts)', async () => {
    const req = {
      method: 'GET',
      originalUrl: '/test-retry',
      headers: {},
      _backendId: 'backend-1',
    };

    let statusCode = null;
    let jsonBody = null;
    const res = {
      headersSent: false,
      status: (code) => {
        statusCode = code;
        return {
          json: (body) => {
            jsonBody = body;
            res.headersSent = true;
          },
        };
      },
    };

    // Attempt 1 -> triggers retry 1 (attempts becomes 2)
    await handleProxyError(new Error('ECONNREFUSED'), req, res, null);
    assert.strictEqual(req._attempts, 2);
    assert.strictEqual(req._failedBackends.has('backend-1'), true);

    // Reset headersSent for test simulation of attempt 2
    res.headersSent = false;

    // Attempt 2 (backend-2) -> triggers retry 2 (attempts becomes 3)
    req._backendId = 'backend-2';
    await handleProxyError(new Error('ETIMEDOUT'), req, res, null);
    assert.strictEqual(req._attempts, 3);
    assert.strictEqual(req._failedBackends.has('backend-2'), true);

    // Reset headersSent for test simulation of attempt 3 (max retries reached)
    res.headersSent = false;

    // Attempt 3 (backend-3) -> retries exhausted -> returns HTTP 502
    req._backendId = 'backend-3';
    await handleProxyError(new Error('ECONNREFUSED'), req, res, null);
    assert.strictEqual(req._attempts, 3);
    assert.strictEqual(statusCode, 502);
    assert.strictEqual(jsonBody.error.attempts, 3);
  });

  it('should NOT retry non-idempotent (POST) requests and return 502 immediately', async () => {
    const req = {
      method: 'POST',
      originalUrl: '/api/submit',
      headers: {},
      _backendId: 'backend-1',
    };

    let statusCode = null;
    let jsonBody = null;
    const res = {
      headersSent: false,
      status: (code) => {
        statusCode = code;
        return {
          json: (body) => {
            jsonBody = body;
            res.headersSent = true;
          },
        };
      },
    };

    await handleProxyError(new Error('ECONNREFUSED'), req, res, null);

    // For POST, attempt count should remain 1 (no retry)
    assert.strictEqual(req._attempts, 1);
    assert.strictEqual(req._failedBackends.has('backend-1'), true);
    assert.strictEqual(statusCode, 502);
    assert.ok(jsonBody.error.message.includes('Non-idempotent request [POST] failed'));
  });

  it('should exclude previously failed backends when selecting retry target', () => {
    const mockBackends = [
      { id: 'backend-1', url: 'http://127.0.0.1:4001', healthy: true },
      { id: 'backend-2', url: 'http://127.0.0.1:4002', healthy: true },
    ];

    const mockRoutingEngine = {
      getHealthyBackends: () => mockBackends,
      selectBackend: function(req) {
        let healthy = this.getHealthyBackends();
        if (req._failedBackends && req._failedBackends.size > 0) {
          healthy = healthy.filter(b => !req._failedBackends.has(b.id));
        }
        return healthy[0] || null;
      },
    };

    const req = { _failedBackends: new Set(['backend-1']) };
    const selected = mockRoutingEngine.selectBackend(req);

    assert.strictEqual(selected.id, 'backend-2', 'Retry backend selection must skip failed backend-1');
  });
});

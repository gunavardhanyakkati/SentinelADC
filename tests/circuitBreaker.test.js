import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import circuitBreakerManager, { CIRCUIT_STATE } from '../src/resilience/circuitBreakerManager.js';
import routingEngine from '../src/routing/routingEngine.js';
import backendPool from '../src/config/backends.js';

describe('Phase 3: Upstream Circuit Breaker Pattern', () => {
  beforeEach(() => {
    // Reset all breakers and backend health before each test
    backendPool.forEach(b => { b.healthy = true; });
    circuitBreakerManager.initBreakers();
  });

  it('should initialize breakers in CLOSED state for all backend nodes', () => {
    const states = circuitBreakerManager.getAllStates();
    assert.ok(states.length >= 3, 'Should track at least 3 backends');
    states.forEach(b => {
      assert.strictEqual(b.state, CIRCUIT_STATE.CLOSED);
      assert.strictEqual(b.consecutiveFailures, 0);
    });
  });

  it('should trip to OPEN after 5 consecutive failures and exclude backend from LB pool', () => {
    const targetId = 'backend-1';
    
    // Simulate 4 failures — should remain CLOSED
    for (let i = 0; i < 4; i++) {
      circuitBreakerManager.recordFailure(targetId, 'HTTP 500');
    }
    let breaker = circuitBreakerManager.getBreaker(targetId);
    assert.strictEqual(breaker.state, CIRCUIT_STATE.CLOSED);
    assert.strictEqual(breaker.consecutiveFailures, 4);

    // 5th failure — should trip to OPEN
    circuitBreakerManager.recordFailure(targetId, 'HTTP 500');
    breaker = circuitBreakerManager.getBreaker(targetId);
    assert.strictEqual(breaker.state, CIRCUIT_STATE.OPEN);

    // Verify backend is removed from load balancer healthy pool
    const healthyBackends = routingEngine.getHealthyBackends();
    assert.ok(!healthyBackends.some(b => b.id === targetId), 'OPEN backend must be excluded from routing engine healthy pool');
  });

  it('should transition to HALF_OPEN after cooldown and allow 1 trial probe request', () => {
    const targetId = 'backend-2';

    // Trip breaker to OPEN
    for (let i = 0; i < 5; i++) {
      circuitBreakerManager.recordFailure(targetId, 'ECONNREFUSED');
    }
    const breaker = circuitBreakerManager.getBreaker(targetId);
    assert.strictEqual(breaker.state, CIRCUIT_STATE.OPEN);

    // Fast fail check during cooldown window
    assert.strictEqual(circuitBreakerManager.canExecute(targetId), false);

    // Advance lastStateChange past 15s cooldown
    breaker.lastStateChange -= 15001;

    // First call post-cooldown should transition to HALF_OPEN and return true for 1 trial probe
    const allowed = circuitBreakerManager.canExecute(targetId);
    assert.strictEqual(allowed, true, 'HALF_OPEN state must permit 1 trial probe request');
    assert.strictEqual(breaker.state, CIRCUIT_STATE.HALF_OPEN);

    // Subsequent calls while HALF_OPEN probe is in-flight should return false
    assert.strictEqual(circuitBreakerManager.canExecute(targetId), false);
  });

  it('should restore backend to CLOSED and re-add to LB pool upon successful trial probe', () => {
    const targetId = 'backend-3';

    // Trip to OPEN, then advance to HALF_OPEN
    for (let i = 0; i < 5; i++) {
      circuitBreakerManager.recordFailure(targetId, 'HTTP 503');
    }
    const breaker = circuitBreakerManager.getBreaker(targetId);
    breaker.lastStateChange -= 15001;
    circuitBreakerManager.canExecute(targetId);
    assert.strictEqual(breaker.state, CIRCUIT_STATE.HALF_OPEN);

    // Simulate successful probe response
    circuitBreakerManager.recordSuccess(targetId);

    assert.strictEqual(breaker.state, CIRCUIT_STATE.CLOSED);
    assert.strictEqual(breaker.consecutiveFailures, 0);

    // Verify backend is restored to load balancer healthy pool
    const healthyBackends = routingEngine.getHealthyBackends();
    assert.ok(healthyBackends.some(b => b.id === targetId), 'Restored CLOSED backend must be included in LB healthy pool');
  });

  it('should support manual admin reset', () => {
    const targetId = 'backend-1';

    for (let i = 0; i < 5; i++) {
      circuitBreakerManager.recordFailure(targetId, 'HTTP 502');
    }
    assert.strictEqual(circuitBreakerManager.getBreaker(targetId).state, CIRCUIT_STATE.OPEN);

    circuitBreakerManager.reset(targetId);

    const breaker = circuitBreakerManager.getBreaker(targetId);
    assert.strictEqual(breaker.state, CIRCUIT_STATE.CLOSED);
    assert.strictEqual(breaker.consecutiveFailures, 0);
  });
});

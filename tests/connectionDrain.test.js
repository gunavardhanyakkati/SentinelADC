import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import connectionDrainManager from '../src/admin/connectionDrainManager.js';
import routingEngine from '../src/routing/routingEngine.js';
import backendPool from '../src/config/backends.js';

describe('Phase 4: Graceful Connection Draining (Maintenance Mode)', () => {
  beforeEach(() => {
    backendPool.forEach(b => {
      b.healthy = true;
      b.status = 'healthy';
      b.activeConnections = 0;
      delete b.onDrainComplete;
      delete b.drainStartTime;
    });
  });

  it('should mark backend as DRAINING and remove it from new LB requests', () => {
    const targetId = 'backend-1';
    const backend = backendPool.find(b => b.id === targetId);
    backend.activeConnections = 3; // 3 in-flight requests

    const res = connectionDrainManager.drainBackend(targetId, 10);
    assert.strictEqual(backend.status, 'draining');
    assert.strictEqual(backend.healthy, false);

    // Verify routingEngine excludes draining backend from healthy rotation
    const healthy = routingEngine.getHealthyBackends();
    assert.ok(!healthy.some(b => b.id === targetId), 'Draining backend must be excluded from healthy LB pool');
  });

  it('should auto-transition status to OFFLINE when active connections drop to 0', () => {
    const targetId = 'backend-2';
    const backend = backendPool.find(b => b.id === targetId);
    backend.activeConnections = 2;

    connectionDrainManager.drainBackend(targetId, 10);
    assert.strictEqual(backend.status, 'draining');

    // Simulate in-flight requests completing
    backend.activeConnections = 1;
    if (backend.onDrainComplete && backend.activeConnections === 0) backend.onDrainComplete();
    assert.strictEqual(backend.status, 'draining'); // Still 1 connection

    backend.activeConnections = 0;
    if (backend.onDrainComplete && backend.activeConnections === 0) backend.onDrainComplete();

    assert.strictEqual(backend.status, 'offline');
    assert.strictEqual(backend.healthy, false);
  });

  it('should support undrain command and restore backend to HEALTHY status in pool', () => {
    const targetId = 'backend-3';
    const backend = backendPool.find(b => b.id === targetId);
    backend.activeConnections = 1;

    connectionDrainManager.drainBackend(targetId, 10);
    assert.strictEqual(backend.status, 'draining');

    // Cancel drain via undrain
    const res = connectionDrainManager.undrainBackend(targetId);
    assert.strictEqual(backend.status, 'healthy');
    assert.strictEqual(backend.healthy, true);

    const healthy = routingEngine.getHealthyBackends();
    assert.ok(healthy.some(b => b.id === targetId), 'Undrained backend must be restored to healthy LB pool');
  });
});

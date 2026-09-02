import { describe, it } from 'node:test';
import assert from 'node:assert';
import ConsistentHashStrategy, { hash32 } from '../src/routing/strategies/consistentHash.js';
import strategyFactory from '../src/routing/strategyFactory.js';
import { LB_ALGORITHMS } from '../src/utils/constants.js';

describe('Consistent Hashing Strategy & Virtual Nodes Ring', () => {
  const mockBackends = [
    { id: 'backend-1', url: 'http://127.0.0.1:4001', weight: 1, healthy: true },
    { id: 'backend-2', url: 'http://127.0.0.1:4002', weight: 1, healthy: true },
    { id: 'backend-3', url: 'http://127.0.0.1:4003', weight: 1, healthy: true },
  ];

  it('should compute consistent 32-bit hashes for string keys', () => {
    const hashA1 = hash32('192.168.1.100');
    const hashA2 = hash32('192.168.1.100');
    const hashB = hash32('192.168.1.101');

    assert.strictEqual(typeof hashA1, 'number');
    assert.strictEqual(hashA1, hashA2, 'Same input string must yield identical hash');
    assert.notStrictEqual(hashA1, hashB, 'Different inputs should yield different hashes');
    assert.ok(hashA1 >= 0 && hashA1 <= 4294967295, 'Hash must be unsigned 32-bit integer');
  });

  it('should build a sorted ring with correct number of virtual nodes', () => {
    const strategy = new ConsistentHashStrategy(40);
    const ring = strategy.buildRing(mockBackends);

    // 3 backends * 40 vnodes = 120 vnodes total
    assert.strictEqual(ring.length, 120);

    // Verify ring is sorted ascending by hash
    for (let i = 0; i < ring.length - 1; i++) {
      assert.ok(ring[i].hash <= ring[i + 1].hash, `Ring entries must be sorted at index ${i}`);
    }
  });

  it('should map identical client IPs / session keys to the same backend deterministically', () => {
    const strategy = new ConsistentHashStrategy(40);
    const req = { headers: { 'x-forwarded-for': '203.0.113.195' } };

    const selected1 = strategy.select(mockBackends, req);
    const selected2 = strategy.select(mockBackends, req);
    const selected3 = strategy.select(mockBackends, req);

    assert.ok(selected1, 'Should return a backend');
    assert.strictEqual(selected1.id, selected2.id);
    assert.strictEqual(selected2.id, selected3.id);
    assert.ok(req._lbReason.includes('consistent-hash'));
  });

  it('should re-map only a minimal fraction of keys (~1/N) when a node is removed', () => {
    const strategy = new ConsistentHashStrategy(40);

    // Generate 100 random client IPs
    const clientIps = Array.from({ length: 100 }, (_, i) => `10.0.${Math.floor(i / 256)}.${i % 256}`);

    // Map keys on 3-node ring
    const originalMappings = clientIps.map(ip => {
      const req = { headers: { 'x-forwarded-for': ip } };
      return strategy.select(mockBackends, req).id;
    });

    // Remove 1 node (backend-3)
    const twoBackends = mockBackends.filter(b => b.id !== 'backend-3');
    const newMappings = clientIps.map(ip => {
      const req = { headers: { 'x-forwarded-for': ip } };
      return strategy.select(twoBackends, req).id;
    });

    // Count how many keys changed target
    let remappedCount = 0;
    for (let i = 0; i < clientIps.length; i++) {
      if (originalMappings[i] !== newMappings[i]) {
        remappedCount++;
        // The newly mapped backend must NOT be the removed node
        assert.notStrictEqual(newMappings[i], 'backend-3');
      }
    }

    // With 3 nodes, ideal re-mapping ratio when 1 node drops is 1/3 (~33 keys out of 100)
    // Contrast with modulo hash where ~66-100 keys would re-map
    assert.ok(remappedCount <= 45, `Only ~1/N keys should re-map on node removal (actual: ${remappedCount}/100)`);
  });

  it('should support weighted virtual node distribution', () => {
    const weightedBackends = [
      { id: 'light-node', url: 'http://127.0.0.1:4001', weight: 1, healthy: true },
      { id: 'heavy-node', url: 'http://127.0.0.1:4002', weight: 3, healthy: true },
    ];

    const strategy = new ConsistentHashStrategy(40);
    const ring = strategy.buildRing(weightedBackends);

    // 1*40 + 3*40 = 160 vnodes
    assert.strictEqual(ring.length, 160);

    const heavyVnodes = ring.filter(v => v.backendId === 'heavy-node').length;
    const lightVnodes = ring.filter(v => v.backendId === 'light-node').length;

    assert.strictEqual(heavyVnodes, 120);
    assert.strictEqual(lightVnodes, 40);
    assert.strictEqual(heavyVnodes / lightVnodes, 3);
  });

  it('should be registered in StrategyFactory under LB_ALGORITHMS.CONSISTENT_HASH', () => {
    const strategy = strategyFactory.getStrategy(LB_ALGORITHMS.CONSISTENT_HASH);
    assert.ok(strategy, 'StrategyFactory should resolve consistent-hash strategy');
    assert.strictEqual(strategy.constructor.name, 'ConsistentHashStrategy');
  });
});

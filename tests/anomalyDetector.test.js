import { describe, it } from 'node:test';
import assert from 'node:assert';
import anomalyDetector from '../src/security/anomalyDetector.js';
import rateLimiter from '../src/security/rateLimiter.js';

describe('Phase 2: Statistical Anomaly Detector (EWMA & Z-Score)', () => {
  it('should initialize with configurable defaults', () => {
    assert.strictEqual(typeof anomalyDetector.zThreshold, 'number');
    assert.strictEqual(typeof anomalyDetector.alpha, 'number');
    assert.ok(anomalyDetector.alpha > 0 && anomalyDetector.alpha < 1);
  });

  it('should compute EWMA baseline and flag statistical anomalies on traffic spikes', async () => {
    anomalyDetector.clearAnomalies();
    const testIp = '10.0.0.50';

    // 1. Establish steady baseline of 2 requests per evaluation window (~12 req/min rate)
    for (let i = 0; i < 5; i++) {
      anomalyDetector.recordRequest(testIp);
      anomalyDetector.recordRequest(testIp);
    }
    
    // Force window timestamp back 10 seconds to allow evaluation
    const stats0 = anomalyDetector.ipStats.get(testIp);
    stats0.windowStart -= 10001;

    // Trigger window evaluation to set initial EWMA baseline
    anomalyDetector.evaluateWindows();

    const baselines = anomalyDetector.getBaselines();
    const stats = baselines.find(b => b.ip === testIp);
    assert.ok(stats, 'IP baseline stats should be created');
    assert.ok(stats.ewma > 0, `EWMA rate should be populated (got ${stats.ewma})`);

    // 2. Simulate traffic spike: 50 requests in the next window (~300 req/min rate)
    for (let i = 0; i < 50; i++) {
      anomalyDetector.recordRequest(testIp);
    }

    stats0.windowStart -= 10001;

    let anomalyEmitted = false;
    anomalyDetector.once('anomaly', (event) => {
      anomalyEmitted = true;
      assert.strictEqual(event.ip, testIp);
      assert.ok(event.zScore >= anomalyDetector.zThreshold, `Z-score (${event.zScore}) should exceed threshold (${anomalyDetector.zThreshold})`);
    });

    // Evaluate window under traffic burst
    anomalyDetector.evaluateWindows();

    assert.ok(anomalyEmitted, 'Anomaly event should be emitted on statistical traffic burst');
    assert.ok(anomalyDetector.getAnomalies().length > 0, 'Anomaly should be recorded in event log');
  });

  it('should support dynamic auto-enforcement penalty tightening', () => {
    anomalyDetector.clearAnomalies();
    rateLimiter.penalizedIps.clear();

    const attackerIp = '192.168.1.200';
    anomalyDetector.setAutoEnforce(true);

    // Warm baseline
    anomalyDetector.recordRequest(attackerIp);
    const stats0 = anomalyDetector.ipStats.get(attackerIp);
    stats0.windowStart -= 10001;
    anomalyDetector.evaluateWindows();

    // Trigger heavy burst
    for (let i = 0; i < 60; i++) {
      anomalyDetector.recordRequest(attackerIp);
    }

    stats0.windowStart -= 10001;
    anomalyDetector.evaluateWindows();

    // Verify rateLimiter penalty was applied
    const penalty = rateLimiter.penalizedIps.get(attackerIp);
    assert.ok(penalty, 'RateLimiter should contain penalty record for attacker IP');
    assert.strictEqual(penalty.maxRequests, anomalyDetector.penaltyMaxRequests);
    assert.strictEqual(penalty.reason, 'statistical-anomaly');
  });
});

/**
 * ─── Statistical Anomaly Detector (EWMA & Z-Score) ───────────────────────────
 *
 * WHY THIS EXISTS:
 * Rather than relying solely on static hardcoded rate limits (e.g. 100 req/min),
 * statistical anomaly detection baselines each client IP's traffic patterns
 * over rolling window intervals using an Exponentially Weighted Moving Average (EWMA).
 *
 * It calculates a z-score deviation for incoming traffic rates:
 *    z = (current_rate - EWMA) / stddev
 * If z > threshold (default 3.0), an anomaly is flagged.
 *
 * DESIGN DECISIONS:
 * - EWMA adapts dynamically to organic traffic growth while detecting sudden spikes.
 * - Computes online variance and standard deviation without storing raw history arrays.
 * - Supports soft-action auto-enforcement: tightens rate limits on flagged IPs temporarily.
 * - Configurable `autoEnforce` toggle allows running in detection/logging-only mode.
 *
 * INTERVIEW QUESTIONS:
 * - Why use EWMA instead of a simple rolling average?
 *   (EWMA gives higher weight to recent windows, adapts faster to baseline shifts,
 *   and operates with O(1) memory overhead per IP rather than storing large arrays)
 * - How do you prevent false positives on low-volume bursty traffic?
 *   (By imposing a minimum request threshold before calculating z-scores, and tuning
 *   the z-score threshold k=3 to cover 99.7% of normal Gaussian distribution variance)
 */

import EventEmitter from 'node:events';
import config from '../config/index.js';
import securityLogger from './securityLogger.js';
import rateLimiter from './rateLimiter.js';
import { createChildLogger } from '../observability/logger.js';

const log = createChildLogger({ module: 'anomaly-detector' });

class AnomalyDetector extends EventEmitter {
  constructor() {
    super();
    this.enabled = config.security.anomaly.enabled;
    this.alpha = 0.3; // EWMA smoothing factor
    this.zThreshold = config.security.anomaly.zThreshold;
    this.autoEnforce = config.security.anomaly.autoEnforce;
    this.penaltyMaxRequests = config.security.anomaly.penaltyMaxRequests;
    this.penaltyWindowMs = config.security.anomaly.penaltyWindowMs;

    this.ipStats = new Map(); // IP -> { ewma, variance, windowCount, windowStart, totalAnomalies, lastZScore }
    this.anomalies = []; // Sliding window of flagged events (last 100)
    this.windowMs = 10000; // 10-second evaluation bucket

    // Periodically process and decay window buckets
    this.intervalId = setInterval(() => this.evaluateWindows(), 5000);
  }

  /**
   * Express middleware to record request statistics for IP baselining.
   */
  middleware() {
    return (req, res, next) => {
      if (this.enabled) {
        const clientIp = req.ip || req.socket.remoteAddress || '127.0.0.1';
        this.recordRequest(clientIp);
      }
      next();
    };
  }

  /**
   * Track incoming request for a client IP.
   * @param {string} ip
   */
  recordRequest(ip) {
    if (!this.enabled || !ip) return;

    const now = Date.now();
    let stats = this.ipStats.get(ip);

    if (!stats) {
      stats = {
        ewma: 0,
        variance: 1, // Default initial variance to prevent divide by zero
        windowCount: 0,
        windowStart: now,
        totalRequests: 0,
        totalAnomalies: 0,
        lastZScore: 0,
        lastFlagged: null,
      };
      this.ipStats.set(ip, stats);
    }

    stats.windowCount++;
    stats.totalRequests++;
  }

  /**
   * Evaluate all active IP request windows.
   */
  evaluateWindows() {
    const now = Date.now();

    for (const [ip, stats] of this.ipStats.entries()) {
      const elapsed = now - stats.windowStart;
      if (elapsed < this.windowMs) continue; // Window still accumulating

      // Convert current window count to rate (requests per minute equivalent)
      const currentRate = (stats.windowCount / (elapsed / 1000)) * 60;
      stats.windowStart = now;
      stats.windowCount = 0;

      // Initialize baseline on first interval
      if (stats.ewma === 0) {
        stats.ewma = currentRate;
        stats.variance = Math.max(1, currentRate * 0.2);
        continue;
      }

      // Compute stddev
      const stddev = Math.sqrt(Math.max(1.0, stats.variance));
      
      // Calculate Z-Score deviation: (currentRate - EWMA) / stddev
      const diff = currentRate - stats.ewma;
      const zScore = Math.round((diff / stddev) * 100) / 100;
      stats.lastZScore = zScore;

      // Update EWMA and variance estimates using Welford's EWMA update
      stats.ewma = Math.round((this.alpha * currentRate + (1 - this.alpha) * stats.ewma) * 100) / 100;
      stats.variance = Math.round(((1 - this.alpha) * (stats.variance + this.alpha * Math.pow(diff, 2))) * 100) / 100;

      // Anomaly trigger condition: z-score > zThreshold AND minimum volume threshold (>= 15 req/min)
      if (zScore >= this.zThreshold && currentRate >= 15) {
        stats.totalAnomalies++;
        stats.lastFlagged = new Date().toISOString();

        const anomalyEvent = {
          id: `anomaly-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
          ip,
          currentRate: Math.round(currentRate),
          ewma: stats.ewma,
          stddev: Math.round(stddev * 100) / 100,
          zScore,
          threshold: this.zThreshold,
          timestamp: stats.lastFlagged,
          enforced: this.autoEnforce,
        };

        this.anomalies.push(anomalyEvent);
        if (this.anomalies.length > 100) this.anomalies.shift();

        // Emit anomaly event
        this.emit('anomaly', anomalyEvent);

        // Security logging
        securityLogger.logEvent('statistical-anomaly', {
          ip,
          path: 'N/A (Rate Anomaly)',
          headers: {},
        }, {
          reason: `Statistical anomaly detected: IP ${ip} request rate (${Math.round(currentRate)}/min) exceeded baseline EWMA (${stats.ewma}/min) by ${zScore} stddevs (z-threshold: ${this.zThreshold}).`,
          ...anomalyEvent,
        });

        log.warn(`🚨 Statistical anomaly flagged for ${ip}: rate=${Math.round(currentRate)}/min, EWMA=${stats.ewma}, zScore=${zScore}`);

        // Auto-enforcement action
        if (this.autoEnforce) {
          rateLimiter.applyPenalty(ip, this.penaltyMaxRequests, this.penaltyWindowMs);
          log.info(`🛡️ Auto-enforcement applied: Throttled rate limit for IP ${ip} to ${this.penaltyMaxRequests} reqs for ${this.penaltyWindowMs / 1000}s`);
        }
      }
    }
  }

  /**
   * Toggle auto-enforcement mode.
   * @param {boolean} enabled
   */
  setAutoEnforce(enabled) {
    this.autoEnforce = Boolean(enabled);
    log.info(`Anomaly auto-enforcement set to: ${this.autoEnforce}`);
  }

  /**
   * Set z-score threshold.
   * @param {number} threshold
   */
  setZThreshold(threshold) {
    this.zThreshold = parseFloat(threshold) || 3.0;
    log.info(`Anomaly z-score threshold set to: ${this.zThreshold}`);
  }

  /**
   * Get flagged anomaly events log.
   */
  getAnomalies() {
    return this.anomalies;
  }

  /**
   * Get active IP baselines metrics.
   */
  getBaselines() {
    const list = [];
    for (const [ip, stats] of this.ipStats.entries()) {
      list.push({
        ip,
        ewma: stats.ewma,
        stddev: Math.round(Math.sqrt(Math.max(1.0, stats.variance)) * 100) / 100,
        totalRequests: stats.totalRequests,
        totalAnomalies: stats.totalAnomalies,
        lastZScore: stats.lastZScore,
        lastFlagged: stats.lastFlagged,
      });
    }
    return list;
  }

  /**
   * Clear anomaly logs and baselines.
   */
  clearAnomalies() {
    this.anomalies = [];
    this.ipStats.clear();
  }
}

const anomalyDetector = new AnomalyDetector();
export default anomalyDetector;

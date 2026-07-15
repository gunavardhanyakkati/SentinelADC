/**
 * ─── Security Logger ──────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * In a professional ADC, tracking and auditing security events is critical for
 * compliance and intrusion detection. This module provides centralized logging for
 * WAF blocks, rate limit violations, JWT failures, and IP blocklist events.
 *
 * DESIGN DECISIONS:
 * - Logs to standard Winston logger at the `warn` level with rich metadata.
 * - Maintains a sliding in-memory history of the last 100 security events so
 *   the dashboard can fetch and display active threat logs without DB lookups.
 *
 * INTERVIEW QUESTIONS:
 * - Why log security events separately from general HTTP traffic logs?
 *   (Security logs require higher visibility, strict retention periods, and are
 *   often piped to SIEM systems like Splunk for automated threat parsing)
 * - How would you prevent log injection attacks?
 *   (Ensure no un-sanitized user input is logged as raw text; serialize objects
 *   or escape strings before writing them to the log sink)
 */

import { createChildLogger } from '../observability/logger.js';
import { getClientIp } from '../utils/helpers.js';

const log = createChildLogger({ module: 'security' });

class SecurityLogger {
  constructor() {
    this.events = [];
    this.limit = 100;
  }

  /**
   * Log a security incident.
   * @param {string} type - Event type (e.g., 'xss-detected', 'rate-limit')
   * @param {import('express').Request} req - The Express request object
   * @param {Object} details - Additional event details
   */
  logEvent(type, req, details = {}) {
    const clientIp = getClientIp(req);
    const event = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      ip: clientIp,
      path: req.originalUrl,
      method: req.method,
      userAgent: req.headers['user-agent'] || 'unknown',
      details,
      timestamp: new Date().toISOString(),
    };

    // Store in sliding window history
    this.events.unshift(event);
    if (this.events.length > this.limit) {
      this.events.pop();
    }

    // Output to Winston structured log
    log.warn(`Security Event: [${type.toUpperCase()}] from IP: ${clientIp} on ${req.method} ${req.originalUrl}`, {
      securityEvent: event,
    });

    return event;
  }

  /**
   * Retrieve the list of active security events.
   * @returns {Object[]}
   */
  getEvents() {
    return this.events;
  }

  /**
   * Clear the in-memory security log.
   */
  clearLogs() {
    this.events = [];
    log.info('Security event log cleared.');
  }
}

const securityLogger = new SecurityLogger();
export default securityLogger;

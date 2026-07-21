/**
 * ─── Security API Routes ─────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Exposes administration endpoints to check firewalled logs, inspect currently
 * blocked client IPs, and manually add/remove IP bans from the pool.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import securityLogger from './securityLogger.js';
import ipBlocklist from './ipBlocklist.js';
import { HTTP_STATUS } from '../utils/constants.js';
import jwtMiddleware from './jwtMiddleware.js';

const router = Router();

/**
 * POST /api/security/login
 * Retrieve a JWT token for administrator auth.
 */
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (username === 'admin' && password === 'sentinel') {
    const token = jwt.sign(
      { username: 'admin', role: 'admin' },
      config.security.jwtSecret,
      { expiresIn: config.security.jwtExpiry }
    );
    return res.json({ token });
  }

  res.status(HTTP_STATUS.UNAUTHORIZED).json({
    error: 'Invalid credentials. Default: admin / sentinel',
    statusCode: HTTP_STATUS.UNAUTHORIZED,
  });
});

// Protect all security routes below this line
router.use(jwtMiddleware());

/**
 * GET /api/security/events
 * Fetch sliding window security events.
 */
router.get('/events', (req, res) => {
  res.json({
    events: securityLogger.getEvents(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * DELETE /api/security/events
 * Clear all logged security logs.
 */
router.delete('/events', (req, res) => {
  securityLogger.clearLogs();
  res.json({
    message: 'Security event logs cleared successfully',
  });
});

/**
 * GET /api/security/blocklist
 * Retrieve currently blocked client IPs.
 */
router.get('/blocklist', (req, res) => {
  res.json({
    blocklist: ipBlocklist.getBlockedList(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/security/blocklist
 * Manually add an IP address to the firewall blocklist.
 */
router.post('/blocklist', (req, res) => {
  const { ip } = req.body;

  if (!ip) {
    return res.status(HTTP_STATUS.BAD_REQUEST).json({
      error: 'Missing required body field: "ip"',
    });
  }

  ipBlocklist.block(ip);
  res.json({
    message: `Manually blocked IP: "${ip}" successfully`,
    blocklist: ipBlocklist.getBlockedList(),
  });
});

/**
 * DELETE /api/security/blocklist/:ip
 * Remove an IP address from the firewall blocklist.
 */
router.delete('/blocklist/:ip', (req, res) => {
  const { ip } = req.params;

  const existed = ipBlocklist.unblock(ip);
  if (!existed) {
    return res.status(HTTP_STATUS.NOT_FOUND).json({
      error: `IP address "${ip}" was not found in the blocklist`,
    });
  }

  res.json({
    message: `Manually unblocked IP: "${ip}" successfully`,
    blocklist: ipBlocklist.getBlockedList(),
  });
});

/**
 * GET /api/security/anomalies
 * Fetch statistical traffic anomalies, baselines, and configuration.
 */
router.get('/anomalies', (req, res) => {
  res.json({
    config: {
      enabled: anomalyDetector.enabled,
      zThreshold: anomalyDetector.zThreshold,
      autoEnforce: anomalyDetector.autoEnforce,
      penaltyMaxRequests: anomalyDetector.penaltyMaxRequests,
      penaltyWindowMs: anomalyDetector.penaltyWindowMs,
    },
    anomalies: anomalyDetector.getAnomalies(),
    baselines: anomalyDetector.getBaselines(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /api/security/anomalies/config
 * Dynamic configuration update for anomaly detection & auto-enforcement.
 */
router.post('/anomalies/config', (req, res) => {
  const { autoEnforce, zThreshold } = req.body;

  if (typeof autoEnforce === 'boolean') {
    anomalyDetector.setAutoEnforce(autoEnforce);
  }
  if (typeof zThreshold === 'number') {
    anomalyDetector.setZThreshold(zThreshold);
  }

  res.json({
    message: 'Anomaly detection configuration updated successfully',
    config: {
      enabled: anomalyDetector.enabled,
      zThreshold: anomalyDetector.zThreshold,
      autoEnforce: anomalyDetector.autoEnforce,
    },
  });
});

/**
 * DELETE /api/security/anomalies
 * Clear logged anomaly events and IP baselines.
 */
router.delete('/anomalies', (req, res) => {
  anomalyDetector.clearAnomalies();
  res.json({
    message: 'Anomaly detection records and baselines cleared successfully',
  });
});

export default router;

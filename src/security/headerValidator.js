/**
 * ─── Header Validator ────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Basic protocol validation at the gateway filter layer blocks malformed HTTP
 * requests, script-based botnets, or command-line scanners (like curl/wget if blocked)
 * before they parse request payloads, saving CPU cycles on origins.
 *
 * DESIGN DECISIONS:
 * - Checks for mandatory HTTP/1.1 headers (e.g. Host).
 * - Identifies and optionally blocks known scraper/bot User-Agent patterns.
 */

import { HTTP_STATUS } from '../utils/constants.js';
import securityLogger from './securityLogger.js';

/**
 * Common script user agents often used by scanners
 */
const SCANNERS = [
  /nikto/i,
  /sqlmap/i,
  /nmap/i,
  /acunetix/i,
  /w3af/i,
];

export default function headerValidator() {
  return (req, res, next) => {
    const host = req.headers['host'];
    const userAgent = req.headers['user-agent'];

    // 1. Validate mandatory Host header exists (HTTP/1.1 requirement)
    if (!host) {
      securityLogger.logEvent('header-invalid', req, {
        reason: 'Request missing mandatory HTTP Host header',
      });
      return res.status(HTTP_STATUS.BAD_REQUEST).json({
        error: 'Bad Request — Missing Host header',
        statusCode: HTTP_STATUS.BAD_REQUEST,
      });
    }

    // 2. Inspect User-Agent for known vulnerability scanners
    if (userAgent) {
      for (const scannerRegex of SCANNERS) {
        if (scannerRegex.test(userAgent)) {
          securityLogger.logEvent('scanner-detected', req, {
            reason: `Malicious scanner User-Agent detected: "${userAgent}"`,
            match: scannerRegex.source,
          });

          return res.status(HTTP_STATUS.FORBIDDEN).json({
            error: 'Forbidden — scanner signature detected',
            statusCode: HTTP_STATUS.FORBIDDEN,
          });
        }
      }
    }

    next();
  };
}

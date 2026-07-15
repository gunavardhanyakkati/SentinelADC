/**
 * ─── Web Application Firewall (WAF) Middleware ──────────────────────────────
 *
 * WHY THIS EXISTS:
 * A Web Application Firewall (WAF) inspects Layer-7 payload content to filter out
 * application-level exploits like SQL Injection (SQLi) and Cross-Site Scripting (XSS)
 * before they reach vulnerable downstream microservices.
 *
 * DESIGN DECISIONS:
 * - Implements signature-based detection using optimized Regular Expression checks.
 * - Recursively scans the request URL paths, raw query parameters, and parsed
 *   request bodies (JSON objects/arrays) to handle nested payloads.
 *
 * INTERVIEW QUESTIONS:
 * - What is SQL Injection (SQLi) and how does a WAF prevent it?
 *   (SQLi happens when untrusted user input is concatenated directly into SQL queries.
 *   A WAF prevents it by checking incoming parameters for SQL commands and commenting symbols)
 * - What is Cross-Site Scripting (XSS) and what are its types?
 *   (XSS allows attackers to inject malicious scripts into trusted websites. Types include
 *   Reflected XSS, Stored XSS, and DOM-based XSS. A WAF screens inputs for script tags and attributes)
 * - What are the limitations of signature-based WAFs, and how do you bypass them?
 *   (They are limited to known patterns and can be bypassed via encoding, obfuscation,
 *   or zero-day exploits. Advanced WAFs use semantic parsing or behavioral profiling)
 */

import { HTTP_STATUS } from '../utils/constants.js';
import securityLogger from './securityLogger.js';

// Optimized regex signatures for SQL Injection
const SQLI_PATTERNS = [
  /\bunion\b.*\bselect\b/i,
  /\bselect\b.*\bfrom\b/i,
  /\binsert\b.*\binto\b/i,
  /\bupdate\b.*\bset\b/i,
  /\bdelete\b.*\bfrom\b/i,
  /\bdrop\b.*\btable\b/i,
  /exec\s*\(/i,
  /cast\s*\(.*as/i,
  /convert\s*\(/i,
  /char\s*\(/i,
  /--\s*$/,
];

// Optimized regex signatures for Cross-Site Scripting
const XSS_PATTERNS = [
  /<script[^>]*>/i,
  /<\/script>/i,
  /javascript:/i,
  /onerror\s*=/i,
  /onload\s*=/i,
  /onclick\s*=/i,
  /src\s*=\s*['"]?javascript:/i,
  /eval\s*\(/i,
  /expression\s*\(/i,
  /<\s*img\s+[^>]*onerror/i,
  /<\s*svg\s+[^>]*onload/i,
];

/**
 * Recursively inspect values for malicious pattern matches.
 * @param {*} val - Value to check (string, object, array)
 * @returns {Object|null} - Details of match, or null
 */
function scanPayload(val) {
  if (typeof val === 'string') {
    // 1. Scan for SQL Injection patterns
    for (const regex of SQLI_PATTERNS) {
      if (regex.test(val)) {
        return { attackType: 'sqli', matchedPattern: regex.source, inputSnippet: val };
      }
    }

    // 2. Scan for Cross-Site Scripting patterns
    for (const regex of XSS_PATTERNS) {
      if (regex.test(val)) {
        return { attackType: 'xss', matchedPattern: regex.source, inputSnippet: val };
      }
    }
  } else if (Array.isArray(val)) {
    for (const item of val) {
      const match = scanPayload(item);
      if (match) return match;
    }
  } else if (typeof val === 'object' && val !== null) {
    for (const [key, value] of Object.entries(val)) {
      // Screen keys as well as values
      const keyMatch = scanPayload(key);
      if (keyMatch) return keyMatch;

      const valMatch = scanPayload(value);
      if (valMatch) return valMatch;
    }
  }

  return null;
}

export default function wafMiddleware() {
  return (req, res, next) => {
    // 1. Scan URI path
    const pathMatch = scanPayload(req.path);
    if (pathMatch) {
      securityLogger.logEvent('waf-block', req, {
        source: 'uri-path',
        ...pathMatch,
      });

      return res.status(HTTP_STATUS.FORBIDDEN).json({
        error: `Access Blocked — WAF detected a potential ${pathMatch.attackType.toUpperCase()} attempt in the URI path`,
        statusCode: HTTP_STATUS.FORBIDDEN,
      });
    }

    // 2. Scan Query string parameters
    const queryMatch = scanPayload(req.query);
    if (queryMatch) {
      securityLogger.logEvent('waf-block', req, {
        source: 'query-params',
        ...queryMatch,
      });

      return res.status(HTTP_STATUS.FORBIDDEN).json({
        error: `Access Blocked — WAF detected a potential ${queryMatch.attackType.toUpperCase()} attempt in query parameters`,
        statusCode: HTTP_STATUS.FORBIDDEN,
      });
    }

    // 3. Scan Request Body (if parsed by body parser)
    if (req.body) {
      const bodyMatch = scanPayload(req.body);
      if (bodyMatch) {
        securityLogger.logEvent('waf-block', req, {
          source: 'request-body',
          ...bodyMatch,
        });

        return res.status(HTTP_STATUS.FORBIDDEN).json({
          error: `Access Blocked — WAF detected a potential ${bodyMatch.attackType.toUpperCase()} attempt in request payload`,
          statusCode: HTTP_STATUS.FORBIDDEN,
        });
      }
    }

    next();
  };
}

/**
 * ─── JWT Authentication Middleware ───────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Protects control plane (admin) API routes (e.g. `/api/admin/*`, `/api/cache/*`)
 * from unauthorized access. An Application Delivery Controller is a high-privilege
 * system component; control APIs must be strictly protected using cryptographic
 * verification.
 *
 * DESIGN DECISIONS:
 * - Reads standard HTTP bearer token from `Authorization: Bearer <token>`.
 * - Verifies the signature and expiration against the centralized JWT secret.
 * - Attaches the verified user metadata (`req.user`) to the request object.
 *
 * INTERVIEW QUESTIONS:
 * - What are the security risks of storing secrets in the codebase?
 *   (Secrets should be injected via environment variables in production. Hardcoded
 *   secrets can be leaked in source control history)
 * - How does JWT signature verification prevent tampering?
 *   (The signature is computed using a secret key over the encoded header and payload.
 *   If the payload is mutated, the signature will not match unless the secret is known)
 * - What are the pros/cons of JWT (stateless) vs Session ID (stateful) auth?
 *   (Stateless JWTs do not require database lookups on the gateway, improving response time
 *   and horizontal scaling. However, they are harder to revoke before expiration)
 */

import jwt from 'jsonwebtoken';
import config from '../config/index.js';
import { HTTP_STATUS } from '../utils/constants.js';
import securityLogger from './securityLogger.js';

export default function jwtMiddleware() {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      securityLogger.logEvent('unauthorized-jwt', req, {
        reason: 'Missing or malformed Authorization Bearer header',
      });

      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        error: 'Unauthorized — Missing or malformed Authorization token',
        statusCode: HTTP_STATUS.UNAUTHORIZED,
      });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = jwt.verify(token, config.security.jwtSecret);
      req.user = decoded;
      next();
    } catch (err) {
      securityLogger.logEvent('unauthorized-jwt', req, {
        reason: `JWT verification failed: ${err.message}`,
        error: err.message,
      });

      return res.status(HTTP_STATUS.UNAUTHORIZED).json({
        error: `Unauthorized — Invalid or expired token: ${err.message}`,
        statusCode: HTTP_STATUS.UNAUTHORIZED,
      });
    }
  };
}

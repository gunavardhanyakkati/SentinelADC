/**
 * ─── TLS / HTTPS Redirect Middleware ─────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * When TLS termination is enabled, unencrypted HTTP traffic reaching the gateway
 * should be automatically redirected to the HTTPS listener to enforce secure
 * transport layer security across all client communications.
 *
 * DESIGN DECISIONS:
 * - Returns 301 Moved Permanently for unencrypted HTTP GET/HEAD requests.
 * - Respects the `TLS_REDIRECT` environment toggle so local development can
 *   run plain HTTP alongside HTTPS if needed.
 */

import config from '../config/index.js';

export default function tlsRedirect() {
  return (req, res, next) => {
    if (!config.tls.enabled || !config.tls.redirect) {
      return next();
    }

    // Check if request is unencrypted HTTP
    const isHttp = !req.secure && req.protocol === 'http';

    if (isHttp) {
      const host = req.headers.host ? req.headers.host.split(':')[0] : 'localhost';
      const httpsPort = config.tls.port === 443 ? '' : `:${config.tls.port}`;
      const targetUrl = `https://${host}${httpsPort}${req.url}`;

      return res.redirect(301, targetUrl);
    }

    next();
  };
}

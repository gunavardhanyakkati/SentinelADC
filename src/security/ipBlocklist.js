/**
 * ─── IP Blocklist ────────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Dynamic IP blocking is a core firewall feature (Layer-3/4 defense). It allows
 * operators to instantly cut off traffic from abusive clients, scrapers, or DDoS
 * sources at the gateway level.
 *
 * DESIGN DECISIONS:
 * - Employs a fast in-memory Set lookup for O(1) IP checks on incoming requests.
 * - Integrates as the very first middleware to drop requests early and conserve CPU resources.
 *
 * INTERVIEW QUESTIONS:
 * - What is the complexity of looking up blocked IPs in a Set vs an Array?
 *   (O(1) lookup time for Sets vs O(N) linear time for Arrays, making Sets vastly
 *   superior under high throughput)
 * - How would you implement IP range/CIDR blocking?
 *   (Use prefix matching, segment/trie structures, or NPM libraries like ip-range-check
 *   to determine if the client IP falls within blocked subnets)
 */

import { getClientIp } from '../utils/helpers.js';
import { HTTP_STATUS } from '../utils/constants.js';
import securityLogger from './securityLogger.js';

class IpBlocklist {
  constructor() {
    this.blockedIps = new Set();
  }

  /**
   * Block a client IP address.
   * @param {string} ip
   */
  block(ip) {
    this.blockedIps.add(ip);
  }

  /**
   * Unblock a client IP address.
   * @param {string} ip
   */
  unblock(ip) {
    return this.blockedIps.delete(ip);
  }

  /**
   * Check if a client IP address is blocked.
   * @param {string} ip
   * @returns {boolean}
   */
  isBlocked(ip) {
    return this.blockedIps.has(ip);
  }

  /**
   * Retrieve all currently blocked IPs.
   * @returns {string[]}
   */
  getBlockedList() {
    return Array.from(this.blockedIps);
  }

  /**
   * Express middleware to block traffic from blacklisted IPs.
   */
  middleware() {
    return (req, res, next) => {
      const clientIp = getClientIp(req);

      if (this.isBlocked(clientIp)) {
        securityLogger.logEvent('ip-blocked', req, {
          reason: 'Client IP is present in the firewall blocklist',
        });

        return res.status(HTTP_STATUS.FORBIDDEN).json({
          error: {
            message: 'Access Forbidden — client IP has been blocked by administrator',
            statusCode: HTTP_STATUS.FORBIDDEN,
            ip: clientIp,
          },
          timestamp: new Date().toISOString(),
        });
      }

      next();
    };
  }
}

const ipBlocklist = new IpBlocklist();
export default ipBlocklist;

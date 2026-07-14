/**
 * ─── IP Hash Load Balancing Strategy ────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * IP Hash provides session affinity (sticky sessions) by mapping the client's
 * IP address to a specific backend server. This is critical when backend servers
 * maintain local, non-distributed session state (e.g. user authentication,
 * shopping cart data stored in local server RAM).
 *
 * DESIGN DECISIONS:
 * - Extracts client IP using our helper function.
 * - Hashes the IP string to a 32-bit integer.
 * - Modulos the hash by the number of healthy backends to get a consistent index.
 *
 * INTERVIEW QUESTIONS:
 * - What are the advantages and disadvantages of IP Hash?
 *   (Advantage: Stateless session stickiness. Disadvantage: Uneven traffic distribution
 *   if many clients share a NAT gateway / public IP, and cache invalidation challenges when pool changes)
 * - How does a production system handle pool scale-up/down with IP Hash? (Consistent Hashing)
 */

import { getClientIp, simpleHash } from '../../utils/helpers.js';

export default class IpHashStrategy {
  /**
   * Select a backend from the list of healthy backends.
   * @param {import('../../config/backends.js').Backend[]} backends
   * @param {import('express').Request} req
   * @returns {import('../../config/backends.js').Backend}
   */
  select(backends, req) {
    const clientIp = getClientIp(req);
    const hashValue = simpleHash(clientIp);
    const index = hashValue % backends.length;
    const selected = backends[index];

    req._lbReason = `ip-hash (client IP: ${clientIp}, hash: ${hashValue}, index: ${index})`;
    return selected;
  }
}

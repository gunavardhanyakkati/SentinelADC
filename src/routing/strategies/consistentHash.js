/**
 * ─── Consistent Hashing Load Balancing Strategy ──────────────────────────────
 *
 * WHY THIS EXISTS:
 * Standard modulo hashing (`hash(IP) % N`) causes massive cache and session
 * invalidation when upstream backends are added or removed, as nearly N/(N+1)
 * keys get re-mapped to different nodes.
 *
 * Consistent Hashing maps both backends and client keys onto a 32-bit integer ring
 * [0, 2^32 - 1]. To prevent uneven distribution (hotspots), each physical backend
 * is mapped to multiple "virtual nodes" (vnodes) scattered around the ring.
 *
 * KEY METRICS & DESIGN DECISIONS:
 * - 40 Virtual Nodes per weight multiplier (e.g. weight 3 = 120 vnodes).
 * - MD5 32-bit unsigned integer hashing for uniform ring distribution.
 * - Binary search lookup on sorted ring array for O(log V) selection.
 * - Clockwise traversal on the ring to skip unhealthy nodes during failover.
 *
 * INTERVIEW QUESTIONS:
 * - What problem does Consistent Hashing solve over simple modulo IP Hash?
 *   (Modulo hashing re-maps almost all keys when pool size changes. Consistent
 *   hashing re-maps only 1/N keys on average, preserving cache locality and sticky sessions)
 * - Why use Virtual Nodes on the hash ring?
 *   (Single physical nodes cause non-uniform key distribution on the ring. Virtual nodes
 *   ensure uniform load distribution and allow weighted allocation based on node capacity)
 * - How does failover work on a Consistent Hashing ring?
 *   (If the mapped virtual node's physical backend is unhealthy, we walk clockwise
 *   to the next healthy virtual node on the ring)
 */

import crypto from 'node:crypto';
import { getClientIp } from '../../utils/helpers.js';

/**
 * Compute 32-bit unsigned integer hash using MD5.
 * @param {string} key
 * @returns {number} 32-bit unsigned integer [0, 4294967295]
 */
export function hash32(key) {
  const hash = crypto.createHash('md5').update(key).digest();
  return hash.readUInt32BE(0);
}

export default class ConsistentHashStrategy {
  /**
   * @param {number} vnodesPerWeight - Base number of virtual nodes per weight unit (default: 40)
   */
  constructor(vnodesPerWeight = 40) {
    this.vnodesPerWeight = vnodesPerWeight;
  }

  /**
   * Build virtual node hash ring for the active backends.
   * @param {import('../../config/backends.js').Backend[]} backends
   * @returns {Array<{ hash: number, backendId: string }>} Sorted ring entries
   */
  buildRing(backends) {
    const ring = [];

    for (const backend of backends) {
      const weight = Math.max(1, backend.weight || 1);
      const vnodeCount = this.vnodesPerWeight * weight;

      for (let i = 0; i < vnodeCount; i++) {
        const vnodeKey = `${backend.id}#vnode-${i}`;
        const hash = hash32(vnodeKey);
        ring.push({ hash, backendId: backend.id });
      }
    }

    // Sort ring numerically by 32-bit hash ascending
    ring.sort((a, b) => a.hash - b.hash);
    return ring;
  }

  /**
   * Binary search for the first ring entry with hash >= targetHash.
   * If targetHash > max ring hash, wraps around to index 0.
   * @param {Array<{ hash: number }>} ring
   * @param {number} targetHash
   * @returns {number} Ring index
   */
  findRingIndex(ring, targetHash) {
    let low = 0;
    let high = ring.length - 1;

    if (targetHash > ring[high].hash) {
      return 0; // Wrap around to first vnode on the ring
    }

    let result = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (ring[mid].hash >= targetHash) {
        result = mid;
        high = mid - 1; // Try to find smaller index that is still >= targetHash
      } else {
        low = mid + 1;
      }
    }

    return result;
  }

  /**
   * Select a backend using Consistent Hashing.
   * @param {import('../../config/backends.js').Backend[]} healthyBackends
   * @param {import('express').Request} req
   * @returns {import('../../config/backends.js').Backend}
   */
  select(healthyBackends, req) {
    if (!healthyBackends || healthyBackends.length === 0) {
      return null;
    }

    // Use client IP or custom session header as key
    const clientKey = req?.headers?.['x-session-id'] || (req ? getClientIp(req) : '0.0.0.0');
    const clientHash = hash32(clientKey);

    // Build ring from healthy backends
    const ring = this.buildRing(healthyBackends);
    if (ring.length === 0) {
      return healthyBackends[0];
    }

    // Find closest virtual node clockwise
    const startIndex = this.findRingIndex(ring, clientHash);
    const selectedEntry = ring[startIndex];

    // Find healthy backend object matching selected entry ID
    const selected = healthyBackends.find(b => b.id === selectedEntry.backendId) || healthyBackends[0];

    if (req) {
      req._lbReason = `consistent-hash (key: ${clientKey}, hash: ${clientHash}, vnode: ${selectedEntry.backendId}, index: ${startIndex}/${ring.length})`;
    }
    
    return selected;
  }
}

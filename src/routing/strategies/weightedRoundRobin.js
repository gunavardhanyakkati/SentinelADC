/**
 * ─── Weighted Round Robin Load Balancing Strategy ───────────────────────────
 *
 * WHY THIS EXISTS:
 * In heterogeneous server clusters, some servers have more capacity (CPU, RAM)
 * than others. Weighted Round Robin (WRR) directs more requests to more powerful
 * servers based on assigned "weights".
 *
 * DESIGN DECISIONS:
 * - Uses the classic LVS (Linux Virtual Server) algorithm.
 * - Dynamically maps configured static weights to virtual weights scaled by the
 *   backend's real-time performance score (F5 "Dynamic Ratio").
 * - Maintains dynamic internal state (`currentIndex` and `currentWeight`).
 *
 * INTERVIEW QUESTIONS:
 * - How does the LVS WRR algorithm work under the hood?
 * - What is "Dynamic Ratio" load balancing? (Real-time performance scores scale
 *   configured server weights dynamically)
 * - How do you prevent division by zero or negative weights? (Cap weights to minimum 1)
 */

import metricsStore from '../../metrics/metricsStore.js';

export default class WeightedRoundRobinStrategy {
  constructor() {
    this.currentIndex = -1;
    this.currentWeight = 0;
  }

  /**
   * Helper to compute Greatest Common Divisor (GCD) of two numbers
   */
  gcd(a, b) {
    while (b) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  /**
   * Helper to compute the GCD of an array of weights
   */
  getGcdOfWeights(backends) {
    let result = backends[0]?.weight || 1;
    for (let i = 1; i < backends.length; i++) {
      result = this.gcd(result, backends[i].weight || 1);
    }
    return result;
  }

  /**
   * Helper to get the maximum weight in the pool
   */
  getMaxWeight(backends) {
    let max = 0;
    for (const b of backends) {
      if (b.weight > max) max = b.weight;
    }
    return max;
  }

  /**
   * Select a backend from the list of healthy backends.
   * @param {import('../../config/backends.js').Backend[]} backends
   * @param {import('express').Request} req
   * @returns {import('../../config/backends.js').Backend}
   */
  select(backends, req) {
    // Map backends to temporary virtual pool members with dynamically adjusted weights based on metrics score
    const virtualPool = backends.map((backend) => {
      const metrics = metricsStore.getBackendMetrics(backend.id);
      const score = metrics ? metrics.score : 100;
      
      // Calculate dynamic weight: configured weight multiplied by score percentage
      const dynamicWeight = Math.max(1, Math.round((backend.weight || 1) * (score / 100)));
      return {
        backend,
        weight: dynamicWeight,
        id: backend.id,
      };
    });

    const n = virtualPool.length;
    const maxWeight = this.getMaxWeight(virtualPool);
    const gcdWeight = this.getGcdOfWeights(virtualPool);

    // If all weights are 0, fallback to standard Round Robin index
    if (maxWeight === 0) {
      this.currentIndex = (this.currentIndex + 1) % n;
      const selected = virtualPool[this.currentIndex].backend;
      req._lbReason = 'weighted-round-robin (dynamic fallback to RR)';
      return selected;
    }

    while (true) {
      this.currentIndex = (this.currentIndex + 1) % n;
      if (this.currentIndex === 0) {
        this.currentWeight = this.currentWeight - gcdWeight;
        if (this.currentWeight <= 0) {
          this.currentWeight = maxWeight;
        }
      }

      const virtualMember = virtualPool[this.currentIndex];
      if (virtualMember.weight >= this.currentWeight) {
        req._lbReason = `weighted-round-robin (dynamic weight: ${virtualMember.weight}/${virtualMember.backend.weight}, selection: ${this.currentWeight})`;
        return virtualMember.backend;
      }
    }
  }
}

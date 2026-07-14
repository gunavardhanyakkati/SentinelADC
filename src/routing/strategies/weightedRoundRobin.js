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
 * - Maintains dynamic internal state (`currentIndex` and `currentWeight`).
 * - Dynamically computes the Greatest Common Divisor (GCD) and Maximum Weight
 *   to handle runtime weight changes.
 *
 * INTERVIEW QUESTIONS:
 * - How does the LVS WRR algorithm work under the hood?
 * - What happens if a server's weight is set to 0? (It gets no traffic)
 * - How does this algorithm compare to a simple "weighted list expansion"?
 *   (List expansion takes O(Sum(Weights)) memory, while LVS is O(1) memory and O(N) selection time)
 */

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
    const n = backends.length;
    const maxWeight = this.getMaxWeight(backends);
    const gcdWeight = this.getGcdOfWeights(backends);

    // If all weights are 0, fallback to standard Round Robin index
    if (maxWeight === 0) {
      this.currentIndex = (this.currentIndex + 1) % n;
      req._lbReason = 'weighted-round-robin (fallback to RR, all weights 0)';
      return backends[this.currentIndex];
    }

    while (true) {
      this.currentIndex = (this.currentIndex + 1) % n;
      if (this.currentIndex === 0) {
        this.currentWeight = this.currentWeight - gcdWeight;
        if (this.currentWeight <= 0) {
          this.currentWeight = maxWeight;
        }
      }

      const backend = backends[this.currentIndex];
      if (backend.weight >= this.currentWeight) {
        req._lbReason = `weighted-round-robin (backend weight: ${backend.weight}, selection weight: ${this.currentWeight})`;
        return backend;
      }
    }
  }
}

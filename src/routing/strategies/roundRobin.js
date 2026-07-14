/**
 * ─── Round Robin Load Balancing Strategy ────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Round Robin is the simplest and most common load balancing algorithm.
 * It distributes requests sequentially and evenly across the pool of backends.
 *
 * DESIGN DECISIONS:
 * - Simple counter modulo the length of healthy backends.
 * - Stateless with respect to request parameters (doesn't look at client IP or payload).
 *
 * INTERVIEW QUESTIONS:
 * - What are the limitations of standard Round Robin?
 * - How would you handle a scenario where backends have different capacities? (Weighted Round Robin)
 * - How do you prevent index overflow over time? (Modulo operation keeps it within safe bounds)
 */

export default class RoundRobinStrategy {
  constructor() {
    this.index = 0;
  }

  /**
   * Select a backend from the list of healthy backends.
   * @param {import('../../config/backends.js').Backend[]} backends
   * @param {import('express').Request} req
   * @returns {import('../../config/backends.js').Backend}
   */
  select(backends, req) {
    const selected = backends[this.index % backends.length];
    
    // Increment index, keeping it within bounds
    this.index = (this.index + 1) % backends.length;
    
    req._lbReason = `round-robin (cyclic index ${this.index})`;
    return selected;
  }
}

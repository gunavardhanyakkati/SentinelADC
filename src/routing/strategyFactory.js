/**
 * ─── Strategy Factory ────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Encapsulates strategy instantiation and mapping. By creating singletons
 * of the strategies, we preserve internal state (like counters for Round Robin
 * and Weighted Round Robin) across requests, rather than starting from scratch
 * on every routing decision.
 *
 * DESIGN DECISIONS:
 * - Simple mapping of algorithm name to class instance.
 * - Reuses instances to preserve strategy-specific state.
 *
 * INTERVIEW QUESTIONS:
 * - Why do we reuse strategy instances instead of instantiating on every select?
 *   (To preserve state like current index/weight across HTTP requests)
 * - How would you make this factory thread-safe in a multi-threaded system?
 */

import RoundRobinStrategy from './strategies/roundRobin.js';
import LeastConnectionsStrategy from './strategies/leastConnections.js';
import WeightedRoundRobinStrategy from './strategies/weightedRoundRobin.js';
import IpHashStrategy from './strategies/ipHash.js';
import { LB_ALGORITHMS } from '../utils/constants.js';

class StrategyFactory {
  constructor() {
    this.strategies = {
      [LB_ALGORITHMS.ROUND_ROBIN]: new RoundRobinStrategy(),
      [LB_ALGORITHMS.LEAST_CONNECTIONS]: new LeastConnectionsStrategy(),
      [LB_ALGORITHMS.WEIGHTED_ROUND_ROBIN]: new WeightedRoundRobinStrategy(),
      [LB_ALGORITHMS.IP_HASH]: new IpHashStrategy(),
    };
  }

  /**
   * Get the strategy instance for a given algorithm name.
   * @param {string} name - The load balancing algorithm name
   * @returns {Object} The strategy instance
   */
  getStrategy(name) {
    const strategy = this.strategies[name];
    if (!strategy) {
      throw new Error(`Unknown load balancing algorithm: ${name}`);
    }
    return strategy;
  }

  /**
   * List all available algorithm names
   * @returns {string[]}
   */
  getAvailableAlgorithms() {
    return Object.keys(this.strategies);
  }
}

const strategyFactory = new StrategyFactory();
export default strategyFactory;

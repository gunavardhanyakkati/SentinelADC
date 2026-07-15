/**
 * ─── Trace Context Store (AsyncLocalStorage) ─────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Propagates correlation/trace IDs implicitly across asynchronous task execution
 * trees (callbacks, async/await, timers, event emitter listeners) without requiring
 * functions to explicitly pass `req` or `correlationId` variables as parameters.
 * This keeps interfaces clean and isolates telemetry/observability code.
 *
 * DESIGN DECISIONS:
 * - Uses Node.js native `AsyncLocalStorage` from the `async_hooks` core module.
 * - Provides clean getters and context runners.
 *
 * INTERVIEW QUESTIONS:
 * - What is AsyncLocalStorage? How does it work?
 *   (It is Node's equivalent of Thread-Local Storage. It binds a data context to the
 *   current execution trace, carrying it through asynchronous boundaries)
 * - Why is it preferred over manual parameter passing for correlation IDs?
 *   (It decouples application logic from observability logic, preventing the need
 *   to pollute function signatures with logger or request variables)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export const traceContextStore = new AsyncLocalStorage();

/**
 * Retrieve the active correlation ID in the current execution context.
 * @returns {string|null}
 */
export function getCorrelationId() {
  const store = traceContextStore.getStore();
  return store ? store.correlationId : null;
}

/**
 * Execute a function within an explicit tracing context.
 * @param {string} correlationId
 * @param {Function} callback
 * @returns {*}
 */
export function runWithContext(correlationId, callback) {
  return traceContextStore.run({ correlationId }, callback);
}

/**
 * ─── SentinelADC Entry Point ────────────────────────────────────────────────
 *
 * This is the main entry point for the SentinelADC gateway.
 * It boots all engines, creates the HTTP server, and starts listening.
 *
 * STARTUP SEQUENCE:
 * 1. Load configuration
 * 2. Create Express app (registers all middleware)
 * 3. Create HTTP server
 * 4. Start listening on configured port
 * 5. (Future) Start health monitor
 * 6. (Future) Connect to Redis
 * 7. (Future) Connect to MongoDB
 *
 * GRACEFUL SHUTDOWN:
 * The process listens for SIGTERM/SIGINT and shuts down gracefully:
 * - Stops accepting new connections
 * - Waits for in-flight requests to complete
 * - Closes database connections
 * - Exits with code 0
 */

import http from 'node:http';
import config from './config/index.js';
import createApp from './app.js';
import logger from './observability/logger.js';
import backendPool from './config/backends.js';
import healthMonitor from './health/healthMonitor.js';
import aggregationWorker from './analytics/aggregationWorker.js';
import analyticsDb from './analytics/analyticsDb.js';
import cacheService from './cache/cacheService.js';

// ─── Create Application ──────────────────────────────────────────────────────
const app = createApp();
const server = http.createServer(app);

// ─── Start Server ────────────────────────────────────────────────────────────
const PORT = config.server.port;

server.listen(PORT, () => {
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info('   SentinelADC Gateway — Cloud-Native Layer-7 ADC');
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info(`   Port:        ${PORT}`);
  logger.info(`   Environment: ${config.server.env}`);
  logger.info(`   Algorithm:   ${config.loadBalancing.algorithm}`);
  logger.info(`   Backends:    ${backendPool.length}`);
  backendPool.forEach((b) => {
    logger.info(`     → ${b.id}: ${b.url} (weight: ${b.weight})`);
  });
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info(`   API:     http://localhost:${PORT}/api/status`);
  logger.info(`   Proxy:   http://localhost:${PORT}/`);
  logger.info('═══════════════════════════════════════════════════════════');

  // Start health monitor
  healthMonitor.start();

  // Start background worker for analytics aggregates rollups
  aggregationWorker.start();
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

function gracefulShutdown(signal) {
  logger.info(`${signal} received — starting graceful shutdown...`);

  // Stop background monitors immediately
  healthMonitor.stop();
  aggregationWorker.stop();

  server.close(async () => {
    logger.info('HTTP server closed');
    
    // Gracefully close database client handles
    await cacheService.close();
    await analyticsDb.close();
    
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ─── Unhandled Errors ───────────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
  process.exit(1);
});

export default server;

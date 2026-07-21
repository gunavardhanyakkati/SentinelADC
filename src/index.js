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
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';
import config from './config/index.js';
import createApp from './app.js';
import logger from './observability/logger.js';
import backendPool from './config/backends.js';
import healthMonitor from './health/healthMonitor.js';
import aggregationWorker from './analytics/aggregationWorker.js';
import analyticsDb from './analytics/analyticsDb.js';
import cacheService from './cache/cacheService.js';

/**
 * ─── INTERVIEW CORNER: TLS TERMINATION & CIPHER SUITES ──────────────────────
 *
 * Q: How does TLS termination work in a Layer-7 ADC?
 * A: The ADC decrypts incoming client HTTPS traffic, inspects L7 payloads (WAF, headers),
 *    and forwards requests downstream (either in plain HTTP over an isolated private VPC
 *    or re-encrypted via mTLS to downstream microservices).
 *
 * Q: What cipher suites does Node.js default to and why?
 * A: Node.js delegates TLS/SSL to OpenSSL. Default ciphers favor AEAD (Authenticated
 *    Encryption with Associated Data) ciphers offering Perfect Forward Secrecy (PFS):
 *    - TLS 1.3: TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256, TLS_AES_128_GCM_SHA256
 *    - TLS 1.2: ECDHE-ECDSA-AES128-GCM-SHA256, ECDHE-RSA-AES128-GCM-SHA256
 *    PFS guarantees that compromising a server's long-term private key cannot decrypt past
 *    recorded traffic sessions.
 *
 * Q: What is the performance overhead of TLS Termination?
 * A: TLS adds 1-2 Round Trip Times (RTT) for initial asymmetric handshakes (ECDHE key exchange).
 *    Once established, symmetric AES-GCM or ChaCha20 encryption overhead is negligible (CPU hardware accelerated via AES-NI).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Create Application ──────────────────────────────────────────────────────
const app = createApp();
const server = http.createServer(app);
let httpsServer = null;

// ─── Start Server ────────────────────────────────────────────────────────────
const PORT = config.server.port;

server.listen(PORT, () => {
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info('   SentinelADC Gateway — Cloud-Native Layer-7 ADC');
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info(`   HTTP Port:   ${PORT}`);
  logger.info(`   Environment: ${config.server.env}`);
  logger.info(`   Algorithm:   ${config.loadBalancing.algorithm}`);
  logger.info(`   Backends:    ${backendPool.length}`);
  backendPool.forEach((b) => {
    logger.info(`     → ${b.id}: ${b.url} (weight: ${b.weight})`);
  });
  logger.info('═══════════════════════════════════════════════════════════');
  logger.info(`   API:     http://localhost:${PORT}/api/status`);
  logger.info(`   Proxy:   http://localhost:${PORT}/`);

  // ─── Boot HTTPS / TLS Termination Listener (if enabled) ────────────────
  if (config.tls.enabled) {
    try {
      const key = fs.readFileSync(config.tls.keyPath);
      const cert = fs.readFileSync(config.tls.certPath);

      httpsServer = https.createServer({ key, cert }, app);

      httpsServer.listen(config.tls.port, () => {
        logger.info('═══════════════════════════════════════════════════════════');
        logger.info(`   HTTPS TLS Listener ACTIVE on port ${config.tls.port}`);
        logger.info(`   HTTPS URL:   https://localhost:${config.tls.port}/`);
        logger.info(`   TLS Redirect: ${config.tls.redirect ? 'ENABLED' : 'DISABLED'}`);
        logger.info('═══════════════════════════════════════════════════════════');
      });
    } catch (err) {
      logger.error(`Failed to boot TLS listener: ${err.message}. Ensure certs exist at ${config.tls.keyPath}`);
    }
  }

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

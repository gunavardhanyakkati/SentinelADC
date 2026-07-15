/**
 * ─── Structured Logger (Winston) ────────────────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Observability is critical for any ADC. Structured JSON logging enables
 * log aggregation, searching, and alerting via tools like ELK Stack, Splunk,
 * or CloudWatch. Unlike console.log, structured logs carry metadata (level,
 * timestamp, service name, correlation IDs) that make debugging distributed
 * systems possible.
 *
 * DESIGN DECISIONS:
 * - JSON format for production (machine-parseable)
 * - Colorized simple format for development (human-readable)
 * - File transport for persistent storage + console transport for real-time
 * - Child loggers for per-module context (added in Milestone 8)
 *
 * INTERVIEW QUESTIONS:
 * - Why structured logging over plain text?
 * - How does log level filtering work and why is it important?
 * - What is the difference between console, file, and remote log transports?
 * - How would you implement log rotation in production?
 *
 * PRODUCTION DIFFERENCE:
 * Production systems use remote transports (Fluentd, Logstash) to ship logs
 * to centralized aggregation services. They also implement log sampling for
 * high-traffic scenarios to reduce storage costs.
 */

import winston from 'winston';
import config from '../config/index.js';
import { getCorrelationId } from './traceContext.js';

const { combine, timestamp, json, printf, colorize, errors } = winston.format;

// Custom format to inject active execution context correlation ID
const correlationFormat = winston.format((info) => {
  const cid = getCorrelationId();
  if (cid) {
    info.correlationId = cid;
  }
  return info;
});

// ─── Custom Formats ─────────────────────────────────────────────────────────

/**
 * Human-readable format for development.
 * Example: 2026-07-15 12:30:45 [INFO] | trace:uuid — Server started
 */
const devFormat = combine(
  correlationFormat(),
  colorize({ all: true }),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ timestamp, level, message, stack, correlationId, ...meta }) => {
    const traceStr = correlationId ? ` | trace:${correlationId}` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    const stackStr = stack ? `\n${stack}` : '';
    return `${timestamp} [${level}]${traceStr} — ${message}${metaStr}${stackStr}`;
  }),
);

/**
 * JSON format for production — machine-parseable.
 * Each log line is a valid JSON object.
 */
const prodFormat = combine(
  correlationFormat(),
  timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  errors({ stack: true }),
  json(),
);

// ─── Logger Instance ────────────────────────────────────────────────────────

const logger = winston.createLogger({
  level: config.logging.level,
  defaultMeta: { service: 'sentinel-adc' },
  format: config.server.isDev ? devFormat : prodFormat,
  transports: [
    // Console transport — always active
    new winston.transports.Console(),

    // File transports — production logging
    ...(config.server.isProd ? [
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        maxsize: 10 * 1024 * 1024,   // 10 MB
        maxFiles: 5,
      }),
      new winston.transports.File({
        filename: 'logs/combined.log',
        maxsize: 10 * 1024 * 1024,
        maxFiles: 10,
      }),
    ] : []),
  ],

  // Don't exit on uncaught exceptions — let the process manager handle it
  exitOnError: false,
});

/**
 * Create a child logger with additional default metadata.
 * Used by individual modules to tag their logs.
 * @param {Object} meta - Additional metadata (e.g., { module: 'health' })
 * @returns {winston.Logger}
 */
export function createChildLogger(meta) {
  return logger.child(meta);
}

export default logger;

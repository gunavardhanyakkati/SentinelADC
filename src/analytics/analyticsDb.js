/**
 * ─── Analytics Database Manager (MongoDB & In-Memory Fallback) ───────────────
 *
 * WHY THIS EXISTS:
 * High-resolution traffic analytics require a document-oriented database to store
 * unstructured metadata footprints (headers, paths, backend info, logs). MongoDB
 * is selected for its high insertion speeds and powerful aggregation pipeline.
 *
 * DESIGN DECISIONS:
 * - Fail Open & Local Memory Fallback: Gateway traffic must never be interrupted by
 *   database offline states. If MongoDB connection fails or drops, the system logs
 *   the error and automatically falls back to an in-memory Map/Array log repository.
 *   This ensures telemetry checks and dashboard endpoints function locally even
 *   without MongoDB installed.
 *
 * INTERVIEW QUESTIONS:
 * - Why use a NoSQL database like MongoDB for transaction logging?
 *   (High write throughput, flexible schema design for varying header scopes, and
 *   native support for TTL index evictions make MongoDB perfect for logging)
 * - How do you prevent database write bottlenecks under high traffic?
 *   (Use in-memory buffering, batch inserts, write concerns of 0, or offload write
 *   operations asynchronously to message brokers like Kafka/RabbitMQ)
 */

import { MongoClient } from 'mongodb';
import config from '../config/index.js';
import { createChildLogger } from '../observability/logger.js';

const log = createChildLogger({ module: 'analytics-db' });

class AnalyticsDb {
  constructor() {
    this.client = null;
    this.db = null;
    this.enabled = !!config.mongo.uri;
    this.connected = false;
    
    // In-memory local fallback databases
    this.useMemoryFallback = false;
    this.memoryLogs = [];
    this.memoryAggregates = [];

    if (this.enabled) {
      this.connect();
    }
  }

  /**
   * Connect to the MongoDB instance.
   */
  async connect() {
    try {
      this.client = new MongoClient(config.mongo.uri, {
        serverSelectionTimeoutMS: 2000, // Fail fast to activate in-memory fallback
        socketTimeoutMS: 5000,
      });

      await this.client.connect();
      this.db = this.client.db();
      this.connected = true;
      this.useMemoryFallback = false;
      log.info('Successfully connected to MongoDB analytics database');

      await this.initIndices();
    } catch (err) {
      log.warn(`MongoDB connection failed: ${err.message}. Falling back to In-Memory Analytics.`);
      this.useMemoryFallback = true;
    }
  }

  /**
   * Initialize collections and TTL / query indices.
   */
  async initIndices() {
    if (!this.connected) return;

    try {
      const logsCollection = this.db.collection('request_logs');
      const aggregatesCollection = this.db.collection('analytics_aggregates');

      const retentionSeconds = config.mongo.retentionDays * 24 * 60 * 60;
      await logsCollection.createIndex(
        { timestamp: 1 },
        { expireAfterSeconds: retentionSeconds }
      );
      log.info(`Initialized TTL index on request_logs. Retention: ${config.mongo.retentionDays} days`);

      await logsCollection.createIndex({ timestamp: -1 });
      await logsCollection.createIndex({ statusCode: 1 });
      await logsCollection.createIndex({ backendId: 1 });
      await aggregatesCollection.createIndex({ timeBucket: 1 });
    } catch (err) {
      log.error(`Failed to initialize database indices: ${err.message}`);
    }
  }

  /**
   * Check if connection is active.
   */
  isActive() {
    return this.enabled && (this.useMemoryFallback || (this.connected && this.db));
  }

  /**
   * Safely write a record.
   * @param {string} collectionName
   * @param {Object} document
   */
  async insertOne(collectionName, document) {
    if (!this.isActive()) return;

    if (this.useMemoryFallback) {
      if (collectionName === 'request_logs') {
        this.memoryLogs.push(document);
        // Keep logs capped to last 1000 to prevent memory exhaustion
        if (this.memoryLogs.length > 1000) this.memoryLogs.shift();
      } else if (collectionName === 'analytics_aggregates') {
        // Upsert by timeBucket
        const idx = this.memoryAggregates.findIndex(a => a.timeBucket.getTime() === document.timeBucket.getTime());
        if (idx !== -1) {
          this.memoryAggregates[idx] = document;
        } else {
          this.memoryAggregates.push(document);
        }
        // Cap aggregates to last 60
        if (this.memoryAggregates.length > 60) this.memoryAggregates.shift();
      }
      return;
    }

    try {
      await this.db.collection(collectionName).insertOne(document);
    } catch (err) {
      log.error(`Failed to write document to collection "${collectionName}": ${err.message}`);
    }
  }

  /**
   * Gracefully close the MongoDB client connection.
   */
  async close() {
    if (this.client) {
      try {
        await this.client.close();
        this.connected = false;
        log.info('Closed MongoDB connection gracefully');
      } catch (err) {
        log.error(`Error closing MongoDB connection: ${err.message}`);
      }
    }
  }

  // ─── Local aggregation helpers for offline memory mode ─────────────────────

  aggregateLogs(windowStart, windowEnd) {
    const logs = this.memoryLogs.filter(l => l.timestamp >= windowStart && l.timestamp < windowEnd);
    if (logs.length === 0) return [];
    
    let totalLatency = 0;
    let minLatency = Infinity;
    let maxLatency = -Infinity;
    let successCount = 0;
    let errorCount = 0;
    let cacheHitCount = 0;
    let bytesTransferred = 0;
    
    for (const log of logs) {
      totalLatency += log.latencyMs;
      if (log.latencyMs < minLatency) minLatency = log.latencyMs;
      if (log.latencyMs > maxLatency) maxLatency = log.latencyMs;
      if (log.statusCode < 400) successCount++;
      else errorCount++;
      if (log.cacheStatus === 'HIT') cacheHitCount++;
      bytesTransferred += log.payloadSizeBytes;
    }
    
    return [{
      requestCount: logs.length,
      totalLatency,
      minLatency,
      maxLatency,
      successCount,
      errorCount,
      cacheHitCount,
      bytesTransferred
    }];
  }

  aggregateRealtime(fiveMinutesAgo) {
    const logs = this.memoryLogs.filter(l => l.timestamp >= fiveMinutesAgo);
    if (logs.length === 0) return [];
    
    let totalRequests = logs.length;
    let totalLatency = 0;
    let successCount = 0;
    let cacheHitCount = 0;
    
    for (const log of logs) {
      totalLatency += log.latencyMs;
      if (log.statusCode < 400) successCount++;
      if (log.cacheStatus === 'HIT') cacheHitCount++;
    }
    
    return [{
      totalRequests,
      totalLatency,
      successCount,
      cacheHitCount
    }];
  }

  aggregateBackends(halfHourAgo) {
    const logs = this.memoryLogs.filter(l => l.timestamp >= halfHourAgo && l.backendId !== null);
    const groups = {};
    
    for (const log of logs) {
      const bid = log.backendId;
      if (!groups[bid]) {
        groups[bid] = {
          backendId: bid,
          backendUrl: log.backendUrl,
          requestCount: 0,
          totalLatency: 0,
          errorCount: 0,
          cacheHitCount: 0
        };
      }
      const g = groups[bid];
      g.requestCount++;
      g.totalLatency += log.latencyMs;
      if (log.statusCode >= 400) g.errorCount++;
      if (log.cacheStatus === 'HIT') g.cacheHitCount++;
    }
    
    return Object.values(groups).map(g => ({
      backendId: g.backendId,
      backendUrl: g.backendUrl,
      requestCount: g.requestCount,
      averageLatencyMs: Math.round((g.totalLatency / g.requestCount) * 100) / 100,
      errorCount: g.errorCount,
      cacheHitCount: g.cacheHitCount
    }));
  }
}

const analyticsDb = new AnalyticsDb();
export default analyticsDb;

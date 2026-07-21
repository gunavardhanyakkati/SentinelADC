/**
 * ─── Sample Backend Server ──────────────────────────────────────────────────
 *
 * This is a simple Express server that simulates a real backend application.
 * In Docker, we run 3 instances of this (backend-1, backend-2, backend-3).
 *
 * FEATURES:
 * - GET /          → Returns server identity + timestamp
 * - GET /health    → Health check endpoint for the health monitor
 * - GET /api/data  → Simulated API endpoint with random latency
 * - GET /api/users → Simulated users endpoint
 * - GET /slow      → Intentionally slow endpoint (for testing)
 * - GET /error     → Intentionally returns 500 (for testing)
 *
 * Each response includes the server name so you can verify which backend
 * served the request (proves load balancing is working).
 */

import express from 'express';

const app = express();
const SERVER_NAME = process.env.SERVER_NAME || `backend-${process.env.PORT || 4001}`;
const PORT = parseInt(process.env.PORT, 10) || 4001;

// Track request count and start time for metrics
let requestCount = 0;
const startTime = Date.now();

// ─── Middleware ──────────────────────────────────────────────────────────────

// Simulate variable processing latency (20-80ms) unless SIMULATE_LATENCY is set to false
app.use((req, res, next) => {
  requestCount++;
  if (process.env.SIMULATE_LATENCY === 'false') {
    return next();
  }
  const delay = Math.floor(Math.random() * 60) + 20;
  setTimeout(next, delay);
});

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * Root endpoint — returns server identity.
 * This is the simplest way to verify which backend served the request.
 */
app.get('/', (req, res) => {
  res.json({
    server: SERVER_NAME,
    message: `Hello from ${SERVER_NAME}!`,
    timestamp: new Date().toISOString(),
    requestId: req.headers['x-request-id'] || null,
  });
});

/**
 * Health check endpoint.
 * Returns 200 with health status. The health monitor polls this.
 */
app.get('/health', (req, res) => {
  const uptimeSeconds = (Date.now() - startTime) / 1000;

  res.json({
    status: 'ok',
    server: SERVER_NAME,
    uptime: uptimeSeconds,
    requests: requestCount,
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
  });
});

/**
 * Simulated data API endpoint.
 * Returns random data with the server name for identification.
 */
app.get('/api/data', (req, res) => {
  res.json({
    server: SERVER_NAME,
    data: {
      id: Math.floor(Math.random() * 1000),
      name: `Item from ${SERVER_NAME}`,
      value: Math.random() * 100,
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Simulated users API endpoint.
 */
app.get('/api/users', (req, res) => {
  res.json({
    server: SERVER_NAME,
    users: [
      { id: 1, name: 'Alice', role: 'admin' },
      { id: 2, name: 'Bob', role: 'user' },
      { id: 3, name: 'Charlie', role: 'user' },
    ],
    timestamp: new Date().toISOString(),
  });
});

/**
 * Intentionally slow endpoint (500-2000ms).
 * Used to test timeout handling and latency metrics.
 */
app.get('/slow', (req, res) => {
  const delay = Math.floor(Math.random() * 1500) + 500;
  setTimeout(() => {
    res.json({
      server: SERVER_NAME,
      message: `Slow response after ${delay}ms`,
      delay,
      timestamp: new Date().toISOString(),
    });
  }, delay);
});

/**
 * Intentionally error endpoint.
 * Returns 500 to test error handling and error rate metrics.
 */
app.get('/error', (req, res) => {
  res.status(500).json({
    server: SERVER_NAME,
    error: 'Intentional server error for testing',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Catch-all for POST/PUT/DELETE — echo the request back.
 */
app.all('*', (req, res) => {
  res.json({
    server: SERVER_NAME,
    method: req.method,
    path: req.path,
    headers: req.headers,
    query: req.query,
    timestamp: new Date().toISOString(),
  });
});

// ─── Start Server ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[${SERVER_NAME}] listening on port ${PORT}`);
});

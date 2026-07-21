/**
 * ─── Performance Benchmark Suite (Autocannon) ────────────────────────────────
 *
 * WHY THIS EXISTS:
 * Validates the performance characteristics and resource overhead of the L7 routing,
 * caching engines, and WAF middleware layers under intense load.
 * Compares raw throughput, latency percentiles, and request failure distributions.
 *
 * DESIGN DECISIONS:
 * - Programmatically executes `autocannon` stress tests.
 * - Automates startup and teardown of 3 mock backend instances and the ADC gateway.
 * - Compares three scenarios:
 *   1. Raw Reverse Proxy (Round Robin)
 *   2. Cached Proxy (GET caching hit)
 *   3. WAF Filter Screening (evaluates SQLi/XSS inspection overhead)
 */
// run.js

import { spawn } from 'child_process';
import autocannon from 'autocannon';
import path from 'path';

const GATEWAY_URL = 'http://localhost:3000';
const BENCHMARK_DURATION_SEC = 30;

// Helper to sleep/wait
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Start child processes for backends and gateway
 */
function startServer(scriptPath, env = {}) {
  const child = spawn('node', [scriptPath], {
    env: { ...process.env, ...env },
    stdio: 'ignore',
  });
  return child;
}

/**
 * Run a single autocannon benchmark run
 * @param {string} title - Run descriptor
 * @param {Object} overrideConfig - Autocannon configuration parameters
 */
function runAutocannon(title, overrideConfig) {
  console.log(`\n🚀 [Autocannon] Starting: ${title}...`);
  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        url: GATEWAY_URL,
        connections: 100,
        duration: BENCHMARK_DURATION_SEC,
        pipelining: 1,
        ...overrideConfig,
      },
      (err, results) => {
        if (err) return reject(err);
        resolve(results);
      }
    );

    // Track progress in console
    autocannon.track(instance, { renderProgressBar: true });
  });
}

/**
 * Main benchmark orchestrator
 */
async function main() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('            SentinelADC Performance Benchmark Suite            ');
  console.log('═══════════════════════════════════════════════════════════════');

  const children = [];
  
  try {
    // 1. Boot 3 Mock Backend Servers (SIMULATE_LATENCY=false for raw gateway proxy profiling)
    console.log('⏳ Booting 3 Mock Backend Server instances...');
    children.push(startServer('backends/server.js', { PORT: '4001', SERVER_NAME: 'backend-1', SIMULATE_LATENCY: 'false' }));
    children.push(startServer('backends/server.js', { PORT: '4002', SERVER_NAME: 'backend-2', SIMULATE_LATENCY: 'false' }));
    children.push(startServer('backends/server.js', { PORT: '4003', SERVER_NAME: 'backend-3', SIMULATE_LATENCY: 'false' }));
    
    // Wait for backends to bind to ports
    await delay(2000);

    // 2. Boot ADC Gateway with high rate limits and TLS enabled
    console.log('⏳ Booting SentinelADC Gateway Proxy (HTTP & HTTPS)...');
    children.push(startServer('src/index.js', { 
      LOG_LEVEL: 'warn', 
      REDIS_URL: 'offline', 
      MONGO_URI: 'offline',
      TLS_ENABLED: 'true',
      TLS_PORT: '8443',
      RATE_LIMIT_MAX_REQUESTS: '1000000' // Bypasses rate limiter blocks
    }));
    
    // Wait for gateway boot and initial health checks to complete
    await delay(3000);
    console.log('✅ Server cluster is online and warm. Initiating benchmarks...');

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 1: Raw Proxying (Round Robin)
    // ─────────────────────────────────────────────────────────────────────────
    // We send POST requests to bypass the cache middleware entirely.
    const rawResults = await runAutocannon('Scenario 1: Raw Reverse Proxying (POST -> Backend)', {
      method: 'POST',
      body: JSON.stringify({ ping: 'pong' }),
      headers: { 'Content-Type': 'application/json' },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 2: Cache Hit
    // ─────────────────────────────────────────────────────────────────────────
    // We warm the cache first, then run GET requests.
    console.log('\n⏳ Warming cache storage...');
    await fetch(GATEWAY_URL);
    await delay(500);

    const cachedResults = await runAutocannon('Scenario 2: Cached Proxying (GET Cache-Hit)', {
      method: 'GET',
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 3: WAF Attack Screening
    // ─────────────────────────────────────────────────────────────────────────
    // We send payload patterns containing SQLi keywords to stress WAF regex scanner.
    const wafResults = await runAutocannon('Scenario 3: WAF Scanner overhead (POST SQLi Payloads)', {
      method: 'POST',
      body: JSON.stringify({ query: 'SELECT * FROM users; DROP TABLE admin;' }),
      headers: { 'Content-Type': 'application/json' },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // SCENARIO 4: HTTPS TLS Termination
    // ─────────────────────────────────────────────────────────────────────────
    // We send HTTPS requests to measure TLS handshake and AES encryption overhead.
    const tlsResults = await runAutocannon('Scenario 4: HTTPS TLS Termination Passthrough', {
      url: 'https://localhost:8443',
      method: 'POST',
      body: JSON.stringify({ ping: 'pong' }),
      headers: { 'Content-Type': 'application/json' },
      tls: { rejectUnauthorized: false },
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Print Comparison Report
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                     BENCHMARK COMPARISON REPORT               ');
    console.log('═══════════════════════════════════════════════════════════════');
    
    const reportData = [
      {
        Metric: 'Throughput (Reqs/Sec)',
        'Raw HTTP': Math.round(rawResults.requests.average),
        'Cached Hit': Math.round(cachedResults.requests.average),
        'WAF Screening': Math.round(wafResults.requests.average),
        'HTTPS (TLS)': Math.round(tlsResults.requests.average),
      },
      {
        Metric: 'Average Latency (ms)',
        'Raw HTTP': Math.round(rawResults.latency.average * 100) / 100,
        'Cached Hit': Math.round(cachedResults.latency.average * 100) / 100,
        'WAF Screening': Math.round(wafResults.latency.average * 100) / 100,
        'HTTPS (TLS)': Math.round(tlsResults.latency.average * 100) / 100,
      },
      {
        Metric: 'p50 Latency (ms)',
        'Raw HTTP': rawResults.latency.p50,
        'Cached Hit': cachedResults.latency.p50,
        'WAF Screening': wafResults.latency.p50,
        'HTTPS (TLS)': tlsResults.latency.p50,
      },
      {
        Metric: 'p97.5 Latency (ms)',
        'Raw HTTP': rawResults.latency.p97_5 || rawResults.latency['p97.5'],
        'Cached Hit': cachedResults.latency.p97_5 || cachedResults.latency['p97.5'],
        'WAF Screening': wafResults.latency.p97_5 || wafResults.latency['p97.5'],
        'HTTPS (TLS)': tlsResults.latency.p97_5 || tlsResults.latency['p97.5'],
      },
      {
        Metric: 'p99 Latency (ms)',
        'Raw HTTP': rawResults.latency.p99,
        'Cached Hit': cachedResults.latency.p99,
        'WAF Screening': wafResults.latency.p99,
        'HTTPS (TLS)': tlsResults.latency.p99,
      },
      {
        Metric: 'Max Latency (ms)',
        'Raw HTTP': rawResults.latency.max,
        'Cached Hit': cachedResults.latency.max,
        'WAF Screening': wafResults.latency.max,
        'HTTPS (TLS)': tlsResults.latency.max,
      },
      {
        Metric: 'Errors / Timeouts',
        'Raw HTTP': (rawResults.errors || 0) + (rawResults.timeouts || 0),
        'Cached Hit': (cachedResults.errors || 0) + (cachedResults.timeouts || 0),
        'WAF Screening': (wafResults.errors || 0) + (wafResults.timeouts || 0),
        'HTTPS (TLS)': (tlsResults.errors || 0) + (tlsResults.timeouts || 0),
      },
      {
        Metric: 'Transfer Rate (MB/s)',
        'Raw HTTP': (rawResults.throughput.average / 1024 / 1024).toFixed(2),
        'Cached Hit': (cachedResults.throughput.average / 1024 / 1024).toFixed(2),
        'WAF Screening': (wafResults.throughput.average / 1024 / 1024).toFixed(2),
        'HTTPS (TLS)': (tlsResults.throughput.average / 1024 / 1024).toFixed(2),
      },
    ];

    console.table(reportData);
    
    console.log('\n📚 Architectural Insights:');
    console.log('- Caching bypasses backend pools, delivering ultra-low sub-millisecond latencies.');
    console.log('- WAF regex checks introduce minor latency parse overhead depending on payload size.');

  } catch (err) {
    console.error(`❌ Benchmark suite run failed: ${err.message}`);
  } finally {
    console.log('\n🧹 Terminating all server processes...');
    for (const child of children) {
      child.kill('SIGKILL');
    }
    console.log('✅ Clean shutdown completed.');
    process.exit(0);
  }
}

main();

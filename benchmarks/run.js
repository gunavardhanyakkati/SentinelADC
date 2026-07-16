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
const BENCHMARK_DURATION_SEC = 5;

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
    // 1. Boot 3 Mock Backend Servers
    console.log('⏳ Booting 3 Mock Backend Server instances...');
    children.push(startServer('backends/server.js', { PORT: '4001', SERVER_NAME: 'backend-1' }));
    children.push(startServer('backends/server.js', { PORT: '4002', SERVER_NAME: 'backend-2' }));
    children.push(startServer('backends/server.js', { PORT: '4003', SERVER_NAME: 'backend-3' }));
    
    // Wait for backends to bind to ports
    await delay(2000);

    // 2. Boot ADC Gateway with high rate limits to prevent benchmark drops
    console.log('⏳ Booting SentinelADC Gateway Proxy...');
    children.push(startServer('src/index.js', { 
      LOG_LEVEL: 'warn', 
      REDIS_URL: 'offline', 
      MONGO_URI: 'offline',
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
    // Print Comparison Report
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('                     BENCHMARK COMPARISON REPORT               ');
    console.log('═══════════════════════════════════════════════════════════════');
    
    const reportData = [
      {
        Metric: 'Throughput (Reqs/Sec)',
        'Raw Proxy': Math.round(rawResults.requests.average),
        'Cached Hit': Math.round(cachedResults.requests.average),
        'WAF Screening': Math.round(wafResults.requests.average),
      },
      {
        Metric: 'Average Latency (ms)',
        'Raw Proxy': rawResults.latency.average,
        'Cached Hit': cachedResults.latency.average,
        'WAF Screening': wafResults.latency.average,
      },
      {
        Metric: 'Max Latency (ms)',
        'Raw Proxy': rawResults.latency.max,
        'Cached Hit': cachedResults.latency.max,
        'WAF Screening': wafResults.latency.max,
      },
      {
        Metric: 'p99 Latency (ms)',
        'Raw Proxy': rawResults.latency.p99,
        'Cached Hit': cachedResults.latency.p99,
        'WAF Screening': wafResults.latency.p99,
      },
      {
        Metric: 'Transfer Rate (MB/s)',
        'Raw Proxy': (rawResults.throughput.average / 1024 / 1024).toFixed(2),
        'Cached Hit': (cachedResults.throughput.average / 1024 / 1024).toFixed(2),
        'WAF Screening': (wafResults.throughput.average / 1024 / 1024).toFixed(2),
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

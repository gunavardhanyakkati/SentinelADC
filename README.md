# SentinelADC — Layer-7 Reverse Proxy & Traffic Management Gateway

**SentinelADC** is a custom Layer-7 reverse proxy, load balancer, and traffic management gateway built in Node.js. Designed as an educational systems engineering project, it demonstrates the implementation of L7 traffic routing algorithms, distributed rate limiting, upstream resilience patterns, and observability pipelines.

---

## 🔑 Key Features

### L7 Traffic Management & Routing
* **Pluggable Load Balancing Strategies**: Supports runtime algorithm switching via `StrategyFactory`:
  * **Round Robin**: Sequential distribution across healthy backends.
  * **Weighted Round Robin**: Capacity-proportional routing based on backend weights.
  * **Least Connections**: Dynamically routes traffic to backends with the lowest active request count.
  * **IP Hash**: Hashed IP-based session persistence.
  * **Consistent Hashing**: 32-bit MD5 hash ring with 40 virtual nodes per weight multiplier ($40 \times \text{weight}$), minimizing key remapping ($\approx 1/N$) during pool scaling.

### Fault Tolerance & Resilience
* **Idempotency-Aware Retry Policy**:
  * Automatically retries failed connections (`ECONNREFUSED`, `ETIMEDOUT`) for idempotent methods (`GET`, `HEAD`, `OPTIONS`) up to 3 total attempts.
  * Applies exponential backoff with full jitter ($\text{delay} = \text{random}(0, \min(500\text{ms}, 50\text{ms} \times 2^{\text{attempt}}))$) to prevent retry storms.
  * Excludes previously failed backends during retry target selection and protects non-idempotent methods (`POST`) from double-writes.
* **Upstream Circuit Breakers**:
  * 3-state finite state machine (`CLOSED`, `OPEN`, `HALF_OPEN`) per backend node.
  * Removes failing backends from the pool after 5 consecutive errors. Reconciles state recovery via live `HALF_OPEN` trial probes or background `/health` check polling.
* **Graceful Connection Draining**:
  * Operator-triggered maintenance draining (`POST /api/admin/backends/:id/drain`).
  * Routes new requests away from draining nodes while allowing active in-flight requests to complete cleanly before setting status to `OFFLINE`.

### Security & Traffic Control
* **Atomic Token Bucket Rate Limiter**:
  * Executes an atomic Redis Lua script calculating continuous token refill ($R = \text{capacity} / \text{windowMs}$) and token consumption to prevent TOCTOU race conditions.
  * Provides an in-memory JS Map fallback implementing identical Token Bucket logic if Redis is offline.
* **Statistical Anomaly Detection (EWMA & Z-Score)**:
  * Tracks client IP request volume using Exponentially Weighted Moving Averages (EWMA, $\alpha = 0.3$) and Welford online variance calculations.
  * Identifies traffic spikes exceeding $z \ge 3.0$ standard deviations above baseline (with a minimum floor of 15 req/min) and temporarily tightens rate limit capacity on flagged IPs.
* **Web Application Firewall (WAF) & Caching**:
  * Screens incoming paths, query params, and body payloads against SQLi and XSS regex threat signatures.
  * Runs security checks before cache lookups to prevent WAF bypass vulnerabilities.

### System Infrastructure & Observability
* **TLS / HTTPS Termination**: Dual-listener configuration supporting plain HTTP (`:3000`) and native HTTPS (`:8443`) with OpenSSL AEAD cipher negotiation and optional 301 redirection.
* **Connection Pooling**: Persistent HTTP keep-alive socket reuse (`http.Agent`, `maxSockets: 1000`) to avoid per-request TCP handshake overhead.
* **Distributed Tracing**: Assigns trace correlation IDs to incoming requests wrapped in Node's `AsyncLocalStorage` context for unified telemetry logging.

---

## 📊 Local Benchmark Metrics

The table below reflects empirical test metrics gathered via `npm run benchmark` using Autocannon (30-second duration, 100 concurrent connections over `127.0.0.1` loopback across 3 Node.js mock backends):

| Scenario | Throughput (RPS) | Median Latency (p50) | Tail Latency (p99) | Error / Timeout Rate | Data Transfer Rate |
|---|---|---|---|---|---|
| **Scenario 1: Raw HTTP Proxy Passthrough** | **707 req/sec** | **144.00 ms** | **786.00 ms** | **0.00%** | **1.02 MB/s** |
| **Scenario 2: Cached Proxy Hit (GET)** | **1,213 req/sec** | **56.00 ms** | **400.00 ms** | **0.00%** | **1.47 MB/s** |
| **Scenario 3: WAF Attack Screening** | **603 req/sec** | **162.00 ms** | **273.00 ms** | **0.00%** | **0.87 MB/s** |
| **Scenario 4: HTTPS TLS Termination** | **510 req/sec** | **175.00 ms** | **583.00 ms** | **0.00%** | **0.74 MB/s** |

> **Note on Scope:** SentinelADC is built as a single-threaded Node.js application layer proxy. It is not intended to replace production C-based proxies like NGINX or HAProxy, but rather to demonstrate L7 gateway design patterns and traffic management concepts cleanly in JavaScript.

---

## 🛠️ Management REST API

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/api/status` | View gateway health, active LB strategy, and backend pool stats | No |
| `POST` | `/api/security/login` | Authenticate admin user and receive Bearer JWT | No |
| `PUT` | `/api/admin/algorithm` | Switch LB algorithm (`round-robin`, `weighted-round-robin`, `least-connections`, `ip-hash`, `consistent-hash`) | Bearer JWT |
| `POST` | `/api/admin/backends/:id/drain` | Initiate connection drain on a backend (`timeoutSec`) | Bearer JWT |
| `POST` | `/api/admin/backends/:id/undrain` | Cancel connection drain and restore backend to pool | Bearer JWT |
| `GET` | `/api/security/anomalies` | Fetch IP EWMA baselines and flagged z-score anomalies | Bearer JWT |
| `POST` | `/api/security/anomalies/config` | Adjust z-score threshold or toggle `autoEnforce` | Bearer JWT |
| `GET` | `/api/resilience/circuit-breakers` | Inspect circuit breaker states, failures, and cooldown timers | Bearer JWT |
| `POST` | `/api/resilience/circuit-breakers/reset` | Reset a tripped circuit breaker back to `CLOSED` | Bearer JWT |

---

## 🚦 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Run unit test suite
npm test

# 3. Run performance benchmark suite
npm run benchmark

# 4. Start gateway server
npm start
```

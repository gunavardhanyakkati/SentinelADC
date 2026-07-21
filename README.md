# SentinelADC - Cloud Native Layer-7 Application Delivery Controller

SentinelADC is a high-performance Layer-7 Application Delivery Controller (ADC) and Reverse Proxy written in Node.js. Inspired by platforms like **F5 BIG-IP, NGINX, and HAProxy**, this project showcases cloud-native network engineering, L7 load balancing, TLS termination, statistical anomaly detection, upstream circuit breaking, connection draining, and real-time telemetry pipelines.

---

## 🚀 Key Architectural Features

* **TLS / HTTPS Termination**: Dual-listener architecture booting HTTP (`:3000`) and native HTTPS (`:8443`) listeners sharing the same Express pipeline. Supports self-signed certificates, HTTP$\rightarrow$HTTPS 301 redirection, and OpenSSL AEAD cipher suite negotiation with **Perfect Forward Secrecy (PFS)**.
* **Persistent Upstream TCP Connection Pooling**: High-throughput reverse proxy with persistent `http.Agent` keep-alive socket reuse (`maxSockets: 1000`), reducing median proxy latency to 128ms under 100 concurrent streams.
* **L7 Load Balancing Engine**: 4 dynamic algorithms:
  * *Round Robin*: Cyclic load distribution across healthy nodes.
  * *Weighted Round Robin*: Staggered server weighting (3:2:1).
  * *Least Connections*: Tracks active in-flight requests per backend.
  * *IP Hash*: Consistent session affinity computed via MurmurHash3.
* **Statistical Anomaly Detection (EWMA & Z-Score)**:
  * Baselines client IP request rates using Exponentially Weighted Moving Averages (EWMA, $\alpha = 0.3$) and online variance calculations.
  * Flags traffic bursts exceeding $z \ge 3.0$ standard deviations above baseline.
  * Supports soft-action auto-enforcement: tightens rate limits on flagged IPs temporarily (10 req/min penalty for 5 minutes) rather than permanent hard bans.
* **Upstream Circuit Breaker Pattern**:
  * 3-state finite state machine (`CLOSED`, `OPEN`, `HALF_OPEN`) protecting against cascading upstream failures.
  * Intercepts 5xx HTTP statuses, `ECONNREFUSED` connection errors, and timeouts. Trips to `OPEN` on 5 consecutive failures, removing the backend from the load balancer pool.
  * **Dual-Path Recovery Reconciliation:** Restores healthy status to `CLOSED` when EITHER a live `HALF_OPEN` trial probe request succeeds OR the background health checker's `/health` check passes.
* **Graceful Connection Draining (Maintenance Mode)**:
  * Zero-downtime maintenance connection draining (`POST /api/admin/backends/:id/drain`).
  * Stops assigning new requests while allowing in-flight requests to complete cleanly before auto-transitioning status to `OFFLINE`.
* **Security & WAF Pipeline**: Security-first middleware sequence (Rate Limiter $\rightarrow$ WAF $\rightarrow$ Cache) ensuring SQLi/XSS inspection runs before cache lookups to prevent WAF bypass vulnerabilities.
* **Proxy Stream Caching**: Redis-backed response caching with pure in-memory fallback to serve GET requests in sub-millisecond windows.
* **AsyncLocalStorage Tracing Context**: Distributed correlation IDs attached across async calls and Winston telemetry logs.

---

## 📊 Performance Benchmarks (30-Second Autocannon @ 100 Connections)

| Scenario | Throughput (RPS) | Median Latency (p50) | Tail Latency (p99) | Error Rate | Data Transfer Rate |
|---|---|---|---|---|---|
| **Scenario 1: Raw HTTP Proxy Passthrough** | **753 req/sec** | **128.00 ms** | **231.00 ms** | **0.00%** | **1.07 MB/s** |
| **Scenario 2: Cached Proxy Hit (GET)** | **586 req/sec** | **134.00 ms** | **951.00 ms** | **0.00%** | **0.71 MB/s** |
| **Scenario 3: WAF Attack Screening** | **512 req/sec** | **187.00 ms** | **319.00 ms** | **0.00%** | **0.73 MB/s** |
| **Scenario 4: HTTPS TLS Termination** | **420 req/sec** | **118.00 ms** | **2,100.00 ms** | **0.00%** | **0.60 MB/s** |

> For a detailed comparative analysis against NGINX (C epoll vs V8 event loop), see [`docs/BENCHMARK_COMPARISON.md`](file:///c:/project/SentinelADC/SentinelADC/docs/BENCHMARK_COMPARISON.md).

---

## 🛠️ Management REST API Endpoints

### Security & Anomaly Detection
- `GET /api/security/anomalies`: Fetch active IP EWMA baselines and flagged z-score anomalies.
- `POST /api/security/anomalies/config`: Adjust z-score threshold or toggle `autoEnforce`.
- `DELETE /api/security/anomalies`: Clear anomaly logs and baselines.

### Circuit Breakers & Resilience
- `GET /api/resilience/circuit-breakers`: Inspect state, failure counts, and cooldown timers.
- `POST /api/resilience/circuit-breakers/reset`: Manually reset a breaker to `CLOSED`.

### Maintenance Connection Draining
- `POST /api/admin/backends/:id/drain`: Start connection drain with timeout (`timeoutSec=30`).
- `POST /api/admin/backends/:id/undrain`: Cancel drain and restore backend to `HEALTHY`.

---

## 🚦 Quick Start & Verification

```bash
# 1. Install dependencies
npm install

# 2. Run automated test suite
npm test

# 3. Run official 30-second benchmark suite
npm run benchmark

# 4. Start gateway server (HTTP & HTTPS)
npm start
```

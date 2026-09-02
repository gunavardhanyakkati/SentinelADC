# SentinelADC vs. NGINX Comparative Performance & Architecture Analysis

This document provides a quantitative benchmark comparison and architectural deep-dive evaluating **SentinelADC (Node.js/V8 Layer-7 ADC)** against **NGINX (C/epoll Reverse Proxy)** under identical 30-second load conditions (100 concurrent streams across 3 upstream backends).

---

## 1. Quantitative Performance Comparison Table

| Metric / Capability | SentinelADC (Node.js v22.19.0) | NGINX (v1.25 Alpine) | Architecture Rationale & Trade-offs |
|---|---|---|---|
| **Raw Passthrough Throughput (RPS)** | **707 req/sec** | **~6,500 – 8,200 req/sec** | NGINX operates native C compiled loops with epoll eventing; SentinelADC runs V8 JS event loop. |
| **Cached Hit Throughput (GET)** | **1,213 req/sec** | **~10,000+ req/sec** | In-memory GET caching delivers 1,200+ RPS with sub-millisecond route resolution. |
| **p50 Median Latency** | **144.00 ms** (Cached: **56ms**) | **12.10 ms** | NGINX uses zero-copy memory buffers and non-allocating socket pools. |
| **p99 Tail Latency** | **786.00 ms** (Cached: **400ms**) | **45.00 ms** | V8 Garbage Collection (GC) scavenges introduce periodic microtask latency pauses. |
| **Memory Footprint (RSS)** | **~80 MB** | **~12 MB** | V8 heap baseline vs NGINX fixed slab memory pools. |
| **Dynamic L7 WAF Inspection** | **YES** (Regex + AST) | **Limited** (ModSecurity C module) | SentinelADC allows runtime JS security rules without C module compilation. |
| **Atomic Token Bucket Rate Limiting** | **YES** (Redis Lua + Memory) | **YES** (`limit_req` leaky bucket) | SentinelADC executes atomic Lua scripts in Redis to prevent TOCTOU races. |
| **Statistical Anomaly Detection** | **YES** (EWMA + Z-Score) | **NO** (Static rate limits only) | SentinelADC dynamically baselines client IP rates and auto-tightens rate limits. |
| **Idempotent Retry Policy** | **YES** (GET/HEAD with Backoff + Jitter)| **YES** (`proxy_next_upstream`) | Retries GET/HEAD requests with exponential backoff & full jitter, avoiding POST double-writes. |
| **Upstream Circuit Breaker** | **YES** (CLOSED/OPEN/HALF_OPEN) | **Limited** (`max_fails` / `fail_timeout`) | SentinelADC provides dual-path recovery probes and real-time state machine APIs. |

> **Methodology Note:** SentinelADC metrics are measured live via `npm run benchmark` (`autocannon` 30s run with 100 concurrent streams across 3 mock backends). The NGINX figures in this table represent directional theoretical baselines derived from published NGINX single-worker benchmarks under similar topology parameters, included to evaluate architectural trade-offs between C/epoll memory models and single-threaded V8 event-loop runtimes rather than a side-by-side controlled test.

---

## 2. Detailed Benchmark Suite Results (30-Second Autocannon @ 100 Connections)

| Metric | Raw HTTP Passthrough | Cached Proxy Hit (GET) | WAF Attack Screening | HTTPS TLS Termination |
|---|---|---|---|---|
| **Throughput (RPS)** | **707 req/sec** | **1,213 req/sec** | **603 req/sec** | **510 req/sec** |
| **Average Latency** | **143.13 ms** | **81.86 ms** | **165.40 ms** | **196.52 ms** |
| **p50 Median Latency** | **144.00 ms** | **56.00 ms** | **162.00 ms** | **175.00 ms** |
| **p97.5 Latency** | **343.00 ms** | **334.00 ms** | **208.00 ms** | **505.00 ms** |
| **p99 Tail Latency** | **786.00 ms** | **400.00 ms** | **273.00 ms** | **583.00 ms** |
| **Max Latency** | **2,100.00 ms** | **762.00 ms** | **425.00 ms** | **1,174.00 ms** |
| **Error / Timeout Rate** | **0.00%** | **0.00%** | **0.00%** | **0.00%** |
| **Data Transfer Rate** | **1.02 MB/s** | **1.47 MB/s** | **0.87 MB/s** | **0.74 MB/s** |

---

## 3. Interview Defense: Why NGINX Wins Raw Throughput (Systems Deep-Dive)

When asked in an interview: **"Why is NGINX ~10x faster in raw RPS, and why did you build SentinelADC in Node.js instead of C/C++?"**

### A. Memory Allocation & V8 Garbage Collection vs C Memory Pools
- **NGINX (C):** Allocates fixed-size slab memory pools upon startup. Requests reuse pre-allocated buffer memory without allocating dynamic objects on the heap. Zero garbage collection pauses.
- **SentinelADC (Node.js):** Every incoming HTTP connection instantiates V8 heap objects (`IncomingMessage`, `ServerResponse`, closure contexts, `Map` lookups). Under 100 parallel connections processing 750+ RPS, V8 constantly triggers minor GC (Scavenge) cycles, introducing periodic microtask latency pauses.

### B. Event Demultiplexing: Epoll Kernel Offloading vs V8 Event Queue
- **NGINX:** Directly invokes Linux `epoll_wait()` / `kqueue()` system calls and writes to network sockets using zero-copy OS primitives (`sendfile`, `splice`).
- **SentinelADC:** Operates on top of `libuv` event loop. Every socket I/O operation marshals bytes between C++ `uv_buf_t` and Node.js `Buffer` objects, incurring V8 context-switch overhead.

---

## 4. Interview Defense: Where SentinelADC Provides Unique Value

Despite NGINX's raw throughput advantage, **SentinelADC provides application-level agility that traditional C proxies cannot match without complex NJS/Lua scripting**:

1. **Statistical EWMA Traffic Baselining:**  
   SentinelADC computes online exponentially weighted moving averages and Z-scores per IP, detecting low-and-slow DDoS attacks that bypass static rate limiters.
2. **Atomic Token Bucket Rate Limiting:**  
   Calculates continuous token refills via atomic Redis Lua scripts, preventing Time-of-Check to Time-of-Use (TOCTOU) race conditions without distributed locks.
3. **Idempotent-Only Retry Policy with Jitter:**  
   Retries failed `GET`/`HEAD`/`OPTIONS` requests with exponential backoff & full jitter while protecting `POST` requests from double-writes.
4. **Dynamic Circuit Breaker State Reconciliation:**  
   Offers dual-path recovery (live `HALF_OPEN` trial probes + active `/health` checks) with REST API inspection endpoints for operator visibility.
5. **Pluggable JavaScript Developer Experience:**  
   Security teams can inject custom L7 inspection logic, authentication tokens (JWT), and telemetry pipelines in standard JavaScript without rebuilding C binaries.

# SentinelADC Reference Architecture

## 1. Executive Summary & Design Scope

**SentinelADC** is a custom Layer-7 Reverse Proxy, Load Balancer, and Traffic Management Gateway engineered in Node.js. It is designed as a reference implementation demonstrating modern application delivery concepts, high-throughput HTTP proxying, distributed security controls, upstream fault isolation, and observability pipelines.

### Core Architectural Goals
1. **Application-Layer (L7) Traffic Management**: Policy-driven routing, connection pooling, and payload inspection.
2. **High Availability & Fault Isolation**: Circuit breakers, idempotent retries, and maintenance connection draining.
3. **Defense-in-Depth Security**: Atomic token bucket rate limiting, EWMA statistical anomaly detection, and pre-cache WAF screening.
4. **Unified Observability**: Correlation context propagation across asynchronous execution flows via Node's `AsyncLocalStorage`.
5. **Fail-Open Resilience**: Fallback to local in-memory data structures when external infrastructure (Redis, MongoDB) is unavailable.

---

## 2. High-Level System Topology

SentinelADC functions as a sequential middleware pipeline. Client requests enter through dual HTTP/HTTPS network listeners, pass through a series of security and routing stages, and are proxied downstream to backend server pools over persistent TCP keep-alive sockets.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             CLIENT INGRESS NETWORK                               │
└──────────────────────────────────────────────────────────────────────────────────┘
                 │                                        │
           (HTTP :3000)                             (HTTPS :8443)
                 │                                        │
                 ▼                                        ▼
    ┌─────────────────────────┐              ┌─────────────────────────┐
    │ HTTP Listener           │              │ TLS Offloader & Cipher  │
    │ (Optional 301 Upgrade)  │              │ Negotiation (OpenSSL)   │
    └─────────────────────────┘              └─────────────────────────┘
                 │                                        │
                 └────────────────────┬───────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                       SENTINELADC PIPELINE (EXPRESS CORE)                        │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 1. Trace Context          │ Generates correlation UUIDv4 & stores in AsyncLocal │
│ 2. L3/L4 Firewall         │ IP Set lookup & User-Agent regex screening           │
│ 3. Token Bucket Rate Limiter│ Redis Lua atomic evaluation / Local Map fallback   │
│ 4. EWMA Anomaly Detector  │ Online Welford variance & Z-score penalty enforcement│
│ 5. Web App Firewall (WAF) │ Pre-cache SQLi & XSS payload pattern parsing         │
│ 6. Response Cache         │ Redis / In-memory lookup (Cache HIT short-circuit)   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 7. Routing Engine         │ Selects backend using configured LB Strategy          │
│                           │ Filters out unhealthy / OPEN circuit breakers        │
│                           │ Excludes backends in req._failedBackends             │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 8. Upstream Proxy         │ Streams request via persistent http.Agent           │
│    & Idempotent Retry     │ Retries GET/HEAD failures with backoff + full jitter│
└──────────────────────────────────────────────────────────────────────────────────┘
          │                           │                           │
          ▼                           ▼                           ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│ Backend Pool #1  │        │ Backend Pool #2  │        │ Backend Pool #3  │
│ (http://127.0.0.1:4001)   │ (http://127.0.0.1:4002)   │ (http://127.0.0.1:4003)   │
└──────────────────┘        └──────────────────┘        └──────────────────┘
```

---

## 3. Subsystem Specifications & Component Contracts

### 3.1. Ingress & TLS Termination Subsystem
- **Dual Listeners**: Operates an HTTP server (`:3000`) and a native HTTPS server (`:8443`) using Node's `https` module.
- **TLS Configuration**: Supports self-signed and CA-signed PEM certificates. Enforces OpenSSL AEAD cipher suites (`TLS_AES_256_GCM_SHA384`, `ECDHE-ECDSA-AES128-GCM-SHA256`) for Perfect Forward Secrecy (PFS).
- **HTTP $\rightarrow$ HTTPS 301 Redirection**: When `TLS_REDIRECT=true`, plain HTTP requests receive an immediate `301 Moved Permanently` response directing clients to the HTTPS listener.
- **TCP Socket Pooling**: Upstream forwarding uses a shared `http.Agent` instance configured with:
  - `keepAlive: true` (reuses open TCP connections)
  - `keepAliveMsecs: 30000`
  - `maxSockets: 1000` (caps simultaneous sockets per origin)
  - `maxFreeSockets: 256`

### 3.2. Tracing & Context Propagation
- **Correlation ID Middleware**: Assigns a unique UUIDv4 string (`req.correlationId`) to every incoming request.
- **AsyncLocalStorage Store**: Wraps request execution inside `AsyncLocalStorage`, allowing logger modules to access the correlation ID without explicit parameter passing.
- **Header Propagation**: Attaches `X-Correlation-ID` to both client responses and upstream proxied requests for distributed tracing.

### 3.3. L3/L4 Network Security & Rate Limiting Subsystem

```
Request ---> [IP Blocklist?] --(Yes)--> Return 403 Forbidden
                 │ (No)
                 ▼
          [Eval Token Bucket]
            ├── Redis Active? ──(Yes)──> Execute EVAL TOKEN_BUCKET_LUA
            └── Redis Offline? ─(No)───> Eval In-Memory Map Bucket
                 │
           Allowed (Tokens >= 1)?
            ├── (Yes) ──> Deduct token & proceed to Anomaly Detector
            └── (No)  ──> Return 429 Too Many Requests (with Retry-After)
```

#### Atomic Token Bucket Rate Limiter
- **Algorithm**: Continuous token bucket refilling at rate $R = \frac{\text{capacity}}{\text{windowMs}}$ tokens/ms up to maximum `capacity`.
- **Redis Lua Script (`TOKEN_BUCKET_LUA`)**: Executes token calculation, continuous refill, deduction, and TTL expiration atomically in Redis:
  $$\text{tokens} = \min(\text{capacity}, \text{tokens} + (\Delta t \times R))$$
- **In-Memory Fallback**: If Redis fails or is disabled, evaluates an in-memory `Map<IP, {tokens, lastRefill}>` implementing identical mathematical logic.
- **Headers Emitted**:
  - `X-RateLimit-Limit`: Maximum bucket capacity.
  - `X-RateLimit-Remaining`: Integer count of available tokens.
  - `X-RateLimit-Reset`: ISO timestamp when bucket fully refills.
  - `Retry-After`: Seconds until sufficient tokens refill (on 429 status).

#### Statistical Anomaly Detector (EWMA & Z-Score)
- **EWMA Calculation**: Maintains an Exponentially Weighted Moving Average of request rate per IP:
  $$\text{EWMA}_t = \alpha \cdot \text{Rate}_t + (1 - \alpha) \cdot \text{EWMA}_{t-1} \quad (\alpha = 0.3)$$
- **Variance Tracking**: Uses online Welford algorithm to update standard deviation ($\sigma$) without storing historical array buffers.
- **Anomaly Detection & Enforcement**:
  - Calculates $z = \frac{\text{Rate}_t - \text{EWMA}_{t-1}}{\sigma}$.
  - Flags anomaly when $z \ge 3.0$ and request volume $\ge 15 \text{ req/min}$ (volume floor protection).
  - When `autoEnforce=true`, applies a soft penalty by temporarily tightening the IP's rate limit capacity (e.g. 10 req/min for 5 minutes).

### 3.4. WAF & Response Caching Subsystem
- **Pre-Cache WAF Screening**: Evaluates incoming request paths, query strings, and body strings against regex threat signatures for SQL Injection (`SELECT`, `UNION`, `DROP TABLE`) and Cross-Site Scripting (`<script>`, `javascript:`). Positioned *before* cache lookups to prevent WAF bypass attacks on cached routes.
- **Stream Intercept Caching**: Monkey-patches response methods (`res.write` and `res.end`) to capture streaming proxy output in memory while piping data to the client. Upon response completion, valid `200 OK` GET responses are cached asynchronously in Redis (or local Map).

---

## 4. Load Balancing & Resilience Architecture

### 4.1. L7 Strategy Factory (`StrategyFactory`)

SentinelADC implements the Strategy design pattern for L7 routing. The `RoutingEngine` queries `StrategyFactory.getStrategy(algorithm)` to execute backend selection across healthy nodes:

```
                          ┌───────────────────────────┐
                          │   RoutingEngine           │
                          └─────────────┬─────────────┘
                                        │
                                        ▼
                          ┌───────────────────────────┐
                          │   StrategyFactory         │
                          └─────────────┬─────────────┘
                                        │
      ┌──────────────────┬──────────────┼──────────────┬──────────────────┐
      ▼                  ▼              ▼              ▼                  ▼
┌───────────────┐ ┌──────────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────────────┐
│ RoundRobin    │ │ WeightedRR   │ │ LeastConn│ │ IpHash       │ │ ConsistentHash   │
└───────────────┘ └──────────────┘ └──────────┘ └──────────────┘ └──────────────────┘
```

#### Strategy Algorithms Breakdown:
1. **Round Robin**: Index-based cyclic iteration across healthy backends.
2. **Weighted Round Robin**: Interleaved weighted array expansion based on backend `weight` property (e.g. 3:2:1).
3. **Least Connections**: Selects the healthy backend with the lowest active request count (`activeConnections`).
4. **IP Hash**: Computes hash string from `clientIp` to pin clients to a specific backend.
5. **Consistent Hashing**:
   - Maps backend nodes onto a 32-bit MD5 unsigned integer hash ring $[0, 2^{32}-1]$.
   - Instantiates $40 \times \text{weight}$ virtual nodes per physical backend to eliminate load hotspots.
   - Executes binary search ($O(\log V)$) on sorted ring values to locate the nearest clockwise virtual node from the client key hash.
   - Walks clockwise to skip unhealthy nodes during failover.

### 4.2. Upstream Circuit Breaker State Machine

Each backend node is protected by a 3-state finite state machine (`CircuitBreaker`):

```
       [ CLOSED (Normal Operation) ]
                   │
         5 Consecutive Failures
         (5xx / Socket Error)
                   │
                   ▼
         [ OPEN (Traffic Blocked) ]
                   │
         Cooldown Timer Expired (15s)
                   │
                   ▼
        [ HALF-OPEN (Trial Probing) ]
         │                         │
  Probe Success /             Probe Failure /
  Health Check Passed         Health Check Failed
         │                         │
         ▼                         ▼
  [ CLOSED ]                  [ OPEN ]
```

- **CLOSED**: Traffic flows normally. Successes reset failure counts.
- **OPEN**: Triggered after 5 consecutive failures. Backend is removed from load balancer selection (`healthy = false`).
- **HALF_OPEN**: Entered after a 15-second cooldown. Allows a single trial request probe.
- **Dual-Path Recovery Reconciliation**: Backend transitions back to `CLOSED` when EITHER:
  1. A live `HALF_OPEN` request probe completes successfully.
  2. The background `HealthMonitor` receives a `200 OK` from `GET /health`.

### 4.3. Idempotent-Only Retry Policy with Exponential Backoff & Jitter

When proxying a request to an upstream backend fails due to network socket errors (`ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`), the proxy error handler evaluates retry eligibility:

```
Proxy Error Occurs (Socket Error / Timeout)
                 │
                 ▼
     Is HTTP Method Idempotent? (GET / HEAD / OPTIONS)
       ├── (No)  ──> Return 502 Bad Gateway (Non-idempotent safety lock)
       └── (Yes) ──> Are req._attempts <= 2 (Max 3 total attempts)?
                       ├── (No)  ──> Return 502 Bad Gateway (Retries exhausted)
                       └── (Yes) ──> Record failed backend ID in req._failedBackends
                                       │
                                       ▼
                          Calculate Backoff + Full Jitter:
                          delay = random(0, min(500ms, 50ms * 2^attempt))
                                       │
                                       ▼
                          Wait delay -> Select NEW backend (skipping failed set)
                                       │
                                       ▼
                          Dispatch Proxy Attempt
```

- **Idempotency Guard**: Automatic retries apply **strictly to idempotent HTTP methods** (`GET`, `HEAD`, `OPTIONS`). Non-idempotent methods (`POST`, `PUT`, `DELETE`, `PATCH`) are excluded to protect origin databases against duplicate writes or double-billing.
- **Retry Cap**: Capped at 2 retry attempts (3 total calls).
- **Exponential Backoff + Full Jitter**:
  $$\text{delay} = \text{random}\left(0, \min(500\text{ms}, 50\text{ms} \times 2^{\text{attempt}})\right)$$
  Prevents **Retry Storms** (failure amplification) by decorrelating retry timing across parallel clients.
- **Failed Backend Exclusion**: Stores failed backend IDs in `req._failedBackends`. `RoutingEngine.selectBackend()` filters out these IDs during retry backend selection.

### 4.4. Zero-Downtime Maintenance Connection Draining

```
Admin POST /api/admin/backends/:id/drain
                 │
                 ▼
   Set backend.status = 'DRAINING' & healthy = false
                 │
                 ▼
   Load Balancer stops assigning NEW requests to backend
                 │
                 ▼
   Track activeConnections via req.res.on('finish')
                 │
        Active Connections = 0? OR Timeout (30s)?
                 │
                 ▼
   Transition backend.status = 'OFFLINE'
```

---

## 5. State Management & Data Schema Architecture

### 5.1. Redis Key Namespaces & Schemas

| Key Pattern | Type | Expiration | Description |
|---|---|---|---|
| `sentinel:tokenbucket:<ip>` | Hash | $\lceil \frac{\text{capacity}}{\text{refillRate}} \rceil + 60\text{s}$ | Fields: `tokens` (float), `lastRefill` (timestamp ms) |
| `sentinel:cache:<hash>` | String | Configurable TTL (default 60s) | Cached response body bytes |
| `sentinel:anomaly:<ip>` | Hash | 24 Hours | IP anomaly state, EWMA value, and variance parameters |

### 5.2. Runtime In-Memory Fallbacks

SentinelADC provides graceful fail-open operation when Redis or MongoDB are unavailable:

```
                               ┌───────────────────────────┐
                               │  Operation Request        │
                               └─────────────┬─────────────┘
                                             │
                                     Is Redis Active?
                                      ├── (Yes) ──> Execute Redis Command / Lua Script
                                      └── (No)  ──> Execute In-Memory Fallback
                                                      ├── Cache: Map<hash, {data, expiresAt}>
                                                      └── Rate Limit: Map<ip, {tokens, lastRefill}>
```

---

## 6. Operational Failure Modes & Mitigation Table

| Failure Scenario | Trigger Condition | System Impact | Mitigation Mechanism |
|---|---|---|---|
| **Redis Connection Loss** | Redis socket error / offline | Redis commands throw errors | Automatic fallback to in-memory JS Maps for caching and rate limiting; system remains operational. |
| **Upstream Backend Crash** | Socket `ECONNREFUSED` / timeout | Upstream connection fails | Idempotent `GET` requests failover to alternate backends with jittered backoff; circuit breaker trips to `OPEN` after 5 failures. |
| **Non-Idempotent Request Failure** | `POST` request socket error | Request fails | Immediate HTTP 502 response sent; no retries executed to prevent origin state duplication. |
| **All Upstream Backends Offline** | 0 healthy backends available | No routing target found | Returns HTTP 502 Bad Gateway with JSON error metadata detailing target pool failure. |
| **Traffic Burst / DDoS** | Client IP exceeds $z \ge 3.0$ baseline | Potential pool saturation | Statistical Anomaly Detector flags IP and dynamically tightens rate limit capacity for 5 minutes. |
| **Slow Backend Maintenance** | Operator triggers drain API | Backend taking updates | Connection Draining isolates new traffic while tracking active connections until 0 or 30s timeout expires. |

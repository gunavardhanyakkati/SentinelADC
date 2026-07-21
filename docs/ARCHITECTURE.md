# SentinelADC System Architecture

This document details the architectural design and structural layers of SentinelADC, explaining how requests flow through the application and how internal systems collaborate to manage traffic.

## Architectural Layers

SentinelADC is structured as a pipeline of modular layers with dual HTTP (`:3000`) and HTTPS (`:8443`) listeners sharing a unified Express application context. Each layer executes sequentially, operating on the request-response lifecycle before handing control over to downstream modules.

```
       [ Client Request (HTTP :3000 / HTTPS :8443) ]
                           |
                           v
   +───────────────────────────────────────────────+
   |  1. TLS Termination & 301 Redirection         |  - Decrypts HTTPS (:8443)
   +───────────────────────────────────────────────+  - 301 redirect if TLS_REDIRECT=true
                           |
                           v
   +───────────────────────────────────────────────+
   |  2. Trace & Correlation Context               |  - Generates trace UUIDv4
   +───────────────────────────────────────────────+  - Node AsyncLocalStorage context
                           |
                           v
   +───────────────────────────────────────────────+
   |  3. L3/L4 Network Firewall                    |  - Set-based IP blocklist lookup
   +───────────────────────────────────────────────+  - User-Agent scanner filter
                           |
                           v
   +───────────────────────────────────────────────+
   |  4. Rate Limiter & EWMA Anomaly Detector      |  - Sliding-window rate limiters
   +───────────────────────────────────────────────+  - EWMA Z-Score spike detection
                           |                          - Soft auto-enforcement penalty
                           v
   +───────────────────────────────────────────────+
   |  5. Web Application Firewall (WAF)            |  - SQLi & XSS regex screening
   +───────────────────────────────────────────────+  - Evaluated before cache lookup
                           |
                           v
   +───────────────────────────────────────────────+
   |  6. Response Caching Layer                    |  - Redis / RAM storage lookup
   +───────────────────────────────────────────────+  - Stream monkey-patching
                           | (Cache Miss)
                           v
   +───────────────────────────────────────────────+
   |  7. L7 Load Balancer & Circuit Breaker        |  - RR, WRR, Least Connections, IP Hash
   +───────────────────────────────────────────────+  - CLOSED / OPEN / HALF_OPEN states
                           |                          - Maintenance Connection Draining
                           v
   +───────────────────────────────────────────────+
   |  8. Upstream Reverse Proxy                     |  - Persistent http.Agent Keep-Alive
   +───────────────────────────────────────────────+  - Header rewriting (X-Forwarded-*)
                           |
                           v
                 [ Upstream Backend Pool ]
```

---

## 1. Request Lifecycle Routing

### TLS Termination & Tracing Context
Client connections arrive via plain HTTP (`:3000`) or native HTTPS (`:8443`). When `TLS_REDIRECT=true`, unencrypted HTTP traffic is upgraded via status 301. On entry, a correlation ID (`req.correlationId`) is assigned and wrapped in Node's `AsyncLocalStorage` context so all logger outputs carry trace contexts automatically.

### Firewall, Rate Limiting & Statistical Anomaly Detection
Requests pass through an $O(1)$ Set-based IP blocklist check. The Statistical Anomaly Detector tracks per-IP request rates using an Exponentially Weighted Moving Average (EWMA, $\alpha=0.3$) and online Welford variance calculations. If $z \ge 3.0$ and volume $\ge 15 \text{ req/min}$, an anomaly is flagged. Under auto-enforcement, the IP's rate limit is temporarily capped (10 req/min for 5 minutes).

### Web Application Firewall (WAF) & Caching
Positioned *before* cache lookups to prevent WAF bypass attacks on cached routes, the WAF parses paths, query strings, and POST bodies for SQLi and XSS regex threat signatures. Valid GET requests then query Redis/RAM cache storage; cache hits return immediately with `x-cache: HIT`.

### Load Balancing, Circuit Breakers & Connection Draining
For cache misses, the Load Balancer selects an optimal backend:
- **Circuit Breakers (`CLOSED`/`OPEN`/`HALF_OPEN`)**: Excludes backends that hit 5 consecutive 5xx/connection errors. After a 15s cooldown, `HALF_OPEN` state allows a trial probe. Both live probes and active `/health` checks feed into a single state machine to restore `CLOSED` status.
- **Connection Draining (`DRAINING`/`OFFLINE`)**: When maintenance mode is triggered via `POST /api/admin/backends/:id/drain`, new requests are routed away from the backend while active in-flight requests finish cleanly before status switches to `OFFLINE`.

### Upstream Proxying
The proxy streams requests downstream using a persistent `http.Agent` connection pool (`keepAlive: true`, `maxSockets: 1000`), avoiding TCP handshake churn and achieving **753 RPS** at **128ms** median latency.

---

## 2. Dynamic Database Fallbacks

SentinelADC features dynamic fail-open database fallback capabilities:
- **Redis Offline**: Switches caching and rate limiting engines to localized memory `Map` namespaces.
- **MongoDB Offline**: Switches analytics logs to an in-memory transactional log buffer with custom JavaScript grouping logic.

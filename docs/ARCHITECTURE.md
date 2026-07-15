# SentinelADC System Architecture

This document details the architectural design and structural layers of SentinelADC, explaining how requests flow through the application and how internal systems collaborate to manage traffic.

## Architectural Layers

SentinelADC is structured as a pipeline of modular layers. Each layer executes sequentially, operating on the request-response lifecycle before handing control over to the next module.

```
       [ Client Request ]
               |
               v
  +─────────────────────────+
  |  1. Trace & Correlation |  - Generates trace UUID
  +─────────────────────────+  - Binds request context
               |
               v
  +─────────────────────────+
  |  2. Network Firewall    |  - Set-based IP blocklist checks
  +─────────────────────────+  - User-agent bots validation
               |
               v
  +─────────────────────────+
  |  3. Rate Limiting       |  - Caps client request limits per minute
  +─────────────────────────+  - Prevents resource exhaustion
               |
               v
  +─────────────────────────+
  |  4. Security WAF        |  - Screens payloads for SQLi and XSS
  +─────────────────────────+  - Parses request parameters & bodies
               |
               v
  +─────────────────────────+
  |  5. Caching Layer       |  - Looks up cache storage (Redis / RAM)
  +─────────────────────────+  - Bypasses pools on hits
               |
               | (Cache Miss)
               v
  +─────────────────────────+
  |  6. Load Balancer       |  - Chooses target node (RR, WRR, LC, Hash)
  +─────────────────────────+  - Inspects active connections & scores
               |
               v
  +─────────────────────────+
  |  7. Reverse Proxy       |  - Rewrites headers (X-Forwarded-*)
  +─────────────────────────+  - Forwards stream downstream
               |
               v
       [ Upstream Node ]
```

---

## 1. Request Lifecycle Routing

### Tracing and Context
Incoming requests first trigger the response timer and correlation ID middleware. The correlation ID is generated via UUIDv4 and set as a request property (`req.correlationId`). Node's native `AsyncLocalStorage` wraps subsequent callback executions in this context, allowing the Winston structured logger to automatically query and output the trace ID.

### Edge Filters and Rate Limits
Requests pass through the Set-based IP blocklist lookup which offers O(1) matching. The rate limiter then increments request counters mapped to the client IP in Redis (or in-memory sliding-window arrays if Redis is offline), returning HTTP 429 if the request limits are exceeded.

### Web Application Firewall (WAF)
Requests destined for administrative paths are parsed for JSON or URL-encoded payloads. The WAF checks request paths, query strings, and body variables against regex signatures designed to match SQL injection (SQLi) keywords and cross-site scripting (XSS) tag injections. Malicious matches trigger an immediate HTTP 403 response.

### Cache Lookup
If the request is a GET and caching is enabled, the cache middleware computes a cache key based on the URL path. It queries Redis (or local Map-based cache structures). If present, the cached payload is written directly to the client with an `x-cache: HIT` header, and the pipeline terminates. If a cache miss occurs, the request proceeds.

### Load Balancing and Upstream Dispatch
The load balancer selects an online, healthy server from the active pool using the configured algorithm. If Least Connections or Weighted Round Robin is active, the pool manager factors in node performance scores derived from historical response times and error records. The proxy module then rewrites client headers (attaching standard `X-Forwarded-*` headers) and streams the request downstream.

---

## 2. Dynamic Memory Fallbacks

Production systems need resilience when secondary stores go offline. SentinelADC implements a dynamic fail-open database fallback mechanism:

```
            +─────────────────────────────+
            |      Database Operation     |
            +─────────────────────────────+
                           |
            +--------------+--------------+
            |                             |
      (Mongo/Redis OK)             (Connection Error)
            |                             |
            v                             v
  +───────────────────+         +───────────────────+
  |  Standard Queries |         |  Activate Memory  |
  |  to Database      |         |  Fallback Engine  |
  +───────────────────+         +───────────────────+
                                          |
                                          v
                                +───────────────────+
                                | Perform Map/Array |
                                | Operations in RAM |
                                +───────────────────+
```

### Caching and Rate Limiting Fallbacks
If Redis is offline, the caching engine uses a localized Map with automatic key expiration checks, while the rate limiter switches to in-memory sliding arrays to track client request intervals.

### Telemetry Database Fallbacks
If MongoDB is offline, the analytics engine records transaction logs in a sliding-window array. The background rollup worker aggregates these logs using JavaScript array metrics, populating the memory timeline bucket so that the dashboard routes return valid charts and telemetry data.

---

## 3. Passive vs. Active Monitoring

SentinelADC combines active background health checks with passive performance tracking:

* **Active Health Monitoring**: A background interval process pings backend servers on `/health` at set intervals. Servers failing multiple checks are marked offline.
* **Passive Performance Tracking**: The gateway metrics engine tracks response latency and success rates during active client transactions. This computes a performance score (0-100) per server. If a server responds slowly, its performance score drops, prompting algorithms like Weighted Round Robin to route traffic away from it before the background monitor officially flags it as offline.

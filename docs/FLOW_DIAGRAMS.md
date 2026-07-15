# SentinelADC Traffic Flow Diagrams

This document contains request flow diagrams tracing paths through the L7 Gateway under varying scenarios.

---

## 1. Request Flow (Cache HIT)

When a GET request matches a valid resource key stored in the cache namespace, the pipeline immediately returns the buffered body, bypassing the load balancer and backend pools:

```
Client             Correlation     Cache          Redis          Backend
  |                     |            |              |               |
  |--- GET /index ----->|            |              |               |
  |                     |--- Hook -->|              |               |
  |                     |    Trace   |--- Query --->|               |
  |                     |            |    Keys      |               |
  |                     |            |<-- Bytes ----|               |
  |                     |<-- HIT ----|    (Cache)   |               |
  |<-- Response --------|    (0.8ms) |              |               |
  |    (x-cache: HIT)   |            |              |               |
```

---

## 2. Request Flow (Cache MISS & Forward)

When a request results in a cache miss, the gateway must execute WAF screening, balance connection parameters, forward headers downstream, buffer target response bytes, save them to cache, and return details to the client:

```
Client       Gateway Edge      WAF Scan       Load Balancer      Backend
  |               |                |                |               |
  |--- POST ----->|                |                |               |
  |               |--- Inspect --->|                |               |
  |               |    Payloads    |                |               |
  |               |<-- Clean ------|                |               |
  |               |                                 |               |
  |               |--- Query Target Selection ----->|               |
  |               |    (RR / WRR / Connections)     |               |
  |               |<-- Return backend-2 IP ---------|               |
  |               |                                                 |
  |               |--- Stream headers & payload (X-Forwarded-*) --->|
  |               |                                                 |
  |               |<-- Stream response chunks (200 OK) -------------|
  |               |                                                 |
  |--- Stream --->|                                                 |
  |    Bytes      |--- Async cache updates (Redis / RAM) ---------> |
  |<-- Output ----|                                                 |
```

---

## 3. Threat Blocking Flow (WAF Block)

When the WAF regex parser flags input structures matching malicious signatures (like SQL injection or scripting tags), the connection terminates immediately at the firewall layer:

```
Client         Gateway Edge      WAF Scan       Logger      Backend
  |                 |               |             |            |
  |--- GET SQLi --->|               |             |            |
  |                 |--- Match ---->|             |            |
  |                 |    Signatures |             |            |
  |                 |<-- Block -----|             |            |
  |                 |                                          |
  |                 |--- Dispatch Audit Log ----->|            |
  |                 |    (Threat details stored)  |            |
  |<-- 403 ---------|                                          |
  |    Forbidden    |                                          |
```

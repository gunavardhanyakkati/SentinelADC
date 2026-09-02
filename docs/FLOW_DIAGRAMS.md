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
  |               |    (Consistent Hash / RR / LC)  |               |
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

---

## 4. Consistent Hashing Ring Selection Flow

When `algorithm=consistent-hash`, client IP/session key is hashed onto a 32-bit MD5 ring. Binary search locates the nearest clockwise virtual node, ensuring $O(\log V)$ lookup speed:

```
Client Key: "192.168.1.50"
  |
  +---> MD5 Hash ("192.168.1.50") = 0x8A4F102B (2,320,432,171)
            |
            v
   [ 32-Bit Hash Ring: 0 ---------------------------------------- 2^32-1 ]
                                    ^ (0x8A4F102B)
                                    |
                 +------------------+------------------+
                 | Clockwise Search (Binary Search)     |
                 v                                     v
            vnode: backend-2#v12                 vnode: backend-1#v05
            (0x8B1002A1)                         (0x91F00112)
                 |
                 v
       Selected Target: Backend-2 (Healthy)
```

---

## 5. Idempotent Retry & Exponential Backoff Flow

When an upstream backend connection drops (`ECONNREFUSED` / timeout), idempotent requests (`GET`/`HEAD`) automatically retry across alternative healthy backends:

```
Client           Proxy Edge              Backend-1 (Down)      Backend-2 (Up)
  |                  |                          |                    |
  |--- GET /data --->|                          |                    |
  |                  |--- (1st Attempt) ------->|                    |
  |                  |<-- ECONNREFUSED ---------|                    |
  |                  |   (recordFailure, add backend-1 to failed set)
  |                  |
  |                  |=== [Is Idempotent? YES] ===
  |                  |=== [Attempts = 1 <= 2? YES] ===
  |                  |=== [Backoff Jitter Delay: 45ms] ===
  |                  |
  |                  |--- (2nd Attempt) ---------------------------->|
  |                  |<-- 200 OK (Stream Bytes) ---------------------|
  |                  |
  |<-- 200 OK -------|
```

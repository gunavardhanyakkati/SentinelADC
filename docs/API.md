# SentinelADC Gateway API Specification

This document details the HTTP endpoints exposed by the SentinelADC Gateway, including requests, responses, status codes, and authorization requirements.

---

## Gateway Access & Health Status

### GET /api/status
Retrieves overall system status, active load balancer settings, and individual pool member health statistics.

* **Authorization**: None
* **Sample Response (HTTP 200)**:
```json
{
  "gateway": {
    "name": "SentinelADC",
    "version": "1.0.0",
    "status": "operational",
    "timestamp": "2026-07-21T08:00:00.000Z"
  },
  "loadBalancing": {
    "algorithm": "consistent-hash"
  },
  "backends": {
    "total": 3,
    "healthy": 3,
    "unhealthy": 0,
    "pool": [
      {
        "id": "backend-1",
        "url": "http://127.0.0.1:4001",
        "status": "healthy",
        "healthy": true,
        "weight": 3,
        "activeConnections": 0
      }
    ]
  }
}
```

---

## Authentication

### POST /api/security/login
Validates admin credentials and issues a signed JWT token used for protected routes.

* **Authorization**: None
* **Request Body**:
```json
{
  "username": "admin",
  "password": "sentinel"
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

---

## Administration Configuration (Requires Bearer JWT)

### PUT /api/admin/algorithm
Updates the active L7 load balancing routing algorithm.

* **Authorization**: Bearer JWT
* **Supported Algorithms**: `round-robin`, `weighted-round-robin`, `least-connections`, `ip-hash`, `consistent-hash`
* **Request Body**:
```json
{
  "algorithm": "consistent-hash"
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Load balancing algorithm successfully switched to consistent-hash",
  "currentAlgorithm": "consistent-hash"
}
```

### POST /api/admin/backends/:id/drain
Initiates zero-downtime maintenance connection draining for a backend.

* **Authorization**: Bearer JWT
* **Request Body** (Optional):
```json
{
  "timeoutSec": 30
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Connection drain initiated for backend-1. Waiting for 3 active connections to finish (timeout: 30s)",
  "backend": {
    "id": "backend-1",
    "url": "http://127.0.0.1:4001",
    "status": "draining",
    "healthy": false,
    "activeConnections": 3
  }
}
```

### POST /api/admin/backends/:id/undrain
Cancels connection drain and restores backend status to `healthy`.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Backend backend-1 undrained successfully and restored to HEALTHY status in load balancer pool",
  "backend": {
    "id": "backend-1",
    "status": "healthy",
    "healthy": true
  }
}
```

---

## Security & Rate Limiting

### Token Bucket Rate Limiter Headers (All Proxied & Gateway Requests)
Every request returns standard Token Bucket capacity and refill status headers:
- `X-RateLimit-Limit`: Maximum bucket token capacity (e.g. `100`).
- `X-RateLimit-Remaining`: Floor of currently available tokens in the client bucket.
- `X-RateLimit-Reset`: ISO timestamp when the bucket will be fully refilled.
- `Retry-After`: Returned on HTTP 429 status indicating seconds until enough tokens refill for a retry attempt.

* **Throttled Response (HTTP 429)**:
```json
{
  "error": {
    "message": "Too Many Requests — Rate limit bucket exhausted. Please try again later.",
    "statusCode": 429,
    "limit": 100,
    "remaining": 0,
    "retryAfter": "5s"
  },
  "timestamp": "2026-09-02T12:00:00.000Z"
}
```

---

## Statistical Anomaly Detection (Requires Bearer JWT)

### GET /api/security/anomalies
Retrieves recent flagged traffic anomalies, IP EWMA baselines, and configuration state.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "config": {
    "enabled": true,
    "zThreshold": 3.0,
    "autoEnforce": false,
    "penaltyMaxRequests": 10,
    "penaltyWindowMs": 300000
  },
  "anomalies": [
    {
      "id": "anomaly-1784601498-abc",
      "ip": "192.168.1.100",
      "currentRate": 300,
      "ewma": 12.5,
      "stddev": 3.2,
      "zScore": 89.84,
      "threshold": 3.0,
      "timestamp": "2026-07-21T08:05:00.000Z",
      "enforced": false
    }
  ],
  "baselines": [
    {
      "ip": "192.168.1.100",
      "ewma": 12.5,
      "stddev": 3.2,
      "totalRequests": 350,
      "totalAnomalies": 1,
      "lastZScore": 89.84,
      "lastFlagged": "2026-07-21T08:05:00.000Z"
    }
  ]
}
```

---

## Circuit Breakers & Upstream Retries

### GET /api/resilience/circuit-breakers
Retrieves the status of all upstream backend circuit breakers.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "enabled": true,
  "failureThreshold": 5,
  "cooldownMs": 15000,
  "circuitBreakers": [
    {
      "backendId": "backend-1",
      "url": "http://127.0.0.1:4001",
      "state": "CLOSED",
      "consecutiveFailures": 0,
      "lastStateChange": "2026-07-21T08:00:00.000Z",
      "cooldownRemainingMs": 0,
      "lastError": null,
      "healthyInPool": true
    }
  ]
}
```

### Idempotent Retry Policy & Error Response (HTTP 502)
When an upstream backend connection drops, idempotent requests (`GET`, `HEAD`, `OPTIONS`) automatically retry on alternate healthy backends up to 3 total attempts with exponential backoff & full jitter. Non-idempotent methods (`POST`) or exhausted retries return:

```json
{
  "error": {
    "message": "Non-idempotent request [POST] failed (retries disabled to prevent double-writes)",
    "statusCode": 502,
    "backend": "backend-1",
    "attempts": 1
  },
  "timestamp": "2026-09-02T12:00:00.000Z"
}
```

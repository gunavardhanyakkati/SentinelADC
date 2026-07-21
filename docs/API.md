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
    "algorithm": "round-robin"
  },
  "backends": {
    "total": 3,
    "healthy": 3,
    "unhealthy": 0,
    "pool": [
      {
        "id": "backend-1",
        "url": "http://localhost:4001",
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
* **Request Body**:
```json
{
  "algorithm": "weighted-round-robin"
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Load balancing algorithm successfully switched to weighted-round-robin",
  "currentAlgorithm": "weighted-round-robin"
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
    "url": "http://localhost:4001",
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

### POST /api/security/anomalies/config
Dynamically updates anomaly detection settings.

* **Authorization**: Bearer JWT
* **Request Body**:
```json
{
  "autoEnforce": true,
  "zThreshold": 3.5
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Anomaly detection configuration updated successfully",
  "config": {
    "enabled": true,
    "zThreshold": 3.5,
    "autoEnforce": true
  }
}
```

### DELETE /api/security/anomalies
Clears anomaly logs and baselines.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Anomaly detection records and baselines cleared successfully"
}
```

---

## Circuit Breakers & Resilience (Requires Bearer JWT)

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
      "url": "http://localhost:4001",
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

### POST /api/resilience/circuit-breakers/reset
Manually resets a tripped circuit breaker for a backend back to `CLOSED`.

* **Authorization**: Bearer JWT
* **Request Body**:
```json
{
  "backendId": "backend-1"
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Circuit breaker for backend \"backend-1\" reset to CLOSED successfully.",
  "circuitBreakers": [...]
}
```

---

## Firewall Policies (Requires Bearer JWT)

### GET /api/security/blocklist
Retrieves the list of currently blocklisted IP addresses.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "blocklist": [
    "192.168.1.100"
  ]
}
```

### POST /api/security/blocklist
Adds an IP address to the blocklist.

* **Authorization**: Bearer JWT
* **Request Body**:
```json
{
  "ip": "203.0.113.50"
}
```

---

## Analytics Telemetry (Requires Bearer JWT)

### GET /api/analytics/realtime
Retrieves real-time traffic statistics aggregated over the last 5 minutes.

### GET /api/analytics/historical
Retrieves 1-minute bucket aggregates of traffic statistics from the last hour.

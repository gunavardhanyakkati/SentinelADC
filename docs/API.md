# SentinelADC Gateway API Specification

This document details the HTTP endpoints exposed by the SentinelADC Gateway, including requests, responses, status codes, and authorization requirements.

---

## Gateway Access Status

### GET /api/status
Retrieves overall system status, active load balancer settings, and individual pool member health statistics.

* **Authorization**: None
* **Sample Response (HTTP 200)**:
```json
{
  "gateway": {
    "status": "green",
    "algorithm": "round-robin",
    "backends": [
      {
        "id": "backend-1",
        "name": "backend-1",
        "url": "http://localhost:4001",
        "weight": 3,
        "activeConnections": 0,
        "performanceScore": 100,
        "healthy": true,
        "overrideStatus": null
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
* **Response (HTTP 401)**:
```json
{
  "error": "Invalid username or password"
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
  "message": "Load balancing algorithm updated successfully",
  "algorithm": "weighted-round-robin"
}
```

---

## Pool Health Management (Requires Bearer JWT)

### POST /api/health/override
Overrides the health status of a backend server pool member.

* **Authorization**: Bearer JWT
* **Request Body**:
```json
{
  "backendId": "backend-2",
  "status": "unhealthy"
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Health override updated successfully for backend-2",
  "backendId": "backend-2",
  "overrideStatus": "unhealthy"
}
```

---

## Cache Controls (Requires Bearer JWT)

### POST /api/cache/clear
Evicts all cache keys stored within the database.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Cache database cleared successfully"
}
```

### POST /api/cache/invalidate
Invalidates specific cached keys matching a glob pattern.

* **Authorization**: Bearer JWT
* **Request Body**:
```json
{
  "pattern": "sentinel:cache:/api/users*"
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "message": "Invalidated keys matching pattern: sentinel:cache:/api/users*",
  "count": 4
}
```

---

## Firewall Policies (Requires Bearer JWT)

### GET /api/security/blocklist
Retrieves the list of currently blocklisted IP addresses.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
[
  "192.168.1.100",
  "45.227.254.12"
]
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
* **Sample Response (HTTP 200)**:
```json
{
  "message": "IP added to blocklist successfully",
  "ip": "203.0.113.50"
}
```

### DELETE /api/security/blocklist
Removes an IP address from the blocklist.

* **Authorization**: Bearer JWT
* **Request Body**:
```json
{
  "ip": "203.0.113.50"
}
```
* **Sample Response (HTTP 200)**:
```json
{
  "message": "IP removed from blocklist successfully",
  "ip": "203.0.113.50"
}
```

---

## Analytics Telemetry (Requires Bearer JWT)

### GET /api/analytics/realtime
Retrieves real-time traffic statistics aggregated over the last 5 minutes.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "dbConnected": true,
  "summary": {
    "throughputRps": 2.45,
    "averageLatencyMs": 18.2,
    "successRate": 100,
    "cacheHitRatio": 45.8,
    "totalRequests": 735
  }
}
```

### GET /api/analytics/historical
Retrieves 1-minute bucket aggregates of traffic statistics from the last hour.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "dbConnected": true,
  "timeline": [
    {
      "timeBucket": "2026-07-15T22:30:00.000Z",
      "requestCount": 120,
      "averageLatencyMs": 14.5,
      "minLatencyMs": 2.1,
      "maxLatencyMs": 95.8,
      "errorRate": 0,
      "cacheHitRatio": 42.5,
      "bytesTransferred": 24580,
      "updatedAt": "2026-07-15T22:31:01.250Z"
    }
  ]
}
```

### GET /api/analytics/backends
Retrieves transactional splits and metrics grouped by individual pool members.

* **Authorization**: Bearer JWT
* **Sample Response (HTTP 200)**:
```json
{
  "dbConnected": true,
  "backends": [
    {
      "backendId": "backend-1",
      "backendUrl": "http://localhost:4001",
      "requestCount": 450,
      "averageLatencyMs": 12.3,
      "errorCount": 0,
      "cacheHitCount": 210
    }
  ]
}
```

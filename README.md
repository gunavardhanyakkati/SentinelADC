# SentinelADC - Cloud Native Layer-7 Application Delivery Controller

SentinelADC is an educational implementation of a Layer-7 Application Delivery Controller (ADC) and Reverse Proxy. Inspired by platforms like F5 BIG-IP, NGINX, and Traefik, this project showcases network engineering, load balancing, security mitigation, performance caching, and distributed tracing in Node.js.

The codebase is built without third-party frameworks like NestJS to display the raw details of Node.js stream manipulation, middleware pipelines, and concurrency handling.

---

## Key Features

* **Reverse Proxying**: Leverages Node's http pipeline to stream incoming client requests to upstream pools, handling body forwarding, custom headers, and request-response cycle wrapping.
* **L7 Load Balancing**: Dynamically balances traffic using multiple strategy modules:
  * *Round Robin*: Standard cyclic round-robin distribution.
  * *Weighted Round Robin*: Automatically incorporates server performance scores to adjust routing weights dynamically.
  * *Least Connections*: Track active connections and selects nodes with minimal workload, utilizing performance scores as a tie-breaker.
  * *IP Hash*: Session affinity using MurmurHash3 computations to bind client IP addresses to static backends.
* **Active Health Monitor**: A background monitor that periodically audits target node endpoints, updating pool status tables on-the-fly and allowing admin-specified maintenance drains or force-up overrides.
* **Security & Firewall Engine**: Implements an edge protection layer including:
  * Fast Set-based IP blocklists.
  * Web Application Firewall (WAF) regex screening against XSS and SQLi payload structures.
  * User-agent validation (blocking standard scanners like sqlmap).
  * JWT auth on administrator API endpoints.
  * Sliding-window rate limiters with dual Redis/local memory fallbacks.
* **Proxy Stream Caching**: Custom middleware that monkey-patches Node's write and end calls, caching proxy responses using Redis (with a Map-based local fallback when offline) to serve recurring requests in sub-millisecond windows.
* **Analytics & Telemetry**: Captures request footprints out-of-band on response termination, rolling up metrics (throughput, average latency, success rate, cache hits, backend node splits) using a background minutes-bucket worker.
* **Distributed Tracing**: Standardizes trace contexts across internal async calls using Node's native AsyncLocalStorage to automatically attach correlation IDs to Winston logger calls and forward tracing headers to upstreams.
* **React Administration Dashboard**: A premium, responsive interface displaying live stats, charts, pool switches, firewall rule builders, and terminal log streams.

---

## System Architecture

The following diagram illustrates the lifecycle of a request entering the controller:

```
                  +-----------------------------------+
                  |           Client Request          |
                  +-----------------------------------+
                                    |
                                    v
                  +-----------------------------------+
                  |      Response Timer & Trace       |
                  |  (Generates trace correlation ID)  |
                  +-----------------------------------+
                                    |
                                    v
                  +-----------------------------------+
                  |         Firewall Filters          |
                  |     (IP Blocklist check & UA)     |
                  +-----------------------------------+
                                    |
                                    v
                  +-----------------------------------+
                  |        Rate Limiter Edge          |
                  |     (Capped limits verification)  |
                  +-----------------------------------+
                                    |
                                    v
                  +-----------------------------------+
                  |            WAF Scanner            |
                  |  (Parses payloads for SQLi/XSS)   |
                  +-----------------------------------+
                                    |
                                    v
                  +-----------------------------------+
                  |      Cache Middleware Check       |
                  |       (Serve from Redis/RAM)      |
                  +-----------------------------------+
                                    |  (Cache MISS)
                                    v
                  +-----------------------------------+
                  |        L7 Routing Engine          |
                  |  (Selects node: RR, WRR, LC, Hash)|
                  +-----------------------------------+
                                    |
                                    v
                  +-----------------------------------+
                  |       Reverse Proxy Forward       |
                  |   (Attaches proxy/trace headers)  |
                  +-----------------------------------+
                                    |
                                    v
                  +-----------------------------------+
                  |          Upstream Servers         |
                  +-----------------------------------+
```

---

## Technical Decisions & Trade-Offs

### Proxy Caching Stream Interception
Express-http-proxy streams responses directly to the client. To capture, cache, and compress the body payload without breaking Node's downstream pipe connection, we monkey-patch Node's native `res.write` and `res.end` methods. This lets us buffer the data chunks into memory on-the-fly and write to Redis/RAM cache keys asynchronously when the response stream signals completion.

### Dynamic Memory Fallbacks
Production platforms depend on external resources like Redis and MongoDB. In local development or resource-constrained situations, these databases might not be running. To prevent gateway startup failure (fail-open strategy), SentinelADC implements dual-mode logic:
* If Redis connection fails, the caching and rate limit engines dynamically switch to in-memory Maps and sliding-window arrays.
* If MongoDB is offline, the analytics engine falls back to an in-memory transactional log buffer with custom JavaScript grouping logic to fulfill analytical query endpoints.

### Context Propagation via AsyncLocalStorage
Distributed tracing requires passing trace IDs across async operations. Instead of manually passing request metadata variables through every middleware, pool selector, or db query, SentinelADC uses Node's `AsyncLocalStorage`. The correlation ID middleware sets this context on entry, and the Winston structured logger automatically queries the active execution trace block to append the trace ID, keeping the business logic clean.

---

## Workspace Layout

* `src/app.js`: Configures the express server instance, registers global middlewares in order, and maps API endpoints.
* `src/index.js`: Bootstraps the application, connects database engines, starts health monitoring processes, and rolls up minutes aggregation routines.
* `src/routing/`: Contains strategies for load balancing (roundRobin, weightedRoundRobin, leastConnections, ipHash).
* `src/cache/`: Middleware and service modules managing caching and cache invalidation.
* `src/security/`: Middleware stack handling IP blocks, WAF scanners, rate limiters, and JWT auth.
* `src/analytics/`: Collector layer and rollup aggregators storing telemetry.
* `src/observability/`: Winston logging formats and trace context stores.
* `dashboard/`: Vite + React + TypeScript single-page application administration dashboard.
* `backends/`: Lightweight Express application simulating real backend pool instances.
* `benchmarks/`: Script that automates stress test scenarios using autocannon.

---

## API Documentation

### Public Endpoints

* `GET /api/status`
  * Returns active status of the ADC gateway, including configuration metadata, current load balancing algorithm, and node status details.

### Protected Administrator Endpoints (Requires Bearer JWT)

Authentication required. Post credentials to retrieve a token:
* `POST /api/security/login` (Payload: `{ username, password }`)
  * Default Credentials: `admin` / `sentinel`

* `PUT /api/admin/algorithm` (Payload: `{ algorithm }`)
  * Transitions the L7 router to a new strategy (e.g. `weighted-round-robin`, `least-connections`).

* `POST /api/health/override` (Payload: `{ backendId, status }`)
  * Imposes manual override state on backend pools (e.g., `status: "unhealthy"` to drain a server).

* `GET /api/security/logs`
  * Fetches the sliding-window audit trail of WAF blocks and scanner detections.

* `GET /api/security/blocklist` / `POST /api/security/blocklist` / `DELETE /api/security/blocklist`
  * Reads, adds, or removes blocked client IP addresses.

* `GET /api/analytics/realtime`
  * Returns realtime RPS throughput, latencies, and success metrics.

* `GET /api/analytics/historical`
  * Returns rolled-up minute bucket aggregates for charting.

* `GET /api/analytics/backends`
  * Returns traffic distributions per backend server.

* `POST /api/cache/clear`
  * Flushes the entire cache namespace.

---

## Getting Started

### Prerequisites

* Node.js (version 18 or higher)
* Optional: Redis and MongoDB (if not running, application seamlessly runs via memory fallbacks)

### Installation

Clone the repository and install the dependencies for both the gateway and the dashboard:

```bash
# Install gateway dependencies
npm install

# Install dashboard dependencies
cd dashboard
npm install
cd ..
```

### Running Locally

To run the full stack locally with simulated backends:

1. **Start the simulated backend servers**:
   ```bash
   # Starts backend instance 1 on port 4001
   npm run backend
   ```
   *To start additional mock nodes, configure the port and server name in your shell:*
   ```powershell
   $env:PORT='4002'; $env:SERVER_NAME='backend-2'; node backends/server.js
   $env:PORT='4003'; $env:SERVER_NAME='backend-3'; node backends/server.js
   ```

2. **Start the ADC Gateway**:
   ```bash
   npm run dev
   ```

3. **Start the Administration Dashboard**:
   ```bash
   cd dashboard
   npm run dev
   ```
   Open `http://localhost:5173` in your browser and sign in using `admin` / `sentinel`.

### Running Performance Benchmarks

The project contains an automated stress testing suite that boots mock servers, starts the gateway with custom configuration, bombards it with loads, and logs a performance matrix comparing raw proxy, caching hits, and WAF overhead:

```bash
npm run benchmark
```

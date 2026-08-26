# Performance Budgets — HQPixels

**Document type:** Reference  
**Version:** 1.0  
**Date:** 2026-08-25

---

## 1. Response Time Targets

All times in milliseconds. Measured at the edge (Cloudflare PoP).

### 1.1 Read Endpoints (Cached)

| Endpoint                      | p50   | p95    | p99    | Cache TTL |
| ----------------------------- | ----- | ------ | ------ | --------- |
| `GET /api/wall/manifest`      | <50ms | <150ms | <300ms | 60s       |
| `GET /api/public/pricing`     | <30ms | <100ms | <200ms | 300s      |
| `GET /api/public/stats`       | <50ms | <150ms | <300ms | 60s       |
| `GET /api/public/leaderboard` | <50ms | <150ms | <300ms | 60s       |
| `GET /go/:id` (redirect)      | <50ms | <150ms | <300ms | 86400s    |

**Notes:**

- p50/p95 are primary targets; p99 is acceptable degradation
- Cache TTLs are enforced via `Cache-Control` headers
- Manifest is the highest-traffic endpoint (~85% of reads)

### 1.2 Write Endpoints (Uncached)

| Endpoint                         | p50    | p95     | p99     | Rate Limit   |
| -------------------------------- | ------ | ------- | ------- | ------------ |
| `POST /api/reservations/reserve` | <200ms | <500ms  | <1000ms | 5/min/user   |
| `POST /api/checkout/open`        | <300ms | <700ms  | <1500ms | 3/min/user   |
| `GET /api/dashboard/*`           | <150ms | <400ms  | <800ms  | 30/min/user  |
| `POST /api/uploads/image`        | <500ms | <1500ms | <3000ms | 2/min/user   |
| `POST /api/admin/*`              | <200ms | <500ms  | <1000ms | 60/min/admin |

**Notes:**

- Write operations are not cached and hit the database directly
- Higher variance expected due to database contention
- Image upload times depend on file size (limit: 2MB)

### 1.3 Webhook Processing

| Event                        | Target Processing Time | SLA              |
| ---------------------------- | ---------------------- | ---------------- |
| `checkout.session.completed` | <2s                    | 99.9% within 30s |
| `payment_intent.succeeded`   | <2s                    | 99.9% within 30s |
| `charge.refunded`            | <2s                    | 99.9% within 30s |
| `charge.dispute.created`     | <5s                    | 99% within 60s   |

**Notes:**

- Webhook idempotency protects against retries
- Stripe retries automatically for 72 hours

---

## 2. Throughput Targets

### 2.1 Concurrent Users

| Tier   | Concurrent Users | Expected Behavior                          |
| ------ | ---------------- | ------------------------------------------ |
| Normal | 1–1,000          | Full performance, all budgets met          |
| High   | 1,000–10,000     | Within budgets, rate limits may engage     |
| Spike  | 10,000–50,000    | Degraded latency, aggressive rate limiting |
| Viral  | 50,000–100,000   | Stale cache served, writes queued          |

### 2.2 Requests Per Second (RPS)

| Endpoint Category   | Normal RPS | Peak RPS | Limit               |
| ------------------- | ---------- | -------- | ------------------- |
| Cached reads        | 1,000      | 50,000   | No hard limit (CDN) |
| Authenticated reads | 100        | 1,000    | 2,000               |
| Writes              | 10         | 100      | 500                 |
| Webhooks            | 1          | 50       | 100                 |

---

## 3. Error Rate Budgets

| Category            | Target | Acceptable | Action Threshold             |
| ------------------- | ------ | ---------- | ---------------------------- |
| Client errors (4xx) | <1%    | <5%        | >10% triggers alert          |
| Server errors (5xx) | <0.01% | <0.1%      | >1% triggers incident        |
| Timeouts            | <0.1%  | <1%        | >2% triggers circuit breaker |
| Rate limits (429)   | <0.5%  | <2%        | Informational only           |

**Error budget policy:**

- 99.9% availability target = 43.2 minutes downtime/month
- Error budget resets monthly
- Depletes budget → freeze non-critical changes

---

## 4. Client-Side Budgets

### 4.1 Page Load

| Metric                         | Budget | Measurement       |
| ------------------------------ | ------ | ----------------- |
| First Contentful Paint (FCP)   | <1.5s  | Lighthouse mobile |
| Largest Contentful Paint (LCP) | <2.5s  | Lighthouse mobile |
| Time to Interactive (TTI)      | <3.5s  | Lighthouse mobile |
| Cumulative Layout Shift (CLS)  | <0.1   | Lighthouse        |
| Total Blocking Time (TBT)      | <300ms | Lighthouse        |

### 4.2 Bundle Size

| Asset              | Budget      | Current |
| ------------------ | ----------- | ------- |
| Main JS bundle     | <250KB gzip | ~235KB  |
| Main CSS           | <50KB gzip  | TBD     |
| Initial HTML       | <15KB gzip  | ~3.7KB  |
| Wall manifest      | <100KB gzip | Varies  |
| Total initial load | <500KB      | TBD     |

### 4.3 Canvas Performance

| Metric               | Budget          |
| -------------------- | --------------- |
| Wall render (PixiJS) | <100ms at 1080p |
| Selection update     | <16ms (60fps)   |
| Zoom/pan             | <16ms (60fps)   |
| Memory usage         | <200MB          |

---

## 5. Database Budgets

### 5.1 Query Performance

| Query Category    | p50   | p95    | p99    |
| ----------------- | ----- | ------ | ------ |
| Simple SELECT     | <5ms  | <20ms  | <50ms  |
| Indexed JOIN      | <10ms | <50ms  | <100ms |
| Complex aggregate | <50ms | <200ms | <500ms |
| reserve_cells()   | <30ms | <100ms | <200ms |
| settle_payment()  | <20ms | <80ms  | <150ms |

### 5.2 Connection Pool

| Metric                 | Budget                         |
| ---------------------- | ------------------------------ |
| Pool size              | 20 connections (Supabase Free) |
| Checkout timeout       | 5s                             |
| Idle timeout           | 60s                            |
| Max queries/connection | 10,000                         |

---

## 6. Infrastructure Budgets

### 6.1 Cloudflare Workers

| Limit            | Free Tier | Paid Tier |
| ---------------- | --------- | --------- |
| CPU time/request | 10ms      | 30ms      |
| Memory           | 128MB     | 128MB     |
| Requests/day     | 100,000   | Unlimited |
| Subrequest limit | 50        | 1000      |

### 6.2 Supabase

| Limit         | Free Tier | Pro Tier   |
| ------------- | --------- | ---------- |
| Database size | 500MB     | 8GB        |
| Connections   | 20        | 60         |
| Bandwidth     | 2GB/month | 50GB/month |
| Storage       | 1GB       | 100GB      |

---

## 7. Monitoring Thresholds

### 7.1 Alerts

| Metric                 | Warning   | Critical  |
| ---------------------- | --------- | --------- |
| p95 latency (manifest) | >200ms    | >500ms    |
| Error rate (5xx)       | >0.5%     | >1%       |
| Cache hit rate         | <90%      | <80%      |
| Database connections   | >80%      | >95%      |
| Worker CPU             | >20ms avg | >40ms avg |

### 7.2 SLOs

| SLO           | Target | Measurement Window |
| ------------- | ------ | ------------------ |
| Availability  | 99.9%  | 30 days            |
| Latency (p95) | <300ms | 7 days             |
| Error rate    | <0.1%  | 24 hours           |

---

## 8. Budget Enforcement

### 8.1 CI Checks

```yaml
# In CI pipeline
- name: Lighthouse CI
  thresholds:
    performance: 90
    accessibility: 100
    best-practices: 100
    seo: 90

- name: Bundle Size
  maxSize:
    main: 260KB

- name: TypeScript Build
  timeout: 60s
```

### 8.2 Production Monitoring

- **Cloudflare Analytics:** Request latency, cache ratio, errors
- **Supabase Dashboard:** Query performance, connection usage
- **Custom metrics:** Business KPIs in Worker KV

### 8.3 Review Cadence

| Review           | Frequency  | Owner       |
| ---------------- | ---------- | ----------- |
| Real-time alerts | Continuous | On-call     |
| Daily dashboard  | Daily      | Engineering |
| Budget review    | Weekly     | Tech lead   |
| SLO review       | Monthly    | Team        |

---

## Appendix: k6 Threshold Configuration

```javascript
// Use these thresholds in k6 tests
export const options = {
  thresholds: {
    // Read endpoints
    'http_req_duration{name:manifest}': ['p95<150', 'p99<300'],
    'http_req_duration{name:pricing}': ['p95<100', 'p99<200'],
    'http_req_duration{name:stats}': ['p95<150', 'p99<300'],

    // Write endpoints
    'http_req_duration{name:reserve}': ['p95<500', 'p99<1000'],
    'http_req_duration{name:checkout}': ['p95<700', 'p99<1500'],

    // Global
    http_req_failed: ['rate<0.01'],
    http_req_duration: ['p95<500'],
  },
};
```

---

**Document end. Budgets are verified in Task I (final verification pass).**

/**
 * k6 Load Test: 10,000 Concurrent Viewers
 *
 * Stress test simulating 10,000 concurrent users viewing the pixel wall.
 * This test validates:
 * - Edge caching holds under high load
 * - No cascading failures to origin
 * - Response times remain acceptable
 * - System gracefully handles traffic spikes
 *
 * CAUTION: This test generates significant load. Only run against:
 * - Local development with rate limiting disabled
 * - Staging environment with proper infrastructure
 * - Never against production without approval
 */

import http from 'k6/http';
import { check, group, sleep, fail } from 'k6';
import { Counter, Rate, Trend, Gauge } from 'k6/metrics';

// Custom metrics
const activeViewers = new Gauge('active_viewers');
const requestsPerSecond = new Counter('requests_per_second');
const originHits = new Counter('origin_hits');
const cacheHitRate = new Rate('cache_hit_rate');
const errorRate = new Rate('error_rate');
const manifestLatency = new Trend('manifest_latency', true);
const p99Latency = new Trend('p99_latency', true);

export const options = {
  scenarios: {
    // Traffic pattern: Sharp spike then sustained load
    spike_and_sustain: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 2000 }, // Initial ramp
        { duration: '2m', target: 5000 }, // Continue ramp
        { duration: '2m', target: 10000 }, // Peak load
        { duration: '5m', target: 10000 }, // Sustain peak
        { duration: '2m', target: 5000 }, // Graceful decrease
        { duration: '1m', target: 0 }, // Ramp down
      ],
      gracefulRampDown: '30s',
    },
    // Background: Periodic heavy manifest requests (simulating page refreshes)
    refresh_storm: {
      executor: 'constant-arrival-rate',
      rate: 500, // 500 requests per second
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 1000,
      maxVUs: 2000,
      startTime: '3m', // Start after initial ramp
    },
  },
  thresholds: {
    // Relaxed thresholds for 10k test (still aggressive)
    http_req_duration: ['p95<300', 'p99<500'],
    http_req_failed: ['rate<0.01'], // <1% error rate
    manifest_latency: ['p95<200', 'p99<400'],
    error_rate: ['rate<0.01'],
    // Circuit breaker: abort if error rate exceeds 5%
    'error_rate{scenario:spike_and_sustain}': [{ threshold: 'rate<0.05', abortOnFail: true }],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';

// Request pool to vary the load
const ENDPOINTS = {
  manifest: { path: '/api/wall/manifest', weight: 0.75 },
  pricing: { path: '/api/public/pricing', weight: 0.1 },
  stats: { path: '/api/public/stats', weight: 0.1 },
  redirect: { path: '/go/sample-placement', weight: 0.05 },
};

/**
 * Main test function: Simulate a viewer's browsing pattern.
 */
export default function () {
  activeViewers.add(__VU);
  requestsPerSecond.add(1);

  const endpoint = selectEndpoint();

  group(endpoint.name, () => {
    const startTime = Date.now();

    const res = http.get(`${BASE_URL}${endpoint.path}`, {
      tags: { name: endpoint.name },
      timeout: '10s', // Generous timeout for high-load conditions
    });

    const duration = Date.now() - startTime;
    manifestLatency.add(duration);
    p99Latency.add(duration);

    // Track errors
    const isError = res.status >= 400 || res.status === 0;
    errorRate.add(isError ? 1 : 0);

    // Track cache status
    const cacheStatus = res.headers['Cf-Cache-Status'] || res.headers['cf-cache-status'];
    const isHit = cacheStatus === 'HIT' || cacheStatus === 'REVALIDATED';
    cacheHitRate.add(isHit ? 1 : 0);

    if (cacheStatus === 'MISS' || cacheStatus === 'EXPIRED') {
      originHits.add(1);
    }

    check(res, {
      'status is 2xx or 3xx': (r) => r.status >= 200 && r.status < 400,
      'response time acceptable': (r) => r.timings.duration < 500,
      'response has body': (r) => r.body && r.body.length > 0,
    });

    // Log slow responses for debugging
    if (duration > 1000) {
      console.warn(`Slow response: ${endpoint.path} took ${duration}ms (VU ${__VU})`);
    }
  });

  // Realistic think time: 1-5 seconds between requests
  sleep(1 + Math.random() * 4);
}

/**
 * Select endpoint based on weighted distribution.
 */
function selectEndpoint() {
  const rand = Math.random();
  let cumulative = 0;

  for (const [name, config] of Object.entries(ENDPOINTS)) {
    cumulative += config.weight;
    if (rand < cumulative) {
      return { name, path: config.path };
    }
  }

  // Fallback to manifest
  return { name: 'manifest', path: ENDPOINTS.manifest.path };
}

/**
 * Setup: Verify system health and warm caches.
 */
export function setup() {
  console.log('=== 10K Viewers Load Test ===');
  console.log(`Target: ${BASE_URL}`);
  console.log('Running pre-flight checks...');

  // Health check
  const health = http.get(`${BASE_URL}/api/public/pricing`);
  if (health.status !== 200) {
    fail(`API not ready: ${health.status}`);
  }

  // Warm caches
  for (const [name, config] of Object.entries(ENDPOINTS)) {
    if (config.path.includes('sample')) continue; // Skip redirect test
    const res = http.get(`${BASE_URL}${config.path}`);
    console.log(`Warmed ${name}: ${res.status}`);
  }

  console.log('Pre-flight complete. Starting load test...');

  return {
    startTime: Date.now(),
    targetUrl: BASE_URL,
  };
}

/**
 * Teardown: Generate summary report.
 */
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  const minutes = Math.floor(duration / 60);
  const seconds = (duration % 60).toFixed(0);

  console.log('\n=== 10K Viewers Test Complete ===');
  console.log(`Duration: ${minutes}m ${seconds}s`);
  console.log(`Target: ${data.targetUrl}`);
  console.log('\nReview the HTML report for detailed metrics.');
}

/**
 * Handle test interruption gracefully.
 */
export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    duration_seconds: data.state.testRunDurationMs / 1000,
    total_requests: data.metrics.http_reqs?.values?.count || 0,
    failed_requests: data.metrics.http_req_failed?.values?.passes || 0,
    avg_response_ms: data.metrics.http_req_duration?.values?.avg || 0,
    p95_response_ms: data.metrics.http_req_duration?.values?.['p(95)'] || 0,
    p99_response_ms: data.metrics.http_req_duration?.values?.['p(99)'] || 0,
    peak_vus: data.metrics.vus_max?.values?.max || 0,
  };

  return {
    'tests/load/results/10k-viewers-summary.json': JSON.stringify(summary, null, 2),
  };
}

/**
 * EXPECTED RESULTS (theoretical, k6 not installed):
 *
 * With properly configured Cloudflare Workers + edge caching:
 *
 * Phase 1 (Ramp to 2,000 VUs):
 * - Response times stable <100ms
 * - Cache hit rate >95%
 * - Zero errors
 *
 * Phase 2 (Ramp to 5,000 VUs):
 * - p95 latency may increase to ~150ms
 * - Origin hits increase slightly during cache refreshes
 * - Error rate remains <0.1%
 *
 * Phase 3 (10,000 VUs sustained):
 * - p95 latency: ~200-300ms expected
 * - Cache hit rate: >90% (some cache stampede during refreshes)
 * - Error rate: <1% (rate limiting may kick in)
 * - Origin requests: <100/second (rest served from edge)
 *
 * Key observations to watch:
 * 1. Cache stampede at expiration boundaries
 * 2. Rate limiter behavior on high-frequency clients
 * 3. Worker CPU time limits (50ms per request on Free tier)
 * 4. Memory pressure from concurrent PixiJS canvases (client-side)
 *
 * Infrastructure requirements for 10k concurrent:
 * - Cloudflare Workers: Handles well (serverless auto-scaling)
 * - Supabase Postgres: May need connection pooling tuned
 * - Stripe: Not tested (payment endpoints not under load)
 *
 * LIMITATIONS:
 * - This test does not simulate WebSocket connections
 * - Real PixiJS canvas rendering is client-side only
 * - Geographic distribution of users not simulated
 */

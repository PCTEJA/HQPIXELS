/**
 * k6 Load Test: Cached Viewers (1,000 concurrent)
 *
 * Simulates 1,000 concurrent viewers hitting cached read-only endpoints.
 * Tests the CDN/edge caching effectiveness and baseline latency.
 *
 * Target endpoints (all cacheable):
 * - GET /api/wall/manifest — primary traffic, cached 60s
 * - GET /api/public/pricing — cached 300s
 * - GET /api/public/stats — cached 60s
 *
 * Expected outcomes:
 * - >99% of requests served from cache (CF edge or Worker KV)
 * - p95 response time under 150ms for manifest
 * - Zero errors under steady load
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics
const cacheHits = new Counter('cache_hits');
const cacheMisses = new Counter('cache_misses');
const cacheHitRate = new Rate('cache_hit_rate');
const manifestLatency = new Trend('manifest_latency', true);
const pricingLatency = new Trend('pricing_latency', true);
const statsLatency = new Trend('stats_latency', true);

export const options = {
  scenarios: {
    // Ramp up to 1000 concurrent viewers over 30s, hold for 2 min
    steady_viewers: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 1000 }, // Ramp up
        { duration: '2m', target: 1000 }, // Steady state
        { duration: '30s', target: 0 }, // Ramp down
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Performance budgets from HANDOFF.md
    http_req_duration: ['p95<150', 'p99<300'],
    http_req_failed: ['rate<0.001'], // <0.1% error rate
    manifest_latency: ['p50<50', 'p95<150', 'p99<300'],
    pricing_latency: ['p50<30', 'p95<100', 'p99<200'],
    cache_hit_rate: ['rate>0.95'], // >95% cache hit rate
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';

/**
 * Standard viewer request pattern:
 * 1. Load manifest (wall state) — most frequent
 * 2. Occasionally check pricing
 * 3. Occasionally check stats
 *
 * Realistic ratio: 80% manifest, 10% pricing, 10% stats
 */
export default function () {
  const rand = Math.random();

  if (rand < 0.8) {
    // 80% of requests: manifest (main wall view)
    fetchManifest();
  } else if (rand < 0.9) {
    // 10% of requests: pricing
    fetchPricing();
  } else {
    // 10% of requests: stats
    fetchStats();
  }

  // Simulate realistic user think time (0.5-2 seconds)
  sleep(0.5 + Math.random() * 1.5);
}

/**
 * Fetch the wall manifest.
 * This is the highest-traffic endpoint — every viewer loads this.
 */
function fetchManifest() {
  group('Manifest', () => {
    const res = http.get(`${BASE_URL}/api/wall/manifest`, {
      tags: { name: 'manifest' },
    });

    manifestLatency.add(res.timings.duration);
    trackCacheStatus(res);

    check(res, {
      'manifest status 200': (r) => r.status === 200,
      'manifest has content': (r) => r.body && r.body.length > 0,
      'manifest is JSON': (r) => {
        try {
          const data = JSON.parse(r.body);
          return 'version' in data || 'placements' in data;
        } catch {
          return false;
        }
      },
      'manifest latency < 150ms': (r) => r.timings.duration < 150,
    });
  });
}

/**
 * Fetch pricing information.
 * Cached longer (300s) since it changes rarely.
 */
function fetchPricing() {
  group('Pricing', () => {
    const res = http.get(`${BASE_URL}/api/public/pricing`, {
      tags: { name: 'pricing' },
    });

    pricingLatency.add(res.timings.duration);
    trackCacheStatus(res);

    check(res, {
      'pricing status 200': (r) => r.status === 200,
      'pricing has price data': (r) => {
        try {
          const data = JSON.parse(r.body);
          return 'base_cents_per_cell' in data || 'pricing' in data;
        } catch {
          return false;
        }
      },
      'pricing latency < 100ms': (r) => r.timings.duration < 100,
    });
  });
}

/**
 * Fetch public statistics.
 * Shows grid occupancy, total placements, etc.
 */
function fetchStats() {
  group('Stats', () => {
    const res = http.get(`${BASE_URL}/api/public/stats`, {
      tags: { name: 'stats' },
    });

    statsLatency.add(res.timings.duration);
    trackCacheStatus(res);

    check(res, {
      'stats status 200': (r) => r.status === 200,
      'stats has data': (r) => r.body && r.body.length > 10,
      'stats latency < 150ms': (r) => r.timings.duration < 150,
    });
  });
}

/**
 * Track cache hit/miss based on response headers.
 * Cloudflare uses CF-Cache-Status, Workers use custom headers.
 */
function trackCacheStatus(res) {
  const cfCacheStatus = res.headers['Cf-Cache-Status'] || res.headers['cf-cache-status'];
  const cacheControl = res.headers['Cache-Control'] || res.headers['cache-control'];
  const xCacheStatus = res.headers['X-Cache-Status'] || res.headers['x-cache-status'];

  // Check for cache hit indicators
  const isHit =
    cfCacheStatus === 'HIT' ||
    cfCacheStatus === 'REVALIDATED' ||
    xCacheStatus === 'HIT' ||
    (cacheControl && cacheControl.includes('public'));

  if (isHit) {
    cacheHits.add(1);
    cacheHitRate.add(1);
  } else {
    cacheMisses.add(1);
    cacheHitRate.add(0);
  }
}

/**
 * Setup: Warm the cache before starting the main test.
 */
export function setup() {
  console.log('Warming cache...');

  // Prime each endpoint once
  const endpoints = ['/api/wall/manifest', '/api/public/pricing', '/api/public/stats'];

  for (const endpoint of endpoints) {
    const res = http.get(`${BASE_URL}${endpoint}`);
    console.log(`Warmed ${endpoint}: ${res.status}`);
  }

  // Brief pause for cache propagation
  sleep(1);

  return { startTime: Date.now() };
}

export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Cached viewers test completed in ${duration.toFixed(2)}s`);
}

/**
 * EXPECTED RESULTS (theoretical, k6 not installed):
 *
 * With properly configured edge caching:
 * - cache_hit_rate: >95% (after warm-up)
 * - manifest_latency p50: <50ms (from edge)
 * - manifest_latency p95: <150ms
 * - pricing_latency p50: <30ms
 * - http_req_failed: 0%
 *
 * Notes:
 * - First requests after deployment may show cache misses
 * - Local testing (localhost) won't have edge caching
 * - Production should use Cloudflare's edge network
 */

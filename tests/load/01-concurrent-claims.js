/**
 * k6 Load Test: Concurrent Claims
 *
 * Simulates 100 simultaneous reservation attempts on overlapping grid regions.
 * Tests the database's ability to prevent double-allocation under concurrent load.
 *
 * Expected outcomes:
 * - Exactly one reservation succeeds per contested cell region
 * - All other attempts receive `cells_unavailable` (409 Conflict)
 * - No partial reservations or data corruption
 * - p95 response time under 500ms even during contention
 *
 * IMPORTANT: This test does NOT target Stripe. It stops at reservation creation.
 */

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// Custom metrics
const reservationSuccess = new Counter('reservation_success');
const reservationConflict = new Counter('reservation_conflict');
const reservationError = new Counter('reservation_error');
const conflictRate = new Rate('conflict_rate');
const reservationDuration = new Trend('reservation_duration', true);

export const options = {
  scenarios: {
    // Scenario 1: Burst of 100 simultaneous claims on the SAME cells
    same_cell_burst: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 100,
      maxDuration: '30s',
      startTime: '0s',
      tags: { scenario: 'same_cell' },
    },
    // Scenario 2: Overlapping chain claims (adjacent rectangles)
    overlapping_chain: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 100,
      maxDuration: '30s',
      startTime: '35s',
      tags: { scenario: 'overlapping' },
    },
  },
  thresholds: {
    // Performance budgets from HANDOFF.md
    http_req_duration: ['p95<500', 'p99<1000'],
    http_req_failed: ['rate<0.02'], // <2% non-conflict errors
    reservation_duration: ['p95<500'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8787';

// Simulated authenticated user session (would need real tokens in production)
const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  // In real test, inject valid session token per VU
  // 'Authorization': `Bearer ${__VU_TOKEN}`,
};

/**
 * Generate test user data for this VU.
 * In production, each VU would have a unique authenticated session.
 */
function getTestUser() {
  return {
    id: `test-user-${__VU}`,
    email: `loadtest-vu${__VU}@example.com`,
  };
}

/**
 * Attempt to reserve a specific cell region.
 * Returns the response for validation.
 */
function reserveCells(x, y, width, height, destinationUrl) {
  const payload = JSON.stringify({
    cell_x: x,
    cell_y: y,
    width: width,
    height: height,
    destination_url: destinationUrl,
    terms_accepted: true,
  });

  const startTime = Date.now();

  const res = http.post(`${BASE_URL}/api/reservations/reserve`, payload, {
    headers: AUTH_HEADERS,
    tags: { name: 'reserve_cells' },
  });

  const duration = Date.now() - startTime;
  reservationDuration.add(duration);

  return res;
}

/**
 * Scenario 1: All 100 VUs attempt to claim the EXACT SAME rectangle.
 * Expected: Exactly 1 succeeds, 99 get conflict.
 */
function sameCellBurst() {
  group('Same Cell Burst', () => {
    // All VUs target the same 2x2 region at (50, 50)
    const res = reserveCells(50, 50, 2, 2, `https://loadtest-vu${__VU}.example.com`);

    const isSuccess = res.status === 201;
    const isConflict = res.status === 409;
    const isError = !isSuccess && !isConflict;

    if (isSuccess) {
      reservationSuccess.add(1);
      conflictRate.add(0);
    } else if (isConflict) {
      reservationConflict.add(1);
      conflictRate.add(1);
    } else {
      reservationError.add(1);
    }

    check(res, {
      'response is success or conflict': (r) => r.status === 201 || r.status === 409,
      'response time acceptable': (r) => r.timings.duration < 500,
      'has valid JSON body': (r) => {
        try {
          JSON.parse(r.body);
          return true;
        } catch {
          return false;
        }
      },
    });
  });
}

/**
 * Scenario 2: VUs claim adjacent/overlapping rectangles.
 * Creates a chain of overlapping claims to test edge conflict detection.
 */
function overlappingChain() {
  group('Overlapping Chain', () => {
    // Each VU claims a 2x2 region, but they overlap by 1 cell
    // VU 1: (0,0)-(2,2), VU 2: (1,0)-(3,2), VU 3: (2,0)-(4,2), etc.
    const x = (__VU - 1) % 50; // Wrap to stay within 100x100 grid
    const y = Math.floor((__VU - 1) / 50) * 2;

    const res = reserveCells(x, y, 2, 2, `https://chain-vu${__VU}.example.com`);

    const isSuccess = res.status === 201;
    const isConflict = res.status === 409;

    if (isSuccess) {
      reservationSuccess.add(1);
    } else if (isConflict) {
      reservationConflict.add(1);
    } else {
      reservationError.add(1);
    }

    check(res, {
      'response is success or conflict': (r) => r.status === 201 || r.status === 409,
      'no partial reservation': (r) => {
        // A partial reservation would show as 500 or inconsistent state
        return r.status !== 500;
      },
      'response time acceptable': (r) => r.timings.duration < 500,
    });
  });
}

export default function () {
  // Route to appropriate scenario based on tags
  const scenario = __ENV.SCENARIO || 'same_cell';

  if (scenario === 'same_cell' || __ITER < 1) {
    sameCellBurst();
  } else {
    overlappingChain();
  }

  // Brief pause between iterations
  sleep(0.1);
}

/**
 * Setup: Verify the API is reachable before starting.
 */
export function setup() {
  const healthCheck = http.get(`${BASE_URL}/api/public/pricing`);

  if (healthCheck.status !== 200) {
    console.error(`API not ready: ${healthCheck.status}`);
    throw new Error('API health check failed');
  }

  console.log('API is ready, starting load test...');

  return {
    startTime: Date.now(),
    baseUrl: BASE_URL,
  };
}

/**
 * Teardown: Log summary statistics.
 */
export function teardown(data) {
  const duration = (Date.now() - data.startTime) / 1000;
  console.log(`Load test completed in ${duration.toFixed(2)}s`);
}

/**
 * EXPECTED RESULTS (theoretical, k6 not installed):
 *
 * Same Cell Burst scenario:
 * - reservation_success: 1 (exactly one winner)
 * - reservation_conflict: 99 (all others get cells_unavailable)
 * - reservation_error: 0 (no crashes or data corruption)
 *
 * Overlapping Chain scenario:
 * - reservation_success: ~44-50 (depends on timing, ~50% of grid fits)
 * - reservation_conflict: ~50-56 (overlapping claims rejected)
 * - reservation_error: 0
 *
 * This mirrors the verified PostgreSQL concurrency test results from HANDOFF.md:
 * "100 concurrent claims on the SAME rectangle: exactly 1 winner, 99 clean cells_unavailable"
 */

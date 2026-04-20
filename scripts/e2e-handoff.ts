/**
 * Phase 5 end-to-end handoff test
 *
 * Requires all Phase 5 services to be running:
 *   - Go core API        :8080
 *   - AI brain           :8000
 *   - Mock drone dispatch :4003
 *
 * Steps:
 *   1. Create a trip with golden_hour_deadline = NOW + 2 min
 *   2. Start the trip  (Pending → InTransit)
 *   3. Subscribe to the dashboard WebSocket for HANDOFF_INITIATED
 *   4. Send GPS pings from 50 km away until they flush to Postgres
 *   5. Poll GET /api/v1/trips/:id until status = DroneHandoff (90 s budget)
 *   6. Assert GET http://localhost:4003/calls logged a dispatch for our trip
 *   7. Assert the WS hub broadcast HANDOFF_INITIATED for our trip
 *
 * Exit 0 on all assertions passing, 1 on any failure (with diff printed to stderr).
 */

import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BACKEND_HTTP  = process.env.BACKEND_URL ?? 'http://localhost:8080';
const BACKEND_WS    = process.env.BACKEND_WS   ?? 'ws://localhost:8080/ws/dashboard';
const DRONE_URL     = process.env.DRONE_URL    ?? 'http://localhost:4003';

const POLL_INTERVAL_MS   = 3_000;
const HANDOFF_TIMEOUT_MS = 90_000;
const PING_DURATION_MS   = 25_000;  // > flush_interval(5s) + monitor_poll(10s) + margin
const PING_INTERVAL_MS   = 1_000;

// Bangalore destination (end of the God-mode route). The ambulance will be
// placed ~50 km south so the AI brain always predicts a golden-hour breach.
const DESTINATION  = { lat: 12.9629, lng: 77.6201 };
const PING_LOCATION = { lat: 12.5129, lng: 77.6201 };  // ≈ 50 km south

// ---------------------------------------------------------------------------
// Assertion collector
// ---------------------------------------------------------------------------
interface Assertion {
  label: string;
  passed: boolean;
  expected: string;
  got: string;
}

const assertions: Assertion[] = [];

function assert(label: string, passed: boolean, expected: string, got: string): void {
  assertions.push({ label, passed, expected, got });
  if (passed) {
    console.log(`  ✓  ${label}`);
  } else {
    console.error(`  ✗  ${label}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function httpPost(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function httpGet(url: string): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('\n=== Sipra Phase 5 E2E — handoff test ===\n');

  // ------------------------------------------------------------------
  // Step 1: pre-flight health checks
  // ------------------------------------------------------------------
  console.log('── pre-flight checks ──');

  for (const [label, url] of [
    ['Go core API', `${BACKEND_HTTP}/healthz`],
    ['AI brain',    'http://localhost:8000/healthz'],
    ['Drone mock',  `${DRONE_URL}/healthz`],
  ] as [string, string][]) {
    const r = await httpGet(url).catch(() => ({ status: 0, data: null }));
    if (r.status !== 200) {
      console.error(`FATAL: ${label} is not reachable at ${url} (HTTP ${r.status})`);
      console.error('Start all services before running the e2e test.');
      process.exit(1);
    }
    console.log(`  ✓  ${label} reachable`);
  }

  // ------------------------------------------------------------------
  // Step 2: create trip with a 2-minute golden-hour deadline
  // ------------------------------------------------------------------
  console.log('\n── create trip ──');
  const deadline = new Date(Date.now() + 2 * 60 * 1_000).toISOString();

  const createRes = await httpPost(`${BACKEND_HTTP}/api/v1/trips`, {
    cargo_category:       'Organ',
    cargo_description:    'E2E test — Kidney',
    origin:               PING_LOCATION,
    destination:          DESTINATION,
    golden_hour_deadline: deadline,
    ambulance_id:         'AMB-E2E-01',
  });

  if (createRes.status !== 201) {
    console.error(`FATAL: trip creation failed (HTTP ${createRes.status}):`, createRes.data);
    process.exit(1);
  }

  const tripId = (createRes.data as { trip_id: string }).trip_id;
  console.log(`  trip_id : ${tripId}`);
  console.log(`  deadline: ${deadline}`);

  // ------------------------------------------------------------------
  // Step 3: transition to InTransit so the Risk Monitor evaluates it
  // ------------------------------------------------------------------
  console.log('\n── start trip (Pending → InTransit) ──');
  const startRes = await httpPost(`${BACKEND_HTTP}/api/v1/trips/${tripId}/start`, {});
  if (startRes.status !== 200) {
    console.error(`FATAL: start trip failed (HTTP ${startRes.status}):`, startRes.data);
    process.exit(1);
  }
  console.log(`  status: ${(startRes.data as { status: string }).status}`);

  // ------------------------------------------------------------------
  // Step 4: subscribe to dashboard WebSocket before sending pings
  // ------------------------------------------------------------------
  console.log('\n── subscribing to dashboard WebSocket ──');
  let handoffReceived = false;
  let handoffPayload: unknown = null;
  const wsMessages: unknown[] = [];

  const ws = new WebSocket(BACKEND_WS);

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      console.log('  WebSocket connected');
      resolve();
    });
    ws.once('error', (err) => reject(new Error(`WS connect error: ${err.message}`)));
    setTimeout(() => reject(new Error('WS connect timeout')), 5_000);
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; payload: Record<string, unknown> };
      wsMessages.push(msg);
      if (
        msg.type === 'HANDOFF_INITIATED' &&
        msg.payload?.trip_id === tripId
      ) {
        handoffReceived = true;
        handoffPayload = msg;
        console.log(`  📡  HANDOFF_INITIATED received on WS`);
      }
    } catch { /* malformed frame */ }
  });

  // ------------------------------------------------------------------
  // Step 5: send GPS pings from 50 km away
  // ------------------------------------------------------------------
  console.log('\n── sending pings from 50 km away ──');
  console.log(`  location: (${PING_LOCATION.lat}, ${PING_LOCATION.lng})`);
  console.log(`  duration: ${PING_DURATION_MS / 1_000} s`);

  let pingsSent = 0;
  const pingStart = Date.now();

  while (Date.now() - pingStart < PING_DURATION_MS) {
    await httpPost(`${BACKEND_HTTP}/api/v1/trips/${tripId}/pings`, {
      lat: PING_LOCATION.lat,
      lng: PING_LOCATION.lng,
      speed_kph: 40,
    }).catch(() => { /* ignore; backend queues in Redis so brief errors are fine */ });
    pingsSent++;
    await sleep(PING_INTERVAL_MS);
  }

  console.log(`  sent ${pingsSent} pings — waiting for Risk Monitor to pick up`);

  // ------------------------------------------------------------------
  // Step 6: poll for DroneHandoff status (90 s budget)
  // ------------------------------------------------------------------
  console.log('\n── polling for DroneHandoff ──');
  const pollStart = Date.now();
  let finalStatus = 'unknown';

  while (Date.now() - pollStart < HANDOFF_TIMEOUT_MS) {
    const r = await httpGet(`${BACKEND_HTTP}/api/v1/trips/${tripId}`).catch(() => ({ status: 0, data: null }));
    if (r.status === 200) {
      finalStatus = (r.data as { status: string }).status;
      process.stdout.write(`\r  status: ${finalStatus.padEnd(20)}`);
      if (finalStatus === 'DroneHandoff') {
        console.log();
        break;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // Give WS a moment to deliver the broadcast if it arrived just after the last poll.
  await sleep(2_000);
  ws.close();

  // ------------------------------------------------------------------
  // Step 7: assertions
  // ------------------------------------------------------------------
  console.log('\n── assertions ──');

  assert(
    'trip status flipped to DroneHandoff',
    finalStatus === 'DroneHandoff',
    'DroneHandoff',
    finalStatus,
  );

  // Check drone dispatch call log.
  const droneCallsRes = await httpGet(`${DRONE_URL}/calls`).catch(() => ({ status: 0, data: null }));
  const droneCalls = droneCallsRes.status === 200
    ? ((droneCallsRes.data as { calls: { trip_id: string }[] }).calls ?? [])
    : [];
  const droneCallForTrip = droneCalls.find(c => c.trip_id === tripId);

  assert(
    'mock drone dispatch received a call for this trip',
    droneCallForTrip !== undefined,
    `a call with trip_id=${tripId}`,
    droneCallForTrip
      ? `found: drone_id=${(droneCallForTrip as unknown as { drone_id: string }).drone_id}`
      : `not found in ${droneCalls.length} recorded calls`,
  );

  assert(
    'dashboard WebSocket received HANDOFF_INITIATED',
    handoffReceived,
    `HANDOFF_INITIATED with trip_id=${tripId}`,
    handoffReceived
      ? JSON.stringify(handoffPayload)
      : `not received (${wsMessages.length} total WS messages observed)`,
  );

  // ------------------------------------------------------------------
  // Result
  // ------------------------------------------------------------------
  const failed = assertions.filter(a => !a.passed);

  if (failed.length === 0) {
    console.log('\n✅  All assertions passed — Phase 5 handoff pipeline is working end-to-end.\n');
    process.exit(0);
  } else {
    console.error('\n❌  FAILED assertions:\n');
    for (const a of failed) {
      console.error(`  assertion : ${a.label}`);
      console.error(`  expected  : ${a.expected}`);
      console.error(`  got       : ${a.got}`);
      console.error();
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFatal error:', (err as Error).message);
  process.exit(1);
});

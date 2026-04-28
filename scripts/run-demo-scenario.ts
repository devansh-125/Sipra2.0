/**
 * Sipra E2E Scenario Injector
 *
 * Feeds the Go backend real HTTP payloads so every WebSocket event the
 * dashboard renders has flowed through production handlers — PostGIS
 * corridor engine, Python AI brain, mock drone dispatch, bounty surge
 * pricing — not frontend simulation.
 *
 * The script talks exclusively to the public REST surface:
 *   POST /api/v1/trips
 *   POST /api/v1/trips/:id/start
 *   POST /api/v1/trips/:id/pings
 *   POST /api/v1/trips/:id/bounties
 *   POST /api/v1/bounties/:id/claim
 *   POST /api/v1/bounties/:id/verify
 *
 * Usage:
 *   cd scripts
 *   npx tsx run-demo-scenario.ts --scenario=happy       [--city=bangalore]
 *   npx tsx run-demo-scenario.ts --scenario=congestion  [--city=bangalore]
 *   npx tsx run-demo-scenario.ts --scenario=drone       [--city=bangalore]
 *
 * Env:
 *   BACKEND_URL  default http://localhost:8080
 *   BACKEND_WS   default ws://localhost:8080/ws/dashboard
 *
 * Exit codes: 0 success, 1 backend/pipeline failure, 2 bad CLI args.
 */

import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BACKEND_HTTP = process.env.BACKEND_URL ?? 'http://localhost:8080';
const BACKEND_WS   = process.env.BACKEND_WS  ?? 'ws://localhost:8080/ws/dashboard';

// ---------------------------------------------------------------------------
// City presets — real hospital coords + hand-traced main-artery waypoints
// ---------------------------------------------------------------------------
interface GeoPoint { lat: number; lng: number }
interface CityPreset {
  name:            string;
  originHospital:  string;
  destHospital:    string;
  origin:          GeoPoint;
  destination:     GeoPoint;
  /** Polyline along the real arterial road between origin and destination. */
  route:           GeoPoint[];
}

const BANGALORE: CityPreset = {
  name:           'Bangalore',
  originHospital: 'Victoria Hospital, Bengaluru',
  destHospital:   'Manipal Hospital HAL, Bengaluru',
  origin:         { lat: 12.9656, lng: 77.5713 },
  destination:    { lat: 12.9587, lng: 77.6442 },
  // KR Circle → MG Road → Indiranagar 100ft → Old Airport Rd (~9 km)
  route: [
    { lat: 12.9656, lng: 77.5713 }, { lat: 12.9680, lng: 77.5810 },
    { lat: 12.9712, lng: 77.5893 }, { lat: 12.9726, lng: 77.5998 },
    { lat: 12.9745, lng: 77.6075 }, { lat: 12.9770, lng: 77.6180 },
    { lat: 12.9778, lng: 77.6255 }, { lat: 12.9768, lng: 77.6330 },
    { lat: 12.9750, lng: 77.6400 }, { lat: 12.9587, lng: 77.6442 },
  ],
};

const CITIES: Record<string, CityPreset> = { bangalore: BANGALORE };

// ---------------------------------------------------------------------------
// Tiny typed-fetch wrapper — native fetch, readable error bodies
// ---------------------------------------------------------------------------
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_HTTP}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `POST ${path} -> HTTP ${res.status}\n`   +
      `  request : ${JSON.stringify(body)}\n` +
      `  response: ${text}`,
    );
  }
  return text ? JSON.parse(text) as T : ({} as T);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const M_PER_DEG_LAT = 111_320;

function segmentM(a: GeoPoint, b: GeoPoint): number {
  const mLng = M_PER_DEG_LAT * Math.cos((a.lat * Math.PI) / 180);
  const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
  const dx = (b.lng - a.lng) * mLng;
  return Math.sqrt(dx * dx + dy * dy);
}

function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Return `n` points evenly spaced along a polyline (inclusive endpoints). */
function interpolatePolyline(pts: GeoPoint[], n: number): GeoPoint[] {
  if (pts.length < 2 || n < 2) return pts.slice();
  const cumulative: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cumulative.push(cumulative[i - 1] + segmentM(pts[i - 1], pts[i]));
  }
  const total = cumulative[cumulative.length - 1];
  const step  = total / (n - 1);

  const out: GeoPoint[] = [];
  let si = 0;
  for (let k = 0; k < n; k++) {
    const target = k * step;
    while (si < pts.length - 2 && cumulative[si + 1] < target) si++;
    const a = pts[si], b = pts[si + 1];
    const segLen = cumulative[si + 1] - cumulative[si];
    const frac   = segLen > 0 ? (target - cumulative[si]) / segLen : 0;
    out.push({ lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backend wrappers (types mirror services/core-go/internal/api/rest/*.go)
// ---------------------------------------------------------------------------
interface CreateTripResponse   { trip_id: string; status: string; golden_hour_deadline: string }
interface CreateBountyResponse { id: string; status: string; amount_points: number }
interface PingResponse         { ping_id: string; status: string }

async function createTrip(p: {
  city:         CityPreset;
  cargo:        'organ' | 'vaccine' | 'blood' | 'medication';
  description:  string;
  /** Minutes from now for the golden-hour deadline. */
  deadlineMin:  number;
  ambulanceId?: string;
}): Promise<string> {
  const deadline = new Date(Date.now() + p.deadlineMin * 60_000).toISOString();
  const res = await post<CreateTripResponse>('/api/v1/trips', {
    cargo_category:       p.cargo,
    cargo_description:    p.description,
    origin:               p.city.origin,
    destination:          p.city.destination,
    golden_hour_deadline: deadline,
    ambulance_id:         p.ambulanceId ?? `AMB-${p.city.name.toUpperCase().slice(0, 3)}-01`,
    hospital_dispatch_id: p.city.originHospital,
  });
  return res.trip_id;
}

/** Pending → InTransit. Risk Monitor only evaluates InTransit trips. */
async function startTrip(tripId: string): Promise<void> {
  await post(`/api/v1/trips/${tripId}/start`, undefined);
}

async function sendPing(
  tripId: string, point: GeoPoint, speedKph?: number, headingDeg?: number,
): Promise<void> {
  await post<PingResponse>(`/api/v1/trips/${tripId}/pings`, {
    lat: point.lat, lng: point.lng,
    ...(speedKph   !== undefined ? { speed_kph:   speedKph   } : {}),
    ...(headingDeg !== undefined ? { heading_deg: headingDeg } : {}),
  });
}

async function createBounty(p: {
  tripId:            string;
  driverRef:         string;
  checkpoint:        GeoPoint;
  radiusM?:          number;
  basePoints?:       number;
  corridorLengthM:   number;
  deviationM:        number;
  expiresMinFromNow?: number;
}): Promise<string> {
  const res = await post<CreateBountyResponse>(`/api/v1/trips/${p.tripId}/bounties`, {
    driver_ref:          p.driverRef,
    base_amount_points:  p.basePoints ?? 100,
    corridor_length_m:   p.corridorLengthM,
    deviation_m:         p.deviationM,
    checkpoint_lat:      p.checkpoint.lat,
    checkpoint_lng:      p.checkpoint.lng,
    checkpoint_radius_m: p.radiusM ?? 80,
    expires_at: new Date(Date.now() + (p.expiresMinFromNow ?? 5) * 60_000).toISOString(),
  });
  return res.id;
}

async function claimBounty(bountyId: string): Promise<void> {
  await post(`/api/v1/bounties/${bountyId}/claim`, undefined);
}

async function verifyBounty(bountyId: string, point: GeoPoint): Promise<void> {
  await post(`/api/v1/bounties/${bountyId}/verify`, { ping_lat: point.lat, ping_lng: point.lng });
}

// ---------------------------------------------------------------------------
// Minimal logger
// ---------------------------------------------------------------------------
const log = {
  info:  (m: string) => console.log(`  ${m}`),
  ok:    (m: string) => console.log(`  ✔ ${m}`),
  step:  (m: string) => console.log(`\n━━ ${m} ${'━'.repeat(Math.max(0, 60 - m.length))}`),
  warn:  (m: string) => console.warn(`  ! ${m}`),
  fatal: (m: string) => console.error(`\n  ✗ ${m}\n`),
};

// ---------------------------------------------------------------------------
// Scenario 1 — The Happy Path
//
// Drives the full corridor pipeline end-to-end:
//   trip → pings → Redis buffer → Postgres flush (every 5s) →
//   ST_MakeLine + ST_Buffer(2km) → CORRIDOR_UPDATE WS + partner webhooks.
// Two Swiggy drivers re-route per 10s tick via real bounty offers, so
// the dashboard also shows REROUTE_STATUS events.
// ---------------------------------------------------------------------------
async function runHappyPath(city: CityPreset): Promise<void> {
  log.step(`Scenario 1 — Happy Path (${city.name})`);
  log.info(`origin      = ${city.originHospital}`);
  log.info(`destination = ${city.destHospital}`);

  const tripId = await createTrip({
    city,
    cargo:       'blood',
    description: 'O-neg 4 units — routine emergency transfusion',
    deadlineMin: 45,
  });
  log.ok(`trip created   id=${tripId}`);

  await startTrip(tripId);
  log.ok('trip started   status=InTransit');

  const PING_COUNT = 60;
  const path = interpolatePolyline(city.route, PING_COUNT);

  log.step(`streaming ${PING_COUNT} ambulance pings @ 1 Hz`);
  for (let i = 0; i < PING_COUNT; i++) {
    const p    = path[i];
    const next = path[Math.min(i + 1, PING_COUNT - 1)];
    await sendPing(tripId, p, 45, bearingDeg(p, next));

    // Every 10s: one partner driver enters the corridor.
    // POST bounty → claim (REROUTE_STATUS=rerouting) → verify (=completed).
    if (i > 0 && i % 10 === 0) {
      const checkpoint = { lat: p.lat + 0.0012, lng: p.lng + 0.0012 }; // ~180m NE
      const bountyId = await createBounty({
        tripId,
        driverRef:       `SWIGGY-${i}`,
        checkpoint,
        corridorLengthM: 2000,
        deviationM:      180,
      });
      log.ok(`bounty offered   tick=${i}  driver=SWIGGY-${i}  id=${bountyId.slice(0, 8)}`);

      // Decouple the claim/verify lifecycle so pings stay at 1 Hz.
      void (async () => {
        await sleep(2000); await claimBounty(bountyId);
        await sleep(3000); await verifyBounty(bountyId, checkpoint);
      })().catch(err => log.warn(`bounty ${bountyId.slice(0, 8)} lifecycle: ${(err as Error).message.split('\n')[0]}`));
    }
    await sleep(1000);
  }
  log.ok('scenario complete — dashboard should show GPS_UPDATE + CORRIDOR_UPDATE + REROUTE_STATUS events');
}

// ---------------------------------------------------------------------------
// Scenario 2 — Congestion & Micro-Bounties
//
// Puts the ambulance mid-corridor crawling at 18 kph, then fan-outs 12
// partner bounties with escalating deviation_m so the surge multiplier in
// bounty.CalculateSurge climbs. Verify step hits PostGIS ST_DWithin in
// bounty.Verify() — the only path that actually touches that spatial op.
// ---------------------------------------------------------------------------
async function runCongestion(city: CityPreset): Promise<void> {
  log.step(`Scenario 2 — Congestion & Micro-Bounties (${city.name})`);

  const tripId = await createTrip({
    city,
    cargo:       'vaccine',
    description: 'COVID-19 booster cold chain — congestion scenario',
    deadlineMin: 60,
  });
  log.ok(`trip created   id=${tripId}`);
  await startTrip(tripId);

  // Ambulance is mid-corridor, crawling at 18 kph.
  const checkpointPath = interpolatePolyline(city.route, 12);
  const ambulanceAt    = checkpointPath[4];
  await sendPing(tripId, ambulanceAt, 18, 90);
  log.ok('ambulance crawling @ 18 kph at waypoint 4/12 (congestion)');

  log.step('injecting 12 partner-driver bounties with escalating surge');
  const bounties: Array<{ id: string; checkpoint: GeoPoint; driver: string; deviation: number }> = [];
  for (let i = 0; i < 12; i++) {
    const cp = checkpointPath[Math.min(4 + Math.floor(i / 2), checkpointPath.length - 1)];
    const checkpoint: GeoPoint = {
      lat: cp.lat + (Math.random() - 0.5) * 0.002, // ±100m jitter
      lng: cp.lng + (Math.random() - 0.5) * 0.002,
    };
    const driver    = `PARTNER-${String(i).padStart(2, '0')}`;
    const deviation = 150 + i * 50; // 150m → 700m — drives surge up

    const bountyId = await createBounty({
      tripId,
      driverRef:       driver,
      checkpoint,
      basePoints:      100,
      corridorLengthM: 2000,
      deviationM:      deviation,
      radiusM:         60,
    });
    bounties.push({ id: bountyId, checkpoint, driver, deviation });
    log.ok(`bounty #${String(i + 1).padStart(2, ' ')}   driver=${driver}  deviation=${deviation}m  id=${bountyId.slice(0, 8)}`);
    await sleep(300);
  }

  log.step('claiming all 12 bounties (drives REROUTE_STATUS=rerouting fan-out)');
  for (const b of bounties) {
    await claimBounty(b.id);
    await sleep(150);
  }

  log.step('verifying bounties — every verify is a PostGIS ST_DWithin call');
  let verified = 0;
  for (const b of bounties) {
    try {
      await verifyBounty(b.id, b.checkpoint);
      verified++;
      log.ok(`verified   ${b.driver}  id=${b.id.slice(0, 8)}`);
    } catch (err) {
      log.warn(`verify failed for ${b.driver}: ${(err as Error).message.split('\n')[0]}`);
    }
    await sleep(200);
  }
  log.ok(`scenario complete — ${verified}/12 REROUTE_STATUS=completed events broadcast`);
}

// ---------------------------------------------------------------------------
// Scenario 3 — Black Swan / Drone Handoff
//
// Create a trip with a 4-minute golden_hour_deadline and hold the ambulance
// stationary (~5 kph) at the origin, ~15 km from destination. The Python
// AI brain's ETA calculation will exceed the deadline → will_breach=true →
// Risk Monitor flips status to DroneHandoff and the WS hub broadcasts
// HANDOFF_INITIATED. We subscribe to /ws/dashboard and assert receipt.
//
// Requires:
//   - services/ai-brain running on :8000 (POST /predict)
//   - services/mocks/drone-dispatch running on :4003 (optional — handoff
//     event still broadcasts if dispatch fails, just without drone_id)
// ---------------------------------------------------------------------------
interface HandoffPayload {
  trip_id:               string;
  drone_id?:             string;
  eta_seconds?:          number;
  reason:                string;
  predicted_eta_seconds: number;
}

async function runDroneHandoff(city: CityPreset): Promise<void> {
  log.step(`Scenario 3 — Black Swan / Drone Handoff (${city.name})`);

  const tripId = await createTrip({
    city,
    cargo:       'organ',
    description: 'Kidney for transplant — golden hour breach imminent',
    deadlineMin: 4,
  });
  log.ok(`trip created   id=${tripId}   deadline=T+4m`);
  await startTrip(tripId);
  log.ok('trip started — risk monitor polls every RISK_POLL_INTERVAL_SEC (default 10s)');

  // Subscribe before we send pings so we don't miss the event.
  const ws = new WebSocket(BACKEND_WS);
  let handoff: HandoffPayload | null = null;

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type: string; payload: unknown };
      if (msg.type === 'HANDOFF_INITIATED') {
        const p = msg.payload as HandoffPayload;
        if (p.trip_id === tripId) {
          handoff = p;
          log.ok(`📡  HANDOFF_INITIATED   drone=${p.drone_id ?? 'n/a'}  predicted_eta=${p.predicted_eta_seconds}s  reason="${p.reason}"`);
        }
      }
    } catch { /* malformed frame */ }
  });
  ws.on('error', (e) => log.warn(`WS error: ${(e as Error).message}`));

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    setTimeout(() => reject(new Error(`WS connect timeout — is Go backend up at ${BACKEND_WS}?`)), 5000);
  });
  log.ok('dashboard WS open — listening for HANDOFF_INITIATED');

  // Hold ambulance at origin with tiny GPS jitter and 5 kph — mimics a
  // bottleneck that makes AI's ETA estimate spike well past the deadline.
  const DURATION_S = 90;
  log.step(`holding ambulance at origin for ${DURATION_S}s (speed=5 kph)`);
  for (let t = 0; t < DURATION_S; t++) {
    if (handoff) break;
    const jitter: GeoPoint = {
      lat: city.origin.lat + (Math.random() - 0.5) * 0.0002,
      lng: city.origin.lng + (Math.random() - 0.5) * 0.0002,
    };
    await sendPing(tripId, jitter, 5, 0);
    if (t % 10 === 9) log.info(`t=${t + 1}s   handoff received: ${handoff ? 'YES' : 'pending'}`);
    await sleep(1000);
  }

  await sleep(3000); // let Go finish fan-out
  ws.close();

  if (!handoff) {
    throw new Error(
      `HANDOFF_INITIATED never received after ${DURATION_S}s.\n` +
      `  likely cause: Python AI brain not running.\n` +
      `  check:        curl http://localhost:8000/healthz\n` +
      `  check:        docker compose ps ai-brain`,
    );
  }
  log.ok('scenario complete — drone-handoff pipeline verified end-to-end');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(): { scenario: string; city: string } {
  const args: Record<string, string> = {};
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([\w-]+)=(.+)$/);
    if (m) args[m[1]] = m[2];
  }
  return {
    scenario: (args.scenario ?? '').toLowerCase(),
    city:     (args.city ?? 'bangalore').toLowerCase(),
  };
}

async function main(): Promise<void> {
  const { scenario, city: cityKey } = parseArgs();
  const city = CITIES[cityKey];
  if (!city) {
    log.fatal(`unknown --city=${cityKey}. valid: ${Object.keys(CITIES).join(', ')}`);
    process.exit(2);
  }

  console.log('┌───────────────────────────────────────────────────');
  console.log('│  Sipra E2E Scenario Injector');
  console.log(`│  backend  = ${BACKEND_HTTP}`);
  console.log(`│  scenario = ${scenario || '(none)'}`);
  console.log(`│  city     = ${city.name}`);
  console.log('└───────────────────────────────────────────────────');

  try {
    switch (scenario) {
      case 'happy':      await runHappyPath(city);    break;
      case 'congestion': await runCongestion(city);   break;
      case 'drone':      await runDroneHandoff(city); break;
      default:
        log.fatal(`unknown --scenario=${scenario}. valid: happy | congestion | drone`);
        process.exit(2);
    }
  } catch (err) {
    log.fatal((err as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

main();

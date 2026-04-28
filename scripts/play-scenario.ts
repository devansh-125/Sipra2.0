/**
 * Sipra Scenario Player
 *
 * Drives the live Go backend end-to-end from a dataset scenario folder:
 *   1. POST /api/v1/trips          — create trip from trip.json
 *   2. POST /api/v1/trips/:id/start — start trip (Pending → InTransit)
 *   3. POST /api/v1/trips/:id/pings — stream pings.ndjson with realistic timing
 *   4. POST /api/v1/sim/fleet       — inject fleet snapshot from fleet.json
 *
 * Also subscribes to ws://localhost:8080/ws/dashboard so every WS envelope
 * (GPS_UPDATE, CORRIDOR_UPDATE, FLEET_UPDATE, RISK_PREDICTION, HANDOFF_INITIATED)
 * is printed live in the terminal — same data the Next.js dashboard receives.
 *
 * Usage:
 *   cd scripts
 *   npx tsx play-scenario.ts --scenario=normal
 *   npx tsx play-scenario.ts --scenario=congestion-breach     --speed=5
 *   npx tsx play-scenario.ts --scenario=sudden-spike-mid-route --speed=10
 *   npx tsx play-scenario.ts --scenario=gps-jitter-stale       --speed=10
 *
 * Available scenarios:
 *   normal | congestion-breach | sudden-spike-mid-route | gps-jitter-stale
 *   peak-hour-mg-road | conflicting-etas
 *
 * Options:
 *   --scenario=<name>   required
 *   --speed=<n>         time compression (default: 1). --speed=10 = 10× faster
 *   --no-fleet          skip fleet injection
 *   --no-ws             do not open WS monitor
 *
 * Env:
 *   BACKEND_URL  default http://localhost:8080
 *   BACKEND_WS   default ws://localhost:8080/ws/dashboard
 */

import * as fs   from 'fs';
import * as path from 'path';
import WebSocket  from 'ws';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BACKEND_HTTP = process.env.BACKEND_URL ?? 'http://localhost:8080';
const BACKEND_WS   = process.env.BACKEND_WS  ?? 'ws://localhost:8080/ws/dashboard';
const DATASET_ROOT = path.resolve(__dirname, '..', 'datasets', 'test-scenarios', 'realtime');

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
interface CliArgs {
  scenario: string;
  speed:    number;
  noFleet:  boolean;
  noWs:     boolean;
}

function parseArgs(): CliArgs {
  const kv: Record<string, string> = {};
  const flags = new Set<string>();
  for (const raw of process.argv.slice(2)) {
    const m = raw.match(/^--([\w-]+)=(.+)$/);
    if (m) { kv[m[1]] = m[2]; continue; }
    if (raw.startsWith('--')) flags.add(raw.slice(2));
  }
  const scenario = (kv['scenario'] ?? '').trim();
  if (!scenario) {
    console.error('  ✗ --scenario=<name> is required');
    console.error('    valid: normal | congestion-breach | sudden-spike-mid-route |');
    console.error('           gps-jitter-stale | peak-hour-mg-road | conflicting-etas');
    process.exit(2);
  }
  return {
    scenario,
    speed:   Math.max(0.1, parseFloat(kv['speed'] ?? '1') || 1),
    noFleet: flags.has('no-fleet'),
    noWs:    flags.has('no-ws'),
  };
}

// ---------------------------------------------------------------------------
// Tiny HTTP helpers
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
      `POST ${path} → HTTP ${res.status}\n` +
      `  body:     ${JSON.stringify(body)}\n` +
      `  response: ${text}`,
    );
  }
  try { return JSON.parse(text) as T; } catch { return {} as T; }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------
function fileExists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

function readNdjson<T>(p: string): T[] {
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as T);
}

// ---------------------------------------------------------------------------
// Timing: parse __T+Ns__ placeholders
// ---------------------------------------------------------------------------
function parseOffsetSeconds(recorded_at: string | undefined): number | null {
  if (!recorded_at) return null;
  const m = recorded_at.match(/^__T\+(\d+)s__$/);
  return m ? parseInt(m[1], 10) : null;
}

function offsetToRFC3339(baseMs: number, offsetSeconds: number): string {
  return new Date(baseMs + offsetSeconds * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';

const log = {
  section: (m: string) => console.log(`\n${BOLD}━━ ${m} ${'━'.repeat(Math.max(0, 58 - m.length))}${RESET}`),
  ok:      (m: string) => console.log(`  ${GREEN}✔${RESET} ${m}`),
  info:    (m: string) => console.log(`  ${CYAN}·${RESET} ${m}`),
  warn:    (m: string) => console.warn(`  ${YELLOW}!${RESET} ${m}`),
  fatal:   (m: string) => { console.error(`  ${RED}✗${RESET} ${m}`); process.exit(1); },
  ws:      (type: string, snippet: string) => console.log(`  ${DIM}ws${RESET}  ${YELLOW}${type.padEnd(22)}${RESET}${DIM}${snippet}${RESET}`),
};

// ---------------------------------------------------------------------------
// WS monitor — runs in the background, non-blocking
// ---------------------------------------------------------------------------
function openWsMonitor(): () => void {
  const ws = new WebSocket(BACKEND_WS);
  ws.on('error', err => log.warn(`WS: ${(err as Error).message}`));
  ws.on('open',  ()  => log.ok(`WS connected → ${BACKEND_WS}`));
  ws.on('close', ()  => log.info('WS closed'));

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as { type?: string; payload?: Record<string, unknown> };
      const type = msg.type ?? '?';
      const p    = msg.payload ?? {};

      let snippet = '';
      switch (type) {
        case 'GPS_UPDATE':
          snippet = `lat=${p['lat']} lng=${p['lng']} speed=${p['speed_kph']}kph`;
          break;
        case 'CORRIDOR_UPDATE':
          snippet = `trip=${String(p['trip_id']).slice(0,8)} v${p['version']} buf=${p['buffer_meters']}m`;
          break;
        case 'RISK_PREDICTION':
          snippet = `breach_prob=${p['breach_probability']} will_breach=${p['will_breach']} eta=${p['predicted_eta_seconds']}s`;
          break;
        case 'HANDOFF_INITIATED':
          snippet = `drone=${p['drone_id'] || 'n/a'} eta=${p['eta_seconds']}s reason="${p['reason']}"`;
          break;
        case 'FLEET_UPDATE':
          snippet = `vehicles=${Array.isArray((p as { fleet?: unknown[] })['fleet']) ? (p as { fleet: unknown[] })['fleet'].length : '?'}`;
          break;
        case 'REROUTE_STATUS':
          snippet = `driver=${p['driver_ref']} status=${p['status']}`;
          break;
        default:
          snippet = JSON.stringify(p).slice(0, 80);
      }
      log.ws(type, snippet);
    } catch { /* malformed */ }
  });

  return () => ws.close();
}

// ---------------------------------------------------------------------------
// Trip creation
// ---------------------------------------------------------------------------
interface TripJson {
  cargo_category:        string;
  cargo_description:     string;
  origin:                { lat: number; lng: number; name?: string };
  destination:           { lat: number; lng: number; name?: string };
  golden_hour_deadline?: string;  // "__DYNAMIC__", RFC3339, or absent
  golden_hour_minutes?:  number;
  ambulance_id:          string;
  hospital_dispatch_id?: string;
  tolerance_celsius?:    number;
}

interface CreateTripResp { trip_id: string; status: string }

async function createAndStartTrip(tripJson: TripJson): Promise<string> {
  let deadline = tripJson.golden_hour_deadline;
  if (!deadline || deadline === '__DYNAMIC__') {
    const minutes = tripJson.golden_hour_minutes ?? 120;
    deadline = new Date(Date.now() + minutes * 60_000).toISOString();
  }

  const body = {
    cargo_category:       tripJson.cargo_category,
    cargo_description:    tripJson.cargo_description,
    cargo_tolerance_celsius: tripJson.tolerance_celsius ?? null,
    origin:               { lat: tripJson.origin.lat, lng: tripJson.origin.lng },
    destination:          { lat: tripJson.destination.lat, lng: tripJson.destination.lng },
    golden_hour_deadline: deadline,
    ambulance_id:         tripJson.ambulance_id,
    hospital_dispatch_id: tripJson.hospital_dispatch_id,
  };

  const res = await post<CreateTripResp>('/api/v1/trips', body);
  log.ok(`trip created   id=${res.trip_id}  deadline=${deadline}`);

  await post(`/api/v1/trips/${res.trip_id}/start`, undefined);
  log.ok(`trip started   status=InTransit`);

  return res.trip_id;
}

// ---------------------------------------------------------------------------
// Ping streaming
// ---------------------------------------------------------------------------
interface PingRow {
  lat:         number;
  lng:         number;
  speed_kph?:  number;
  heading_deg?: number;
  accuracy_m?: number;
  recorded_at?: string;
  note?:       string;  // gps-jitter-stale annotation — ignored
}

async function streamPings(
  tripId:    string,
  pings:     PingRow[],
  baseMs:    number,
  speedMult: number,
): Promise<void> {
  log.section(`streaming ${pings.length} pings (speed=${speedMult}×)`);

  const hasOffsets = pings.some(p => parseOffsetSeconds(p.recorded_at) !== null);
  let prevOffsetMs = 0;

  for (let i = 0; i < pings.length; i++) {
    const ping = pings[i];

    // Build request body — strip dataset-only fields
    const body: Record<string, unknown> = { lat: ping.lat, lng: ping.lng };
    if (ping.speed_kph  !== undefined) body['speed_kph']   = ping.speed_kph;
    if (ping.heading_deg !== undefined) body['heading_deg'] = ping.heading_deg;
    if (ping.accuracy_m !== undefined) body['accuracy_m']  = ping.accuracy_m;

    // Timing
    let waitMs = 0;
    const offsetSec = parseOffsetSeconds(ping.recorded_at);

    if (offsetSec !== null) {
      // Scenario has explicit T+ offsets (e.g. gps-jitter-stale)
      body['recorded_at'] = offsetToRFC3339(baseMs, offsetSec);
      const targetMs = Math.round(offsetSec * 1000 / speedMult);
      waitMs = Math.max(0, targetMs - prevOffsetMs);
      prevOffsetMs = targetMs;
    } else if (hasOffsets) {
      // Mixed file — some have offsets, some don't; default 1s apart
      waitMs = Math.round(1000 / speedMult);
    } else {
      // No timing info at all — 1 ping per second scaled by speed
      if (i > 0) waitMs = Math.round(1000 / speedMult);
    }

    if (waitMs > 0) await sleep(waitMs);

    try {
      await post(`/api/v1/trips/${tripId}/pings`, body);
      process.stdout.write(
        `\r  · ping ${String(i + 1).padStart(3)}/${pings.length}  [${ping.lat.toFixed(5)}, ${ping.lng.toFixed(5)}]  ${(ping.speed_kph ?? 0).toString().padStart(3)} kph   `,
      );
    } catch (err) {
      console.log(); // newline after \r
      log.warn(`ping ${i + 1} failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  console.log(); // newline after final \r
  log.ok('all pings sent');
}

// ---------------------------------------------------------------------------
// Fleet injection
// ---------------------------------------------------------------------------
interface FleetVehicle {
  id:            string;
  lat:           number;
  lng:           number;
  evading?:      boolean;
  heading_deg?:  number;
  route_id?:     string;
  reroute_status?: string;
}

interface FleetJson {
  snapshot_at_seconds_into_trip: number;
  fleet:                         FleetVehicle[];
}

// Mutable per-vehicle state used by runFleetLoop.
interface VehicleState {
  id:             string;
  lat:            number;
  lng:            number;
  heading_deg:    number;
  status:         string;
  route_id?:      string;
  reroute_status?: string;
  speed_kph:      number;
}

// runFleetLoop replaces the one-shot injectFleet: it waits for the scenario's
// snapshot offset then continuously moves vehicles every TICK_MS real milliseconds
// until done.done is set to true (i.e. ping streaming has finished).
async function runFleetLoop(
  fleetJson:  FleetJson,
  speedMult:  number,
  baseMs:     number,
  done:       { done: boolean },
  tickMs:     number = 2_000,
): Promise<void> {
  const snapshotAt = fleetJson.snapshot_at_seconds_into_trip;
  const targetMs   = baseMs + Math.round(snapshotAt * 1000 / speedMult);
  const waitMs     = Math.max(0, targetMs - Date.now());
  if (waitMs > 1000) {
    log.info(`fleet loop starts at T+${snapshotAt}s — waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  // Seed mutable state from the snapshot.
  const state: VehicleState[] = fleetJson.fleet.map(v => ({
    id:             v.id,
    lat:            v.lat,
    lng:            v.lng,
    heading_deg:    v.heading_deg ?? Math.random() * 360,
    status:         v.evading ? 'evading' : 'active',
    route_id:       v.route_id,
    reroute_status: v.reroute_status,
    speed_kph:      v.evading ? 35 : 25,
  }));

  let ticks = 0;
  const evadingCount = state.filter(v => v.status === 'evading').length;

  while (!done.done) {
    // Each real-world tick corresponds to speedMult simulated seconds.
    const elapsedSimSec = (tickMs / 1_000) * speedMult;

    for (const v of state) {
      const distM      = (v.speed_kph * 1_000 / 3_600) * elapsedSimSec;
      const headingRad = (v.heading_deg * Math.PI) / 180;
      const latRad     = (v.lat * Math.PI) / 180;

      // Standard bearing decomposition: 0° = North, 90° = East.
      v.lat += (distM / 111_320) * Math.cos(headingRad);
      v.lng += (distM / (111_320 * Math.cos(latRad))) * Math.sin(headingRad);

      // ±3° drift per tick for organic feel.
      v.heading_deg = (v.heading_deg + (Math.random() - 0.5) * 6 + 360) % 360;
    }

    await post<{ ok: boolean }>('/api/v1/sim/fleet', state.map(v => ({
      id:             v.id,
      lat:            v.lat,
      lng:            v.lng,
      status:         v.status,
      heading_deg:    v.heading_deg,
      route_id:       v.route_id,
      reroute_status: v.reroute_status,
    }))).catch(err =>
      log.warn(`fleet tick ${ticks} failed: ${(err as Error).message.split('\n')[0]}`),
    );

    if (ticks === 0) {
      log.ok(`fleet loop running   ${state.length} vehicles  (${evadingCount} evading)`);
    }
    ticks++;
    await sleep(tickMs);
  }

  log.info(`fleet loop stopped after ${ticks} ticks`);
}

// ---------------------------------------------------------------------------
// Scenario runners
// ---------------------------------------------------------------------------

async function runSingle(dir: string, speedMult: number, noFleet: boolean): Promise<void> {
  const tripFile  = path.join(dir, 'trip.json');
  const pingsFile = path.join(dir, 'pings.ndjson');
  const fleetFile = path.join(dir, 'fleet.json');

  if (!fileExists(tripFile)) {
    log.fatal(`trip.json not found in ${dir}\n  This scenario has no trip — check its README.md`);
  }
  if (!fileExists(pingsFile)) {
    log.fatal(`pings.ndjson not found in ${dir}\n  This scenario has no ping stream — check its README.md`);
  }

  const tripJson  = readJson<TripJson>(tripFile);
  const pings     = readNdjson<PingRow>(pingsFile);

  const tripId = await createAndStartTrip(tripJson);
  const baseMs = Date.now();

  const done = { done: false };

  if (!noFleet && fileExists(fleetFile)) {
    const fleetJson = readJson<FleetJson>(fleetFile);
    void runFleetLoop(fleetJson, speedMult, baseMs, done).catch((err: Error) =>
      log.warn(`fleet loop error: ${err.message.split('\n')[0]}`),
    );
  } else if (!noFleet) {
    log.info('no fleet.json in this scenario — skipping fleet loop');
  }

  await streamPings(tripId, pings, baseMs, speedMult);
  done.done = true;
}

async function runGpsJitterStale(dir: string, speedMult: number): Promise<void> {
  const pingsFile = path.join(dir, 'pings.ndjson');
  const pings     = readNdjson<PingRow>(pingsFile);

  // Create a minimal trip for this GPS edge-case scenario
  const deadline = new Date(Date.now() + 120 * 60_000).toISOString();
  const body = {
    cargo_category:       'Vaccine',
    cargo_description:    'GPS jitter/stale edge-case replay — Manipal HAL → Sri Siddhartha',
    cargo_tolerance_celsius: 2.0,
    origin:               { lat: 12.9587, lng: 77.6442 },
    destination:          { lat: 13.3379, lng: 77.1031 },
    golden_hour_deadline: deadline,
    ambulance_id:         'AMB-JITTER-TEST',
    hospital_dispatch_id: 'Manipal-HAL-BLR',
  };

  const res = await post<CreateTripResp>('/api/v1/trips', body);
  log.ok(`trip created   id=${res.trip_id}  deadline=${deadline}`);
  await post(`/api/v1/trips/${res.trip_id}/start`, undefined);
  log.ok('trip started   status=InTransit');

  const baseMs = Date.now();
  await streamPings(res.trip_id, pings, baseMs, speedMult);

  log.info('expected hygiene output: 9 of 25 pings dropped/clamped');
  log.info('check pings.expected-after-hygiene.ndjson for the reference list');
}

async function runConflictingEtas(dir: string, speedMult: number): Promise<void> {
  interface MultiTrips { trips: Array<TripJson & { label?: string }> }
  const { trips } = readJson<MultiTrips>(path.join(dir, 'trips.json'));

  log.section(`creating ${trips.length} concurrent trips`);
  const ids: string[] = [];
  for (const t of trips) {
    const label = (t as { label?: string }).label ?? t.ambulance_id;
    log.info(`  → ${label}  (${t.cargo_category})`);
    const id = await createAndStartTrip(t);
    ids.push(id);
  }

  log.section('trips are now InTransit — risk monitor will poll each independently');
  log.info('watch the WS monitor for interleaved RISK_PREDICTION events per trip_id');
  log.info(`trip IDs: ${ids.join(' | ')}`);
  log.info('');
  log.info('Note: no pings.ndjson for conflicting-etas — the risk monitor will poll');
  log.info('the origin position (no movement). Predicted ETAs depend on AI brain.');
  log.info('Send custom pings with:');
  for (const id of ids) {
    log.info(`  curl -s -X POST ${BACKEND_HTTP}/api/v1/trips/${id}/pings -d '{"lat":12.96,"lng":77.64,"speed_kph":20}' -H "Content-Type: application/json"`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { scenario, speed, noFleet, noWs } = parseArgs();
  const dir = path.join(DATASET_ROOT, scenario);

  if (!fileExists(dir)) {
    log.fatal(`scenario "${scenario}" not found at ${dir}`);
  }

  console.log('┌──────────────────────────────────────────────────────────');
  console.log('│  Sipra Scenario Player');
  console.log(`│  scenario  = ${scenario}`);
  console.log(`│  speed     = ${speed}×`);
  console.log(`│  backend   = ${BACKEND_HTTP}`);
  console.log(`│  ws        = ${noWs ? '(disabled)' : BACKEND_WS}`);
  console.log('└──────────────────────────────────────────────────────────');

  // README hint
  const readmeFile = path.join(dir, 'README.md');
  if (fileExists(readmeFile)) {
    const readme = fs.readFileSync(readmeFile, 'utf8');
    const firstLine = readme.split('\n').find(l => l.startsWith('# '))?.slice(2);
    if (firstLine) log.info(`scenario: ${firstLine}`);
  }

  // Open WS monitor before sending any data so we don't miss early events
  let closeWs: (() => void) | null = null;
  if (!noWs) {
    closeWs = openWsMonitor();
    await sleep(600); // let WS handshake complete
  }

  try {
    switch (scenario) {
      case 'normal':
      case 'congestion-breach':
      case 'peak-hour-mg-road':
      case 'sudden-spike-mid-route':
        await runSingle(dir, speed, noFleet);
        break;

      case 'gps-jitter-stale':
        await runGpsJitterStale(dir, speed);
        break;

      case 'conflicting-etas':
        await runConflictingEtas(dir, speed);
        break;

      case 'no-agents-available':
        log.section('no-agents-available — reference scenario');
        log.info('This scenario has no pings to stream.');
        log.info(`Fleet snapshot (empty): ${path.join(dir, 'fleet-empty.json')}`);
        log.info(`To test drain: POST ${BACKEND_HTTP}/api/v1/chaos/drain-fleet`);
        log.info(`  body: ${fs.readFileSync(path.join(dir, 'chaos-event.json'), 'utf8').trim()}`);
        break;

      case 'drone-unavailable-fallback':
        log.section('drone-unavailable-fallback — reference scenario');
        log.info('This scenario documents the graceful-degradation code path.');
        log.info('To trigger it, run the congestion-breach scenario while the');
        log.info('drone-dispatch mock (port 4003) is stopped.');
        log.info(`  cd services/mocks/drone-dispatch && npm stop  (or just don't start it)`);
        log.info(`  npx tsx play-scenario.ts --scenario=congestion-breach --speed=5`);
        log.info('Expected: HANDOFF_INITIATED fires with drone_id="" and eta_seconds=0');
        break;

      default:
        log.fatal(
          `unknown scenario "${scenario}".\n` +
          `  valid: normal | congestion-breach | sudden-spike-mid-route |\n` +
          `         gps-jitter-stale | peak-hour-mg-road | conflicting-etas |\n` +
          `         no-agents-available | drone-unavailable-fallback`,
        );
    }
  } finally {
    // Keep WS open for 5s after pings end so we can receive final RISK_PREDICTION
    if (closeWs) {
      log.info('waiting 5s for final WS events…');
      await sleep(5000);
      closeWs();
    }
  }

  log.section('scenario complete');
  log.ok('open the Next.js dashboard at http://localhost:3000 to see the visual output');
}

main().catch(err => {
  console.error('\n  ✗', (err as Error).message);
  process.exit(1);
});

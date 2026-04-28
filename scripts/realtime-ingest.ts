/**
 * Sipra Realtime Ingest Runner
 *
 * 1. Reads datasets/realtime/trip.json and POSTs it to the Go server to create a trip.
 * 2. Optionally starts the trip (AUTO_START_TRIP=true by default).
 * 3. Streams each row from datasets/realtime/ambulance-pings.ndjson to
 *    POST /api/v1/trips/:id/pings at PING_INTERVAL_MS intervals.
 *
 * Environment variables:
 *   BACKEND_URL       — default: http://localhost:8080
 *   DATASET_DIR       — default: ../datasets/realtime
 *   TRIP_ID           — skip trip creation and use an existing trip ID
 *   AUTO_START_TRIP   — default: true
 *   PING_INTERVAL_MS  — default: 1000
 *   LOOP              — default: false  (replay pings indefinitely when true)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const BACKEND_URL      = process.env.BACKEND_URL      ?? 'http://localhost:8080';
const DATASET_DIR      = process.env.DATASET_DIR      ?? path.join(__dirname, '..', 'datasets', 'realtime');
const EXISTING_TRIP_ID = process.env.TRIP_ID          ?? '';
const AUTO_START       = (process.env.AUTO_START_TRIP ?? 'true') !== 'false';
const PING_INTERVAL_MS = Number(process.env.PING_INTERVAL_MS ?? 1000);
const LOOP             = process.env.LOOP === 'true';

const TRIP_FILE  = path.join(DATASET_DIR, 'trip.json');
const PINGS_FILE = path.join(DATASET_DIR, 'ambulance-pings.ndjson');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} → ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Read all non-empty lines from an NDJSON file. */
function readNdjsonLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

// ---------------------------------------------------------------------------
// Step 1 — Create (or reuse) trip
// ---------------------------------------------------------------------------
async function resolveTrip(): Promise<string> {
  if (EXISTING_TRIP_ID) {
    console.log(`♻️   Reusing existing trip: ${EXISTING_TRIP_ID}`);
    return EXISTING_TRIP_ID;
  }

  if (!fs.existsSync(TRIP_FILE)) {
    throw new Error(`trip.json not found at ${TRIP_FILE}`);
  }

  const raw = JSON.parse(fs.readFileSync(TRIP_FILE, 'utf8')) as Record<string, unknown>;

  // Replace the __DYNAMIC__ placeholder with a real deadline 1 hour from now
  if (raw['golden_hour_deadline'] === '__DYNAMIC__') {
    raw['golden_hour_deadline'] = new Date(Date.now() + 3_600_000).toISOString();
  }

  console.log('🚑  Creating trip…');
  const result = await post(`${BACKEND_URL}/api/v1/trips`, raw) as { trip_id: string };
  console.log(`✅  Trip created: ${result.trip_id}`);
  return result.trip_id;
}

// ---------------------------------------------------------------------------
// Step 2 — Start trip
// ---------------------------------------------------------------------------
async function startTrip(tripId: string): Promise<void> {
  console.log(`▶️   Starting trip ${tripId}…`);
  await post(`${BACKEND_URL}/api/v1/trips/${tripId}/start`, {});
  console.log('✅  Trip is InTransit');
}

// ---------------------------------------------------------------------------
// Step 3 — Stream pings
// ---------------------------------------------------------------------------
async function streamPings(tripId: string): Promise<void> {
  if (!fs.existsSync(PINGS_FILE)) {
    throw new Error(`ambulance-pings.ndjson not found at ${PINGS_FILE}`);
  }

  const lines = readNdjsonLines(PINGS_FILE);
  console.log(`📡  Streaming ${lines.length} pings → ${BACKEND_URL} (interval: ${PING_INTERVAL_MS}ms)`);
  if (LOOP) console.log('🔁  LOOP=true — will replay indefinitely (Ctrl+C to stop)');

  let iteration = 0;
  let running = true;

  process.on('SIGINT', () => {
    console.log('\n🛑  Ingest stopped');
    running = false;
    process.exit(0);
  });

  do {
    iteration++;
    if (LOOP && iteration > 1) {
      console.log(`\n🔁  Loop ${iteration} — replaying ${lines.length} pings…`);
    }

    for (let i = 0; i < lines.length && running; i++) {
      const ping = JSON.parse(lines[i]) as {
        lat: number;
        lng: number;
        speed_kph?: number;
        heading_deg?: number;
        accuracy_m?: number;
      };

      try {
        await post(`${BACKEND_URL}/api/v1/trips/${tripId}/pings`, ping);
        process.stdout.write(
          `\r  ping ${i + 1}/${lines.length}  [${ping.lat.toFixed(5)}, ${ping.lng.toFixed(5)}]   `,
        );
      } catch (err) {
        console.error(`\n⚠️   Ping ${i + 1} failed: ${(err as Error).message}`);
      }

      if (i < lines.length - 1) {
        await sleep(PING_INTERVAL_MS);
      }
    }

    if (running) {
      console.log('\n✅  All pings sent');
    }
  } while (LOOP && running);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log('=== Sipra Realtime Ingest ===');
  console.log(`Backend : ${BACKEND_URL}`);
  console.log(`Datasets: ${DATASET_DIR}`);
  console.log('');

  const tripId = await resolveTrip();

  if (AUTO_START) {
    await startTrip(tripId);
  } else {
    console.log('⏭️   AUTO_START_TRIP=false — skipping trip start');
  }

  await streamPings(tripId);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

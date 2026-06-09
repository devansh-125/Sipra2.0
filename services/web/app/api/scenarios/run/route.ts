import { NextRequest, NextResponse } from 'next/server';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_KEYS = new Set(['s1-normal', 's2-congestion', 's3-drone-handoff']);
const DATASET_ROOT =
  process.env.SCENARIO_DATASET_ROOT ??
  path.join(process.cwd(), '../../datasets/test-scenarios/realtime');
const BACKEND =
  process.env.BACKEND_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_BACKEND_HTTP_URL ??
  'http://localhost:8080';
const SCENARIO_SPEED = Math.max(0.1, Number(process.env.SCENARIO_SPEED ?? '1') || 1);

// Demo geometry constants — must match the backend / dashboard's
// EXCLUSION_RADIUS_M and the driver-side checkpoint logic.
const EXCLUSION_RADIUS_KM = 2.0;
const CHECKPOINT_OFFSET_M = 2_050; // 50 m past the red-zone edge
const CHECKPOINT_RADIUS_M = 50;

interface TripJson {
  cargo_category: string;
  cargo_description: string;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  golden_hour_minutes?: number;
  golden_hour_deadline?: string;
  ambulance_id: string;
  hospital_dispatch_id?: string;
  tolerance_celsius?: number;
}

interface PingRow {
  lat: number;
  lng: number;
  speed_kph?: number;
  heading_deg?: number;
  accuracy_m?: number;
  recorded_at?: string;
}

interface FleetVehicleSnapshot {
  id: string;
  lat: number;
  lng: number;
  speed_kph?: number;
  heading_deg?: number;
  evading?: boolean;
  route_id?: string;
  reroute_status?: string;
  // Optional staged-spawn time. Vehicles with this field omitted appear
  // immediately when the fleet loop starts; vehicles with a value are held
  // out of the swarm until the trip clock reaches it. Used by s2-congestion
  // to materialise evading vehicles at each congestion zone right when the
  // ambulance arrives, instead of seeding everything at the origin.
  spawn_at_seconds_into_trip?: number;
}

interface FleetJson {
  snapshot_at_seconds_into_trip: number;
  fleet: FleetVehicleSnapshot[];
}

async function readScenario(
  key: string,
): Promise<{ trip: TripJson; pings: PingRow[]; fleet: FleetJson | null }> {
  const dir = path.join(DATASET_ROOT, key);
  const tripRaw = await fs.readFile(path.join(dir, 'trip.json'), 'utf8');
  const pingsRaw = await fs.readFile(path.join(dir, 'pings.ndjson'), 'utf8');
  const trip = JSON.parse(tripRaw) as TripJson;
  const pings = pingsRaw
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .map(l => JSON.parse(l) as PingRow);

  let fleet: FleetJson | null = null;
  try {
    const fleetRaw = await fs.readFile(path.join(dir, 'fleet.json'), 'utf8');
    fleet = JSON.parse(fleetRaw) as FleetJson;
  } catch {
    // fleet.json is optional
  }

  return { trip, pings, fleet };
}

async function postJSON(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Timing helpers — parse __T+Ns__ offsets used by play-scenario.ts
// ---------------------------------------------------------------------------

function parseOffsetSeconds(recordedAt?: string): number | null {
  if (!recordedAt) return null;
  const match = recordedAt.match(/^__T\+(\d+)s__$/);
  return match ? Number(match[1]) : null;
}

function offsetToRFC3339(baseMs: number, offsetSeconds: number): string {
  return new Date(baseMs + offsetSeconds * 1000).toISOString();
}

function guessOffsetStepSeconds(pings: PingRow[]): number | null {
  const offsets = pings
    .map(p => parseOffsetSeconds(p.recorded_at))
    .filter((v): v is number => v !== null);
  if (offsets.length < 2) return null;
  return Math.max(1, offsets[1] - offsets[0]);
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const D2R = Math.PI / 180;

function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = (b.lat - a.lat) * D2R;
  const dLng = (b.lng - a.lng) * D2R;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * D2R) * Math.cos(b.lat * D2R) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearingDeg(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const dLng = (to.lng - from.lng) * D2R;
  const lat1 = from.lat * D2R;
  const lat2 = to.lat * D2R;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Project a point CHECKPOINT_OFFSET_M from `center` along the bearing to `outward`.
function projectCheckpoint(
  center: { lat: number; lng: number },
  outward: { lat: number; lng: number },
): { lat: number; lng: number } {
  const dLat = outward.lat - center.lat;
  const dLng = outward.lng - center.lng;
  const len = Math.sqrt(dLat * dLat + dLng * dLng) || 1e-12;
  const nLat = dLat / len;
  const nLng = dLng / len;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(center.lat * D2R);
  return {
    lat: center.lat + (nLat * CHECKPOINT_OFFSET_M) / mPerDegLat,
    lng: center.lng + (nLng * CHECKPOINT_OFFSET_M) / mPerDegLng,
  };
}

// ---------------------------------------------------------------------------
// HTTP entry
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  let body: { scenario?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const key = body.scenario ?? '';
  if (!ALLOWED_KEYS.has(key)) {
    return NextResponse.json(
      { error: `unknown scenario "${key}". Allowed: ${[...ALLOWED_KEYS].join(', ')}` },
      { status: 400 },
    );
  }

  let scenario: { trip: TripJson; pings: PingRow[]; fleet: FleetJson | null };
  try {
    scenario = await readScenario(key);
  } catch (err) {
    return NextResponse.json(
      { error: `dataset read failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  const { trip, pings, fleet } = scenario;
  const minutes = trip.golden_hour_minutes ?? 120;
  const deadline = new Date(Date.now() + minutes * 60_000).toISOString();

  const createBody = {
    cargo_category: trip.cargo_category,
    cargo_description: trip.cargo_description,
    cargo_tolerance_celsius: trip.tolerance_celsius ?? null,
    origin: { lat: trip.origin.lat, lng: trip.origin.lng },
    destination: { lat: trip.destination.lat, lng: trip.destination.lng },
    golden_hour_deadline: deadline,
    ambulance_id: trip.ambulance_id,
    hospital_dispatch_id: trip.hospital_dispatch_id,
  };

  const createRes = await postJSON(`${BACKEND}/api/v1/trips`, createBody);
  if (!createRes.ok) {
    const text = await createRes.text();
    return NextResponse.json(
      { error: `core-go create-trip ${createRes.status}: ${text}` },
      { status: 502 },
    );
  }
  const { trip_id } = (await createRes.json()) as { trip_id: string };

  const startRes = await postJSON(`${BACKEND}/api/v1/trips/${trip_id}/start`, undefined);
  if (!startRes.ok) {
    const text = await startRes.text();
    return NextResponse.json(
      { error: `core-go start-trip ${startRes.status}: ${text}` },
      { status: 502 },
    );
  }

  // Shared state between the two background loops.
  // ambulancePos is updated by replayPings every tick so replayFleet can
  // use it to size the red zone and progress bounties.
  const shared: SharedState = {
    done: false,
    ambulancePos: { lat: trip.origin.lat, lng: trip.origin.lng },
  };

  // S3 is the drone-handoff scenario by design — the ambulance is supposed to
  // stop at the lorry blockage and the drone takes over. Don't extend pings.
  const extendToDestination = key !== 's3-drone-handoff';

  const totalDistanceKm = haversineKm(trip.origin, trip.destination) * 1.4; // road approx
  const baseMs = Date.now();
  void replayPings(
    trip_id,
    pings,
    trip.destination,
    extendToDestination,
    shared,
    totalDistanceKm,
    baseMs,
    SCENARIO_SPEED,
  );
  if (fleet && fleet.fleet.length > 0) {
    void replayFleet(trip_id, fleet, shared, SCENARIO_SPEED);
  }

  return NextResponse.json({
    trip_id,
    scenario: key,
    total_pings: pings.length,
    fleet_size: fleet?.fleet.length ?? 0,
    extends_to_destination: extendToDestination,
    deadline,
  });
}

// ---------------------------------------------------------------------------
// Shared state across loops
// ---------------------------------------------------------------------------

interface SharedState {
  done: boolean;
  ambulancePos: { lat: number; lng: number };
}

// ---------------------------------------------------------------------------
// Ping replay: dataset rows honoring recorded_at offsets, then optional extension
// ---------------------------------------------------------------------------

async function replayPings(
  tripId: string,
  pings: PingRow[],
  destination: { lat: number; lng: number },
  extend: boolean,
  shared: SharedState,
  distanceKm: number,
  baseMs: number,
  speedMult: number,
): Promise<void> {
  try {
    const hasOffsets = pings.some(p => parseOffsetSeconds(p.recorded_at) !== null);
    const offsetStepSec = guessOffsetStepSeconds(pings) ?? 1;
    let prevOffsetMs = 0;
    let lastOffsetSec = 0;

    // Dataset rows (timed)
    for (let i = 0; i < pings.length; i++) {
      const offsetSec = parseOffsetSeconds(pings[i].recorded_at);
      let waitMs = 0;
      if (offsetSec !== null) {
        lastOffsetSec = offsetSec;
        const targetMs = Math.round((offsetSec * 1000) / speedMult);
        waitMs = Math.max(0, targetMs - prevOffsetMs);
        prevOffsetMs = targetMs;
      } else if (hasOffsets) {
        waitMs = Math.round(1000 / speedMult);
        prevOffsetMs += waitMs;
        lastOffsetSec = Math.round(prevOffsetMs / 1000);
      } else if (i > 0) {
        waitMs = Math.round(1000 / speedMult);
      }
      if (waitMs > 0) await sleep(waitMs);
      const p = pings[i];
      shared.ambulancePos = { lat: p.lat, lng: p.lng };
      await sendPing(tripId, p, baseMs);
    }

    if (extend && haversineKm(shared.ambulancePos, destination) >= 0.1) {
      // Walk the great-circle from the last dataset ping toward destination
      // at the dataset's last speed (or 70 kph default).
      const last = pings[pings.length - 1];
      const speedKph = last.speed_kph ?? 70;
      const tickSec = offsetStepSec;
      const tickMs = Math.max(200, Math.round((tickSec * 1000) / speedMult));
      const stepM = (speedKph * 1_000) / 3_600 * tickSec;

      // Cap at 2 hours of synthetic travel. The real terminator is the
      // haversine < 100 m check inside the loop; this is just a safety net.
      const remainingKm = haversineKm(shared.ambulancePos, destination);
      const MAX_EXTEND_TICKS = Math.max(3_600, Math.ceil((remainingKm * 1_000) / stepM) + 120);

      for (let tick = 0; tick < MAX_EXTEND_TICKS; tick++) {
        const distKm = haversineKm(shared.ambulancePos, destination);
        if (distKm < 0.1) break; // arrived (within 100 m)
        await sleep(tickMs);

        // Bearing from current to destination, in radians.
        const brg = bearingDeg(shared.ambulancePos, destination);
        const brgRad = brg * D2R;
        const latRad = shared.ambulancePos.lat * D2R;
        const dLat = (stepM / 111_320) * Math.cos(brgRad);
        const dLng = (stepM / (111_320 * Math.cos(latRad))) * Math.sin(brgRad);

        shared.ambulancePos = {
          lat: shared.ambulancePos.lat + dLat,
          lng: shared.ambulancePos.lng + dLng,
        };

        lastOffsetSec += tickSec;
        await sendPing(tripId, {
          lat: shared.ambulancePos.lat,
          lng: shared.ambulancePos.lng,
          speed_kph: speedKph,
          heading_deg: brg,
          accuracy_m: 8,
          recorded_at: hasOffsets ? `__T+${lastOffsetSec}s__` : undefined,
        }, baseMs);
      }
    }
  } finally {
    shared.done = true;
    // Give the Go backend 2 s to flush the last ping before marking complete.
    await sleep(2_000);
    try {
      await postJSON(`${BACKEND}/api/v1/trips/${tripId}/complete`, { distance_km: distanceKm });
    } catch (err) {
      console.error('[scenario-run] complete trip failed:', err);
    }
  }
}

async function sendPing(tripId: string, p: PingRow, baseMs: number): Promise<void> {
  const body: Record<string, unknown> = { lat: p.lat, lng: p.lng };
  if (p.speed_kph !== undefined) body.speed_kph = p.speed_kph;
  if (p.heading_deg !== undefined) body.heading_deg = p.heading_deg;
  if (p.accuracy_m !== undefined) body.accuracy_m = p.accuracy_m;
  const offsetSec = parseOffsetSeconds(p.recorded_at);
  if (offsetSec !== null) {
    body.recorded_at = offsetToRFC3339(baseMs, offsetSec);
  } else if (p.recorded_at) {
    body.recorded_at = p.recorded_at;
  }
  try {
    await postJSON(`${BACKEND}/api/v1/trips/${tripId}/pings`, body);
  } catch (err) {
    console.error('[scenario-run] ping failed:', err);
  }
}

// ---------------------------------------------------------------------------
// Fleet replay + bounty progression
//
// Each evading vehicle:
//   1. Heading is overridden to point AWAY from the ambulance (radial outward),
//      guaranteeing it will exit the red zone within ~60 s.
//   2. When still inside red zone and no bounty exists yet → CREATE bounty.
//   3. When dead-reckoning takes it OUTSIDE the red zone → CLAIM bounty.
//   4. When it reaches its checkpoint (within 50 m) → VERIFY bounty.
//
// Non-evading vehicles just drift along their natural heading for visual
// flavour and never have bounties created.
// ---------------------------------------------------------------------------

interface VehicleState {
  id: string;
  lat: number;
  lng: number;
  heading_deg: number;
  speed_kph: number;
  status: string;
  route_id?: string;
  reroute_status?: string;
  evading: boolean;
  bountyId: string | null;
  bountyStage: 'none' | 'offered' | 'claimed' | 'verified';
  checkpoint: { lat: number; lng: number } | null;
  offerCenter: { lat: number; lng: number } | null;
  spawnAtMs: number;          // wall-clock ms when this vehicle joins the swarm
  spawned: boolean;
}

async function replayFleet(
  tripId: string,
  fleetData: FleetJson,
  shared: SharedState,
  speedMult: number,
): Promise<void> {
  // Brief warm-up so the ambulance has moved a couple of pings before partner
  // vehicles populate the corridor view.
  await sleep(Math.round(5_000 / speedMult));
  if (shared.done) return;

  // Trip clock anchor: vehicles with `spawn_at_seconds_into_trip` join the
  // swarm once `Date.now() - tripStartMs >= spawn_at * 1000 / speedMult`.
  // Honoured per vehicle so multi-zone scenarios (s2-congestion) can stage
  // evading vehicles at each congestion choke point.
  const tripStartMs = Date.now() - 5_000;

  const state: VehicleState[] = fleetData.fleet.map(v => {
    const spawnSec  = v.spawn_at_seconds_into_trip ?? 0;
    const spawnAtMs = tripStartMs + Math.round((spawnSec * 1_000) / speedMult);
    return {
      id: v.id,
      lat: v.lat,
      lng: v.lng,
      heading_deg: v.heading_deg ?? Math.random() * 360,
      speed_kph: v.speed_kph ?? (v.evading ? 35 : 25),
      status: v.evading ? 'evading' : 'active',
      route_id: v.route_id,
      reroute_status: v.reroute_status,
      evading: !!v.evading,
      bountyId: null,
      bountyStage: 'none',
      checkpoint: null,
      offerCenter: null,
      spawnAtMs,
      spawned: spawnAtMs <= Date.now(),
    };
  });

  const tickMs = Math.max(250, Math.round(2_000 / speedMult));
  const tickSec = tickMs / 1_000;

  while (!shared.done) {
    const amb = shared.ambulancePos;
    const now = Date.now();

    for (const v of state) {
      if (!v.spawned) {
        if (now < v.spawnAtMs) continue;
        v.spawned = true;
      }

      // Evading vehicles: once a bounty has been offered, head radially
      // outward from the offer centre and accelerate to clear the corridor.
      // Real drivers don't crawl out of a 2 km exclusion zone — they reroute
      // and floor it. The pre-offer crawl speed is whatever the seed says.
      if (v.evading) {
        if (v.offerCenter) {
          v.heading_deg = bearingDeg(v.offerCenter, { lat: v.lat, lng: v.lng });
          if (v.speed_kph < 35) v.speed_kph = 35;
        }
      }

      // Standard dead-reckoning step (matches scripts/play-scenario.ts).
      const distM = ((v.speed_kph * 1_000) / 3_600) * tickSec;
      const headingRad = v.heading_deg * D2R;
      const latRad = v.lat * D2R;
      v.lat += (distM / 111_320) * Math.cos(headingRad);
      v.lng += (distM / (111_320 * Math.cos(latRad))) * Math.sin(headingRad);

      // Non-evading vehicles still get organic drift.
      if (!v.evading) {
        v.heading_deg = (v.heading_deg + (Math.random() - 0.5) * 6 + 360) % 360;
      }

      // Bounty progression for evading vehicles only.
      if (v.evading) {
        await progressBounty(tripId, v, amb);
      }
    }

    try {
      await postJSON(
        `${BACKEND}/api/v1/sim/fleet`,
        state.filter(v => v.spawned).map(v => ({
          id: v.id,
          lat: v.lat,
          lng: v.lng,
          status: v.status,
          heading_deg: v.heading_deg,
          route_id: v.route_id,
          reroute_status: v.reroute_status,
        })),
      );
    } catch (err) {
      console.error('[scenario-run] fleet tick failed:', err);
    }

    await sleep(tickMs);
  }
}

async function progressBounty(
  tripId: string,
  v: VehicleState,
  amb: { lat: number; lng: number },
): Promise<void> {
  const distKm = haversineKm(amb, { lat: v.lat, lng: v.lng });
  const offerCenter = v.offerCenter ?? amb;
  const offerDistKm = haversineKm(offerCenter, { lat: v.lat, lng: v.lng });

  // Stage: none → offered
  if (v.bountyStage === 'none' && distKm <= EXCLUSION_RADIUS_KM) {
    v.offerCenter = { lat: amb.lat, lng: amb.lng };
    const cp = projectCheckpoint(v.offerCenter, { lat: v.lat, lng: v.lng });
    v.checkpoint = cp;
    const expiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
    try {
      const res = await postJSON(`${BACKEND}/api/v1/trips/${tripId}/bounties`, {
        driver_ref: v.id,
        base_amount_points: 150,
        corridor_length_m: 4_000,
        deviation_m: 100,
        checkpoint_lat: cp.lat,
        checkpoint_lng: cp.lng,
        checkpoint_radius_m: CHECKPOINT_RADIUS_M,
        expires_at: expiresAt,
      });
      if (res.ok) {
        const b = (await res.json()) as { id: string };
        v.bountyId = b.id;
        v.bountyStage = 'offered';
        v.reroute_status = 'rerouting';
      }
    } catch (err) {
      console.error(`[scenario-run] create bounty for ${v.id} failed:`, err);
    }
    return;
  }

  // Stage: offered → claimed (vehicle has exited the red zone)
  if (v.bountyStage === 'offered' && v.bountyId && offerDistKm > EXCLUSION_RADIUS_KM) {
    try {
      const res = await postJSON(`${BACKEND}/api/v1/bounties/${v.bountyId}/claim`, undefined);
      if (res.ok) {
        v.bountyStage = 'claimed';
      }
    } catch (err) {
      console.error(`[scenario-run] claim bounty ${v.bountyId} failed:`, err);
    }
    return;
  }

  // Stage: claimed → verified (vehicle reached checkpoint)
  if (v.bountyStage === 'claimed' && v.bountyId && v.checkpoint) {
    const cpDistM = haversineKm({ lat: v.lat, lng: v.lng }, v.checkpoint) * 1_000;
    if (cpDistM <= CHECKPOINT_RADIUS_M) {
      try {
        const res = await postJSON(
          `${BACKEND}/api/v1/bounties/${v.bountyId}/verify`,
          { ping_lat: v.lat, ping_lng: v.lng },
        );
        if (res.ok) {
          v.bountyStage = 'verified';
          v.reroute_status = 'completed';
        }
      } catch (err) {
        console.error(`[scenario-run] verify bounty ${v.bountyId} failed:`, err);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

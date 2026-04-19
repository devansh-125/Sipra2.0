/**
 * Sipra "God Mode" Simulator
 *
 * 1. Creates a demo trip on the Go backend.
 * 2. Drives a simulated ambulance along a hardcoded Bangalore route, posting a
 *    GPS ping every second to POST /api/v1/trips/:id/pings.
 * 3. Spawns 50 fake partner-fleet vehicles scattered around the route.
 * 4. Subscribes to ws://localhost:8080/ws/dashboard; on each CORRIDOR_UPDATE
 *    it checks which fleet vehicles are inside the GeoJSON polygon and steers
 *    them perpendicularly away from the ambulance heading — visually simulating
 *    drivers obeying the B2B webhook exclusion notice.
 * 5. Serves live fleet positions over a WebSocket on port 4001 so the Next.js
 *    dashboard can render the FleetSwarm layer without a backend change.
 */

import WebSocket, { WebSocketServer } from 'ws';
import type { Polygon, MultiPolygon } from 'geojson';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BACKEND_HTTP = process.env.BACKEND_URL ?? 'http://localhost:8080';
const BACKEND_WS   = process.env.BACKEND_WS   ?? 'ws://localhost:8080/ws/dashboard';
const FLEET_PORT   = Number(process.env.FLEET_PORT ?? 4001);
const PING_INTERVAL_MS = 1_000;
const FLEET_SIZE       = 50;
// How far an evading car moves perpendicular each tick (~8 m in Bangalore lat).
const EVASION_STEP_DEG = 0.00008;

// ---------------------------------------------------------------------------
// Ambulance route — interpolated waypoints through Indiranagar → Koramangala.
// The simulator cycles through these continuously so the demo never ends.
// ---------------------------------------------------------------------------
const ROUTE: [number, number][] = [
  [12.9783, 77.6408],
  [12.9765, 77.6385],
  [12.9748, 77.6362],
  [12.9731, 77.6339],
  [12.9714, 77.6316],
  [12.9697, 77.6293],
  [12.9680, 77.6270],
  [12.9663, 77.6247],
  [12.9646, 77.6224],
  [12.9629, 77.6201],
];
const SUBSTEPS = 10; // linear interpolation steps between each waypoint pair

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface FleetVehicle {
  id: string;
  lat: number;
  lng: number;
  evading: boolean;
}

type CorridorGeometry = Polygon | MultiPolygon;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/**
 * Classic ray-casting point-in-polygon for a single ring.
 * Ring coordinates are GeoJSON [lng, lat] pairs.
 */
function raycast(lngLat: [number, number], ring: [number, number][]): boolean {
  const [px, py] = lngLat;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function pointInCorridor(lat: number, lng: number, geom: CorridorGeometry): boolean {
  // GeoJSON exterior rings; inner rings (holes) are ignored for this demo.
  const rings: [number, number][][] =
    geom.type === 'Polygon'
      ? [geom.coordinates[0] as [number, number][]]
      : geom.coordinates.map(p => p[0] as [number, number][]);

  return rings.some(ring => raycast([lng, lat], ring));
}

/** Returns a unit vector or [0, 1] if the input is zero-length. */
function normalize(dx: number, dy: number): [number, number] {
  const len = Math.sqrt(dx * dx + dy * dy);
  return len > 1e-10 ? [dx / len, dy / len] : [0, 1];
}

// ---------------------------------------------------------------------------
// Fleet initialisation
// ---------------------------------------------------------------------------
function spawnFleet(centerLat: number, centerLng: number): FleetVehicle[] {
  return Array.from({ length: FLEET_SIZE }, (_, i) => ({
    id: `fleet-${i}`,
    // Scatter randomly within ~3 km of the route start.
    lat: centerLat + (Math.random() - 0.5) * 0.055,
    lng: centerLng + (Math.random() - 0.5) * 0.055,
    evading: false,
  }));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {

  // 1. Create a trip on the backend.
  console.log('🚑  Creating demo trip…');
  const tripRes = await fetch(`${BACKEND_HTTP}/api/v1/trips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cargo_category: 'organ',
      cargo_description: 'Hackathon Demo — Kidney',
      origin:      { lat: ROUTE[0][0], lng: ROUTE[0][1] },
      destination: { lat: ROUTE[ROUTE.length - 1][0], lng: ROUTE[ROUTE.length - 1][1] },
      golden_hour_deadline: new Date(Date.now() + 3_600_000).toISOString(),
      ambulance_id: 'AMB-DEMO-01',
    }),
  });
  if (!tripRes.ok) {
    throw new Error(`Trip creation failed: ${tripRes.status} ${await tripRes.text()}`);
  }
  const { trip_id: tripId } = await tripRes.json() as { trip_id: string };
  console.log(`✅  Trip ID: ${tripId}`);

  // 2. Start the fleet WebSocket server (consumed by the Next.js dashboard).
  const wss = new WebSocketServer({ port: FLEET_PORT });
  console.log(`🌐  Fleet WS server listening on ws://localhost:${FLEET_PORT}`);

  function broadcastFleet(vehicles: FleetVehicle[]): void {
    const msg = JSON.stringify(vehicles);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    }
  }

  // 3. Initialise fleet around route start.
  const fleet = spawnFleet(ROUTE[0][0], ROUTE[0][1]);

  // 4. Subscribe to the Go backend for corridor updates.
  let corridorGeom: CorridorGeometry | null = null;

  const backendWs = new WebSocket(BACKEND_WS);
  backendWs.on('open', () => console.log('📡  Connected to backend WS'));
  backendWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: string;
        payload: { version: number; polygon_geojson: CorridorGeometry };
      };
      if (msg.type === 'CORRIDOR_UPDATE') {
        corridorGeom = msg.payload.polygon_geojson;
        console.log(`🗺   Corridor v${msg.payload.version} — checking ${FLEET_SIZE} vehicles…`);
      }
    } catch { /* malformed frame */ }
  });
  backendWs.on('error', (err) => console.error('Backend WS error:', (err as Error).message));
  backendWs.on('close', () => console.warn('⚠️  Backend WS closed; corridor updates paused'));

  // 5. Ambulance drive loop.
  let waypointIdx = 0;
  let subStep = 0;
  let ambulanceLat = ROUTE[0][0];
  let ambulanceLng = ROUTE[0][1];

  const interval = setInterval(async () => {
    const fromWp = ROUTE[waypointIdx % ROUTE.length];
    const toWp   = ROUTE[(waypointIdx + 1) % ROUTE.length];
    const t      = subStep / SUBSTEPS;

    // Linearly interpolate position between the two waypoints.
    ambulanceLat = fromWp[0] + (toWp[0] - fromWp[0]) * t;
    ambulanceLng = fromWp[1] + (toWp[1] - fromWp[1]) * t;

    subStep++;
    if (subStep >= SUBSTEPS) {
      subStep = 0;
      waypointIdx = (waypointIdx + 1) % (ROUTE.length - 1);
    }

    // Post GPS ping to the backend (fire-and-forget; errors are logged only).
    fetch(`${BACKEND_HTTP}/api/v1/trips/${tripId}/pings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: ambulanceLat, lng: ambulanceLng }),
    }).catch((err: unknown) => console.error('Ping POST failed:', (err as Error).message));

    // Heading unit vector for perpendicular evasion calculation.
    const rawDx = toWp[0] - fromWp[0];
    const rawDy = toWp[1] - fromWp[1];
    const [hdx, hdy] = normalize(rawDx, rawDy);

    // For each fleet vehicle, determine if it is inside the active corridor.
    // If so, steer it perpendicularly away from the ambulance's path.
    for (const car of fleet) {
      if (corridorGeom && pointInCorridor(car.lat, car.lng, corridorGeom)) {
        car.evading = true;

        // Vector from ambulance to car.
        const toCarLat = car.lat - ambulanceLat;
        const toCarLng = car.lng - ambulanceLng;

        // Determine which perpendicular side the car is already on and push
        // it further in that direction (avoids cars crossing the route).
        // Left perpendicular: (-hdy, hdx); right: (hdy, -hdx).
        const leftDot = toCarLat * (-hdy) + toCarLng * hdx;
        const [evadeLat, evadeLng] = leftDot >= 0
          ? normalize(-hdy, hdx)
          : normalize(hdy, -hdx);

        car.lat += evadeLat * EVASION_STEP_DEG;
        car.lng += evadeLng * EVASION_STEP_DEG;
      } else {
        car.evading = false;
      }
    }

    broadcastFleet(fleet);

    const evading = fleet.filter(v => v.evading).length;
    if (evading > 0) {
      process.stdout.write(`\r🚑  [${ambulanceLat.toFixed(5)}, ${ambulanceLng.toFixed(5)}]  🚗  evading: ${evading}/${FLEET_SIZE}   `);
    }
  }, PING_INTERVAL_MS);

  // Graceful shutdown.
  process.on('SIGINT', () => {
    console.log('\n🛑  Simulator stopped');
    clearInterval(interval);
    backendWs.close();
    wss.close();
    process.exit(0);
  });

  console.log('▶️   Simulation running — press Ctrl+C to stop');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

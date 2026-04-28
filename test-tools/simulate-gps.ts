/**
 * Sipra "God Mode" Simulator — Road-Aligned Fleet Edition
 *
 * 1. Creates a demo trip on the Go backend.
 * 2. Drives the ambulance along a real road route fetched from Google Maps
 *    Directions API (same query Google Maps uses when you type origin → destination).
 * 3. Spawns 20 fleet vehicles distributed across 5 real Bangalore roads.
 *    Each vehicle crawls along its assigned road at ~30 kph with a correct heading.
 * 4. When the ambulance corridor intersects a vehicle's road, the vehicle is
 *    rerouted to a predefined alternate road (no off-road perpendicular drift).
 * 5. Serves live fleet state over WebSocket on port 4001 (consumed by Next.js).
 */

import WebSocket from 'ws';
import type { Polygon, MultiPolygon } from 'geojson';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BACKEND_HTTP = process.env.BACKEND_URL ?? 'http://localhost:8080';
const BACKEND_WS   = process.env.BACKEND_WS   ?? 'ws://localhost:8080/ws/dashboard';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';
const FLEET_PORT   = Number(process.env.FLEET_PORT ?? 4001);
const PING_INTERVAL_MS = 1_000;
const FLEET_SIZE       = 20;

// Speed constants
const VEHICLE_KPH      = 30;                  // fleet vehicle speed
const AMBULANCE_KPH    = 45;                  // ambulance speed
const M_PER_DEG_LAT    = 111_320;

// ---------------------------------------------------------------------------
// Hospital coordinates — Victoria Hospital → Manipal Hospital HAL
// (These are the same coords you'd type into Google Maps)
// ---------------------------------------------------------------------------
const HOSPITAL_ORIGIN = { lat: 12.9656, lng: 77.5713 };
const HOSPITAL_DEST   = { lat: 12.9587, lng: 77.6442 };

// ---------------------------------------------------------------------------
// Polyline decoder (Google's encoded polyline algorithm, precision 1e-5)
// ---------------------------------------------------------------------------
function decodePolyline(encoded: string): { lat: number; lng: number }[] {
  const result: { lat: number; lng: number }[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, val = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; val |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (val & 1) ? ~(val >> 1) : (val >> 1);
    shift = 0; val = 0;
    do { b = encoded.charCodeAt(index++) - 63; val |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (val & 1) ? ~(val >> 1) : (val >> 1);
    result.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
function bearingDeg(
  aLat: number, aLng: number,
  bLat: number, bLng: number,
): number {
  const dLng = (bLng - aLng) * (Math.PI / 180);
  const lat1  = aLat * (Math.PI / 180);
  const lat2  = bLat * (Math.PI / 180);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) -
            Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Segment length in metres (flat-earth approximation, fine at city scale). */
function segmentM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const mLng = M_PER_DEG_LAT * Math.cos((aLat * Math.PI) / 180);
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  const dx = (bLng - aLng) * mLng;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Total polyline length in metres. */
function polylineM(pts: { lat: number; lng: number }[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += segmentM(pts[i - 1].lat, pts[i - 1].lng, pts[i].lat, pts[i].lng);
  }
  return total;
}

type GeoCoord = { lat: number; lng: number };

/** Advance position along a polyline by `distM` metres.
 *  Returns new position, segment index, and fractional offset within segment. */
function advanceAlongPolyline(
  pts: GeoCoord[],
  segIdx: number,
  segFrac: number,
  distM: number,
  direction: 1 | -1,
): { lat: number; lng: number; segIdx: number; segFrac: number; looped: boolean } {
  let remaining = distM;
  let si = segIdx;
  let sf = segFrac;

  while (remaining > 0) {
    const nextSi = si + direction;
    if (nextSi < 0 || nextSi >= pts.length) {
      // Reached an end — loop back
      si   = direction === 1 ? 0 : pts.length - 1;
      sf   = 0;
      return advanceAlongPolyline(pts, si, sf, remaining, direction);
    }
    const a = pts[si];
    const b = pts[nextSi];
    const segLen = segmentM(a.lat, a.lng, b.lat, b.lng);
    const traversed = segLen * (1 - sf);

    if (remaining <= traversed) {
      sf += (remaining / segLen) * Math.sign(direction); // handles direction
      // clamp
      const newSf = sf < 0 ? 0 : sf > 1 ? 1 : sf;
      const pos = {
        lat: a.lat + (b.lat - a.lat) * newSf,
        lng: a.lng + (b.lng - a.lng) * newSf,
        segIdx: si,
        segFrac: newSf,
        looped: false,
      };
      return pos;
    }

    remaining -= traversed;
    si = nextSi;
    sf = direction === 1 ? 0 : 1;
  }

  const a = pts[si];
  return { lat: a.lat, lng: a.lng, segIdx: si, segFrac: sf, looped: false };
}

// ---------------------------------------------------------------------------
// Ray-casting point-in-polygon
// ---------------------------------------------------------------------------
type CorridorGeometry = Polygon | MultiPolygon;

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
  const rings: [number, number][][] =
    geom.type === 'Polygon'
      ? [geom.coordinates[0] as [number, number][]]
      : geom.coordinates.map(p => p[0] as [number, number][]);
  return rings.some(ring => raycast([lng, lat], ring));
}

/** Check if any segment of a polyline passes through the corridor. */
function polylineIntersectsCorridor(
  pts: GeoCoord[],
  geom: CorridorGeometry,
): boolean {
  return pts.some(p => pointInCorridor(p.lat, p.lng, geom));
}

// ---------------------------------------------------------------------------
// Route fetching — Google Maps Directions API (same as typing in Google Maps)
// ---------------------------------------------------------------------------
async function fetchRoadRoute(
  origin: GeoCoord,
  destination: GeoCoord,
  label: string,
): Promise<GeoCoord[]> {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  if (apiKey) {
    try {
      const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
      url.searchParams.set('origin', `${origin.lat},${origin.lng}`);
      url.searchParams.set('destination', `${destination.lat},${destination.lng}`);
      url.searchParams.set('mode', 'driving');
      url.searchParams.set('departure_time', 'now');
      url.searchParams.set('traffic_model', 'best_guess');
      url.searchParams.set('key', apiKey);

      const res = await fetch(url.toString(), { signal: AbortSignal.timeout(8_000) });
      if (res.ok) {
        const data = await res.json() as {
          status: string;
          routes?: Array<{ overview_polyline: { points: string } }>;
        };
        if (data.status === 'OK' && data.routes?.length) {
          const pts = decodePolyline(data.routes[0].overview_polyline.points);
          if (pts.length >= 2) {
            console.log(`✅  [${label}] Google Maps route — ${pts.length} waypoints`);
            return pts;
          }
        } else {
          console.warn(`⚠️  [${label}] Directions API: ${data.status}`);
        }
      }
    } catch (err) {
      console.warn(`⚠️  [${label}] API unavailable: ${(err as Error).message}`);
    }
  }

  // Also try via Next.js proxy (server key without browser restrictions)
  try {
    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
    });
    const res = await fetch(`${FRONTEND_URL}/api/route/directions?${params}`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (res.ok) {
      const json = await res.json() as { polylineEncoded?: string };
      if (json.polylineEncoded) {
        const pts = decodePolyline(json.polylineEncoded);
        if (pts.length >= 2) {
          console.log(`✅  [${label}] proxy route — ${pts.length} waypoints`);
          return pts;
        }
      }
    }
  } catch { /* proxy unavailable */ }

  return []; // empty → caller uses fallback
}

// ---------------------------------------------------------------------------
// Predefined road polylines (hand-traced Bangalore roads)
// These are the fallback when Directions API is unavailable.
// All coordinates lie on actual road centre-lines.
// ---------------------------------------------------------------------------

/** Ambulance main route: Victoria Hospital → Manipal HAL */
const FALLBACK_AMBULANCE_ROUTE: GeoCoord[] = [
  { lat: 12.9656, lng: 77.5713 }, // Victoria Hospital
  { lat: 12.9661, lng: 77.5740 },
  { lat: 12.9668, lng: 77.5773 }, // KR Circle
  { lat: 12.9680, lng: 77.5810 }, // Kasturba Rd
  { lat: 12.9697, lng: 77.5850 }, // Raj Bhavan Rd junction
  { lat: 12.9712, lng: 77.5893 }, // MG Road start
  { lat: 12.9718, lng: 77.5930 }, // MG Road / Brigade Rd
  { lat: 12.9722, lng: 77.5965 }, // MG Road / Lavelle Rd
  { lat: 12.9726, lng: 77.5998 }, // MG Road / Richmond Rd
  { lat: 12.9735, lng: 77.6035 }, // MG Road / Ulsoor Lake
  { lat: 12.9745, lng: 77.6075 }, // Trinity junction
  { lat: 12.9757, lng: 77.6112 }, // Halasuru
  { lat: 12.9763, lng: 77.6145 }, // CMH Road start
  { lat: 12.9770, lng: 77.6180 }, // CMH Road
  { lat: 12.9775, lng: 77.6218 }, // Indiranagar 1st Stage
  { lat: 12.9778, lng: 77.6255 }, // Indiranagar 100ft Road
  { lat: 12.9774, lng: 77.6292 }, // Indiranagar 2nd Stage
  { lat: 12.9768, lng: 77.6330 }, // Domlur flyover approach
  { lat: 12.9760, lng: 77.6368 }, // Old Airport Rd junction
  { lat: 12.9750, lng: 77.6400 }, // Old Airport Road
  { lat: 12.9740, lng: 77.6428 }, // HAL Old Airport Rd
  { lat: 12.9620, lng: 77.6440 }, // Jeevanbhima Nagar
  { lat: 12.9600, lng: 77.6443 }, // Manipal approach
  { lat: 12.9587, lng: 77.6442 }, // Manipal Hospital HAL (destination)
];

/** Route 0 — Indiranagar 100ft Road (north–south main artery near ambulance) */
const ROAD_100FT: GeoCoord[] = [
  { lat: 12.9826, lng: 77.6388 }, // 100ft Road north end
  { lat: 12.9814, lng: 77.6390 },
  { lat: 12.9800, lng: 77.6392 },
  { lat: 12.9783, lng: 77.6390 }, // Central Indiranagar
  { lat: 12.9775, lng: 77.6385 },
  { lat: 12.9762, lng: 77.6376 },
  { lat: 12.9748, lng: 77.6368 },
  { lat: 12.9735, lng: 77.6360 }, // Domlur junction
  { lat: 12.9720, lng: 77.6352 },
];

/** Route 1 — CMH Road / Indiranagar 12th Main */
const ROAD_CMH: GeoCoord[] = [
  { lat: 12.9817, lng: 77.6230 }, // CMH Road north
  { lat: 12.9808, lng: 77.6228 },
  { lat: 12.9793, lng: 77.6222 },
  { lat: 12.9778, lng: 77.6218 }, // Indiranagar 1st Stage junction
  { lat: 12.9763, lng: 77.6210 },
  { lat: 12.9750, lng: 77.6201 },
  { lat: 12.9737, lng: 77.6190 },
  { lat: 12.9720, lng: 77.6180 }, // Ulsoor vicinity
];

/** Route 2 — Old Airport Road (parallel to ambulance going east) */
const ROAD_OLD_AIRPORT: GeoCoord[] = [
  { lat: 12.9690, lng: 77.6300 }, // Old Airport Rd west
  { lat: 12.9700, lng: 77.6325 },
  { lat: 12.9712, lng: 77.6350 },
  { lat: 12.9725, lng: 77.6380 },
  { lat: 12.9738, lng: 77.6410 },
  { lat: 12.9748, lng: 77.6435 },
  { lat: 12.9755, lng: 77.6458 }, // HAL
  { lat: 12.9760, lng: 77.6475 },
  { lat: 12.9762, lng: 77.6490 }, // Old Airport Rd east
];

/** Route 3 — Ulsoor Road → Halasuru (connects MG Road to CMH Road area) */
const ROAD_ULSOOR: GeoCoord[] = [
  { lat: 12.9757, lng: 77.6070 }, // MG Road / Ulsoor junction
  { lat: 12.9762, lng: 77.6090 },
  { lat: 12.9768, lng: 77.6112 }, // Halasuru temple junction
  { lat: 12.9775, lng: 77.6130 },
  { lat: 12.9780, lng: 77.6150 },
  { lat: 12.9786, lng: 77.6168 },
  { lat: 12.9792, lng: 77.6188 }, // joins CMH Road area
];

/** Route 4 — Domlur–Koramangala connector (south of ambulance route) */
const ROAD_DOMLUR: GeoCoord[] = [
  { lat: 12.9640, lng: 77.6310 }, // Koramangala / ST Bed area
  { lat: 12.9648, lng: 77.6330 },
  { lat: 12.9658, lng: 77.6352 },
  { lat: 12.9668, lng: 77.6375 },
  { lat: 12.9680, lng: 77.6398 },
  { lat: 12.9690, lng: 77.6418 }, // Domlur
  { lat: 12.9700, lng: 77.6438 },
  { lat: 12.9710, lng: 77.6455 }, // near Manipal HAL
];

// ---------------------------------------------------------------------------
// Named fleet routes (id, fallback polyline, alternate route id when evading)
// ---------------------------------------------------------------------------
interface FleetRoute {
  id: string;
  label: string;
  origin: GeoCoord;
  destination: GeoCoord;
  fallback: GeoCoord[];
  altRouteId: string; // which route to switch to when evading
}

const FLEET_ROUTES: FleetRoute[] = [
  {
    id: 'route-100ft',
    label: '100ft Road',
    origin:      { lat: 12.9826, lng: 77.6388 },
    destination: { lat: 12.9720, lng: 77.6352 },
    fallback:    ROAD_100FT,
    altRouteId:  'route-cmh',
  },
  {
    id: 'route-cmh',
    label: 'CMH Road',
    origin:      { lat: 12.9817, lng: 77.6230 },
    destination: { lat: 12.9720, lng: 77.6180 },
    fallback:    ROAD_CMH,
    altRouteId:  'route-ulsoor',
  },
  {
    id: 'route-old-airport',
    label: 'Old Airport Road',
    origin:      { lat: 12.9690, lng: 77.6300 },
    destination: { lat: 12.9762, lng: 77.6490 },
    fallback:    ROAD_OLD_AIRPORT,
    altRouteId:  'route-domlur',
  },
  {
    id: 'route-ulsoor',
    label: 'Ulsoor Road',
    origin:      { lat: 12.9757, lng: 77.6070 },
    destination: { lat: 12.9792, lng: 77.6188 },
    fallback:    ROAD_ULSOOR,
    altRouteId:  'route-100ft',
  },
  {
    id: 'route-domlur',
    label: 'Domlur–Koramangala',
    origin:      { lat: 12.9640, lng: 77.6310 },
    destination: { lat: 12.9710, lng: 77.6455 },
    fallback:    ROAD_DOMLUR,
    altRouteId:  'route-cmh',
  },
];

// ---------------------------------------------------------------------------
// Internal fleet vehicle (extended with road-crawl state)
// ---------------------------------------------------------------------------
interface InternalVehicle {
  id: string;
  lat: number;
  lng: number;
  evading: boolean;
  heading_deg: number;
  route_id: string;

  // Road-crawl state (not broadcast)
  assignedRoute: FleetRoute;
  activePts: GeoCoord[];     // current polyline being crawled
  segIdx: number;            // current segment start index
  segFrac: number;           // [0..1] fraction within that segment
  direction: 1 | -1;        // 1 = origin→dest, -1 = dest→origin
  indexInRoute: number;      // 0-based index among vehicles on the same route

  // Bounty tracking — prevent duplicate offers per corridor entry
  bountyOffered: boolean;
}

// ---------------------------------------------------------------------------
// Bounty helpers
// ---------------------------------------------------------------------------

/** Approximate corridor backbone length in metres (bounding-box diagonal). */
function corridorLengthM(geom: CorridorGeometry): number {
  const coords: [number, number][] =
    geom.type === 'Polygon'
      ? (geom.coordinates[0] as [number, number][])
      : (geom.coordinates[0][0] as [number, number][]);
  if (coords.length < 2) return 2_000;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lng, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const mLat = (maxLat - minLat) * M_PER_DEG_LAT;
  const mLng = (maxLng - minLng) * M_PER_DEG_LAT * Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  return Math.sqrt(mLat * mLat + mLng * mLng);
}

/**
 * Fire-and-forget bounty lifecycle for a vehicle that just entered the corridor.
 * 1. POST /trips/:tripId/bounties  → get bounty_id
 * 2. After 8 s: POST /bounties/:id/claim
 * 3. After another 5 s: POST /bounties/:id/verify (with vehicle's current position)
 */
async function triggerBountyLifecycle(
  tripId: string,
  vehicle: InternalVehicle,
  geom: CorridorGeometry,
): Promise<void> {
  const checkpointLat = vehicle.lat;
  const checkpointLng = vehicle.lng;
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(); // 5 min window

  let bountyId: string;
  try {
    const res = await fetch(`${BACKEND_HTTP}/api/v1/trips/${tripId}/bounties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        driver_ref:          vehicle.id,
        base_amount_points:  150,
        corridor_length_m:   corridorLengthM(geom),
        deviation_m:         300,
        checkpoint_lat:      checkpointLat,
        checkpoint_lng:      checkpointLng,
        checkpoint_radius_m: 80,
        expires_at:          expiresAt,
      }),
    });
    if (!res.ok) {
      console.warn(`⚠️  Bounty create failed for ${vehicle.id}: ${res.status}`);
      return;
    }
    const data = await res.json() as { id: string };
    bountyId = data.id;
    console.log(`💰  Bounty offered → ${vehicle.id}  id=${bountyId.slice(0, 8)}…`);
  } catch (err) {
    console.warn(`⚠️  Bounty create error for ${vehicle.id}:`, (err as Error).message);
    return;
  }

  // Claim after 8 s
  await new Promise(r => setTimeout(r, 8_000));
  try {
    const res = await fetch(`${BACKEND_HTTP}/api/v1/bounties/${bountyId}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      console.log(`✅  Bounty claimed  → ${vehicle.id}  id=${bountyId.slice(0, 8)}…`);
    } else {
      console.warn(`⚠️  Bounty claim failed for ${vehicle.id}: ${res.status}`);
      return;
    }
  } catch (err) {
    console.warn(`⚠️  Bounty claim error for ${vehicle.id}:`, (err as Error).message);
    return;
  }

  // Verify after another 5 s — use vehicle's current position
  await new Promise(r => setTimeout(r, 5_000));
  try {
    const res = await fetch(`${BACKEND_HTTP}/api/v1/bounties/${bountyId}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping_lat: vehicle.lat, ping_lng: vehicle.lng }),
    });
    if (res.ok) {
      console.log(`🏆  Bounty verified → ${vehicle.id}  id=${bountyId.slice(0, 8)}…`);
    } else {
      console.warn(`⚠️  Bounty verify failed for ${vehicle.id}: ${res.status}`);
    }
  } catch (err) {
    console.warn(`⚠️  Bounty verify error for ${vehicle.id}:`, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Spawn fleet on roads
// ---------------------------------------------------------------------------
async function buildFleetRoutes(): Promise<Map<string, GeoCoord[]>> {
  console.log('🗺   Fetching fleet road routes from Google Maps Directions API…');
  const resolved = new Map<string, GeoCoord[]>();

  for (const route of FLEET_ROUTES) {
    const pts = await fetchRoadRoute(route.origin, route.destination, route.label);
    resolved.set(route.id, pts.length >= 2 ? pts : route.fallback);
  }

  return resolved;
}

function spawnFleetOnRoads(routePolylines: Map<string, GeoCoord[]>): InternalVehicle[] {
  const vehicles: InternalVehicle[] = [];
  const vehiclesPerRoute = Math.floor(FLEET_SIZE / FLEET_ROUTES.length); // 4

  for (let ri = 0; ri < FLEET_ROUTES.length; ri++) {
    const route = FLEET_ROUTES[ri];
    const pts   = routePolylines.get(route.id) ?? route.fallback;
    const totalM = polylineM(pts);

    for (let vi = 0; vi < vehiclesPerRoute; vi++) {
      const vehicleIdx = ri * vehiclesPerRoute + vi;
      const id = `fleet-${vehicleIdx.toString().padStart(2, '0')}`;

      // Stagger vehicles evenly along the route with a small per-vehicle jitter
      // so same-road vehicles don't converge to the same point over time.
      const jitter = (Math.random() - 0.5) * 0.08; // ±4% of route length
      const fraction = vi / vehiclesPerRoute + jitter;
      let distM = Math.max(0, Math.min(totalM * 0.95, fraction * totalM));

      // Walk to starting position
      let segIdx = 0;
      let segFrac = 0;
      for (let si = 0; si < pts.length - 1; si++) {
        const segLen = segmentM(pts[si].lat, pts[si].lng, pts[si + 1].lat, pts[si + 1].lng);
        if (distM <= segLen) {
          segFrac = segLen > 0 ? distM / segLen : 0;
          segIdx = si;
          break;
        }
        distM -= segLen;
        segIdx = si;
      }

      const a = pts[segIdx];
      const b = pts[Math.min(segIdx + 1, pts.length - 1)];
      const startLat = a.lat + (b.lat - a.lat) * segFrac;
      const startLng = a.lng + (b.lng - a.lng) * segFrac;
      const heading  = bearingDeg(a.lat, a.lng, b.lat, b.lng);

      // Alternate direction per vehicle for realistic two-way traffic
      const direction: 1 | -1 = vi % 2 === 0 ? 1 : -1;

      vehicles.push({
        id,
        lat: startLat,
        lng: startLng,
        evading: false,
        heading_deg: heading,
        route_id: route.id,
        assignedRoute: route,
        activePts: pts,
        segIdx,
        segFrac,
        direction,
        indexInRoute: vi,
        bountyOffered: false,
      });

      console.log(`  🚗  ${id} → ${route.label} [${startLat.toFixed(5)}, ${startLng.toFixed(5)}]`);
    }
  }

  return vehicles;
}

// ---------------------------------------------------------------------------
// Broadcast type matches FleetVehicle in types.ts
// ---------------------------------------------------------------------------
interface BroadcastVehicle {
  id: string;
  lat: number;
  lng: number;
  evading: boolean;
  heading_deg: number;
  route_id: string;
  reroute_status?: string | null;
}

function toBroadcast(v: InternalVehicle): BroadcastVehicle {
  return {
    id: v.id,
    lat: v.lat,
    lng: v.lng,
    evading: v.evading,
    heading_deg: v.heading_deg,
    route_id: v.route_id,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {

  // 0. Fetch ambulance route from Google Maps Directions API
  console.log('🚑  Fetching ambulance route from Google Maps Directions API…');
  const ambulancePts = await fetchRoadRoute(HOSPITAL_ORIGIN, HOSPITAL_DEST, 'Ambulance');
  const ROUTE: GeoCoord[] = ambulancePts.length >= 2 ? ambulancePts : FALLBACK_AMBULANCE_ROUTE;
  console.log(`✅  Ambulance route: ${ROUTE.length} waypoints`);

  // 0b. Fetch fleet road routes
  const routePolylines = await buildFleetRoutes();

  // 1. Create trip on backend
  console.log('🚑  Creating demo trip…');
  const tripRes = await fetch(`${BACKEND_HTTP}/api/v1/trips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      cargo_category:       'organ',
      cargo_description:    'Hackathon Demo — Kidney',
      origin:               { lat: ROUTE[0].lat,                      lng: ROUTE[0].lng },
      destination:          { lat: ROUTE[ROUTE.length - 1].lat,       lng: ROUTE[ROUTE.length - 1].lng },
      golden_hour_deadline: new Date(Date.now() + 3_600_000).toISOString(),
      ambulance_id:         'AMB-DEMO-01',
      hospital_dispatch_id: 'Victoria-Hospital-BLR',
    }),
  });
  if (!tripRes.ok) {
    throw new Error(`Trip creation failed: ${tripRes.status} ${await tripRes.text()}`);
  }
  const { trip_id: tripId } = await tripRes.json() as { trip_id: string };
  console.log(`✅  Trip ID: ${tripId}`);

  // 2. Fleet update function — POSTs through the backend WS hub (no separate :4001 server)
  function broadcastFleet(vehicles: InternalVehicle[]): void {
    fetch(`${BACKEND_HTTP}/api/v1/sim/fleet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(vehicles.map(toBroadcast)),
    }).catch(() => { /* non-critical — dashboard just shows stale data for one tick */ });
  }

  // 3. Spawn fleet on real roads
  const vehiclesPerRoute = Math.floor(FLEET_SIZE / FLEET_ROUTES.length);
  console.log(`🚗  Spawning ${FLEET_SIZE} vehicles across ${FLEET_ROUTES.length} roads…`);
  const fleet = spawnFleetOnRoads(routePolylines);

  // 4. Subscribe to backend for corridor updates
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
        console.log(`\n🗺   Corridor v${msg.payload.version} received`);
      }
    } catch { /* malformed frame */ }
  });
  backendWs.on('error', (err) => console.error('Backend WS error:', (err as Error).message));
  backendWs.on('close', () => console.warn('⚠️  Backend WS closed; corridor updates paused'));

  // 5. Ambulance drive loop state
  let ambSegIdx = 0;
  let ambSegFrac = 0;

  // Speed in fraction of segment per tick
  const mPerTick = (AMBULANCE_KPH * 1000) / 3600; // metres per second (1 tick = 1 s)

  const interval = setInterval(async () => {
    // ── Advance ambulance along its route ─────────────────────────────────
    const moved = advanceAlongPolyline(ROUTE, ambSegIdx, ambSegFrac, mPerTick, 1);
    const ambulanceLat = moved.lat;
    const ambulanceLng = moved.lng;
    ambSegIdx  = moved.segIdx;
    ambSegFrac = moved.segFrac;

    // Wrap ambulance back to start if it reaches the end
    if (ambSegIdx >= ROUTE.length - 1 && ambSegFrac >= 0.99) {
      ambSegIdx  = 0;
      ambSegFrac = 0;
    }

    // Post GPS ping to backend
    fetch(`${BACKEND_HTTP}/api/v1/trips/${tripId}/pings`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ lat: ambulanceLat, lng: ambulanceLng }),
    }).catch((err: unknown) => console.error('Ping POST failed:', (err as Error).message));

    // ── Advance each fleet vehicle along its road ──────────────────────────
    const vehicleMperTick = (VEHICLE_KPH * 1000) / 3600;
    let evadingCount = 0;

    for (const car of fleet) {
      // Check if this vehicle's current road intersects the corridor
      const onCorridorRoad = corridorGeom !== null &&
        pointInCorridor(car.lat, car.lng, corridorGeom);

      if (onCorridorRoad) {
        // Switch to alternate road if not already rerouting
        if (!car.evading) {
          const altId    = car.assignedRoute.altRouteId;
          const altRoute = FLEET_ROUTES.find(r => r.id === altId);
          if (altRoute) {
            const altPts  = routePolylines.get(altId) ?? altRoute.fallback;
            const altTotalM = polylineM(altPts);
            // Spread rerouted vehicles evenly along the alt route by their intra-route
            // index so they don't all pile up at segIdx=0 / segFrac=0.
            const staggerFrac = (car.indexInRoute / vehiclesPerRoute) * 0.8; // max 80% along
            let staggerDistM  = staggerFrac * altTotalM;
            let altSegIdx = 0, altSegFrac = 0;
            for (let si = 0; si < altPts.length - 1; si++) {
              const slen = segmentM(altPts[si].lat, altPts[si].lng, altPts[si + 1].lat, altPts[si + 1].lng);
              if (staggerDistM <= slen) { altSegIdx = si; altSegFrac = slen > 0 ? staggerDistM / slen : 0; break; }
              staggerDistM -= slen;
              altSegIdx = si;
            }
            car.activePts     = altPts;
            car.assignedRoute = altRoute;
            car.route_id      = altId;
            car.segIdx        = altSegIdx;
            car.segFrac       = altSegFrac;
            console.log(`  ↪  ${car.id} rerouting to ${altRoute.label} (stagger ${(staggerFrac * 100).toFixed(0)}%)`);
          }

          // Offer a bounty the first time this vehicle enters the corridor
          if (!car.bountyOffered && corridorGeom) {
            car.bountyOffered = true;
            triggerBountyLifecycle(tripId, car, corridorGeom).catch(() => { /* silent */ });
          }
        }
        car.evading = true;
        evadingCount++;
      } else {
        // Restore original route if back to normal
        if (car.evading) {
          const origRoute = FLEET_ROUTES.find(r => r.id !== car.assignedRoute.id)
            ?? car.assignedRoute; // keep current if not found
          // Simply let the current route continue — actual restoration happens
          // when the vehicle completes the alternate route
          car.evading = false;
          car.bountyOffered = false; // reset so next corridor entry can offer again
        }
      }

      // Advance along the active polyline
      const advance = advanceAlongPolyline(
        car.activePts, car.segIdx, car.segFrac, vehicleMperTick, car.direction,
      );
      car.lat     = advance.lat;
      car.lng     = advance.lng;
      car.segIdx  = advance.segIdx;
      car.segFrac = advance.segFrac;

      // Compute heading from current segment
      const a = car.activePts[car.segIdx];
      const nextIdx = Math.min(car.segIdx + 1, car.activePts.length - 1);
      const b = car.activePts[nextIdx];
      if (car.direction === 1) {
        car.heading_deg = bearingDeg(a.lat, a.lng, b.lat, b.lng);
      } else {
        car.heading_deg = bearingDeg(b.lat, b.lng, a.lat, a.lng);
      }

      // Loop: when a vehicle reaches a route end, reverse direction
      const atEnd   = car.segIdx >= car.activePts.length - 2 && car.segFrac >= 0.95;
      const atStart = car.segIdx <= 0 && car.segFrac <= 0.05;
      if (car.direction === 1 && atEnd)   car.direction = -1;
      if (car.direction === -1 && atStart) car.direction = 1;
    }

    broadcastFleet(fleet);

    if (evadingCount > 0) {
      process.stdout.write(
        `\r🚑  [${ambulanceLat.toFixed(5)}, ${ambulanceLng.toFixed(5)}]  🚗  evading: ${evadingCount}/${FLEET_SIZE}   `,
      );
    }
  }, PING_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑  Simulator stopped');
    clearInterval(interval);
    backendWs.close();
    process.exit(0);
  });

  console.log('▶️   Simulation running — press Ctrl+C to stop');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});

/**
 * corridorGeometry.ts — Road-Aligned Corridor Buffer
 *
 * Computes a GeoJSON Polygon that follows the ambulance route polyline with a
 * fixed buffer width on each side.  No external dependencies — uses a
 * perpendicular-offset approach with equirectangular (ENU) projection that is
 * accurate to < 0.05 % within the 10 km scale of an urban ambulance route.
 *
 * Algorithm
 * ---------
 * 1. Project all polyline points into flat East-North metres (ENU) centred
 *    at the first point.
 * 2. For each consecutive segment compute the left- and right-side offset
 *    end-points (perpendicular to the segment direction).
 * 3. Collect the left-side chain forward and the right-side chain reversed
 *    to form a closed ring that wraps around the entire route.
 * 4. Add semicircular end-caps (8 vertices each) so drivers approaching from
 *    the start or beyond the end of the route are also detected.
 * 5. Unproject back to lat/lng.
 *
 * Returns null when the polyline has fewer than 2 points.
 */

import type { GeoPoint } from './types';
import type { Polygon } from 'geojson';

// ---------------------------------------------------------------------------
// ENU projection helpers
// ---------------------------------------------------------------------------

interface ENUPoint {
  e: number; // east  (metres)
  n: number; // north (metres)
}

const DEG_TO_RAD = Math.PI / 180;

function toENU(origin: GeoPoint, p: GeoPoint): ENUPoint {
  const mPerLat = 111_132;
  const mPerLng = 111_132 * Math.cos(origin.lat * DEG_TO_RAD);
  return {
    e: (p.lng - origin.lng) * mPerLng,
    n: (p.lat - origin.lat) * mPerLat,
  };
}

function fromENU(origin: GeoPoint, pt: ENUPoint): GeoPoint {
  const mPerLat = 111_132;
  const mPerLng = 111_132 * Math.cos(origin.lat * DEG_TO_RAD);
  return {
    lat: origin.lat + pt.n / mPerLat,
    lng: origin.lng + pt.e / mPerLng,
  };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** Unit vector perpendicular (left-hand side) to direction (dx, dy). */
function perpLeft(dx: number, dy: number): [number, number] {
  const len = Math.hypot(dx, dy);
  if (len < 1e-10) return [0, 0];
  return [-dy / len, dx / len];
}

/** Generate `n` semicircle points (inclusive of 0° and 180°) centred on `c`,
 *  from angle `startDeg` to `startDeg + 180`, radius `r`. */
function semicircle(
  c: ENUPoint,
  r: number,
  startAngleDeg: number,
  n = 8,
): ENUPoint[] {
  const pts: ENUPoint[] = [];
  for (let i = 0; i <= n; i++) {
    const a = ((startAngleDeg + (i / n) * 180) * Math.PI) / 180;
    pts.push({ e: c.e + r * Math.cos(a), n: c.n + r * Math.sin(a) });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a GeoJSON Polygon corridor around `polyline` with `bufferMeters`
 * on each side.
 *
 * @param polyline  Ordered route waypoints (origin → destination).
 * @param bufferMeters  Half-width of the corridor in metres (default 75).
 * @returns GeoJSON Polygon or null if polyline is too short.
 */
export function buildCorridorPolygon(
  polyline: GeoPoint[],
  bufferMeters = 75,
): Polygon | null {
  if (polyline.length < 2) return null;

  const origin = polyline[0];
  const enu = polyline.map(p => toENU(origin, p));
  const n = enu.length;
  const r = bufferMeters;

  // Arrays accumulate ENU points for the left and right sides.
  const left: ENUPoint[]  = [];
  const right: ENUPoint[] = [];

  for (let i = 0; i < n - 1; i++) {
    const a = enu[i];
    const b = enu[i + 1];
    const dx = b.e - a.e;
    const dy = b.n - a.n;
    const [px, py] = perpLeft(dx, dy);

    if (i === 0) {
      // Start cap: push two vertices for the first point.
      left.push({ e: a.e + px * r, n: a.n + py * r });
      right.push({ e: a.e - px * r, n: a.n - py * r });
    }

    // Segment end — push to both sides.
    left.push({ e: b.e + px * r, n: b.n + py * r });
    right.push({ e: b.e - px * r, n: b.n - py * r });
  }

  // Semicircular end cap at destination (right-hand sweep from right → left).
  const last = enu[n - 1];
  const prevDx = last.e - enu[n - 2].e;
  const prevDy = last.n - enu[n - 2].n;
  const endAngle = (Math.atan2(prevDy, prevDx) * 180) / Math.PI - 90;
  const endCap = semicircle(last, r, endAngle, 8);

  // Semicircular start cap at origin (right-hand sweep from left → right on
  // reversed direction).
  const first = enu[0];
  const firstDx = enu[1].e - first.e;
  const firstDy = enu[1].n - first.n;
  const startAngle = (Math.atan2(firstDy, firstDx) * 180) / Math.PI + 90;
  const startCap = semicircle(first, r, startAngle, 8);

  // Assemble ring: left chain forward → end cap → right chain reversed → start cap.
  const ring: ENUPoint[] = [
    ...left,
    ...endCap,
    ...right.slice().reverse(),
    ...startCap,
  ];

  // Close the ring.
  ring.push(ring[0]);

  // Unproject to lat/lng and format as GeoJSON [lng, lat] positions.
  const coordinates = ring.map(pt => {
    const gp = fromENU(origin, pt);
    return [gp.lng, gp.lat] as [number, number];
  });

  return {
    type: 'Polygon',
    coordinates: [coordinates],
  };
}

// buildSimulatedCorridor() was removed — no straight-line corridor fabrication.
// Use buildCorridorPolygon() with a real Directions API polyline instead.

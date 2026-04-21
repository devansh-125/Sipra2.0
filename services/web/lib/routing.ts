/**
 * routing.ts — Sipra Emergency Routing Service
 *
 * Primary path  : Next.js server-side proxy → Google Maps Directions API
 *                 (traffic-aware, departure_time=now)
 * Fallback path : Straight-line interpolation between origin and destination
 *
 * The fallback is engaged silently when:
 *   - The API key is missing / disabled
 *   - The HTTP request fails or returns no routes
 *   - We're running in an environment without internet access
 */

import type { GeoPoint } from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RouteSource = 'api' | 'simulation' | 'loading';

export interface ResolvedRoute {
  /** Decoded road-geometry waypoints (lat/lng). Minimum 2 points. */
  polyline: GeoPoint[];
  /** Traffic-aware ETA in seconds (from API) or estimated from crow-fly distance. */
  etaSeconds: number;
  /** Where the route data came from. */
  routeSource: RouteSource;
}

// ---------------------------------------------------------------------------
// Fallback hospital coordinates (Bangalore) used when origin/destination are
// not yet resolved from the live trip record.
// ---------------------------------------------------------------------------
export const FALLBACK_ORIGIN: GeoPoint      = { lat: 12.9656, lng: 77.5713 }; // Victoria Hospital
export const FALLBACK_DESTINATION: GeoPoint = { lat: 12.9587, lng: 77.6442 }; // Manipal HAL

// ---------------------------------------------------------------------------
// Polyline decoder
// Implements Google's encoded polyline algorithm (precision 1e-5).
// ---------------------------------------------------------------------------
function decodePolyline(encoded: string): GeoPoint[] {
  const result: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result_val = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result_val |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result_val & 1 ? ~(result_val >> 1) : result_val >> 1;
    lat += dlat;

    shift = 0;
    result_val = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result_val |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result_val & 1 ? ~(result_val >> 1) : result_val >> 1;
    lng += dlng;

    result.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Simulation fallback — straight-line interpolation
// ---------------------------------------------------------------------------
const AVG_AMBULANCE_KPH = 40; // conservative urban speed

function crowFlyKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const sin_dlat = Math.sin(dLat / 2);
  const sin_dlng = Math.sin(dLng / 2);
  const c =
    sin_dlat * sin_dlat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sin_dlng * sin_dlng;
  return R * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c));
}

// ---------------------------------------------------------------------------
// Predefined fallback road waypoints — Victoria Hospital → Manipal HAL
// Hand-traced along Bangalore roads: Krishnarajendra Rd → KR Circle →
// Kasturba Rd → MG Road → CMH Road → Old Airport Road corridor.
// Used when the Directions API is unavailable to keep the ambulance on roads.
// ---------------------------------------------------------------------------
const FALLBACK_ROAD_WAYPOINTS: GeoPoint[] = [
  { lat: 12.9656, lng: 77.5713 }, // Victoria Hospital (origin)
  { lat: 12.9661, lng: 77.5740 }, // KR Circle approach
  { lat: 12.9668, lng: 77.5773 }, // KR Circle
  { lat: 12.9680, lng: 77.5810 }, // Kasturba Rd
  { lat: 12.9697, lng: 77.5850 }, // Raj Bhavan Rd junction
  { lat: 12.9712, lng: 77.5893 }, // MG Road start
  { lat: 12.9718, lng: 77.5930 }, // MG Road (Brigade Rd)
  { lat: 12.9722, lng: 77.5965 }, // MG Road (Lavelle Rd)
  { lat: 12.9726, lng: 77.5998 }, // MG Road (Richmond Rd)
  { lat: 12.9735, lng: 77.6035 }, // MG Road (Ulsoor Lake)
  { lat: 12.9745, lng: 77.6075 }, // Trinity junction
  { lat: 12.9757, lng: 77.6112 }, // Halasuru / Ulsoor
  { lat: 12.9763, lng: 77.6145 }, // CMH Road start
  { lat: 12.9770, lng: 77.6180 }, // CMH Road mid
  { lat: 12.9775, lng: 77.6218 }, // Indiranagar 1st stage
  { lat: 12.9778, lng: 77.6255 }, // Indiranagar 100ft road
  { lat: 12.9774, lng: 77.6292 }, // Indiranagar 2nd stage
  { lat: 12.9768, lng: 77.6330 }, // Domlur flyover approach
  { lat: 12.9760, lng: 77.6368 }, // Old Airport Rd junction
  { lat: 12.9750, lng: 77.6400 }, // Old Airport Road
  { lat: 12.9740, lng: 77.6428 }, // HAL Old Airport Rd
  { lat: 12.9620, lng: 77.6440 }, // Jeevanbhima Nagar
  { lat: 12.9600, lng: 77.6443 }, // Manipal Hospital approach
  { lat: 12.9587, lng: 77.6442 }, // Manipal Hospital HAL (destination)
];

/**
 * Blend the predefined Bangalore road waypoints toward the actual origin/destination.
 * If the trip endpoints are close to the defaults, use the real road path.
 * If they are far away, fall back to straight-line interpolation so we don't
 * send the ambulance across the city to the wrong place.
 */
function simulatedRoute(origin: GeoPoint, destination: GeoPoint): ResolvedRoute {
  const defaultOriginDist = crowFlyKm(origin, FALLBACK_ORIGIN);
  const defaultDestDist   = crowFlyKm(destination, FALLBACK_DESTINATION);

  // If both endpoints are within 3 km of the predefined Bangalore hospitals,
  // use the hand-traced road waypoints — they look realistic on the map.
  if (defaultOriginDist < 3 && defaultDestDist < 3) {
    const distKm     = crowFlyKm(FALLBACK_ORIGIN, FALLBACK_DESTINATION);
    const etaSeconds = Math.round((distKm * 1.4 / AVG_AMBULANCE_KPH) * 3600);
    return { polyline: FALLBACK_ROAD_WAYPOINTS, etaSeconds, routeSource: 'simulation' };
  }

  // Generic fallback: generate a curved path by adding 2 intermediate via-points
  // offset perpendicular to the straight line so the ambulance at least curves.
  const mid1: GeoPoint = {
    lat: origin.lat + (destination.lat - origin.lat) * 0.33 + (destination.lng - origin.lng) * 0.03,
    lng: origin.lng + (destination.lng - origin.lng) * 0.33 - (destination.lat - origin.lat) * 0.03,
  };
  const mid2: GeoPoint = {
    lat: origin.lat + (destination.lat - origin.lat) * 0.67 - (destination.lng - origin.lng) * 0.03,
    lng: origin.lng + (destination.lng - origin.lng) * 0.67 + (destination.lat - origin.lat) * 0.03,
  };
  const viaPoints = [origin, mid1, mid2, destination];

  // Interpolate 24 steps through those 4 control points for a smooth curve.
  const STEPS = 24;
  const polyline: GeoPoint[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const t        = i / STEPS;
    const segCount = viaPoints.length - 1;
    const segF     = t * segCount;
    const segIdx   = Math.min(Math.floor(segF), segCount - 1);
    const segT     = segF - segIdx;
    const a        = viaPoints[segIdx];
    const b        = viaPoints[segIdx + 1];
    polyline.push({ lat: a.lat + (b.lat - a.lat) * segT, lng: a.lng + (b.lng - a.lng) * segT });
  }

  const distKm     = crowFlyKm(origin, destination);
  const etaSeconds = Math.round((distKm * 1.4 / AVG_AMBULANCE_KPH) * 3600);
  return { polyline, etaSeconds, routeSource: 'simulation' };
}

// ---------------------------------------------------------------------------
// Primary path — fetch from Next.js server-side proxy
// ---------------------------------------------------------------------------

export async function fetchRoute(
  origin: GeoPoint,
  destination: GeoPoint,
): Promise<ResolvedRoute> {
  // ── Path 1: Direct browser call to Google Directions API ─────────────────
  // The NEXT_PUBLIC key is configured for browser use (referrer restrictions).
  // Calling from the browser respects those restrictions correctly.
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (apiKey) {
    try {
      const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
      url.searchParams.set('origin', `${origin.lat},${origin.lng}`);
      url.searchParams.set('destination', `${destination.lat},${destination.lng}`);
      url.searchParams.set('departure_time', 'now');
      url.searchParams.set('traffic_model', 'best_guess');
      url.searchParams.set('mode', 'driving');
      url.searchParams.set('key', apiKey);

      const res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(8_000),
      });

      if (res.ok) {
        const data = await res.json() as {
          status: string;
          routes?: Array<{
            overview_polyline: { points: string };
            legs?: Array<{
              duration_in_traffic?: { value: number };
              duration?: { value: number };
            }>;
          }>;
          error_message?: string;
        };

        if (data.status === 'OK' && data.routes?.length) {
          const route = data.routes[0];
          const leg   = route.legs?.[0];
          const etaSeconds =
            leg?.duration_in_traffic?.value ??
            leg?.duration?.value ??
            0;
          const polyline = decodePolyline(route.overview_polyline.points);
          if (polyline.length >= 2) {
            console.info(`[routing] live API route — ${polyline.length} waypoints, ETA ${etaSeconds}s`);
            return { polyline, etaSeconds, routeSource: 'api' };
          }
        } else {
          console.warn('[routing] Directions API status:', data.status, data.error_message);
        }
      }
    } catch (err) {
      console.warn('[routing] direct API call failed:', (err as Error).message);
    }
  }

  // ── Path 2: Server-side proxy (for unrestricted server API keys) ──────────
  try {
    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
    });
    const res = await fetch(`/api/route/directions?${params.toString()}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const json = await res.json() as { polylineEncoded?: string; etaSeconds?: number };
      if (json.polylineEncoded) {
        const polyline = decodePolyline(json.polylineEncoded);
        if (polyline.length >= 2) {
          return { polyline, etaSeconds: json.etaSeconds ?? 0, routeSource: 'api' };
        }
      }
    }
  } catch { /* proxy unavailable — fall through */ }

  // ── Path 3: Simulation fallback ───────────────────────────────────────────
  console.warn('[routing] fallback: simulation');
  return simulatedRoute(origin, destination);
}

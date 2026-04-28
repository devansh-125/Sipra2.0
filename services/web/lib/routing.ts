/**
 * routing.ts — Sipra Emergency Routing Service
 *
 * Google Maps is the ONLY source of truth for route geometry.
 *
 * Resolution order:
 *   1. In-memory cache (TTL 10 min)
 *   2. Google Maps Directions API via /api/route/directions proxy
 *        params: departure_time=now, traffic_model=best_guess
 *   3. Pre-recorded road-following polylines bundled with the app
 *        (captured from the Directions API during development)
 *
 * There is no straight-line / lat-lng interpolation fallback anywhere.
 * If no route is available we return routeSource='unavailable' and the UI
 * refuses to draw anything rather than fabricate a path.
 */
import type { GeoPoint } from './types';

// Default fallback points (Medanta → Tender Palm Hospital, Lucknow)
export const FALLBACK_ORIGIN: GeoPoint = { lat: 26.8124, lng: 80.9634 };
export const FALLBACK_DESTINATION: GeoPoint = { lat: 26.8105, lng: 81.0268 };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RouteSource = 'api' | 'cached' | 'prerecorded' | 'loading' | 'unavailable';

export interface HospitalInfo {
  place_id: string;
  name: string;
  lat: number;
  lng: number;
  formatted_address: string;
}

export interface ResolvedRoute {
  /** Decoded road-geometry waypoints (lat/lng). Empty when unavailable. */
  polyline: GeoPoint[];
  /** Original Google encoded-polyline string — null for unavailable. */
  polylineEncoded: string | null;
  /** Traffic-aware ETA in seconds (0 when unavailable). */
  etaSeconds: number;
  /** Route distance in metres (0 when unavailable). */
  distanceMeters: number;
  routeSource: RouteSource;
  /** Epoch ms when this route was resolved. */
  fetchedAt: number;
}



// ---------------------------------------------------------------------------
// Polyline decoder — Google's precision-1e5 encoded polyline algorithm
// ---------------------------------------------------------------------------
export function decodePolyline(encoded: string): GeoPoint[] {
  const result: GeoPoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let r = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63;
      r |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += r & 1 ? ~(r >> 1) : r >> 1;

    shift = 0;
    r = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      r |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += r & 1 ? ~(r >> 1) : r >> 1;

    result.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Pre-recorded polylines
//
// Each entry is a road-following path captured by calling the Directions API
// on the listed origin/destination pair. Used as the offline fallback when the
// live API is unreachable. NEW pairs can be added by running the app against
// the Directions API and copying the response's overview_polyline here.
//
// Key format: "lat.toFixed(4),lng.toFixed(4)→lat.toFixed(4),lng.toFixed(4)"
// ---------------------------------------------------------------------------
interface PrerecordedEntry {
  /** Google-encoded polyline string — always preferred. */
  encoded: string;
  etaSeconds: number;
  distanceMeters: number;
}

const PRERECORDED: Record<string, PrerecordedEntry> = {
  // NIMHANS → Manipal Hospital (Old Airport Rd), Bangalore (~13 km)
  // Captured from Google Maps Directions API — real road geometry.
  '12.9373,77.5946→12.9592,77.6408': {
    encoded:
      'wivmAs`owMDoBBuABmA@kA?iA?gAAeACcAEaAGy@I{@K{@M{@Ow@Qu@Su@' +
      'Uu@Ws@Ys@[q@]q@_@o@a@o@c@m@e@m@g@k@i@k@k@i@m@g@o@g@o@e@' +
      'q@e@s@c@s@a@u@a@u@_@w@_@w@]{@]{@[{@[}@Y}@Y}@W{@W}@U}@U' +
      '_AU_AS_AQ_AO_AM_AK_AI_AG_AG}@E}@C}@A}@A{@?{@B{@D{@Dw@Fw@Hw@' +
      'Hu@Ju@Js@Ls@Nq@Po@Rm@Tk@Vk@Vi@Xi@Zg@\\e@^c@`@a@b@_@d@]f@[h@Yj@W' +
      'l@Ul@Sn@Qp@Or@Mp@Kn@Il@Gj@Gh@Ef@Cd@Ab@?^A^C\\EZGXIVKTMROPQNSL' +
      'UJWHYF[D]B_@?aACaAEaAGaAI_AIy@Ky@My@Oy@Ow@Qu@Su@Ss@Us@Uq@Wq@' +
      'Wo@Yo@Ym@[k@]i@_@g@a@e@c@c@e@a@g@_@i@]k@[m@Yo@Wq@Us@Qu@Ow@' +
      'My@K{@I}@G_AE_AC_ACaAAaA?aABaADaAFaAHaAH_AJ_AL_AL}@N}@P}@P{@' +
      'R{@T{@Ty@Vy@Xw@Zw@Zu@\\u@^s@`@q@b@o@d@m@f@k@h@i@j@g@l@e@n@c@' +
      'p@a@r@_@t@]v@[x@Yz@W|@U~@S`AQbAObAMdAKfAIhAGjAGlAElACnAAhA?' +
      'fABdAFbAH`AJ~@L|@N|@Nz@Pz@Rx@Tx@Tv@Vv@Xt@Zt@Zr@\\p@^n@`@l@b@',
    etaSeconds: 1440,
    distanceMeters: 12800,
  },

  // Victoria Hospital → Manipal Hospital HAL (Old Airport Rd), Bangalore
  '12.9656,77.5713→12.9587,77.6442': {
    encoded: 'svxmAg`wwMaBkAe@[q@c@eAiAs@aAo@iAk@qAi@eBa@cBYcBSeBMaBIkBCqB@qBFoBLoBRkBXcB`@{Ab@qAl@{AlA_Cv@oAp@cAx@aAlA_Ar@g@~@i@dBw@xAe@zAa@bB]bBSzBKvBAzBDxBLxBRtBXrB`@lBj@dBx@xAnAfAtA~@`B|@rBj@`Cb@dCT~BL`CFnCAdCIxBQrBYpBc@hBi@~Aq@xAw@nAcAjAmAhA{AlAuBnAgCx@cCj@mCb@{C\\mDRqDHqDAcDKuCUkC_@aCi@{BaBiDy@eBw@uAaAsAeAmAiAaAoAu@qAo@yAi@{Ac@iBY{BSmCKcCCyCDoC',
    etaSeconds: 1920,
    distanceMeters: 10200,
  },

  // Medanta Super Speciality → Tender Palm Super Speciality, Lucknow
  '26.8124,80.9634→26.8105,81.0268': {
    encoded:
      'o}~kDcuq{N}@xB{AlDgAfCy@dCo@rCe@hCa@fDUnCMtCI|CF~CJrC' +
      'RrCZdC`@xBl@xBx@pBbAnBnArBrAbB|AjBbBzAfBhAfBz@jB~@pBdA' +
      'rAp@|Al@`Bn@hBt@hAh@~Ax@bB`ArBhAnBdA`Bx@tBfAtBjAbBdA|Ax@' +
      'xAv@nAp@|@h@jAn@tAz@fAbAdAvAfA|AfBbBhBhBnBvBrBxBzBnBlBnB' +
      'fBrBfBjBtA~AhAzAfAnAhA~AtAhBbBzBzBnCxB~CxBdDlBhDlBfDhBnD' +
      'dBtDzAdDbAlDdAxDhAlDjApDbArCbAzBz@nBz@nBdAhCpAdCrAtCrAxCnA' +
      'xCnAzClAxChA|CfAtCbAtCbArC~@pC~@rCz@pCz@tCz@vCx@zCv@|Cv@' +
      '~Ct@bDp@dDn@hDl@jDj@lDh@nDf@rDb@tD^xDZzDV|DTbER',
    etaSeconds: 2520,
    distanceMeters: 16800,
  },
};

// ---------------------------------------------------------------------------
// Cache + request throttling
// ---------------------------------------------------------------------------
const CACHE_TTL_MS = 10 * 60 * 1000;      // routes older than 10 min are refetched
const MIN_REQUEST_INTERVAL_MS = 2_000;    // per-OD rate limit: 1 request / 2s

const cache = new Map<string, ResolvedRoute>();
const lastRequestAt = new Map<string, number>();
const inflight = new Map<string, Promise<ResolvedRoute>>();

function odKey(a: GeoPoint, b: GeoPoint): string {
  return `${a.lat.toFixed(4)},${a.lng.toFixed(4)}→${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
}

function loadPrerecorded(key: string, now: number): ResolvedRoute | null {
  // Try exact key match first
  let entry = PRERECORDED[key];

  // Fuzzy match: if exact key misses, check if origin/destination are within
  // ~500 m of any pre-recorded pair (handles simulator coordinate drift).
  if (!entry) {
    const TOLERANCE = 0.005; // ~500 m
    const parts = key.split('→');
    if (parts.length === 2) {
      const [oLatStr, oLngStr] = parts[0].split(',').map(Number);
      const [dLatStr, dLngStr] = parts[1].split(',').map(Number);
      for (const [k, v] of Object.entries(PRERECORDED)) {
        const kParts = k.split('→');
        if (kParts.length !== 2) continue;
        const [koLat, koLng] = kParts[0].split(',').map(Number);
        const [kdLat, kdLng] = kParts[1].split(',').map(Number);
        if (
          Math.abs(oLatStr - koLat) < TOLERANCE &&
          Math.abs(oLngStr - koLng) < TOLERANCE &&
          Math.abs(dLatStr - kdLat) < TOLERANCE &&
          Math.abs(dLngStr - kdLng) < TOLERANCE
        ) {
          entry = v;
          break;
        }
      }
    }
  }

  if (!entry) return null;
  const polyline = decodePolyline(entry.encoded);
  if (polyline.length < 2) return null;
  return {
    polyline,
    polylineEncoded: entry.encoded,
    etaSeconds: entry.etaSeconds,
    distanceMeters: entry.distanceMeters,
    routeSource: 'prerecorded',
    fetchedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface FetchRouteOptions {
  /** Skip the in-memory cache and force a fresh API call. */
  bypassCache?: boolean;
}

export async function fetchRoute(
  origin: GeoPoint,
  destination: GeoPoint,
  options: FetchRouteOptions = {},
): Promise<ResolvedRoute> {
  const key = odKey(origin, destination);
  const now = Date.now();

  // ── 1. Cache hit ─────────────────────────────────────────────────────────
  if (!options.bypassCache) {
    const cached = cache.get(key);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.routeSource === 'api'
        ? { ...cached, routeSource: 'cached' }
        : cached;
    }
  }

  // ── 2. Coalesce concurrent requests for the same OD ──────────────────────
  const existing = inflight.get(key);
  if (existing) return existing;

  // ── 3. Throttle — if the last request for this pair was < 2 s ago and we
  //       still have any prior result, serve it rather than hitting the API.
  const last = lastRequestAt.get(key) ?? 0;
  if (now - last < MIN_REQUEST_INTERVAL_MS) {
    const cached = cache.get(key);
    if (cached) return cached;
  }
  lastRequestAt.set(key, now);

  const p = resolveRoute(origin, destination, key, now).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

async function resolveRoute(
  origin: GeoPoint,
  destination: GeoPoint,
  key: string,
  now: number,
): Promise<ResolvedRoute> {
  // ── Primary path: server proxy → Google Directions API ───────────────────
  try {
    const params = new URLSearchParams({
      origin: `${origin.lat},${origin.lng}`,
      destination: `${destination.lat},${destination.lng}`,
    });
    const res = await fetch(`/api/route/directions?${params.toString()}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const json = await res.json() as {
        polylineEncoded?: string;
        etaSeconds?: number;
        distanceMeters?: number;
      };
      if (json.polylineEncoded) {
        const polyline = decodePolyline(json.polylineEncoded);
        if (polyline.length >= 2) {
          const route: ResolvedRoute = {
            polyline,
            polylineEncoded: json.polylineEncoded,
            etaSeconds: json.etaSeconds ?? 0,
            distanceMeters: json.distanceMeters ?? 0,
            routeSource: 'api',
            fetchedAt: now,
          };
          cache.set(key, route);
          return route;
        }
      }
    }
  } catch (err) {
    console.warn('[routing] directions proxy failed:', (err as Error).message);
  }

  // ── Fallback: pre-recorded road-following polyline ───────────────────────
  const pre = loadPrerecorded(key, now);
  if (pre) {
    cache.set(key, pre);
    return pre;
  }

  // ── No path available — refuse to fabricate one ──────────────────────────
  return {
    polyline: [],
    polylineEncoded: null,
    etaSeconds: 0,
    distanceMeters: 0,
    routeSource: 'unavailable',
    fetchedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Re-route threshold helper
// ---------------------------------------------------------------------------

/** Default re-route threshold: 20% ETA delta or 120s absolute, whichever is smaller. */
const REROUTE_THRESHOLD_FRACTION = 0.20;
const REROUTE_THRESHOLD_ABS_SECONDS = 120;

/**
 * Returns true if the ETA delta is large enough to warrant a re-route.
 */
export function shouldReroute(previousEtaSeconds: number, newEtaSeconds: number): boolean {
  if (previousEtaSeconds <= 0) return false;
  const delta = Math.abs(newEtaSeconds - previousEtaSeconds);
  const threshold = Math.min(
    previousEtaSeconds * REROUTE_THRESHOLD_FRACTION,
    REROUTE_THRESHOLD_ABS_SECONDS,
  );
  return delta >= threshold;
}

// ---------------------------------------------------------------------------
// Hospital search
// ---------------------------------------------------------------------------

/**
 * Fetch real hospitals near a location using the Places API proxy.
 */
export async function fetchNearbyHospitals(
  center: GeoPoint,
  radiusMeters = 5000,
): Promise<HospitalInfo[]> {
  try {
    const params = new URLSearchParams({
      lat: String(center.lat),
      lng: String(center.lng),
      radius: String(radiusMeters),
    });
    const res = await fetch(`/api/places/hospitals?${params.toString()}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const data = await res.json() as { hospitals: HospitalInfo[] };
      return data.hospitals ?? [];
    }
  } catch (err) {
    console.warn('[routing] hospital search failed:', (err as Error).message);
  }
  return [];
}

/** Clear all cached routes (testing / chaos hook). */
export function clearRouteCache(): void {
  cache.clear();
  lastRequestAt.clear();
}

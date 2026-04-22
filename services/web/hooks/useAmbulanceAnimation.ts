'use client';

/**
 * useAmbulanceAnimation
 *
 * Keeps the ambulance marker snapped to the decoded road polyline at all times.
 *
 *   Primary  : Live GPS_UPDATE frames are projected onto the nearest polyline
 *              segment so GPS noise never drags the marker off the road.
 *
 *   Fallback : When no GPS has arrived for STALE_THRESHOLD_MS the marker
 *              advances along the polyline by distance (not by waypoint
 *              index), segment-by-segment, proportional to elapsed mission
 *              time vs etaSeconds. Monotonic — never goes backwards, never
 *              teleports.
 *
 * Off-road drift is structurally impossible: every position returned is the
 * output of a polyline projection, never a raw lat/lng.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { GeoPoint } from '../lib/types';

const STALE_THRESHOLD_MS = 2_000;
const TICK_MS = 500;
const MIN_ETA_SECONDS = 60;

// ---------------------------------------------------------------------------
// Distance helpers
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
const EARTH_M = 6_371_000;

function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG_TO_RAD) * Math.cos(b.lat * DEG_TO_RAD) *
    Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Cumulative-distance array along the polyline, in metres. */
function cumulativeDistances(polyline: GeoPoint[]): number[] {
  const cum = new Array<number>(polyline.length);
  cum[0] = 0;
  for (let i = 1; i < polyline.length; i++) {
    cum[i] = cum[i - 1] + haversineMeters(polyline[i - 1], polyline[i]);
  }
  return cum;
}

/**
 * Return the lat/lng located `targetM` metres along the polyline.
 * Walks segment-by-segment — output is always on the road path, never off it.
 */
function positionAtDistance(
  polyline: GeoPoint[],
  cum: number[],
  targetM: number,
): GeoPoint {
  const total = cum[cum.length - 1];
  if (total <= 0) return polyline[0];
  const t = Math.max(0, Math.min(total, targetM));

  // Binary search for the segment [lo, lo+1] containing `t`.
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (cum[mid] <= t) lo = mid; else hi = mid;
  }
  const segLen = cum[hi] - cum[lo];
  const frac = segLen > 0 ? (t - cum[lo]) / segLen : 0;
  const a = polyline[lo];
  const b = polyline[hi];
  return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac };
}

/**
 * Snap raw GPS to the polyline: project onto the segment with the shortest
 * perpendicular distance, and also return the distance travelled along the
 * polyline so the fallback interpolator can resume monotonically.
 */
function snapToPolyline(
  raw: GeoPoint,
  polyline: GeoPoint[],
  cum: number[],
): { pos: GeoPoint; distanceAlongM: number } {
  let bestDist2 = Infinity;
  let bestPos: GeoPoint = polyline[0];
  let bestDistanceAlongM = 0;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const abLat = b.lat - a.lat;
    const abLng = b.lng - a.lng;
    const abLen2 = abLat * abLat + abLng * abLng;
    if (abLen2 === 0) continue;

    const tRaw = ((raw.lat - a.lat) * abLat + (raw.lng - a.lng) * abLng) / abLen2;
    const t = Math.max(0, Math.min(1, tRaw));
    const proj: GeoPoint = { lat: a.lat + t * abLat, lng: a.lng + t * abLng };

    const dLat = raw.lat - proj.lat;
    const dLng = raw.lng - proj.lng;
    const d2 = dLat * dLat + dLng * dLng;
    if (d2 < bestDist2) {
      bestDist2 = d2;
      bestPos = proj;
      bestDistanceAlongM = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }

  return { pos: bestPos, distanceAlongM: bestDistanceAlongM };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface AmbulanceAnimState {
  lat: number;
  lng: number;
  /** true = driven by live GPS (snapped to road), false = polyline interpolation */
  isLive: boolean;
}

export function useAmbulanceAnimation(
  wsLat: number | null,
  wsLng: number | null,
  polyline: GeoPoint[],
  etaSeconds: number,
  startedAt: string | null | undefined,
  origin: GeoPoint | undefined,
): AmbulanceAnimState {
  const cum = useMemo(() => cumulativeDistances(polyline), [polyline]);
  const totalM = cum.length > 0 ? cum[cum.length - 1] : 0;

  const lastWsUpdateRef = useRef<number>(0);
  // Monotonic distance-travelled along the polyline (metres).
  // Fallback interpolator never decreases this; WS updates may advance it.
  const distanceAlongRef = useRef<number>(0);
  const startTimeRef = useRef<number>(
    startedAt ? new Date(startedAt).getTime() : Date.now(),
  );

  const [state, setState] = useState<AmbulanceAnimState>(() => ({
    lat: origin?.lat ?? polyline[0]?.lat ?? 0,
    lng: origin?.lng ?? polyline[0]?.lng ?? 0,
    isLive: false,
  }));

  // Reset monotonic cursor when the polyline itself changes (e.g. reroute).
  // The next GPS or tick will seed a new distanceAlong value.
  useEffect(() => {
    distanceAlongRef.current = 0;
  }, [polyline]);

  // Live GPS → snap to road + advance the monotonic cursor.
  useEffect(() => {
    if (wsLat === null || wsLng === null) return;
    if (polyline.length < 2) {
      setState({ lat: wsLat, lng: wsLng, isLive: true });
      return;
    }
    const raw: GeoPoint = { lat: wsLat, lng: wsLng };
    const { pos, distanceAlongM } = snapToPolyline(raw, polyline, cum);
    lastWsUpdateRef.current = Date.now();
    if (distanceAlongM > distanceAlongRef.current) {
      distanceAlongRef.current = distanceAlongM;
    }
    setState({ lat: pos.lat, lng: pos.lng, isLive: true });
  }, [wsLat, wsLng, polyline, cum]);

  // Fallback tick — advance along polyline by distance proportional to elapsed time.
  useEffect(() => {
    if (polyline.length < 2 || totalM <= 0) return;
    const eta = Math.max(MIN_ETA_SECONDS, etaSeconds);

    const id = setInterval(() => {
      const now = Date.now();
      if (now - lastWsUpdateRef.current < STALE_THRESHOLD_MS) return;

      const elapsedS = (now - startTimeRef.current) / 1_000;
      const progress = Math.min(1, Math.max(0, elapsedS / eta));
      const targetM = progress * totalM;

      // Monotonic — never retreat.
      if (targetM > distanceAlongRef.current) {
        distanceAlongRef.current = targetM;
      }
      const pos = positionAtDistance(polyline, cum, distanceAlongRef.current);
      setState({ lat: pos.lat, lng: pos.lng, isLive: false });
    }, TICK_MS);

    return () => clearInterval(id);
  }, [polyline, cum, totalM, etaSeconds]);

  useEffect(() => {
    if (startedAt) startTimeRef.current = new Date(startedAt).getTime();
  }, [startedAt]);

  return state;
}

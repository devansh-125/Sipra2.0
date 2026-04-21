'use client';

/**
 * useAmbulanceAnimation
 *
 * Drives the ambulance dot's on-screen position by blending two sources:
 *
 *   Primary  : Live GPS_UPDATE frames from the Go backend (useSipraWebSocket).
 *              When a new frame arrives it is snapped to the nearest polyline
 *              segment (if available) so GPS jitter never drags the marker
 *              off the road, then the deck.gl transition smooths it.
 *
 *   Fallback : If no WS update arrives within STALE_THRESHOLD_MS the hook
 *              switches to client-side interpolation along the decoded
 *              polyline, advancing proportionally to elapsed mission time
 *              vs total etaSeconds. This means the ambulance keeps moving
 *              even when the backend is offline / demo mode.
 *
 * Returns { lat, lng } — always a valid coordinate (defaults to origin).
 */

import { useEffect, useRef, useState } from 'react';
import type { GeoPoint } from '../lib/types';

const STALE_THRESHOLD_MS = 2_000; // Switch to interpolation after 2 s of silence
const TICK_MS = 500;              // Interpolation update rate
const MIN_ETA_SECONDS = 60;       // Guard against 0-ETA edge case

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Find position along the polyline for a given progress ratio [0..1]. */
function positionOnPolyline(polyline: GeoPoint[], t: number): GeoPoint {
  if (polyline.length === 0) return { lat: 0, lng: 0 };
  if (polyline.length === 1) return polyline[0];

  const clamped = Math.max(0, Math.min(1, t));
  if (clamped >= 1) return polyline[polyline.length - 1];
  if (clamped <= 0) return polyline[0];

  // Distribute progress evenly across segments.
  const segment = clamped * (polyline.length - 1);
  const idx = Math.floor(segment);
  const frac = segment - idx;
  const a = polyline[idx];
  const b = polyline[idx + 1];
  return { lat: lerp(a.lat, b.lat, frac), lng: lerp(a.lng, b.lng, frac) };
}

/**
 * Project a raw GPS point onto the nearest segment of the route polyline.
 * This keeps the ambulance marker on the road even when the raw GPS signal
 * drifts slightly off to the side (common with phone/hardware GPS noise).
 *
 * Uses a 2-D perpendicular-distance projection in lat/lng space. Precision
 * is sufficient for sub-50m snapping at Bangalore latitudes.
 */
function snapToPolyline(raw: GeoPoint, polyline: GeoPoint[]): GeoPoint {
  if (polyline.length < 2) return raw;

  let bestDist = Infinity;
  let bestPt: GeoPoint = raw;

  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];

    const abLat  = b.lat - a.lat;
    const abLng  = b.lng - a.lng;
    const abLen2 = abLat * abLat + abLng * abLng;

    if (abLen2 === 0) continue; // degenerate zero-length segment

    // Scalar projection of (raw - a) onto AB, clamped to segment [0, 1]
    const t = Math.max(0, Math.min(1,
      ((raw.lat - a.lat) * abLat + (raw.lng - a.lng) * abLng) / abLen2,
    ));

    const proj: GeoPoint = { lat: a.lat + t * abLat, lng: a.lng + t * abLng };
    const dLat = raw.lat - proj.lat;
    const dLng = raw.lng - proj.lng;
    const dist = dLat * dLat + dLng * dLng;

    if (dist < bestDist) {
      bestDist = dist;
      bestPt   = proj;
    }
  }

  return bestPt;
}

export interface AmbulanceAnimState {
  lat: number;
  lng: number;
  /** true = live GPS (snapped to road), false = polyline-interpolated */
  isLive: boolean;
}

export function useAmbulanceAnimation(
  /** Live GPS from useSipraWebSocket. null = no data yet. */
  wsLat: number | null,
  wsLng: number | null,
  /** Decoded road-geometry waypoints. May be empty while loading. */
  polyline: GeoPoint[],
  /** Traffic-aware ETA for the full route (seconds). */
  etaSeconds: number,
  /** RFC3339 timestamp the mission started (trip.started_at). */
  startedAt: string | null | undefined,
  /** Fallback origin for before we have any data. */
  origin: GeoPoint | undefined,
): AmbulanceAnimState {
  const lastWsUpdateRef = useRef<number>(0);
  const startTimeRef    = useRef<number>(
    startedAt ? new Date(startedAt).getTime() : Date.now(),
  );

  const [state, setState] = useState<AmbulanceAnimState>(() => ({
    lat: origin?.lat ?? 0,
    lng: origin?.lng ?? 0,
    isLive: false,
  }));

  // When the WS position updates, snap it to the route polyline (if loaded)
  // then record the time and update state.
  useEffect(() => {
    if (wsLat === null || wsLng === null) return;
    lastWsUpdateRef.current = Date.now();
    const raw: GeoPoint = { lat: wsLat, lng: wsLng };
    const snapped = polyline.length >= 2 ? snapToPolyline(raw, polyline) : raw;
    setState({ lat: snapped.lat, lng: snapped.lng, isLive: true });
  }, [wsLat, wsLng, polyline]);

  // Tick: if WS data has gone stale, interpolate along the polyline.
  useEffect(() => {
    if (polyline.length < 2) return;

    const effectiveEta = Math.max(MIN_ETA_SECONDS, etaSeconds);

    const id = setInterval(() => {
      const now = Date.now();
      const age = now - lastWsUpdateRef.current;
      if (age < STALE_THRESHOLD_MS) return; // WS is fresh — leave it alone

      // Use startedAt if available, otherwise assume we started at mount.
      const elapsedS = (now - startTimeRef.current) / 1_000;
      const progress = Math.min(1, elapsedS / effectiveEta);
      const pos = positionOnPolyline(polyline, progress);
      setState({ lat: pos.lat, lng: pos.lng, isLive: false });
    }, TICK_MS);

    return () => clearInterval(id);
  }, [polyline, etaSeconds]);

  // Update start-time ref if startedAt changes.
  useEffect(() => {
    if (startedAt) startTimeRef.current = new Date(startedAt).getTime();
  }, [startedAt]);

  return state;
}

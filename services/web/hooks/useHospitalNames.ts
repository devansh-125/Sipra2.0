'use client';

/**
 * useHospitalNames
 *
 * Resolves human-readable hospital names for the origin and destination
 * GeoPoints. Results are cached by lat,lng key so repeated renders don't
 * re-fetch.
 *
 * Resolution order (per point):
 *   1. /api/places/nearby proxy → Places Nearby Search ("hospital" type, 300 m radius)
 *   2. /api/places/nearby proxy → Geocoding reverse-lookup
 *   3. Static fallback strings ("Pickup Hospital" / "Destination Hospital")
 *
 * Returns { originName, destinationName } — always strings (never null),
 * starting as fallback labels until the async calls resolve.
 */

import { useEffect, useRef, useState } from 'react';
import type { GeoPoint } from '../lib/types';

export interface HospitalNames {
  originName: string;
  destinationName: string;
}

const DEFAULT_NAMES: HospitalNames = {
  originName: 'Pickup Hospital',
  destinationName: 'Destination Hospital',
};

/** In-memory cache: "lat,lng" → resolved name string */
const nameCache = new Map<string, string>();

// Per-point sentinel so we can invalidate the cached fallback when the caller
// supplies a better default (e.g. the first call used 'Pickup Hospital' but
// the next should use 'Medanta').
const nameCacheFallback = new Map<string, string>();

async function resolveHospitalName(
  point: GeoPoint,
  fallback: string,
): Promise<string> {
  const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;

  // If the cached value was only a fallback sentinel AND the caller now provides
  // a better fallback, evict so we can try the API again (or return the better label).
  if (nameCache.has(key) && nameCacheFallback.get(key) === nameCache.get(key)) {
    if (fallback !== nameCacheFallback.get(key)) {
      nameCache.delete(key);
      nameCacheFallback.delete(key);
    } else {
      return nameCache.get(key)!;
    }
  } else if (nameCache.has(key)) {
    return nameCache.get(key)!;
  }

  try {
    const params = new URLSearchParams({
      lat: String(point.lat),
      lng: String(point.lng),
      type: 'hospital',
    });
    const res = await fetch(`/api/places/nearby?${params.toString()}`, {
      signal: AbortSignal.timeout(6_000),
    });

    if (res.ok) {
      const data = await res.json() as { name: string | null; address?: string | null };
      if (data.name) {
        nameCache.set(key, data.name);
        return data.name;
      }
    }
  } catch (err) {
    console.warn('[useHospitalNames] lookup failed for', key, err);
  }

  // Fallback — cache it and record it was a fallback so callers with a better
  // label can evict it on the next render cycle.
  nameCache.set(key, fallback);
  nameCacheFallback.set(key, fallback);
  return fallback;
}

export function useHospitalNames(
  origin: GeoPoint | undefined,
  destination: GeoPoint | undefined,
  fallbacks: HospitalNames = DEFAULT_NAMES,
): HospitalNames {
  const [names, setNames] = useState<HospitalNames>(fallbacks);

  // Track which origin/dest key we last resolved to avoid duplicate fetches.
  const resolvedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!origin || !destination) return;

    const key = `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}→${destination.lat.toFixed(5)},${destination.lng.toFixed(5)}`;
    if (resolvedKeyRef.current === key) return;
    resolvedKeyRef.current = key;

    let cancelled = false;

    Promise.all([
      resolveHospitalName(origin,      fallbacks.originName),
      resolveHospitalName(destination, fallbacks.destinationName),
    ]).then(([originName, destinationName]) => {
      if (!cancelled) setNames({ originName, destinationName });
    });

    return () => { cancelled = true; };
  // fallbacks is stable (object literal at call-site) — spread to avoid
  // referential-equality churn while still reacting to value changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [origin, destination, fallbacks.originName, fallbacks.destinationName]);

  return names;
}

'use client';

/**
 * useMissionRoute
 *
 * Resolves a Google Maps road-geometry route for the current mission and keeps
 * it in sync as the mission progresses.
 *
 * Responsibilities:
 *   - Initial fetch on origin/destination change
 *   - Expose `reroute()` — recomputes with bypassCache to pick up traffic or blockage changes
 *   - Auto-reroute when ETA delta exceeds threshold (periodic check every 60s)
 *   - Expose `simulateBlockage()` — triggers an immediate re-route for demo/chaos purposes
 *   - Track loading state and last-fetched timestamp
 *   - Pure pass-through to lib/routing (which owns caching + throttling)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchRoute, shouldReroute, type ResolvedRoute, type RouteSource } from '../lib/routing';
import type { GeoPoint } from '../lib/types';

const REROUTE_CHECK_INTERVAL_MS = 60_000; // check for ETA-delta re-routing every 60s

export interface MissionRouteState {
  polyline: GeoPoint[];
  etaSeconds: number;
  distanceMeters: number;
  routeSource: RouteSource;
  /** True while an API request is in flight. */
  isRerouting: boolean;
  /** Force a fresh route. `reason` is logged but does not affect the request. */
  reroute: (reason?: string) => Promise<void>;
  /** Simulate a blockage — triggers immediate re-route. */
  simulateBlockage: () => Promise<void>;
  /** Epoch ms the current route was last resolved. null = no resolution yet. */
  lastFetchedAt: number | null;
}

const INITIAL: Omit<MissionRouteState, 'reroute' | 'simulateBlockage'> = {
  polyline: [],
  etaSeconds: 0,
  distanceMeters: 0,
  routeSource: 'loading',
  isRerouting: false,
  lastFetchedAt: null,
};

export function useMissionRoute(
  origin: GeoPoint | undefined,
  destination: GeoPoint | undefined,
): MissionRouteState {
  const [state, setState] = useState<Omit<MissionRouteState, 'reroute' | 'simulateBlockage'>>(INITIAL);

  // Track current OD so reroute() uses the latest values.
  const odRef = useRef<{ origin: GeoPoint | undefined; destination: GeoPoint | undefined }>({
    origin, destination,
  });
  odRef.current = { origin, destination };

  // Track the OD we last fetched for so origin/destination updates don't double-fetch.
  const fetchedKeyRef = useRef<string | null>(null);

  // Track previous ETA for delta-based rerouting
  const previousEtaRef = useRef<number>(0);

  const applyResult = useCallback((r: ResolvedRoute) => {
    setState({
      polyline: r.polyline,
      etaSeconds: r.etaSeconds,
      distanceMeters: r.distanceMeters,
      routeSource: r.routeSource,
      isRerouting: false,
      lastFetchedAt: r.fetchedAt,
    });
    previousEtaRef.current = r.etaSeconds;
  }, []);

  // Initial fetch + refetch on OD change
  useEffect(() => {
    if (!origin || !destination) return;
    const key = `${origin.lat},${origin.lng}→${destination.lat},${destination.lng}`;
    if (fetchedKeyRef.current === key) return;
    fetchedKeyRef.current = key;

    let cancelled = false;
    setState((s) => ({ ...s, isRerouting: true }));
    fetchRoute(origin, destination).then((r) => {
      if (!cancelled) applyResult(r);
    });
    return () => { cancelled = true; };
  }, [origin, destination, applyResult]);

  // Periodic ETA-delta re-routing check
  useEffect(() => {
    if (!origin || !destination) return;

    const id = setInterval(async () => {
      const { origin: o, destination: d } = odRef.current;
      if (!o || !d) return;

      try {
        const fresh = await fetchRoute(o, d, { bypassCache: true });
        if (shouldReroute(previousEtaRef.current, fresh.etaSeconds)) {
          console.info('[useMissionRoute] auto-reroute: ETA delta exceeded threshold',
            { previous: previousEtaRef.current, new: fresh.etaSeconds });
          applyResult(fresh);
        }
      } catch (err) {
        console.warn('[useMissionRoute] periodic check failed:', err);
      }
    }, REROUTE_CHECK_INTERVAL_MS);

    return () => clearInterval(id);
  }, [origin, destination, applyResult]);

  const reroute = useCallback(async (reason?: string) => {
    const { origin: o, destination: d } = odRef.current;
    if (!o || !d) return;
    if (reason) console.info('[useMissionRoute] reroute:', reason);
    setState((s) => ({ ...s, isRerouting: true }));
    const r = await fetchRoute(o, d, { bypassCache: true });
    applyResult(r);
  }, [applyResult]);

  const simulateBlockage = useCallback(async () => {
    console.info('[useMissionRoute] blockage simulated — forcing re-route');
    await reroute('blockage-simulated');
  }, [reroute]);

  return { ...state, reroute, simulateBlockage };
}

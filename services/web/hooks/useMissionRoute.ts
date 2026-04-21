'use client';

/**
 * useMissionRoute
 *
 * Fetches a traffic-aware hospital-to-hospital route via the Directions API
 * proxy the first time origin + destination are both defined.
 *
 * Returns:
 *   polyline      — decoded road-geometry waypoints ([] while loading)
 *   etaSeconds    — traffic-aware ETA (0 while loading)
 *   routeSource   — 'api' | 'simulation' | 'loading'
 */

import { useEffect, useRef, useState } from 'react';
import { fetchRoute, type ResolvedRoute, type RouteSource } from '../lib/routing';
import type { GeoPoint } from '../lib/types';

export interface MissionRouteState {
  polyline: GeoPoint[];
  etaSeconds: number;
  routeSource: RouteSource;
}

const LOADING: MissionRouteState = {
  polyline: [],
  etaSeconds: 0,
  routeSource: 'loading',
};

export function useMissionRoute(
  origin: GeoPoint | undefined,
  destination: GeoPoint | undefined,
): MissionRouteState {
  const [state, setState] = useState<MissionRouteState>(LOADING);
  // Track the key we last fetched to avoid duplicate requests.
  const fetchedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!origin || !destination) return;

    const key = `${origin.lat},${origin.lng}→${destination.lat},${destination.lng}`;
    if (fetchedKeyRef.current === key) return; // already fetched for this O/D pair
    fetchedKeyRef.current = key;

    let cancelled = false;
    setState(LOADING);

    fetchRoute(origin, destination).then((route: ResolvedRoute) => {
      if (cancelled) return;
      setState({
        polyline: route.polyline,
        etaSeconds: route.etaSeconds,
        routeSource: route.routeSource,
      });
    });

    return () => { cancelled = true; };
  }, [origin, destination]);

  return state;
}

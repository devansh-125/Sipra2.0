'use client';

/**
 * useCorridorGeometry
 *
 * Memoized hook that converts a route polyline into a road-aligned buffered
 * GeoJSON Polygon corridor.
 *
 * Only builds a corridor when a real road-geometry polyline (≥ 2 points) is
 * available. NEVER fabricates a straight-line corridor — returns null instead.
 *
 * The same shape is used in:
 *   - Mission Control map (ExclusionPolygon layer)
 *   - Driver POV overlay (ExclusionPolygon layer + ProximityAlert)
 *   - DriverShell mobile view (ExclusionPolygon layer + zone detection)
 */

import { useMemo } from 'react';
import type { Polygon } from 'geojson';
import { buildCorridorPolygon } from '../lib/corridorGeometry';
import type { GeoPoint } from '../lib/types';

export const DEFAULT_BUFFER_M = 75;

export function useCorridorGeometry(
  polyline: GeoPoint[],
  bufferMeters: number = DEFAULT_BUFFER_M,
  _origin?: GeoPoint,
  _destination?: GeoPoint,
): Polygon | null {
  return useMemo(() => {
    // Only build corridor from real road-geometry polyline.
    // NEVER fabricate a straight-line corridor from origin/destination.
    if (polyline.length >= 2) {
      return buildCorridorPolygon(polyline, bufferMeters);
    }

    return null;
  }, [polyline, bufferMeters]);
}

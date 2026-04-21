'use client';

/**
 * useCorridorGeometry
 *
 * Memoized hook that converts a route polyline into a road-aligned buffered
 * GeoJSON Polygon corridor.
 *
 * Priority:
 *   1. If polyline >= 2 points → build a real road-geometry corridor.
 *   2. If origin + destination provided but no polyline → build a simulated
 *      straight-line corridor (demo fallback).
 *   3. Otherwise → null.
 *
 * The same shape is used in:
 *   - Mission Control map (ExclusionPolygon layer)
 *   - Driver POV overlay (ExclusionPolygon layer + ProximityAlert)
 *   - DriverShell mobile view (ExclusionPolygon layer + zone detection)
 */

import { useMemo } from 'react';
import type { Polygon } from 'geojson';
import { buildCorridorPolygon, buildSimulatedCorridor } from '../lib/corridorGeometry';
import type { GeoPoint } from '../lib/types';

export const DEFAULT_BUFFER_M = 75;

export function useCorridorGeometry(
  polyline: GeoPoint[],
  bufferMeters: number = DEFAULT_BUFFER_M,
  origin?: GeoPoint,
  destination?: GeoPoint,
): Polygon | null {
  return useMemo(() => {
    // ── Path 1: Real road polyline ──────────────────────────────────────────
    if (polyline.length >= 2) {
      return buildCorridorPolygon(polyline, bufferMeters);
    }

    // ── Path 2: Simulated fallback (straight line) ──────────────────────────
    if (origin && destination) {
      return buildSimulatedCorridor(origin, destination, bufferMeters);
    }

    return null;
  }, [polyline, bufferMeters, origin, destination]);
}

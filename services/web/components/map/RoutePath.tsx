import { useMemo } from 'react';
import { PathLayer } from '@deck.gl/layers';
import type { GeoPoint } from '../../lib/types';

// ---------------------------------------------------------------------------
// Dashed straight-line fallback (used when no real polyline is available)
// ---------------------------------------------------------------------------

interface DashSegment {
  path: [[number, number], [number, number]];
}

function dashSegments(a: GeoPoint, b: GeoPoint, n = 20): DashSegment[] {
  const segments: DashSegment[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    if (i % 2 === 0) {
      segments.push({
        path: [
          [a.lng + (b.lng - a.lng) * t0, a.lat + (b.lat - a.lat) * t0],
          [a.lng + (b.lng - a.lng) * t1, a.lat + (b.lat - a.lat) * t1],
        ],
      });
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Real road-geometry layer (used when a decoded polyline is available)
// ---------------------------------------------------------------------------

interface RoadSegment {
  path: [number, number][];
}

function roadSegments(polyline: GeoPoint[]): RoadSegment[] {
  if (polyline.length < 2) return [];
  return [{ path: polyline.map(p => [p.lng, p.lat]) }];
}

// ---------------------------------------------------------------------------
// Hook — picks the right layer depending on what data is available
// ---------------------------------------------------------------------------

export function useRoutePathLayer(
  origin: GeoPoint | undefined,
  destination: GeoPoint | undefined,
  /** Decoded road-geometry waypoints from the Directions API. */
  polyline?: GeoPoint[],
): PathLayer<DashSegment> | PathLayer<RoadSegment> | null {
  return useMemo(() => {
    // ── Real road-geometry path ──────────────────────────────────────────
    if (polyline && polyline.length >= 2) {
      return new PathLayer<RoadSegment>({
        id: 'route-path',
        data: roadSegments(polyline),
        getPath: (d) => d.path,
        // Solid blue road line
        getColor: [96, 165, 250, 220],
        getWidth: 5,
        widthUnits: 'pixels',
        capRounded: true,
        jointRounded: true,
        pickable: false,
      });
    }

    // ── Straight-line dashed fallback ────────────────────────────────────
    if (!origin || !destination) return null;
    return new PathLayer<DashSegment>({
      id: 'route-path',
      data: dashSegments(origin, destination),
      getPath: (d) => d.path,
      getColor: [96, 165, 250, 160],
      getWidth: 4,
      widthUnits: 'pixels',
      pickable: false,
    });
  }, [origin, destination, polyline]);
}


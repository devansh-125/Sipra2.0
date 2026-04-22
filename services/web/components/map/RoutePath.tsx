import { useMemo } from 'react';
import { PathLayer } from '@deck.gl/layers';
import type { GeoPoint } from '../../lib/types';

// ---------------------------------------------------------------------------
// Road-geometry layer — renders the decoded Directions API polyline.
// No straight-line fallback — if no polyline is available, nothing is drawn.
// ---------------------------------------------------------------------------

interface RoadSegment {
  path: [number, number][];
}

function roadSegments(polyline: GeoPoint[]): RoadSegment[] {
  if (polyline.length < 2) return [];
  return [{ path: polyline.map(p => [p.lng, p.lat]) }];
}

// ---------------------------------------------------------------------------
// Hook — renders the road-following route or nothing at all
// ---------------------------------------------------------------------------

export function useRoutePathLayer(
  _origin: GeoPoint | undefined,
  _destination: GeoPoint | undefined,
  /** Decoded road-geometry waypoints from the Directions API. */
  polyline?: GeoPoint[],
): PathLayer<RoadSegment> | null {
  return useMemo(() => {
    // Only render when we have a real road-geometry polyline (≥ 2 points).
    // NEVER fabricate a straight-line fallback.
    if (!polyline || polyline.length < 2) return null;

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
  }, [polyline]);
}

import { useMemo } from 'react';
import { PathLayer } from '@deck.gl/layers';
import type { GeoPoint } from '../../lib/types';

interface DashSegment {
  path: [[number, number], [number, number]];
}

function dashSegments(a: GeoPoint, b: GeoPoint, n = 20): DashSegment[] {
  const segments: DashSegment[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    // Emit only every other segment to create a dashed appearance.
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

export function useRoutePathLayer(
  origin: GeoPoint | undefined,
  destination: GeoPoint | undefined,
): PathLayer<DashSegment> | null {
  return useMemo(() => {
    if (!origin || !destination) return null;
    return new PathLayer<DashSegment>({
      id: 'route-path',
      data: dashSegments(origin, destination),
      getPath: (d) => d.path,
      getColor: [96, 165, 250, 200],
      getWidth: 4,
      widthUnits: 'pixels',
      pickable: false,
    });
  }, [origin, destination]);
}

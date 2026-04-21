import { useMemo } from 'react';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import type { Geometry, MultiPolygon, Point, Polygon, Position } from 'geojson';

export type ProximityState = 'NORMAL' | 'INSIDE_ZONE';

export interface DriverProximityResult {
  state: ProximityState;
  distanceToEdgeM: number | null;
}

interface LatLng {
  lat: number;
  lng: number;
}

// Local ENU (equirectangular) projection — accurate within <10 km scale,
// which is well within the 2 km corridor we're measuring against.
function pointToSegmentMeters(
  p: LatLng,
  a: Position,
  b: Position,
): number {
  const latRad = (p.lat * Math.PI) / 180;
  const mPerLat = 111_132;
  const mPerLng = 111_132 * Math.cos(latRad);
  const px = p.lng * mPerLng;
  const py = p.lat * mPerLat;
  const ax = a[0] * mPerLng;
  const ay = a[1] * mPerLat;
  const bx = b[0] * mPerLng;
  const by = b[1] * mPerLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq)) : 0;
  const fx = ax + t * dx;
  const fy = ay + t * dy;
  return Math.hypot(px - fx, py - fy);
}

export function useDriverProximity(
  corridorGeoJSON: Geometry | null,
  position: LatLng,
): DriverProximityResult {
  return useMemo(() => {
    if (
      corridorGeoJSON === null ||
      (corridorGeoJSON.type !== 'Polygon' && corridorGeoJSON.type !== 'MultiPolygon')
    ) {
      return { state: 'NORMAL', distanceToEdgeM: null };
    }

    const pt: Point = { type: 'Point', coordinates: [position.lng, position.lat] };

    const inside = booleanPointInPolygon(pt, corridorGeoJSON as Polygon | MultiPolygon);

    const rings: Position[][] =
      corridorGeoJSON.type === 'Polygon'
        ? (corridorGeoJSON as Polygon).coordinates
        : (corridorGeoJSON as MultiPolygon).coordinates.flat(1);

    let minDistM: number | null = null;
    for (const ring of rings) {
      for (let i = 0; i < ring.length - 1; i++) {
        const d = pointToSegmentMeters(position, ring[i], ring[i + 1]);
        if (minDistM === null || d < minDistM) minDistM = d;
      }
    }

    return { state: inside ? 'INSIDE_ZONE' : 'NORMAL', distanceToEdgeM: minDistM };
  }, [corridorGeoJSON, position.lat, position.lng]);
}

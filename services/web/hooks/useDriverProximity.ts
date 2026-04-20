import { useMemo } from 'react';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import distance from '@turf/distance';
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
      for (const v of ring) {
        const d = distance(pt, { type: 'Point', coordinates: [v[0], v[1]] } as Point, {
          units: 'meters',
        });
        if (minDistM === null || d < minDistM) {
          minDistM = d;
        }
      }
    }

    return { state: inside ? 'INSIDE_ZONE' : 'NORMAL', distanceToEdgeM: minDistM };
  }, [corridorGeoJSON, position.lat, position.lng]);
}

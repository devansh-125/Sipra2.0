'use client';

import { useMemo } from 'react';
import { PathLayer } from '@deck.gl/layers';
import type { Geometry, Polygon, MultiPolygon } from 'geojson';

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '../ui/sheet';
import { Button } from '../ui/button';

interface LatLng {
  lat: number;
  lng: number;
}

type Coord = [number, number];

function nearestRingVertex(
  corridorGeoJSON: Geometry,
  driverPosition: LatLng,
): Coord | null {
  const rings =
    corridorGeoJSON.type === 'Polygon'
      ? (corridorGeoJSON as Polygon).coordinates
      : (corridorGeoJSON as MultiPolygon).coordinates.flat(1);

  const dpLng = driverPosition.lng;
  const dpLat = driverPosition.lat;
  let nearest: Coord | null = null;
  let minDist = Infinity;

  for (const ring of rings) {
    for (const v of ring) {
      const dx = v[0] - dpLng;
      const dy = v[1] - dpLat;
      const d = dx * dx + dy * dy;
      if (d < minDist) {
        minDist = d;
        nearest = [v[0], v[1]];
      }
    }
  }

  return nearest;
}

const CARDINAL = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

export function exitDirectionLabel(
  corridorGeoJSON: Geometry | null,
  driverPosition: LatLng,
): string {
  if (!corridorGeoJSON) return '';
  if (corridorGeoJSON.type !== 'Polygon' && corridorGeoJSON.type !== 'MultiPolygon') return '';

  const target = nearestRingVertex(corridorGeoJSON, driverPosition);
  if (!target) return '';

  const dLng = (target as Coord)[0] - driverPosition.lng;
  const dLat = (target as Coord)[1] - driverPosition.lat;
  const angleDeg = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  const normalized = ((angleDeg % 360) + 360) % 360;
  const dir = CARDINAL[Math.round(normalized / 45) % 8];

  const distM = Math.round(
    Math.sqrt(
      Math.pow(dLat * 111320, 2) +
        Math.pow(dLng * 111320 * Math.cos((driverPosition.lat * Math.PI) / 180), 2),
    ),
  );

  return `Head ~${dir} — approx. ${distM}m to exit the corridor`;
}

/**
 * Generates dashed segments along a path for visual distinction.
 * Returns alternating segments so the path appears as a dashed line.
 */
function dashedPath(from: Coord, to: Coord, segments: number = 12): { path: Coord[] }[] {
  const result: { path: Coord[] }[] = [];
  for (let i = 0; i < segments; i++) {
    // Only emit odd segments (dashes), skip even (gaps)
    if (i % 2 === 0) {
      const t0 = i / segments;
      const t1 = (i + 1) / segments;
      const p0: Coord = [
        from[0] + (to[0] - from[0]) * t0,
        from[1] + (to[1] - from[1]) * t0,
      ];
      const p1: Coord = [
        from[0] + (to[0] - from[0]) * t1,
        from[1] + (to[1] - from[1]) * t1,
      ];
      result.push({ path: [p0, p1] });
    }
  }
  return result;
}

export function useExitPathLayer(
  corridorGeoJSON: Geometry | null,
  driverPosition: LatLng,
  active: boolean,
  targetOverride?: LatLng,
): PathLayer<{ path: Coord[] }> | null {
  return useMemo(() => {
    if (!active) return null;

    let target: Coord;
    if (targetOverride) {
      target = [targetOverride.lng, targetOverride.lat];
    } else {
      if (!corridorGeoJSON) return null;
      if (corridorGeoJSON.type !== 'Polygon' && corridorGeoJSON.type !== 'MultiPolygon') return null;
      const v = nearestRingVertex(corridorGeoJSON, driverPosition);
      if (!v) return null;
      target = v;
    }

    const dp: Coord = [driverPosition.lng, driverPosition.lat];
    const segments = dashedPath(dp, target);

    // Cyan/teal color — distinct from original blue route [96,165,250]
    // and from the red exclusion zone
    return new PathLayer<{ path: Coord[] }>({
      id: 'exit-route',
      data: segments,
      getPath: d => d.path,
      getColor: [0, 210, 190, 255], // Teal/cyan
      getWidth: 5,
      widthUnits: 'pixels',
      capRounded: true,
      pickable: false,
    });
  }, [active, corridorGeoJSON, driverPosition.lat, driverPosition.lng, targetOverride]);
}

interface ExitRouteCardProps {
  open: boolean;
  onDismiss: () => void;
  directionLabel: string;
  targetOverride?: LatLng;
}

export function ExitRouteCard({ open, onDismiss, directionLabel, targetOverride }: ExitRouteCardProps) {
  const isCheckpoint = targetOverride !== undefined;
  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onDismiss(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader className="mb-4">
          <SheetTitle>
            {isCheckpoint ? 'Bounty Checkpoint' : 'Exit Route'}
          </SheetTitle>
          <SheetDescription>
            {isCheckpoint
              ? 'Follow the teal line to reach your bounty checkpoint and earn 50 points.'
              : 'The map shows the nearest exit path. Follow the teal line to clear the ambulance corridor.'}
          </SheetDescription>
        </SheetHeader>
        {directionLabel ? (
          <p className="text-sm font-medium text-foreground mb-6">{directionLabel}</p>
        ) : (
          <p className="text-sm text-muted-foreground mb-6">Calculating route…</p>
        )}
        <SheetFooter>
          <Button onClick={onDismiss} className="w-full" size="lg">
            Got it
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

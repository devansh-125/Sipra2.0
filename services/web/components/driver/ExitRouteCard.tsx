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

export function useExitPathLayer(
  corridorGeoJSON: Geometry | null,
  driverPosition: LatLng,
  active: boolean,
): PathLayer<{ path: Coord[] }> | null {
  return useMemo(() => {
    if (!active || !corridorGeoJSON) return null;
    if (corridorGeoJSON.type !== 'Polygon' && corridorGeoJSON.type !== 'MultiPolygon') return null;

    const target = nearestRingVertex(corridorGeoJSON, driverPosition);
    if (!target) return null;

    const dp: Coord = [driverPosition.lng, driverPosition.lat];
    return new PathLayer<{ path: Coord[] }>({
      id: 'exit-route',
      data: [{ path: [dp, target] }],
      getPath: d => d.path,
      getColor: [34, 197, 94, 255],
      getWidth: 4,
      widthUnits: 'pixels',
      capRounded: true,
      pickable: false,
    });
  }, [active, corridorGeoJSON, driverPosition.lat, driverPosition.lng]);
}

interface ExitRouteCardProps {
  open: boolean;
  onDismiss: () => void;
  directionLabel: string;
}

export function ExitRouteCard({ open, onDismiss, directionLabel }: ExitRouteCardProps) {
  return (
    <Sheet open={open} onOpenChange={v => { if (!v) onDismiss(); }}>
      <SheetContent side="bottom" className="rounded-t-2xl">
        <SheetHeader className="mb-4">
          <SheetTitle>Exit Route</SheetTitle>
          <SheetDescription>
            The map shows the nearest exit path in green. Follow the line to clear the
            ambulance corridor.
          </SheetDescription>
        </SheetHeader>
        {directionLabel ? (
          <p className="text-sm font-medium text-foreground mb-6">{directionLabel}</p>
        ) : (
          <p className="text-sm text-muted-foreground mb-6">Calculating nearest exit…</p>
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

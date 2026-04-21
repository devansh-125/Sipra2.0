'use client';

import { useMemo } from 'react';
import { ScatterplotLayer, IconLayer } from '@deck.gl/layers';
import type { CompositeLayer } from '@deck.gl/core';
import type { FleetVehicle } from '../../lib/types';

// Ease-out quad: decelerates at the end of each position transition so car
// movement looks like braking rather than an abrupt stop.
const easeOut = (t: number): number => t * (2 - t);

/**
 * Resolves fill and line colours from the vehicle's reroute_status.
 * Priority: reroute_status > evading flag > default blue.
 */
function vehicleFillColor(v: FleetVehicle): [number, number, number, number] {
  if (v.reroute_status === 'completed') return [34, 197, 94, 230];   // green
  if (v.reroute_status === 'failed')    return [239, 68, 68, 230];   // red
  if (v.reroute_status === 'rerouting') return [255, 165, 0, 230];   // amber
  if (v.evading)                        return [255, 165, 0, 230];   // amber (legacy)
  return [30, 120, 255, 200]; // default blue
}

function vehicleLineColor(v: FleetVehicle): [number, number, number, number] {
  if (v.reroute_status === 'completed') return [74, 222, 128, 255];  // green ring
  if (v.reroute_status === 'failed')    return [252, 100, 100, 255]; // red ring
  if (v.reroute_status === 'rerouting') return [255, 200, 0, 255];   // amber ring
  if (v.evading)                        return [255, 200, 0, 255];   // amber ring (legacy)
  return [80, 160, 255, 180]; // default blue ring
}

function vehicleRadius(v: FleetVehicle): number {
  if (v.reroute_status === 'completed') return 16;
  if (v.reroute_status === 'failed')    return 14;
  if (v.reroute_status === 'rerouting') return 18;
  if (v.evading)                        return 18;
  return 10;
}

function vehicleLineWidth(v: FleetVehicle): number {
  if (v.reroute_status) return 3;
  if (v.evading) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Minimal inline SVG arrow icon (pointing north = 0°).
// deck.gl IconLayer rotates it by `getAngle` (clockwise degrees).
// We encode it as a data-URI so we don't need an external file.
// ---------------------------------------------------------------------------
const ARROW_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <polygon points="12,2 20,20 12,16 4,20" fill="white" fill-opacity="0.95"/>
</svg>`.trim();

const ARROW_ICON_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ARROW_ICON_SVG)}`;

// Shared icon atlas — a single icon mapped to the full texture.
const ICON_MAPPING = {
  arrow: { x: 0, y: 0, width: 24, height: 24, anchorY: 12, mask: false },
};

/**
 * Returns TWO deck.gl layers representing the partner fleet:
 *
 *  1. **ScatterplotLayer** — filled circle with status-driven colour/size.
 *  2. **IconLayer** — small directional arrow rotated by `heading_deg`.
 *
 * Both layers share the same data array and position accessor so they
 * always render together.  The arrow is omitted for vehicles without
 * `heading_deg` (undefined → angle 0 pointing north, visually acceptable).
 *
 * Status colours:
 *   - rerouting  → amber
 *   - completed  → green
 *   - failed     → red
 *   - default    → blue
 */
export function useFleetLayer(
  vehicles: FleetVehicle[],
): [ScatterplotLayer<FleetVehicle>, IconLayer<FleetVehicle>] {
  const updateTriggers = useMemo(
    () => vehicles.map(v => `${v.evading}-${v.reroute_status ?? ''}-${v.heading_deg ?? 0}`),
    [vehicles],
  );

  const circleLayer = useMemo(
    () =>
      new ScatterplotLayer<FleetVehicle>({
        id: 'fleet-swarm-circles',
        data: vehicles,
        getPosition: v => [v.lng, v.lat],
        getRadius: v => vehicleRadius(v),
        getFillColor: v => vehicleFillColor(v),
        getLineColor: v => vehicleLineColor(v),
        getLineWidth: v => vehicleLineWidth(v),
        lineWidthUnits: 'pixels',
        radiusUnits: 'pixels',
        stroked: true,
        pickable: true,
        // Smooth visual transitions when the simulator pushes coordinate/state updates.
        transitions: {
          getPosition: { duration: 350, easing: easeOut },
          getFillColor: { duration: 200 },
          getRadius:    { duration: 200 },
        },
        updateTriggers: {
          getRadius:    updateTriggers,
          getFillColor: updateTriggers,
          getLineColor: updateTriggers,
          getLineWidth: updateTriggers,
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vehicles],
  );

  const arrowLayer = useMemo(
    () =>
      new IconLayer<FleetVehicle>({
        id: 'fleet-swarm-arrows',
        data: vehicles,
        iconAtlas: ARROW_ICON_DATA_URL,
        iconMapping: ICON_MAPPING,
        getIcon: () => 'arrow',
        getPosition: v => [v.lng, v.lat],
        getSize: v => {
          // Scale arrow with circle radius so they visually track together
          return vehicleRadius(v) + 4;
        },
        sizeUnits: 'pixels',
        // deck.gl IconLayer: getAngle is CLOCKWISE from north (same as heading_deg)
        getAngle: v => v.heading_deg ?? 0,
        // Tint the arrow to match the vehicle's state colour so it's readable
        getColor: v => {
          const [r, g, b] = vehicleFillColor(v);
          // Slightly brighter version of the fill
          return [Math.min(255, r + 60), Math.min(255, g + 60), Math.min(255, b + 60), 220] as [number, number, number, number];
        },
        billboard: true,
        pickable: false,
        transitions: {
          getPosition: { duration: 350, easing: easeOut },
          getAngle:    { duration: 350 },
        },
        updateTriggers: {
          getAngle:  updateTriggers,
          getSize:   updateTriggers,
          getColor:  updateTriggers,
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vehicles],
  );

  return [circleLayer, arrowLayer];
}

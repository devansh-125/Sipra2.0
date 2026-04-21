'use client';

import { useMemo } from 'react';
import { ScatterplotLayer } from '@deck.gl/layers';
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

/**
 * Returns a deck.gl ScatterplotLayer representing the partner fleet.
 *
 * - Normal vehicles render as small blue circles.
 * - Vehicles with reroute_status render with distinct colours:
 *   - "rerouting": larger amber circles with amber ring
 *   - "completed": green circles with green ring
 *   - "failed": red circles with red ring
 * - Legacy evading vehicles (inside the exclusion corridor) render as larger
 *   amber circles for backwards compatibility.
 * - Deck.gl's built-in transition system interpolates position, colour, and
 *   radius changes so coordinate updates from the simulator look smooth.
 */
export function useFleetLayer(vehicles: FleetVehicle[]): ScatterplotLayer<FleetVehicle> {
  return useMemo(
    () =>
      new ScatterplotLayer<FleetVehicle>({
        id: 'fleet-swarm',
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
          getRadius: { duration: 200 },
        },
        updateTriggers: {
          getRadius: vehicles.map(v => `${v.evading}-${v.reroute_status}`),
          getFillColor: vehicles.map(v => `${v.evading}-${v.reroute_status}`),
          getLineColor: vehicles.map(v => `${v.evading}-${v.reroute_status}`),
          getLineWidth: vehicles.map(v => `${v.evading}-${v.reroute_status}`),
        },
      }),
    [vehicles],
  );
}

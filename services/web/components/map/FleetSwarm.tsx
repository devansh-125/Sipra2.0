'use client';

import { useMemo } from 'react';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { FleetVehicle } from '../../lib/types';

// Ease-out quad: decelerates at the end of each position transition so car
// movement looks like braking rather than an abrupt stop.
const easeOut = (t: number): number => t * (2 - t);

/**
 * Returns a deck.gl ScatterplotLayer representing the partner fleet.
 *
 * - Normal vehicles render as small blue circles.
 * - Evading vehicles (inside the exclusion corridor) render as larger amber
 *   circles so the "get out of the way" behaviour is immediately visible.
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
        getRadius: v => (v.evading ? 18 : 10),
        getFillColor: v => (v.evading ? [255, 165, 0, 230] : [30, 120, 255, 200]),
        getLineColor: v => (v.evading ? [255, 200, 0, 255] : [80, 160, 255, 180]),
        getLineWidth: v => (v.evading ? 2 : 1),
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
          getRadius: vehicles.map(v => v.evading),
          getFillColor: vehicles.map(v => v.evading),
          getLineColor: vehicles.map(v => v.evading),
          getLineWidth: vehicles.map(v => v.evading),
        },
      }),
    [vehicles],
  );
}

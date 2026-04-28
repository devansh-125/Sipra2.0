'use client';

import { useMemo } from 'react';
import { ScatterplotLayer, IconLayer } from '@deck.gl/layers';
import type { FleetVehicle } from '../../lib/types';

// Ease-out quad: decelerates at the end of each position transition so car
// movement looks like braking rather than an abrupt stop.
const easeOut = (t: number): number => t * (2 - t);

/**
 * Resolves fill and line colours from the vehicle's state.
 * Priority:
 * 1) In red zone and bounty not claimed => RED
 * 2) Claimed but not verified yet => GREEN
 * 3) In warning zone => YELLOW
 * 4) Verified/completed => GREEN
 * 5) Failed => RED
 * 6) Default => BLUE
 */
function vehicleFillColor(v: FleetVehicle & { inWarningZone?: boolean }): [number, number, number, number] {
  const statusUpper = (v.status ?? '').toUpperCase();
  const claimedNotVerified = v.reroute_status === 'rerouting' || statusUpper === 'CLAIMED';
  const inRedUnclaimed = !!v.evading && !claimedNotVerified;

  if (inRedUnclaimed)                   return [255, 20, 20, 255];
  if (claimedNotVerified)               return [34, 197, 94, 255];
  if (v.inWarningZone)                  return [255, 200, 0, 255];
  if (v.reroute_status === 'completed') return [34, 197, 94, 255];
  if (v.reroute_status === 'failed')    return [239, 68, 68, 255];
  return [30, 144, 255, 255];
}

function vehicleLineColor(v: FleetVehicle & { inWarningZone?: boolean }): [number, number, number, number] {
  const statusUpper = (v.status ?? '').toUpperCase();
  const claimedNotVerified = v.reroute_status === 'rerouting' || statusUpper === 'CLAIMED';
  const inRedUnclaimed = !!v.evading && !claimedNotVerified;

  if (inRedUnclaimed)                   return [200, 0, 0, 255];
  if (claimedNotVerified)               return [22, 163, 74, 255];
  if (v.inWarningZone)                  return [245, 158, 11, 255];
  if (v.reroute_status === 'completed') return [22, 163, 74, 255];
  if (v.reroute_status === 'failed')    return [220, 38, 38, 255];
  return [30, 64, 175, 255];
}

function vehicleRadius(v: FleetVehicle & { inWarningZone?: boolean }): number {
  const statusUpper = (v.status ?? '').toUpperCase();
  const claimedNotVerified = v.reroute_status === 'rerouting' || statusUpper === 'CLAIMED';
  const inRedUnclaimed = !!v.evading && !claimedNotVerified;

  if (inRedUnclaimed)                   return 16;
  if (claimedNotVerified)               return 14;
  if (v.inWarningZone)                  return 12;
  if (v.reroute_status === 'completed') return 12;
  if (v.reroute_status === 'failed')    return 11;
  return 8;
}

function vehicleLineWidth(v: FleetVehicle & { inWarningZone?: boolean }): number {
  const statusUpper = (v.status ?? '').toUpperCase();
  const claimedNotVerified = v.reroute_status === 'rerouting' || statusUpper === 'CLAIMED';
  const inRedUnclaimed = !!v.evading && !claimedNotVerified;

  if (inRedUnclaimed) return 4;
  if (claimedNotVerified || v.reroute_status === 'completed' || v.reroute_status === 'failed') return 3;
  if (v.inWarningZone)  return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// Minimal inline SVG arrow icon (pointing north = 0 degrees).
// deck.gl IconLayer rotates it by getAngle (clockwise degrees).
// ---------------------------------------------------------------------------
const ARROW_ICON_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <polygon points="12,2 20,20 12,16 4,20" fill="white" fill-opacity="0.95"/>
</svg>`.trim();

const ARROW_ICON_DATA_URL = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(ARROW_ICON_SVG)}`;

const ICON_MAPPING = {
  arrow: { x: 0, y: 0, width: 24, height: 24, anchorY: 12, mask: false },
};

export function useFleetLayer(
  vehicles: (FleetVehicle & { inWarningZone?: boolean })[],
): [ScatterplotLayer<FleetVehicle & { inWarningZone?: boolean }>, IconLayer<FleetVehicle & { inWarningZone?: boolean }>] {
  const updateTriggers = useMemo(
    () => vehicles.map(v => `${v.evading}-${v.inWarningZone || false}-${v.reroute_status ?? ''}-${v.heading_deg ?? 0}`),
    [vehicles],
  );

  const circleLayer = useMemo(
    () =>
      new ScatterplotLayer<FleetVehicle & { inWarningZone?: boolean }>({
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
        transitions: {
          getPosition: { duration: 1100, easing: easeOut },
          getFillColor: { duration: 400 },
          getRadius: { duration: 400 },
        },
        updateTriggers: {
          getRadius: updateTriggers,
          getFillColor: updateTriggers,
          getLineColor: updateTriggers,
          getLineWidth: updateTriggers,
        },
      }),
    [vehicles, updateTriggers],
  );

  const arrowLayer = useMemo(
    () =>
      new IconLayer<FleetVehicle & { inWarningZone?: boolean }>({
        id: 'fleet-swarm-arrows',
        data: vehicles,
        iconAtlas: ARROW_ICON_DATA_URL,
        iconMapping: ICON_MAPPING,
        getIcon: () => 'arrow',
        getPosition: v => [v.lng, v.lat],
        getSize: v => vehicleRadius(v) + 4,
        sizeUnits: 'pixels',
        getAngle: v => v.heading_deg ?? 0,
        getColor: v => {
          const [r, g, b] = vehicleFillColor(v);
          return [Math.min(255, r + 60), Math.min(255, g + 60), Math.min(255, b + 60), 220] as [number, number, number, number];
        },
        billboard: true,
        pickable: false,
        transitions: {
          getPosition: { duration: 1100, easing: easeOut },
          getAngle: { duration: 1100 },
        },
        updateTriggers: {
          getAngle: updateTriggers,
          getSize: updateTriggers,
          getColor: updateTriggers,
        },
      }),
    [vehicles, updateTriggers],
  );

  return [circleLayer, arrowLayer];
}

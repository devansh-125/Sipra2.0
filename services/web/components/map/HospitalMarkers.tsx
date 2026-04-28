'use client';

import { useMemo } from 'react';
import { TextLayer } from '@deck.gl/layers';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import type { Layer } from '@deck.gl/core';
import type { GeoPoint } from '../../lib/types';

// ---------------------------------------------------------------------------
// Hospital cross SVG icon (white circle, red cross)
// ---------------------------------------------------------------------------
const HOSPITAL_ICON_URL =
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
    '<circle cx="24" cy="24" r="22" fill="white" stroke="#dc2626" stroke-width="2.5"/>' +
    '<rect x="20" y="10" width="8" height="28" rx="2" fill="#dc2626"/>' +
    '<rect x="10" y="20" width="28" height="8" rx="2" fill="#dc2626"/>' +
    '</svg>',
  )}`;

interface HospitalPoint {
  position:  [number, number, number];
  label:     string;
  role:      'origin' | 'destination';
}

export interface HospitalLabels {
  originName:      string;
  destinationName: string;
}

/**
 * 3D scenegraph models pinned at origin/destination, with a dark-slate label
 * floating above each model. Replaces the prior 2D IconLayer.
 */
export function useHospitalLayer(
  origin:      GeoPoint | undefined,
  destination: GeoPoint | undefined,
  labels: HospitalLabels = {
    originName:      'Pickup Hospital',
    destinationName: 'Destination Hospital',
  },
): Layer[] {
  return useMemo(() => {
    if (!origin || !destination) return [];

    const data: HospitalPoint[] = [
      { position: [origin.lng,      origin.lat,      0], label: labels.originName,      role: 'origin' },
      { position: [destination.lng, destination.lat, 0], label: labels.destinationName, role: 'destination' },
    ];

    const scenegraphLayer = new ScenegraphLayer<HospitalPoint>({
      id: 'hospital-scenegraph',
      data,
      scenegraph: HOSPITAL_GLB_URL,
      getPosition:    d => d.position,
      // Scale a 1 m unit-cube up to a building-sized footprint at z13.
      sizeScale:      180,
      // Upright, +Z up (Google Maps deck.gl overlay uses Mercator + meters).
      getOrientation: [0, 0, 90],
      _animations:    { '*': { speed: 1 } },
      _lighting:      'pbr',
      pickable:       true,
    });

    const textLayer = new TextLayer<HospitalPoint>({
      id: 'hospital-labels',
      data,
      getPosition:          d => d.position,
      getText:              d => d.label,
      getSize:              13,
      sizeUnits:            'pixels',
      getColor:             [255, 255, 255, 255],
      background:           true,
      getBackgroundColor:   [20, 25, 35, 230],
      backgroundPadding:    [8, 4, 8, 4],
      getBorderColor:       [96, 165, 250, 200],
      getBorderWidth:       1,
      getTextAnchor:        'middle',
      getAlignmentBaseline: 'bottom',
      // Lift the label above the 3D model in screen space.
      getPixelOffset:       [0, -90],
      fontFamily:           '"Inter", "system-ui", sans-serif',
      fontWeight:           '600',
      pickable:             false,
    });

    return [scenegraphLayer, textLayer];
  }, [origin, destination, labels.originName, labels.destinationName]);
}

'use client';

import { useMemo } from 'react';
import { IconLayer, TextLayer } from '@deck.gl/layers';
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
  position:  [number, number];
  label:     string;
  /** 'origin' | 'destination' — used for tooltip colour coding */
  role:      'origin' | 'destination';
}

export interface HospitalLabels {
  originName:      string;
  destinationName: string;
}

/**
 * Returns a combined [IconLayer, TextLayer] pair for hospital markers.
 *
 * - Icons: hospital cross pinned at origin and destination
 * - Labels: resolved hospital name (or "Pickup Hospital" / "Destination Hospital")
 *           rendered as white text with a dark shadow beneath the icon
 *
 * @param origin      - Origin GeoPoint (source hospital)
 * @param destination - Destination GeoPoint (target hospital)
 * @param labels      - Resolved human-readable names (from useHospitalNames)
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
      { position: [origin.lng,      origin.lat],      label: labels.originName,      role: 'origin' },
      { position: [destination.lng, destination.lat], label: labels.destinationName, role: 'destination' },
    ];

    // ── Icon layer ───────────────────────────────────────────────────────────
    const iconLayer = new IconLayer<HospitalPoint>({
      id: 'hospital-icons',
      data,
      getPosition: d => d.position,
      getIcon: () => ({
        url:     HOSPITAL_ICON_URL,
        width:   48,
        height:  48,
        anchorY: 48, // pin at bottom-centre of the icon
      }),
      getSize:   48,
      sizeUnits: 'pixels',
      pickable:  true,
      // Tooltip shown on hover
      onHover: ({ object }: { object?: HospitalPoint }) => {
        if (typeof document !== 'undefined') {
          document.body.style.cursor = object ? 'pointer' : 'default';
        }
      },
    });

    // ── Text label layer ─────────────────────────────────────────────────────
    // Positioned 30 px below the icon anchor so it doesn't overlap the cross.
    const textLayer = new TextLayer<HospitalPoint>({
      id: 'hospital-labels',
      data,
      getPosition:     d => d.position,
      getText:         d => d.label,
      getSize:         13,
      sizeUnits:       'pixels',
      getColor:        [255, 255, 255, 240],
      getBackgroundColor: [0, 0, 0, 180],
      background:      true,
      backgroundPadding: [6, 3, 6, 3],
      getBorderColor:  [220, 0, 0, 180],
      getBorderWidth:  1,
      getTextAnchor:   'middle',
      getAlignmentBaseline: 'top',
      // Shift the label 52 px below the icon (in screen space)
      getPixelOffset:  [0, 52],
      fontFamily:      '"Inter", "system-ui", sans-serif',
      fontWeight:      '600',
      pickable:        false,
    });

    return [iconLayer, textLayer];
  }, [origin, destination, labels.originName, labels.destinationName]);
}

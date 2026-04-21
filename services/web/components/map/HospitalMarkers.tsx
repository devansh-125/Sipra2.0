'use client';

import { useMemo } from 'react';
import { IconLayer } from '@deck.gl/layers';
import type { GeoPoint } from '../../lib/types';

const ICON_URL =
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44">' +
    '<circle cx="22" cy="22" r="20" fill="white" stroke="#dc2626" stroke-width="2"/>' +
    '<rect x="18" y="10" width="8" height="24" fill="#dc2626"/>' +
    '<rect x="10" y="18" width="24" height="8" fill="#dc2626"/>' +
    '</svg>',
  )}`;

interface HospitalPoint {
  position: [number, number];
}

export function useHospitalLayer(
  origin: GeoPoint | undefined,
  destination: GeoPoint | undefined,
): IconLayer<HospitalPoint> | null {
  return useMemo(() => {
    if (!origin || !destination) return null;

    const data: HospitalPoint[] = [
      { position: [origin.lng, origin.lat] },
      { position: [destination.lng, destination.lat] },
    ];

    return new IconLayer<HospitalPoint>({
      id: 'hospital-markers',
      data,
      getPosition: d => d.position,
      getIcon: () => ({
        url: ICON_URL,
        width: 44,
        height: 44,
        anchorY: 44,
      }),
      getSize: 44,
      sizeUnits: 'pixels',
      pickable: true,
    });
  }, [origin, destination]);
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Geometry, Polygon, MultiPolygon } from 'geojson';
import type { GeoPoint } from '../../lib/types';

// GeoJSON stores coordinates as [lng, lat]; deck.gl PolygonLayer expects the
// same [lng, lat, z?] ordering, so no axis swap is needed here.
function extractRings(geom: Geometry): number[][][] {
  if (geom.type === 'Polygon') {
    return (geom as Polygon).coordinates;
  }
  if (geom.type === 'MultiPolygon') {
    return (geom as MultiPolygon).coordinates.flatMap(poly => poly);
  }
  return [];
}

interface ZoneData {
  contour: number[][];
}

/**
 * Returns a deck.gl PolygonLayer that renders the ambulance road-buffer corridor.
 * Kept for legacy / WS-corridor use cases.
 */
export function useExclusionLayer(
  corridorGeoJSON: Geometry | null,
  intensity = 1,
): PolygonLayer<ZoneData> | null {
  const [pulse, setPulse] = useState(0);
  const rafRef = useRef<number | null>(null);
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    const tick = (timestamp: number) => {
      setPulse(((Math.sin(timestamp * 0.005) + 1) / 2) * intensityRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (!corridorGeoJSON) return null;

  const rings = extractRings(corridorGeoJSON);
  if (rings.length === 0) return null;

  const data: ZoneData[] = rings.map(ring => ({ contour: ring }));

  const fillAlpha = Math.round((0.15 + pulse * 0.15) * 255);
  const lineWidth = 3 + pulse * 7;

  return new PolygonLayer<ZoneData>({
    id: 'exclusion-zone',
    data,
    getPolygon: d => d.contour,
    getFillColor: [220, 20, 20, fillAlpha],
    getLineColor: [255, 40, 40, 255],
    getLineWidth: lineWidth,
    lineWidthUnits: 'pixels',
    filled: true,
    stroked: true,
    pickable: false,
    updateTriggers: {
      getFillColor: fillAlpha,
      getLineWidth: lineWidth,
    },
  });
}

// ---------------------------------------------------------------------------
// 2 km Circular Exclusion Zone
// ---------------------------------------------------------------------------

interface CircleZonePoint {
  position: [number, number];
}

/**
 * Returns TWO deck.gl ScatterplotLayers that together render a pulsing
 * 2 km circular red exclusion zone centred on the ambulance:
 *
 *   [0] — translucent red fill disc (radius = 2000 m)
 *   [1] — solid red stroked ring (slightly larger; stroked ScatterplotLayer)
 *
 * Both pulse via a shared rAF so the zone feels alive.
 * Returns [null, null] when `ambulancePos` is not yet available.
 */
export function useCircularZoneLayer(
  ambulancePos: GeoPoint | null,
  radiusMeters = 2_000,
  intensity = 1,
): [ScatterplotLayer<CircleZonePoint> | null, ScatterplotLayer<CircleZonePoint> | null] {
  const [pulse, setPulse] = useState(0);
  const rafRef = useRef<number | null>(null);
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    const tick = (timestamp: number) => {
      setPulse(((Math.sin(timestamp * 0.004) + 1) / 2) * intensityRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (!ambulancePos) return [null, null];

  const data: CircleZonePoint[] = [
    { position: [ambulancePos.lng, ambulancePos.lat] },
  ];

  // Fill alpha: 20–45 out of 255 (subtle translucent red disc)
  const fillAlpha = Math.round((0.08 + pulse * 0.10) * 255);
  // Ring alpha: always strong
  const ringAlpha = Math.round((0.7 + pulse * 0.3) * 255);
  // Ring radius slightly larger than fill so it visually outlines the zone
  const ringRadius = radiusMeters + pulse * 80;

  const fillLayer = new ScatterplotLayer<CircleZonePoint>({
    id: 'exclusion-circle-fill',
    data,
    getPosition: d => d.position,
    getRadius: radiusMeters,
    getFillColor: [220, 20, 20, fillAlpha],
    getLineColor: [0, 0, 0, 0],
    radiusUnits: 'meters',
    stroked: false,
    filled: true,
    pickable: false,
    updateTriggers: { getFillColor: fillAlpha },
  });

  const ringLayer = new ScatterplotLayer<CircleZonePoint>({
    id: 'exclusion-circle-ring',
    data,
    getPosition: d => d.position,
    getRadius: ringRadius,
    getFillColor: [0, 0, 0, 0],
    getLineColor: [255, 40, 40, ringAlpha],
    getLineWidth: 3,
    lineWidthUnits: 'pixels',
    radiusUnits: 'meters',
    stroked: true,
    filled: false,
    pickable: false,
    updateTriggers: {
      getRadius: ringRadius,
      getLineColor: ringAlpha,
    },
  });

  return [fillLayer, ringLayer];
}

// ---------------------------------------------------------------------------
// 3 km Circular Warning Zone
// ---------------------------------------------------------------------------

/**
 * Returns TWO deck.gl ScatterplotLayers that together render a pulsing
 * 3 km circular yellow warning zone centred on the ambulance:
 *
 *   [0] — translucent yellow fill disc (radius = 3000 m)
 *   [1] — solid yellow stroked ring (slightly larger; stroked ScatterplotLayer)
 *
 * Both pulse via a shared rAF so the zone feels alive.
 * Returns [null, null] when `ambulancePos` is not yet available.
 */
export function useWarningZoneLayer(
  ambulancePos: GeoPoint | null,
  radiusMeters = 3_000,
  intensity = 1,
): [ScatterplotLayer<CircleZonePoint> | null, ScatterplotLayer<CircleZonePoint> | null] {
  const [pulse, setPulse] = useState(0);
  const rafRef = useRef<number | null>(null);
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;

  useEffect(() => {
    const tick = (timestamp: number) => {
      setPulse(((Math.sin(timestamp * 0.003) + 1) / 2) * intensityRef.current);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  if (!ambulancePos) return [null, null];

  const data: CircleZonePoint[] = [
    { position: [ambulancePos.lng, ambulancePos.lat] },
  ];

  // Fill alpha: 10–25 out of 255 (subtle translucent yellow disc)
  const fillAlpha = Math.round((0.04 + pulse * 0.06) * 255);
  // Ring alpha: moderate visibility
  const ringAlpha = Math.round((0.5 + pulse * 0.2) * 255);
  // Ring radius slightly larger than fill so it visually outlines the zone
  const ringRadius = radiusMeters + pulse * 60;

  const fillLayer = new ScatterplotLayer<CircleZonePoint>({
    id: 'warning-circle-fill',
    data,
    getPosition: d => d.position,
    getRadius: radiusMeters,
    getFillColor: [255, 170, 0, fillAlpha], // Yellow warning color
    getLineColor: [0, 0, 0, 0],
    radiusUnits: 'meters',
    stroked: false,
    filled: true,
    pickable: false,
    updateTriggers: { getFillColor: fillAlpha },
  });

  const ringLayer = new ScatterplotLayer<CircleZonePoint>({
    id: 'warning-circle-ring',
    data,
    getPosition: d => d.position,
    getRadius: ringRadius,
    getFillColor: [0, 0, 0, 0],
    getLineColor: [255, 200, 0, ringAlpha], // Bright yellow ring
    getLineWidth: 2,
    lineWidthUnits: 'pixels',
    radiusUnits: 'meters',
    stroked: true,
    filled: false,
    pickable: false,
    updateTriggers: {
      getRadius: ringRadius,
      getLineColor: ringAlpha,
    },
  });

  return [fillLayer, ringLayer];
}

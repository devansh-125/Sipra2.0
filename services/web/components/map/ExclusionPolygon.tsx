'use client';

import { useEffect, useRef, useState } from 'react';
import { PolygonLayer } from '@deck.gl/layers';
import type { Geometry, Polygon, MultiPolygon } from 'geojson';

// GeoJSON stores coordinates as [lng, lat]; deck.gl PolygonLayer expects the
// same [lng, lat, z?] ordering, so no axis swap is needed here.
function extractRings(geom: Geometry): number[][][] {
  if (geom.type === 'Polygon') {
    return (geom as Polygon).coordinates;
  }
  if (geom.type === 'MultiPolygon') {
    // Flatten to individual rings; deck.gl treats each element as one polygon.
    return (geom as MultiPolygon).coordinates.flatMap(poly => poly);
  }
  return [];
}

interface ZoneData {
  contour: number[][];
}

/**
 * Returns a deck.gl PolygonLayer that renders the ambulance exclusion corridor.
 *
 * Visual style: translucent red fill with a harsh, continuously pulsing outline
 * driven by a requestAnimationFrame loop. The pulse updates getFillColor and
 * getLineWidth every frame; deck.gl reconciles only those uniforms without
 * re-uploading geometry buffers.
 *
 * Returns null when no corridor has been received yet.
 */
export function useExclusionLayer(corridorGeoJSON: Geometry | null): PolygonLayer<ZoneData> | null {
  const [pulse, setPulse] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = (timestamp: number) => {
      // Oscillate 0→1→0 at ~0.8 Hz
      setPulse((Math.sin(timestamp * 0.005) + 1) / 2);
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

  // Pulse drives both fill opacity (15 %–30 %) and outline width (3–10 px).
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
    // Hint deck.gl which accessors changed each frame so it skips geometry
    // re-upload and only patches the colour/width uniforms.
    updateTriggers: {
      getFillColor: fillAlpha,
      getLineWidth: lineWidth,
    },
  });
}

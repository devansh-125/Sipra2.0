'use client';

/**
 * CorridorSimMap
 *
 * Full-page Google Maps component with deck.gl overlays demonstrating the
 * rolling exclusion zone concept. Uses useCorridorSimulation for all state.
 *
 * Layers:
 *   - Ambulance (white dot with red ring)
 *   - 2km exclusion zone (red translucent circle)
 *   - 3km alert boundary (yellow ring)
 *   - 50 drivers colored by proximity status
 *   - Hospital markers at origin/destination
 *   - Route lines via native DirectionsRenderer + deck.gl PathLayer
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer, PathLayer, IconLayer } from '@deck.gl/layers';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import type { Layer, Position } from '@deck.gl/core';

import {
  useCorridorSimulation,
  type SimDriver,
  type DriverStatus,
} from '../../hooks/useCorridorSimulation';
import type { GeoPoint } from '../../lib/types';

// Spatial culling radius (meters) — drivers beyond this are not rendered.
const CULL_RADIUS_M = 4000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const LUCKNOW_CENTER = { lat: 26.795, lng: 80.955 };

// Hospital coordinates for markers
const ORIGIN_LABEL = 'Medanta Hospital';
const DESTINATION_LABEL = 'Tender Palm Hospital';

// ---------------------------------------------------------------------------
// Driver colour mapping
// ---------------------------------------------------------------------------
function driverFillColor(status: DriverStatus): [number, number, number, number] {
  switch (status) {
    case 'evading': return [255, 80, 40, 220];   // orange-red
    case 'alerted': return [255, 200, 0, 200];    // yellow
    case 'safe': return [60, 140, 255, 180];   // blue
  }
}

function driverLineColor(status: DriverStatus): [number, number, number, number] {
  switch (status) {
    case 'evading': return [255, 40, 0, 255];
    case 'alerted': return [255, 220, 0, 255];
    case 'safe': return [80, 160, 255, 200];
  }
}

function driverRadius(status: DriverStatus): number {
  switch (status) {
    case 'evading': return 14;
    case 'alerted': return 11;
    case 'safe': return 8;
  }
}

// ---------------------------------------------------------------------------
// DeckGLOverlay — binds deck.gl layers to the Google Maps canvas
// ---------------------------------------------------------------------------
function DeckGLOverlay({ layers }: { layers: (Layer | null)[] }) {
  const map = useMap();
  const overlayRef = useRef<GoogleMapsOverlay | null>(null);

  useEffect(() => {
    if (!map) return;
    const overlay = new GoogleMapsOverlay({ layers: [] });
    overlayRef.current = overlay;
    const rafId = requestAnimationFrame(() => {
      if (overlayRef.current === overlay) overlay.setMap(map);
    });
    return () => {
      cancelAnimationFrame(rafId);
      overlay.setMap(null);
      overlayRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    overlayRef.current?.setProps({
      layers: layers.filter((l): l is Layer => l !== null),
    });
  });

  return null;
}

// ---------------------------------------------------------------------------
// Pulsing alpha for the exclusion zone
// ---------------------------------------------------------------------------
function usePulseAlpha(period = 2000): number {
  const [alpha, setAlpha] = useState(80);

  useEffect(() => {
    let raf: number;
    const start = performance.now();
    const animate = () => {
      const elapsed = performance.now() - start;
      const t = (Math.sin((elapsed / period) * Math.PI * 2) + 1) / 2;
      setAlpha(Math.round(40 + t * 60)); // 40–100
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [period]);

  return alpha;
}

// ---------------------------------------------------------------------------
// MapScene — inner component with access to Google Maps instance
// ---------------------------------------------------------------------------
function MapScene({
  routePoints,
  alternateRoutePoints,
  ambulancePosition,
  drivers,
  progress,
  isEmergencyMode,
  emergencyPhase,
  dronePosition,
  midpoint,
}: {
  routePoints: GeoPoint[];
  alternateRoutePoints: GeoPoint[];
  ambulancePosition: GeoPoint;
  drivers: SimDriver[];
  progress: number;
  isEmergencyMode: boolean;
  emergencyPhase: string;
  dronePosition: GeoPoint;
  midpoint: GeoPoint | null;
}) {
  // ── Spatial Render Culling ─────────────────────────────────────────────
  // Use google.maps.geometry.spherical.computeDistanceBetween to cull
  // drivers > 4km from the ambulance. This drastically reduces DOM/WebGL
  // nodes by only rendering nearby drivers.
  const visibleDrivers = useMemo(() => {
    // Guard: geometry library may not be loaded yet
    if (
      typeof google === 'undefined' ||
      !google.maps?.geometry?.spherical?.computeDistanceBetween
    ) {
      // Fallback: use the visibility flag set by the tick function
      return drivers.filter(d => d.visible !== false);
    }

    const ambLatLng = new google.maps.LatLng(ambulancePosition.lat, ambulancePosition.lng);
    return drivers.filter(d => {
      const driverLatLng = new google.maps.LatLng(d.lat, d.lng);
      const distM = google.maps.geometry.spherical.computeDistanceBetween(
        ambLatLng,
        driverLatLng,
      );
      return distM <= CULL_RADIUS_M;
    });
  }, [drivers, ambulancePosition]);

  const activeVehiclePosition = useMemo(() => {
    return isEmergencyMode && (emergencyPhase === 'transfer' || emergencyPhase === 'drone-flight' || emergencyPhase === 'arrived')
      ? dronePosition
      : ambulancePosition;
  }, [isEmergencyMode, emergencyPhase, dronePosition, ambulancePosition]);

  const map = useMap();
  const didFitRef = useRef(false);
  const pulseAlpha = usePulseAlpha(2500);

  // Fit bounds once
  useEffect(() => {
    if (!map || didFitRef.current || routePoints.length < 2) return;
    const bounds = new google.maps.LatLngBounds();
    routePoints.forEach((p) => bounds.extend({ lat: p.lat, lng: p.lng }));
    map.fitBounds(bounds, 80);
    didFitRef.current = true;
  }, [map, routePoints]);

  // ── Route path layers ───────────────────────────────────────────────────────────
  // During ambulance-to-midpoint we show the FULL route so the handoff looks
  // like a real-time surprise, not a pre-scripted split.
  // Only clip to the first half AFTER the transfer alert fires.
  const displayRoutePoints = useMemo(() => {
    const shouldClip =
      isEmergencyMode &&
      emergencyPhase !== 'none' &&
      emergencyPhase !== 'ambulance-to-midpoint'; // show full route during approach
    if (!shouldClip) return routePoints;
    const midIdx = Math.floor((routePoints.length - 1) / 2);
    return routePoints.slice(0, midIdx + 1);
  }, [routePoints, isEmergencyMode, emergencyPhase]);

  const routePathLayer = useMemo(() => {
    if (displayRoutePoints.length < 2) return null;
    return new PathLayer({
      id: 'sim-route-primary',
      data: [{ path: displayRoutePoints.map((p) => [p.lng, p.lat] as Position) }],
      getPath: (d: { path: Position[] }) => d.path,
      getColor: [66, 133, 244, 200],
      getWidth: 6,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    });
  }, [displayRoutePoints]);

  const altRoutePathLayer = useMemo(() => {
    if (alternateRoutePoints.length < 2) return null;
    return new PathLayer({
      id: 'sim-route-alternate',
      data: [{ path: alternateRoutePoints.map((p) => [p.lng, p.lat] as Position) }],
      getPath: (d: { path: Position[] }) => d.path,
      getColor: [150, 150, 150, 100],
      getWidth: 4,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    });
  }, [alternateRoutePoints]);

  // ── Traversed (bright blue highlight of the portion already covered) ──
  const traversedLayer = useMemo(() => {
    if (routePoints.length < 2 || progress <= 0) return null;
    const endIdx = Math.min(
      Math.floor(progress * (routePoints.length - 1)) + 1,
      routePoints.length,
    );
    const traversed = routePoints.slice(0, endIdx);
    if (traversed.length < 2) return null;
    return new PathLayer({
      id: 'sim-route-traversed',
      data: [{ path: traversed.map((p) => [p.lng, p.lat] as Position) }],
      getPath: (d: { path: Position[] }) => d.path,
      getColor: [66, 133, 244, 255],
      getWidth: 8,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    });
  }, [routePoints, progress]);

  // ── 2km Exclusion Zone ────────────────────────────────────────────────
  const exclusionLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'sim-exclusion-zone',
      data: [activeVehiclePosition],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 2000,
      radiusUnits: 'meters',
      getFillColor: [255, 40, 0, pulseAlpha],
      stroked: true,
      getLineColor: [255, 60, 20, 140],
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      pickable: false,
      transitions: { getPosition: { duration: 400 } },
    });
  }, [activeVehiclePosition, pulseAlpha]);

  // ── 3km Alert Ring ────────────────────────────────────────────────────
  const alertRingLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'sim-alert-ring',
      data: [activeVehiclePosition],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 3000,
      radiusUnits: 'meters',
      filled: false,
      stroked: true,
      getLineColor: [255, 200, 0, 100],
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      pickable: false,
      transitions: { getPosition: { duration: 400 } },
    });
  }, [activeVehiclePosition]);

  // ── Ambulance marker ──────────────────────────────────────────────────
  const ambulanceLayer = useMemo(() => {
    // Hide ambulance once drone takes over
    if (isEmergencyMode && emergencyPhase !== 'none' && emergencyPhase !== 'ambulance-to-midpoint') {
      return null;
    }
    return new ScatterplotLayer({
      id: 'sim-ambulance',
      data: [ambulancePosition],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 16,
      getFillColor: [255, 255, 255, 255],
      getLineColor: [220, 0, 0, 255],
      getLineWidth: 4,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
      transitions: { getPosition: { duration: 300 } },
    });
  }, [ambulancePosition, isEmergencyMode, emergencyPhase]);

  // ── Ambulance inner dot (red cross effect / organ marker) ──────────────
  const ambulanceInnerLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'sim-ambulance-inner',
      data: [activeVehiclePosition],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 8, // slightly larger to clearly show it tracks the drone
      getFillColor: [220, 0, 0, 255],
      radiusUnits: 'pixels',
      stroked: false,
      pickable: false,
      transitions: { getPosition: { duration: 300 } },
    });
  }, [activeVehiclePosition]);

  // ── Driver dots (only visible / culled drivers are rendered) ───────────
  const driverLayer = useMemo(() => {
    return new ScatterplotLayer<SimDriver>({
      id: 'sim-drivers',
      data: visibleDrivers,
      getPosition: (d) => [d.lng, d.lat],
      getRadius: (d) => driverRadius(d.status),
      getFillColor: (d) => driverFillColor(d.status),
      getLineColor: (d) => driverLineColor(d.status),
      getLineWidth: 2,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
      transitions: {
        getPosition: { duration: 300 },
        getFillColor: { duration: 200 },
        getRadius: { duration: 200 },
      },
      updateTriggers: {
        getRadius: visibleDrivers.map((d) => d.status),
        getFillColor: visibleDrivers.map((d) => d.status),
        getLineColor: visibleDrivers.map((d) => d.status),
      },
    });
  }, [visibleDrivers]);

  // ── Escape route path lines (road-snapped evasion visualization) ──────
  const escapeRouteLayer = useMemo(() => {
    const pathData = visibleDrivers
      .filter(d => d.escapeRoute && d.escapeRoute.length >= 2)
      .map(d => ({
        path: d.escapeRoute!.map(p => [p.lng, p.lat] as Position),
      }));
    if (pathData.length === 0) return null;
    return new PathLayer({
      id: 'sim-escape-routes',
      data: pathData,
      getPath: (d: { path: Position[] }) => d.path,
      getColor: [0, 210, 190, 160],
      getWidth: 3,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    });
  }, [visibleDrivers]);

  // ── Hospital markers (origin + destination) ───────────────────────────
  const hospitalOriginLayer = useMemo(() => {
    if (routePoints.length === 0) return null;
    const origin = routePoints[0];
    return new ScatterplotLayer({
      id: 'sim-hospital-origin',
      data: [origin],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 20,
      getFillColor: [34, 197, 94, 230],
      getLineColor: [255, 255, 255, 255],
      getLineWidth: 3,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
    });
  }, [routePoints]);

  const hospitalDestLayer = useMemo(() => {
    if (routePoints.length === 0) return null;
    const dest = routePoints[routePoints.length - 1];
    return new IconLayer({
      id: 'sim-hospital-dest',
      data: [dest],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getIcon: () => ({
        url: '/hospital-cross.svg',
        width: 64,
        height: 64,
        anchorY: 32,
      }),
      getSize: 40,
      pickable: false,
    });
  }, [routePoints]);

  // ── Emergency: midpoint pickup marker ───────────────────────────────────────
  // Hidden during approach — only revealed when the alert fires, so it
  // doesn’t telegraph the handoff location in advance.
  const midpointMarkerLayer = useMemo(() => {
    if (!isEmergencyMode || !midpoint) return null;
    if (emergencyPhase === 'none' || emergencyPhase === 'ambulance-to-midpoint') return null;
    return new ScatterplotLayer({
      id: 'sim-midpoint-marker',
      data: [midpoint],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 22,
      getFillColor: [251, 191, 36, 230],  // amber
      getLineColor: [255, 255, 255, 255],
      getLineWidth: 3,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
    });
  }, [isEmergencyMode, midpoint]);

  // ── Emergency: drone flight path (straight purple line) ──────────────────
  const droneFlightPathLayer = useMemo(() => {
    if (!isEmergencyMode || !midpoint || routePoints.length === 0) return null;
    if (emergencyPhase !== 'drone-flight' && emergencyPhase !== 'transfer' && emergencyPhase !== 'arrived') return null;
    const dest = routePoints[routePoints.length - 1];
    return new PathLayer({
      id: 'sim-drone-flight-path',
      data: [{ path: [[midpoint.lng, midpoint.lat], [dest.lng, dest.lat]] as Position[] }],
      getPath: (d: { path: Position[] }) => d.path,
      getColor: [167, 85, 247, 200],  // purple
      getWidth: 5,
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
    });
  }, [isEmergencyMode, emergencyPhase, midpoint, routePoints]);

  // ── Emergency: drone glow pulse ring ──────────────────────────────────────
  const droneGlowLayer = useMemo(() => {
    if (!isEmergencyMode || emergencyPhase !== 'drone-flight') return null;
    return new ScatterplotLayer({
      id: 'sim-drone-glow',
      data: [dronePosition],
      getPosition: (d: GeoPoint) => [d.lng, d.lat],
      getRadius: 32,
      getFillColor: [139, 92, 246, Math.round(pulseAlpha * 0.55)],  // semi-transparent purple
      stroked: false,
      pickable: false,
      transitions: { getPosition: { duration: 180 } },
    });
  }, [isEmergencyMode, emergencyPhase, dronePosition, pulseAlpha]);

  // ── Emergency: drone body (solid purple dot) ─────────────────────────────
  const droneBodyLayer = useMemo(() => {
    if (!isEmergencyMode) return null;
    if (emergencyPhase === 'none' || emergencyPhase === 'ambulance-to-midpoint') return null;
    return new ScenegraphLayer({
      id: 'sim-drone-body',
      data: [dronePosition],
      scenegraph: '/drone.glb',
      getPosition: (d: GeoPoint) => [d.lng, d.lat, 50],
      getOrientation: [0, 0, 90],
      sizeScale: 150,
      _lighting: 'pbr',
      transitions: { getPosition: { duration: 180 } },
    });
  }, [isEmergencyMode, emergencyPhase, dronePosition]);

  return (
    <DeckGLOverlay
      layers={[
        altRoutePathLayer,
        routePathLayer,
        traversedLayer,
        alertRingLayer,
        exclusionLayer,
        hospitalOriginLayer,
        hospitalDestLayer,
        midpointMarkerLayer,
        droneFlightPathLayer,
        droneGlowLayer,
        escapeRouteLayer,
        driverLayer,
        ambulanceInnerLayer,
        ambulanceLayer,
        droneBodyLayer,
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Control Panel HUD
// ---------------------------------------------------------------------------
function ControlPanel({
  isRunning,
  progress,
  driversInZone,
  driversAlerted,
  driversVisible,
  totalDrivers,
  etaSeconds,
  distanceMeters,
  distanceText,
  durationText,
  speed,
  onStart,
  onPause,
  onReset,
  onSpeedChange,
}: {
  isRunning: boolean;
  progress: number;
  driversInZone: number;
  driversAlerted: number;
  driversVisible: number;
  totalDrivers: number;
  etaSeconds: number;
  distanceMeters: number;
  distanceText: string;
  durationText: string;
  speed: number;
  onStart: () => void;
  onPause: () => void;
  onReset: () => void;
  onSpeedChange: (s: number) => void;
}) {
  const etaMin = Math.round((etaSeconds * (1 - progress)) / 60);
  const distKm = (distanceMeters / 1000).toFixed(1);
  // Prefer real Google text; fall back to computed values
  const displayDist = distanceText || `${distKm} km`;
  const displayEta = durationText || `${etaMin} min`;

  return (
    <div
      style={{
        position: 'absolute',
        top: 20,
        right: 20,
        zIndex: 20,
        width: 280,
        background: 'rgba(10, 10, 20, 0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16,
        padding: '20px 20px',
        color: '#fff',
        fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
        boxShadow: '0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05)',
      }}
    >
      {/* Title */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 2,
          color: 'rgba(255,255,255,0.4)',
          marginBottom: 12,
          textTransform: 'uppercase',
        }}
      >
        Corridor Sim
      </div>

      {/* Progress bar */}
      <div
        style={{
          background: 'rgba(255,255,255,0.08)',
          borderRadius: 6,
          height: 8,
          overflow: 'hidden',
          marginBottom: 16,
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${Math.round(progress * 100)}%`,
            background: 'linear-gradient(90deg, #4285f4, #34a853)',
            borderRadius: 6,
            transition: 'width 0.3s ease',
          }}
        />
      </div>

      {/* Stats grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '10px 16px',
          marginBottom: 16,
          fontSize: 12,
        }}
      >
        <div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginBottom: 2, fontWeight: 600 }}>
            PROGRESS
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>
            {Math.round(progress * 100)}%
          </div>
        </div>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginBottom: 2, fontWeight: 600 }}>
            ETA
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, fontVariantNumeric: 'tabular-nums' }}>
            {durationText ? durationText : `${etaMin}m`}
          </div>
        </div>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginBottom: 2, fontWeight: 600 }}>
            IN ZONE
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, color: '#ff5028', fontVariantNumeric: 'tabular-nums' }}>
            {driversInZone}
          </div>
        </div>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginBottom: 2, fontWeight: 600 }}>
            ALERTED
          </div>
          <div style={{ fontWeight: 700, fontSize: 18, color: '#ffc800', fontVariantNumeric: 'tabular-nums' }}>
            {driversAlerted}
          </div>
        </div>
        <div>
          <div style={{ color: 'rgba(255,255,255,0.4)', fontSize: 10, marginBottom: 2, fontWeight: 600 }}>
            RENDERED
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#8b5cf6', fontVariantNumeric: 'tabular-nums' }}>
            {driversVisible}/{totalDrivers}
          </div>
        </div>
      </div>

      {/* Route info */}
      <div
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.5)',
          marginBottom: 14,
          borderTop: '1px solid rgba(255,255,255,0.08)',
          paddingTop: 10,
        }}
      >
        Distance: <span style={{ color: '#fff', fontWeight: 600 }}>{displayDist}</span>
        {durationText && (
          <span style={{ marginLeft: 12 }}>ETA: <span style={{ color: '#fff', fontWeight: 600 }}>{displayEta}</span></span>
        )}
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button
          id="sim-play-btn"
          onClick={isRunning ? onPause : onStart}
          style={{
            flex: 1,
            padding: '10px 0',
            borderRadius: 10,
            border: 'none',
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer',
            background: isRunning
              ? 'linear-gradient(135deg, #ff4444, #ff6644)'
              : 'linear-gradient(135deg, #4285f4, #34a853)',
            color: '#fff',
            letterSpacing: 0.5,
            transition: 'transform 0.1s, opacity 0.2s',
          }}
          onMouseDown={(e) => ((e.target as HTMLElement).style.transform = 'scale(0.96)')}
          onMouseUp={(e) => ((e.target as HTMLElement).style.transform = 'scale(1)')}
          onMouseLeave={(e) => ((e.target as HTMLElement).style.transform = 'scale(1)')}
        >
          {isRunning ? '⏸ Pause' : '▶ Play'}
        </button>
        <button
          id="sim-reset-btn"
          onClick={onReset}
          style={{
            padding: '10px 16px',
            borderRadius: 10,
            border: '1px solid rgba(255,255,255,0.15)',
            background: 'rgba(255,255,255,0.06)',
            color: '#fff',
            fontWeight: 600,
            fontSize: 13,
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => ((e.target as HTMLElement).style.background = 'rgba(255,255,255,0.12)')}
          onMouseLeave={(e) => ((e.target as HTMLElement).style.background = 'rgba(255,255,255,0.06)')}
        >
          ↻
        </button>
      </div>

      {/* Speed selector */}
      <div style={{ display: 'flex', gap: 6 }}>
        {[1, 2, 5, 10].map((s) => (
          <button
            key={s}
            id={`sim-speed-${s}x`}
            onClick={() => onSpeedChange(s)}
            style={{
              flex: 1,
              padding: '6px 0',
              borderRadius: 8,
              border: speed === s ? '1px solid #4285f4' : '1px solid rgba(255,255,255,0.1)',
              background: speed === s ? 'rgba(66,133,244,0.2)' : 'rgba(255,255,255,0.04)',
              color: speed === s ? '#4285f4' : 'rgba(255,255,255,0.5)',
              fontWeight: 700,
              fontSize: 11,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------
function Legend() {
  const items = [
    { color: '#fff', border: '#dc0000', label: 'Ambulance' },
    { color: 'rgba(255,40,0,0.5)', border: '#ff3c14', label: '2 km Exclusion Zone' },
    { color: 'transparent', border: '#ffc800', label: '3 km Alert Boundary' },
    { color: '#3c8cff', border: '#50a0ff', label: 'Safe Driver' },
    { color: '#ffc800', border: '#ffdc00', label: 'Alerted Driver' },
    { color: '#ff5028', border: '#ff2800', label: 'Evading Driver' },
    { color: '#22c55e', border: '#fff', label: 'Origin Hospital' },
    { color: '#ef4444', border: '#fff', label: 'Destination Hospital' },
    { color: '#00d2be', border: '#00d2be', label: 'Escape Route (road-snapped)' },
    { color: '#8b5cf6', border: '#8b5cf6', label: 'Render Culled (>4km hidden)' },
  ];

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 24,
        left: 20,
        zIndex: 20,
        background: 'rgba(10, 10, 20, 0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 12,
        padding: '14px 18px',
        color: '#fff',
        fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.5,
          color: 'rgba(255,255,255,0.35)',
          marginBottom: 8,
          textTransform: 'uppercase',
        }}
      >
        Legend
      </div>
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 4,
            fontSize: 11,
            color: 'rgba(255,255,255,0.75)',
          }}
        >
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: item.color,
              border: `2px solid ${item.border}`,
              flexShrink: 0,
            }}
          />
          {item.label}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route info badge (top-left)
// ---------------------------------------------------------------------------
function RouteInfo() {
  return (
    <div
      style={{
        position: 'absolute',
        top: 20,
        left: 20,
        zIndex: 20,
        background: 'rgba(10, 10, 20, 0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 12,
        padding: '14px 18px',
        color: '#fff',
        fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1.5, color: 'rgba(255,255,255,0.35)', marginBottom: 8, textTransform: 'uppercase' }}>
        Active Mission
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span style={{ fontSize: 14, color: '#22c55e' }}>✚</span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{ORIGIN_LABEL}</span>
      </div>
      <div style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, paddingLeft: 20, marginBottom: 2 }}>↓</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 14, color: '#ef4444' }}>✚</span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{DESTINATION_LABEL}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading overlay
// ---------------------------------------------------------------------------
function LoadingOverlay() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(8px)',
        color: '#fff',
        fontFamily: "'Inter', sans-serif",
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          border: '3px solid rgba(255,255,255,0.15)',
          borderTopColor: '#4285f4',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
          marginBottom: 16,
        }}
      />
      <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: 0.5 }}>
        Loading route data…
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CorridorSimMap — public component
// ---------------------------------------------------------------------------
interface CorridorSimMapProps {
  apiKey: string;
  /** When provided, uses this sim state instead of creating its own. */
  sim?: import('../../hooks/useCorridorSimulation').CorridorSimState;
  /** When true, hides all overlay panels (for embedded dashboard use). */
  embedded?: boolean;
}

export default function CorridorSimMap({ apiKey, sim: externalSim, embedded }: CorridorSimMapProps) {
  const internalSim = useCorridorSimulation();
  const sim = externalSim ?? internalSim;
  const [speed, setSpeedLocal] = useState(1);

  const handleSpeedChange = useCallback(
    (s: number) => {
      setSpeedLocal(s);
      sim.setSpeed(s);
    },
    [sim],
  );

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', background: '#0a0a14' }}>
      <Map
        defaultCenter={LUCKNOW_CENTER}
        defaultZoom={12}
        mapId="sipra-corridor-sim"
        gestureHandling="greedy"
        disableDefaultUI
        style={{ width: '100%', height: '100%' }}
      >
        <MapScene
          routePoints={sim.routePoints}
          alternateRoutePoints={sim.alternateRoutePoints}
          ambulancePosition={sim.ambulancePosition}
          drivers={sim.drivers}
          progress={sim.progress}
          isEmergencyMode={sim.isEmergencyMode}
          emergencyPhase={sim.emergencyPhase}
          dronePosition={sim.dronePosition}
          midpoint={sim.midpoint}
        />
      </Map>

      {/* Loading overlay */}
      {sim.isLoading && <LoadingOverlay />}

      {/* ── Operational emergency alert (real-time traffic blockage) ────── */}
      {sim.showTransferPopup && (
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 120,
            width: 440,
            background: 'rgba(6, 4, 18, 0.96)',
            backdropFilter: 'blur(28px)',
            WebkitBackdropFilter: 'blur(28px)',
            border: '1px solid rgba(239, 68, 68, 0.45)',
            borderRadius: 16,
            overflow: 'hidden',
            fontFamily: "'Inter', 'SF Pro Display', -apple-system, sans-serif",
            boxShadow: '0 0 80px rgba(239,68,68,0.25), 0 0 40px rgba(139,92,246,0.2), 0 16px 48px rgba(0,0,0,0.8)',
            animation: 'alertSlideIn 0.45s cubic-bezier(0.22,1,0.36,1)',
          }}
        >
          {/* Alert header bar */}
          <div style={{
            background: 'linear-gradient(90deg, rgba(239,68,68,0.9) 0%, rgba(220,38,38,0.7) 100%)',
            padding: '10px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}>
            <span style={{ fontSize: 16 }}>🚨</span>
            <span style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: 2,
              textTransform: 'uppercase',
              color: '#fff',
            }}>Critical System Alert</span>
            <div style={{
              marginLeft: 'auto',
              width: 8, height: 8,
              borderRadius: '50%',
              background: '#fff',
              animation: 'alertBlink 0.6s ease-in-out infinite',
            }} />
          </div>

          {/* Alert body */}
          <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Row 1: Traffic blockage */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{
                width: 36, height: 36, flexShrink: 0,
                borderRadius: 10,
                background: 'rgba(239,68,68,0.15)',
                border: '1px solid rgba(239,68,68,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18,
              }}>🚧</div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#fca5a5', letterSpacing: 0.3, marginBottom: 3 }}>
                  Traffic Blockage Detected
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
                  Exclusion zone congestion is blocking ambulance corridor ahead.
                  Road clearance unavailable.
                </div>
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

            {/* Row 2: Time window exceeded */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{
                width: 36, height: 36, flexShrink: 0,
                borderRadius: 10,
                background: 'rgba(245,158,11,0.15)',
                border: '1px solid rgba(245,158,11,0.35)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18,
              }}>⏰</div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#fcd34d', letterSpacing: 0.3, marginBottom: 3 }}>
                  Estimated Arrival Exceeds Safe Medical Window
                </div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
                  Remaining ambulance ETA will breach the organ viability threshold.
                  Road delivery is no longer viable.
                </div>
              </div>
            </div>

            {/* Divider */}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.06)' }} />

            {/* Row 3: Drone initiated */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <div style={{
                width: 36, height: 36, flexShrink: 0,
                borderRadius: 10,
                background: 'rgba(139,92,246,0.2)',
                border: '1px solid rgba(139,92,246,0.45)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18,
              }}>🚁</div>
              <div>
                <div style={{
                  fontSize: 12, fontWeight: 700, letterSpacing: 0.3, marginBottom: 3,
                  background: 'linear-gradient(90deg, #a78bfa, #e879f9)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}>Organ Transferred to Drone — Urgent Aerial Delivery</div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5 }}>
                  Emergency drone dispatched from ambulance handoff point.
                  Direct flight path to destination initiated.
                </div>
              </div>
            </div>

            {/* Progress bar animation */}
            <div style={{
              marginTop: 4,
              height: 3,
              borderRadius: 9999,
              background: 'rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                borderRadius: 9999,
                background: 'linear-gradient(90deg, #ef4444, #a855f7)',
                animation: 'alertProgress 3.5s linear forwards',
              }} />
            </div>
          </div>

          <style>{`
            @keyframes alertSlideIn {
              from { transform: translate(-50%,-50%) scale(0.88) translateY(20px); opacity: 0; }
              to   { transform: translate(-50%,-50%) scale(1)    translateY(0);    opacity: 1; }
            }
            @keyframes alertBlink { 0%,100% { opacity:1 } 50% { opacity:0.2 } }
            @keyframes alertProgress { from { width: 0% } to { width: 100% } }
          `}</style>
        </div>
      )}

      {!embedded && (
        <>
          <RouteInfo />

          <ControlPanel
            isRunning={sim.isRunning}
            progress={sim.progress}
            driversInZone={sim.driversInZone}
            driversAlerted={sim.driversAlerted}
            driversVisible={sim.driversVisible ?? sim.drivers.length}
            totalDrivers={sim.drivers.length}
            etaSeconds={sim.etaSeconds}
            distanceMeters={sim.distanceMeters}
            distanceText={sim.distanceText}
            durationText={sim.durationText}
            speed={speed}
            onStart={sim.start}
            onPause={sim.pause}
            onReset={sim.reset}
            onSpeedChange={handleSpeedChange}
          />

          <Legend />
        </>
      )}
    </div>
  );
}

// Re-export ControlPanel for use in external sidebars
export { ControlPanel };


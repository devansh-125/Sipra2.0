'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { Geometry } from 'geojson';

import { useExclusionLayer } from './ExclusionPolygon';
import { useFleetLayer } from './FleetSwarm';
import { useHospitalLayer } from './HospitalMarkers';
import { useRoutePathLayer } from './RoutePath';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useAmbulanceAnimation } from '../../hooks/useAmbulanceAnimation';
import { useHospitalNames } from '../../hooks/useHospitalNames';
import type { FleetVehicle, GeoPoint, HandoffInitiatedPayload } from '../../lib/types';

// Default viewport: Lucknow — matches the Medanta → Tender Palm route.
const DEFAULT_CENTER = { lat: 26.82, lng: 80.97 };
const FLEET_WS_URL = process.env.NEXT_PUBLIC_SIM_WS_URL ?? 'ws://localhost:4001';

// --------------------------------------------------------------------------
// DeckGLOverlay
// --------------------------------------------------------------------------
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

  // No dep array — runs after every render to propagate animated layer props.
  useEffect(() => {
    overlayRef.current?.setProps({
      layers: layers.filter((l): l is Layer => l !== null),
    });
  });

  return null;
}

// --------------------------------------------------------------------------
// MapLegend
// --------------------------------------------------------------------------
function MapLegend({
  fleetCount, evadingCount, routeSource, corridorSource,
  originName, destinationName,
}: {
  fleetCount: number;
  evadingCount: number;
  routeSource?: string;
  corridorSource?: 'road-aligned' | 'ws-based' | 'none';
  originName?: string;
  destinationName?: string;
}) {
  return (
    <div style={{
      position: 'absolute', top: 16, right: 16, zIndex: 10,
      padding: '10px 16px', borderRadius: 8,
      background: 'rgba(0,0,0,0.80)',
      color: '#fff', fontFamily: 'monospace', fontSize: 12, lineHeight: 2,
      minWidth: 220,
    }}>
      {/* Hospital route summary */}
      {(originName || destinationName) && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ color: '#60a5fa', fontWeight: 700, fontSize: 10, letterSpacing: 1, marginBottom: 2 }}>ACTIVE ROUTE</div>
          <div style={{ color: '#fff', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#22c55e' }}>✚</span>
            <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{originName ?? 'Pickup Hospital'}</span>
          </div>
          <div style={{ color: '#6b7280', fontSize: 10, paddingLeft: 16 }}>↓</div>
          <div style={{ color: '#fff', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#ef4444' }}>✚</span>
            <span style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{destinationName ?? 'Destination Hospital'}</span>
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', margin: '6px 0 2px' }} />
        </div>
      )}
      <div style={{ color: '#ff4444', fontWeight: 700 }}>▬ CORRIDOR (emergency zone)</div>
      <div style={{ color: '#ff8c00', fontSize: 10, marginTop: -4 }}>  ⚠ 150 m warning band</div>
      <div style={{ color: '#1e78ff' }}>● FLEET  ({fleetCount} vehicles)</div>
      <div style={{ color: '#ffa500' }}>● EVADING  ({evadingCount} rerouting)</div>
      <div style={{ color: '#ffffff' }}>◎ AMBULANCE</div>
      <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', margin: '4px 0' }} />
      <div style={{ color: '#ffa500' }}>◉ REROUTING</div>
      <div style={{ color: '#22c55e' }}>◉ COMPLETED</div>
      <div style={{ color: '#ef4444' }}>◉ FAILED</div>
      <div style={{ color: '#00d2be' }}>━ REROUTE PATH</div>
      {routeSource && (
        <div style={{
          borderTop: '1px solid rgba(255,255,255,0.15)',
          marginTop: 4, paddingTop: 4,
          color: routeSource === 'api' || routeSource === 'cached' ? '#22c55e' : routeSource === 'prerecorded' ? '#fbbf24' : routeSource === 'unavailable' ? '#ef4444' : '#6b7280',
          fontSize: 10,
        }}>
          ⬤ ROUTE: {routeSource === 'api' ? 'LIVE API' : routeSource === 'cached' ? 'CACHED (API)' : routeSource === 'prerecorded' ? 'PRE-RECORDED' : routeSource === 'unavailable' ? 'UNAVAILABLE' : 'LOADING…'}
        </div>
      )}
      {corridorSource && corridorSource !== 'none' && (
        <div style={{
          color: corridorSource === 'road-aligned' ? '#22c55e' : '#fbbf24',
          fontSize: 10,
        }}>
          ⬤ CORRIDOR: {corridorSource === 'road-aligned' ? 'ROAD-ALIGNED' : 'PING-BASED'}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// MapScene — inner component that has access to the Google Maps instance
// --------------------------------------------------------------------------
interface MapSceneProps {
  backendWsUrl: string;
  onHandoff?: (p: HandoffInitiatedPayload) => void;
  origin?: GeoPoint;
  destination?: GeoPoint;
  polyline?: GeoPoint[];
  etaSeconds?: number;
  startedAt?: string | null;
  routeSource?: string;
  /** Road-aligned corridor from MissionContext (preferred). */
  corridorGeometry?: Geometry | null;
}

function MapScene({
  backendWsUrl,
  onHandoff,
  origin,
  destination,
  polyline = [],
  etaSeconds = 0,
  startedAt,
  routeSource,
  corridorGeometry,
}: MapSceneProps) {
  const { ambulanceLat, ambulanceLng, corridorGeoJSON, handoffState } =
    useSipraWebSocket(backendWsUrl);
  const map = useMap();
  const { originName, destinationName } = useHospitalNames(origin, destination);
  const didFitRef = useRef(false);

  useEffect(() => {
    if (handoffState) onHandoff?.(handoffState);
  }, [handoffState, onHandoff]);

  // ── Fleet subscribers (port 4001) ─────────────────────────────────────
  const [fleet, setFleet] = useState<FleetVehicle[]>([]);
  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    const connect = () => {
      ws = new WebSocket(FLEET_WS_URL);
      ws.onmessage = ({ data }) => {
        try { setFleet(JSON.parse(data as string) as FleetVehicle[]); } catch { /* ignore */ }
      };
      ws.onclose = () => { reconnectTimer = setTimeout(connect, 3_000); };
      ws.onerror = () => ws.close();
    };
    connect();
    return () => { ws?.close(); clearTimeout(reconnectTimer); };
  }, []);

  // ── Animated ambulance position (WS primary, polyline fallback) ────────
  const ambulance = useAmbulanceAnimation(
    ambulanceLat, ambulanceLng, polyline, etaSeconds, startedAt, origin,
  );

  // ── Fit map bounds to polyline once ───────────────────────────────────
  useEffect(() => {
    if (!map || didFitRef.current) return;
    if (polyline.length >= 2) {
      const bounds = new google.maps.LatLngBounds();
      polyline.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
      map.fitBounds(bounds, 60);
      didFitRef.current = true;
    } else if (origin && destination) {
      const bounds = new google.maps.LatLngBounds();
      bounds.extend({ lat: origin.lat, lng: origin.lng });
      bounds.extend({ lat: destination.lat, lng: destination.lng });
      map.fitBounds(bounds, 80);
      // Don't mark done — refit when polyline arrives.
    }
  }, [map, polyline, origin, destination]);

  // ── Prefer road-aligned corridor; fall back to WS-pushed GeoJSON ──────
  const activeCorridor: Geometry | null = corridorGeometry ?? corridorGeoJSON;
  const corridorSource: 'road-aligned' | 'ws-based' | 'none' =
    corridorGeometry ? 'road-aligned'
    : corridorGeoJSON ? 'ws-based'
    : 'none';

  // ── Layers ─────────────────────────────────────────────────────────────
  const ambulanceLayer = useMemo(() => {
    return new ScatterplotLayer({
      id: 'ambulance',
      data: [{ lat: ambulance.lat, lng: ambulance.lng }],
      getPosition: (d: { lat: number; lng: number }) => [d.lng, d.lat],
      getRadius: 14,
      getFillColor: [255, 255, 255, 240],
      getLineColor: [220, 0, 0, 255],
      getLineWidth: 3,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
      transitions: { getPosition: { duration: 300 } },
    });
  }, [ambulance.lat, ambulance.lng]);

  const routePathLayer = useRoutePathLayer(origin, destination, polyline);
  const hospitalLayers = useHospitalLayer(origin, destination, { originName, destinationName });
  const exclusionLayer = useExclusionLayer(activeCorridor, handoffState ? 2 : 1);
  // useFleetLayer returns [circleLayer, arrowLayer] — spread both
  const [fleetCircleLayer, fleetArrowLayer] = useFleetLayer(fleet);

  const evadingCount = fleet.filter(v => v.evading).length;

  return (
    <>
      <MapLegend
        fleetCount={fleet.length}
        evadingCount={evadingCount}
        routeSource={routeSource}
        corridorSource={corridorSource}
        originName={originName}
        destinationName={destinationName}
      />
      <DeckGLOverlay layers={[routePathLayer, ...hospitalLayers, exclusionLayer, fleetCircleLayer, fleetArrowLayer, ambulanceLayer]} />
    </>
  );
}

// --------------------------------------------------------------------------
// CorridorMap — public component
// --------------------------------------------------------------------------
interface CorridorMapProps {
  googleMapsApiKey: string;
  backendWsUrl?: string;
  onHandoff?: (p: HandoffInitiatedPayload) => void;
  origin?: GeoPoint;
  destination?: GeoPoint;
  /** Decoded road-geometry waypoints from the Directions API (or pre-recorded fallback). */
  polyline?: GeoPoint[];
  etaSeconds?: number;
  startedAt?: string | null;
  routeSource?: string;
  /** Road-aligned corridor polygon from MissionContext (preferred over WS GeoJSON). */
  corridorGeometry?: Geometry | null;
}

export default function CorridorMap({
  googleMapsApiKey,
  backendWsUrl = 'ws://localhost:8080/ws/dashboard',
  onHandoff,
  origin,
  destination,
  polyline = [],
  etaSeconds = 0,
  startedAt,
  routeSource,
  corridorGeometry,
}: CorridorMapProps) {
  return (
    <APIProvider apiKey={googleMapsApiKey}>
      <div style={{ width: '100%', height: '100vh', position: 'relative' }}>
        <Map
          defaultCenter={DEFAULT_CENTER}
          defaultZoom={14}
          mapId="sipra-dark-v1"
          gestureHandling="greedy"
          disableDefaultUI={false}
        >
          <MapScene
            backendWsUrl={backendWsUrl}
            onHandoff={onHandoff}
            origin={origin}
            destination={destination}
            polyline={polyline}
            etaSeconds={etaSeconds}
            startedAt={startedAt}
            routeSource={routeSource}
            corridorGeometry={corridorGeometry}
          />
        </Map>
      </div>
    </APIProvider>
  );
}

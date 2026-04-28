'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { Geometry } from 'geojson';

import { useCircularZoneLayer, useWarningZoneLayer } from './ExclusionPolygon';
import { useFleetLayer } from './FleetSwarm';
import { useHospitalLayer } from './HospitalMarkers';
import { useRoutePathLayer } from './RoutePath';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useAmbulanceAnimation } from '../../hooks/useAmbulanceAnimation';
import { useHospitalNames } from '../../hooks/useHospitalNames';
import { useCorridorGeometry } from '../../hooks/useCorridorGeometry';
import type { FleetVehicle, GeoPoint, HandoffInitiatedPayload } from '../../lib/types';

// Default viewport: Lucknow — matches the Medanta → Tender Palm route.
const DEFAULT_CENTER = { lat: 26.82, lng: 80.97 };
const FLEET_WS_URL = process.env.NEXT_PUBLIC_SIM_WS_URL ?? 'ws://localhost:4001';
const SIM_WS_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SIM_WS === 'true';

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
  fleetCount, alertedCount, warningCount, routeSource, corridorSource,
  originName, destinationName, directionsStatus, handoffActive,
  ambulanceSpeedKmh, distanceText, durationText,
}: {
  fleetCount: number;
  alertedCount: number;
  warningCount: number;
  routeSource?: string;
  corridorSource?: 'road-aligned' | 'ws-based' | 'none';
  originName?: string;
  destinationName?: string;
  directionsStatus: 'loading' | 'live' | 'fallback' | 'error';
  handoffActive?: boolean;
  ambulanceSpeedKmh?: number;
  distanceText?: string;
  durationText?: string;
}) {
  const dsColor =
    directionsStatus === 'live'    ? '#22c55e' :
    directionsStatus === 'loading' ? '#fbbf24' :
    directionsStatus === 'error'   ? '#ef4444' : '#94a3b8';

  const dsLabel =
    directionsStatus === 'live'    ? 'LIVE (DirectionsService)' :
    directionsStatus === 'loading' ? 'FETCHING…' :
    directionsStatus === 'error'   ? 'ERROR – pre-recorded fallback' :
    'FALLBACK';

  const routeSummary = distanceText && durationText
    ? `${distanceText} · ${durationText}`
    : distanceText || durationText || '';

  return (
    <div style={{
      position: 'absolute', top: 16, right: 16, zIndex: 10,
      padding: '10px 16px', borderRadius: 8,
      background: 'rgba(0,0,0,0.82)',
      color: '#fff', fontFamily: 'monospace', fontSize: 12, lineHeight: 2,
      minWidth: 230,
    }}>
      {(originName || destinationName) && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ color: '#60a5fa', fontWeight: 700, fontSize: 10, letterSpacing: 1, marginBottom: 2 }}>
            ACTIVE ROUTE{routeSummary ? ` · ${routeSummary}` : ''}
          </div>
          <div style={{ color: '#fff', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#22c55e' }}>✚</span>
            <span style={{ maxWidth: 165, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{originName ?? 'Origin'}</span>
          </div>
          <div style={{ color: '#6b7280', fontSize: 10, paddingLeft: 16 }}>↓</div>
          <div style={{ color: '#fff', fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
            <span style={{ color: '#ef4444' }}>✚</span>
            <span style={{ maxWidth: 165, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{destinationName ?? 'Destination'}</span>
          </div>
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', margin: '6px 0 2px' }} />
        </div>
      )}

      {/* Zone info — hidden during drone handoff (ground corridor is unmounted) */}
      {!handoffActive && (
        <>
          <div style={{ color: '#ff4444', fontWeight: 700 }}>◉ 2 KM EXCLUSION ZONE</div>
          <div style={{ color: '#ff8c00', fontSize: 10, marginTop: -4 }}>  Critical zone · immediate reroute required</div>
          <div style={{ color: '#ffaa00', fontWeight: 700 }}>◉ 3 KM WARNING ZONE</div>
          <div style={{ color: '#ffcc00', fontSize: 10, marginTop: -4 }}>  Caution zone · prepare for reroute</div>
        </>
      )}

      {/* Fleet */}
      <div style={{ color: '#1e78ff' }}>● FLEET IN ZONES  ({fleetCount} vehicles)</div>
      <div style={{ color: '#ff501e', fontWeight: alertedCount > 0 ? 700 : 400 }}>
        🔴 IN RED ZONE  ({alertedCount} critical)
      </div>
      <div style={{ color: '#ffaa00', fontWeight: warningCount > 0 ? 700 : 400 }}>
        🟡 IN YELLOW ZONE  ({warningCount} warning)
      </div>

      {/* Ambulance */}
      <div style={{ color: '#ffffff' }}>◎ AMBULANCE</div>
      {ambulanceSpeedKmh !== undefined && (
        <div style={{ color: '#22c55e', fontSize: 11, fontWeight: 700, marginTop: -2 }}>
          🚑 {ambulanceSpeedKmh} km/hr
        </div>
      )}

      {/* Drone handoff indicator */}
      {handoffActive && (
        <div style={{ color: '#7c3aed', fontWeight: 700 }}>🚁 DRONE HANDOFF ACTIVE — AIR CORRIDOR OPEN</div>
      )}

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', margin: '4px 0' }} />
      <div style={{ color: '#ffa500' }}>◉ REROUTING</div>
      <div style={{ color: '#22c55e' }}>◉ COMPLETED</div>
      <div style={{ color: '#ef4444' }}>◉ FAILED</div>

      <div style={{
        borderTop: '1px solid rgba(255,255,255,0.15)',
        marginTop: 4, paddingTop: 4,
        color: dsColor, fontSize: 10,
      }}>
        ⬤ ROUTE: {dsLabel}
      </div>

      {routeSource && (
        <div style={{
          color: routeSource === 'api' || routeSource === 'cached' ? '#22c55e'
            : routeSource === 'prerecorded' ? '#fbbf24'
            : routeSource === 'unavailable' ? '#ef4444' : '#6b7280',
          fontSize: 10,
        }}>
          ⬤ PROXY: {routeSource === 'api' ? 'LIVE API' : routeSource === 'cached' ? 'CACHED' : routeSource === 'prerecorded' ? 'PRE-RECORDED' : routeSource === 'unavailable' ? 'UNAVAILABLE' : 'LOADING…'}
        </div>
      )}
      {corridorSource && corridorSource !== 'none' && (
        <div style={{ color: corridorSource === 'road-aligned' ? '#22c55e' : '#fbbf24', fontSize: 10 }}>
          ⬤ ROUTE: {corridorSource === 'road-aligned' ? 'ROAD-ALIGNED' : 'PING-BASED'}
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// MapScene
// --------------------------------------------------------------------------
export interface RouteTelemetry {
  distanceMeters: number;
  durationSeconds: number;
  distanceText: string;
  durationText: string;
}

interface MapSceneProps {
  backendWsUrl: string;
  onHandoff?: (p: HandoffInitiatedPayload) => void;
  onRouteResolved?: (info: RouteTelemetry) => void;
  origin?: GeoPoint;
  destination?: GeoPoint;
  polyline?: GeoPoint[];
  etaSeconds?: number;
  startedAt?: string | null;
  routeSource?: string;
  corridorGeometry?: Geometry | null;
}

interface DroneDot {
  pos: [number, number];
}

function MapScene({
  backendWsUrl,
  onHandoff,
  onRouteResolved,
  origin,
  destination,
  polyline: fallbackPolyline = [],
  etaSeconds: fallbackEta = 0,
  startedAt,
  routeSource,
  corridorGeometry,
}: MapSceneProps) {
  const { ambulanceLat, ambulanceLng, ambulanceSpeedKph, corridorGeoJSON, handoffState, fleet: wsFleet } =
    useSipraWebSocket(backendWsUrl);
  const map = useMap();
  const { originName, destinationName } = useHospitalNames(
    origin,
    destination,
    { originName: 'Origin', destinationName: 'Destination' },
  );
  const didFitRef = useRef(false);

  useEffect(() => {
    if (handoffState) onHandoff?.(handoffState);
  }, [handoffState, onHandoff]);

  // ── DirectionsService — authoritative road-snapped route ───────────────
  const [actualRoute, setActualRoute] = useState<GeoPoint[]>([]);
  const [directionsEta, setDirectionsEta] = useState<number>(0);
  const [directionsDistanceM, setDirectionsDistanceM] = useState<number>(0);
  const [distanceText, setDistanceText] = useState<string>('');
  const [durationText, setDurationText] = useState<string>('');
  const [directionsStatus, setDirectionsStatus] = useState<'loading' | 'live' | 'fallback' | 'error'>('loading');
  const directionsCalledRef = useRef(false);

  useEffect(() => {
    if (!SIM_WS_ENABLED || !FLEET_WS_URL) {
      setFleet([]);
      return;
    }

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

    if (!origin || !destination) return;

    directionsCalledRef.current = true;
    const requestOrigin = origin;
    const requestDest   = destination;

    const svc = new google.maps.DirectionsService();
    svc.route(
      {
        origin:      { lat: requestOrigin.lat, lng: requestOrigin.lng },
        destination: { lat: requestDest.lat,   lng: requestDest.lng },
        travelMode:  google.maps.TravelMode.DRIVING,
        drivingOptions: {
          departureTime: new Date(),
          trafficModel:  google.maps.TrafficModel.BEST_GUESS,
        },
      },
      (response, status) => {
        if (status !== google.maps.DirectionsStatus.OK || !response) {
          console.warn('[CorridorMap] DirectionsService error:', status);
          setDirectionsStatus('error');
          return;
        }
        const route = response.routes[0];
        if (!route) { setDirectionsStatus('error'); return; }

        // overview_path is the source of truth for the blue PathLayer + ambulance loop.
        const roadPath: GeoPoint[] = route.overview_path.map(latLng => ({
          lat: latLng.lat(),
          lng: latLng.lng(),
        }));

        if (roadPath.length < 2) { setDirectionsStatus('error'); return; }

        const leg = route.legs[0];
        const etaSecs = leg?.duration_in_traffic?.value ?? leg?.duration?.value ?? 0;
        const distM   = leg?.distance?.value ?? 0;
        const distTxt = leg?.distance?.text ?? '';
        const durTxt  = leg?.duration_in_traffic?.text ?? leg?.duration?.text ?? '';

        console.info(
          `[CorridorMap] DirectionsService OK — ${roadPath.length} pts, ` +
          `${distTxt} / ${durTxt}`,
        );

        setActualRoute(roadPath);
        setDirectionsEta(etaSecs);
        setDirectionsDistanceM(distM);
        setDistanceText(distTxt);
        setDurationText(durTxt);
        setDirectionsStatus('live');

        onRouteResolved?.({
          distanceMeters:  distM,
          durationSeconds: etaSecs,
          distanceText:    distTxt,
          durationText:    durTxt,
        });
      },
    );
  }, [map, origin, destination, onRouteResolved]);

  useEffect(() => {
    directionsCalledRef.current = false;
    setActualRoute([]);
    setDirectionsEta(0);
    setDirectionsDistanceM(0);
    setDistanceText('');
    setDurationText('');
    setDirectionsStatus('loading');
  }, [origin?.lat, origin?.lng, destination?.lat, destination?.lng]);

  const activePolyline = actualRoute.length >= 2 ? actualRoute : fallbackPolyline;
  const activeEta      = directionsEta > 0        ? directionsEta : fallbackEta;

  // ── Ambulance position (road-snapped) ──────────────────────────────────
  const ambulance = useAmbulanceAnimation(
    ambulanceLat, ambulanceLng, activePolyline, activeEta, startedAt,
    origin,
  );
  const ambulancePos: GeoPoint = { lat: ambulance.lat, lng: ambulance.lng };

  // ── Fit bounds ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!map || didFitRef.current) return;
    if (activePolyline.length >= 2) {
      const bounds = new google.maps.LatLngBounds();
      activePolyline.forEach(p => bounds.extend({ lat: p.lat, lng: p.lng }));
      map.fitBounds(bounds, 60);
      didFitRef.current = true;
    } else if (origin && destination) {
      const bounds = new google.maps.LatLngBounds();
      bounds.extend({ lat: origin.lat, lng: origin.lng });
      bounds.extend({ lat: destination.lat, lng: destination.lng });
      map.fitBounds(bounds, 80);
    }
  }, [map, activePolyline, origin, destination]);

  // ── Corridor for route line ────────────────────────────────────────────
  const localCorridorGeometry = useCorridorGeometry(activePolyline, 75);
  const corridorSource: 'road-aligned' | 'ws-based' | 'none' =
    localCorridorGeometry ? 'road-aligned'
    : (corridorGeometry ?? corridorGeoJSON) ? 'ws-based'
    : 'none';

  const isHandoff = !!handoffState;

  // ── Ground exclusion zones — suppressed when the drone takes over ──────
  const groundZonePos: GeoPoint | null = isHandoff ? null : ambulancePos;

  const [zoneFillLayer, zoneRingLayer] = useCircularZoneLayer(
    groundZonePos, EXCLUSION_RADIUS_M, 1,
  );
  const [warningFillLayer, warningRingLayer] = useWarningZoneLayer(
    groundZonePos, WARNING_RADIUS_M, 0.8,
  );

  // ── Drone flight: spawn at ambulance stop, fly straight to destination ─
  const droneSpawnRef   = useRef<GeoPoint | null>(null);
  const droneStartMsRef = useRef<number>(0);

  useEffect(() => {
    if (isHandoff && !droneSpawnRef.current) {
      droneSpawnRef.current = { lat: ambulance.lat, lng: ambulance.lng };
      droneStartMsRef.current = Date.now();
    }
    if (!isHandoff) {
      droneSpawnRef.current = null;
    }
  }, [isHandoff, ambulance.lat, ambulance.lng]);

  const [droneFrame, setDroneFrame] = useState<{
    lat: number; lng: number; pulse: number; bearingDeg: number;
  } | null>(null);

  useEffect(() => {
    if (!isHandoff) {
      setDroneFrame(null);
      return;
    }
    const dest = destination;
    if (!dest) return;
    let rafId: number;

    const tick = (ts: number) => {
      const pulse = (Math.sin(ts * 0.006) + 1) / 2;
      const spawn = droneSpawnRef.current;
      if (spawn) {
        const t = Math.min(1, (Date.now() - droneStartMsRef.current) / DRONE_FLIGHT_MS);
        const lat = spawn.lat + (dest.lat - spawn.lat) * t;
        const lng = spawn.lng + (dest.lng - spawn.lng) * t;
        // Bearing from spawn → dest (constant for the whole flight; cheap to recompute)
        const bearingDeg =
          (Math.atan2(dest.lng - spawn.lng, dest.lat - spawn.lat) * 180) / Math.PI;
        setDroneFrame({ lat, lng, pulse, bearingDeg });
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isHandoff, destination]);

  // Outer violet aura — pulsing disc beneath the drone for visibility.
  const droneAuraLayer = useMemo((): ScatterplotLayer<DroneDot> | null => {
    if (!droneFrame) return null;
    const { lat, lng, pulse } = droneFrame;
    const radius = Math.round(60 + pulse * 40);
    const alpha  = Math.round((0.08 + pulse * 0.20) * 255);
    return new ScatterplotLayer<DroneDot>({
      id: 'drone-aura',
      data: [{ pos: [lng, lat] }],
      getPosition: d => d.pos,
      getRadius: radius,
      getFillColor: [167, 139, 250, alpha],
      getLineColor: [0, 0, 0, 0],
      radiusUnits: 'pixels',
      stroked: false,
      filled: true,
      pickable: false,
      updateTriggers: { getRadius: radius, getFillColor: alpha },
    });
  }, [droneFrame]);

  // Drone IconLayer — the actual drone marker, rotated toward destination.
  const droneIconLayer = useMemo((): IconLayer<DroneDot> | null => {
    if (!droneFrame) return null;
    const { lat, lng, pulse, bearingDeg } = droneFrame;
    const size = Math.round(44 + pulse * 8);
    return new IconLayer<DroneDot>({
      id: 'drone-icon',
      data: [{ pos: [lng, lat] }],
      getPosition: d => d.pos,
      getIcon: () => ({
        url:     DRONE_ICON_URL,
        width:   64,
        height:  64,
        anchorX: 32,
        anchorY: 32,
      }),
      getSize:   size,
      getAngle:  bearingDeg,
      sizeUnits: 'pixels',
      pickable:  false,
      updateTriggers: { getSize: size, getAngle: bearingDeg },
    });
  }, [droneFrame]);

  // ── Fleet proximity tagging ────────────────────────────────────────────
  // Fleet comes from the backend WS (FLEET_UPDATE from simulator, FLEET_SPAWN from chaos).
  const fleet = useMemo<FleetVehicle[]>(() => {
    if (wsFleet.length === 0) return wsFleet;
    return wsFleet
      .map(v => {
        const distKm = haversineKm(ambulancePos, { lat: v.lat, lng: v.lng });
        const inRedZone    = distKm <= EXCLUSION_RADIUS_KM;
        const inYellowZone = !inRedZone && distKm <= WARNING_RADIUS_KM;
        return { ...v, evading: inRedZone, inWarningZone: inYellowZone };
      })
      .filter(v => v.evading || v.inWarningZone);
  }, [wsFleet, ambulancePos.lat, ambulancePos.lng]);

  const alertedCount      = fleet.filter(v => v.evading).length;
  const warningCount      = fleet.filter(v => v.inWarningZone).length;
  const totalFleetInZones = fleet.length;

  // ── Ambulance marker ───────────────────────────────────────────────────
  const ambulanceLayer = useMemo(() => new ScatterplotLayer({
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
  }), [ambulance.lat, ambulance.lng]);

  const routePathLayer = useRoutePathLayer(
    origin,
    destination,
    activePolyline,
  );

  // 3D hospital scenegraph + dark-slate label.
  // The brief mandates the suffix '(PICKUP)' / '(DESTINATION)'.
  const hospitalLayers = useHospitalLayer(
    origin,
    destination,
    {
      originName:      `${(originName      ?? 'Origin').toUpperCase()} (PICKUP)`,
      destinationName: `${(destinationName ?? 'Destination').toUpperCase()} (DESTINATION)`,
    },
  );

  const [fleetCircleLayer, fleetArrowLayer] = useFleetLayer(fleet);

  return (
    <>
      <MapLegend
        fleetCount={totalFleetInZones}
        alertedCount={alertedCount}
        warningCount={warningCount}
        routeSource={routeSource}
        corridorSource={corridorSource}
        originName={originName}
        destinationName={destinationName}
        directionsStatus={directionsStatus}
        handoffActive={isHandoff}
        ambulanceSpeedKmh={ambulanceSpeedKph ?? undefined}
        distanceText={distanceText}
        durationText={durationText}
      />
      <DeckGLOverlay
        layers={[
          // Blue PathLayer — sourced from overview_path
          routePathLayer,
          // Ground exclusion zones — null during DRONE_HANDOFF
          warningFillLayer,
          warningRingLayer,
          zoneFillLayer,
          zoneRingLayer,
          // Fleet (only in-zone vehicles render)
          fleetCircleLayer,
          fleetArrowLayer,
          // Ambulance marker
          ambulanceLayer,
          // 3D hospitals + labels (rendered last so they draw on top)
          ...hospitalLayers,
          // Drone — aura beneath, IconLayer on top (only during DRONE_HANDOFF)
          droneAuraLayer,
          droneIconLayer,
        ]}
      />
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
  onRouteResolved?: (info: RouteTelemetry) => void;
  origin?: GeoPoint;
  destination?: GeoPoint;
  polyline?: GeoPoint[];
  etaSeconds?: number;
  startedAt?: string | null;
  routeSource?: string;
  corridorGeometry?: Geometry | null;
}

export default function CorridorMap({
  googleMapsApiKey,
  backendWsUrl = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard',
  onHandoff,
  onRouteResolved,
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
          defaultZoom={13}
          defaultTilt={45}
          defaultHeading={0}
          mapId="sipra-dark-v1"
          gestureHandling="greedy"
          disableDefaultUI={false}
        >
          <MapScene
            backendWsUrl={backendWsUrl}
            onHandoff={onHandoff}
            onRouteResolved={onRouteResolved}
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

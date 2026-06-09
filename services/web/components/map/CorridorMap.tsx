'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, AdvancedMarker, AdvancedMarkerAnchorPoint, Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { Geometry } from 'geojson';

import { useCircularZoneLayer, useWarningZoneLayer } from './ExclusionPolygon';
import { useFleetLayer } from './FleetSwarm';
import { useHospitalLayer } from './HospitalMarkers';
import { useRoutePathLayer } from './RoutePath';
import DroneThreeOverlay from './DroneThreeOverlay';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useAmbulanceAnimation } from '../../hooks/useAmbulanceAnimation';
import { useHospitalNames } from '../../hooks/useHospitalNames';
import { useCorridorGeometry } from '../../hooks/useCorridorGeometry';
import { useMission } from '../../lib/MissionContext';
import type { FleetVehicle, GeoPoint, HandoffInitiatedPayload } from '../../lib/types';

// ---------------------------------------------------------------------------
// Map Defaults
// ---------------------------------------------------------------------------
const DEFAULT_CENTER  = { lat: 12.9716, lng: 77.5946 }; // Bangalore

// 2 km exclusion zone radius (metres)
const EXCLUSION_RADIUS_M  = 2_000;
const EXCLUSION_RADIUS_KM = EXCLUSION_RADIUS_M / 1_000;

// 3 km warning zone radius (metres)
const WARNING_RADIUS_M = 3_000;
const WARNING_RADIUS_KM = WARNING_RADIUS_M / 1_000;

// ---------------------------------------------------------------------------
// Haversine distance helper (km)
// ---------------------------------------------------------------------------
const DEG = Math.PI / 180;
function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

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
  const [keyOpen, setKeyOpen] = useState(false);

  const routeSummary = distanceText && durationText
    ? `${distanceText} · ${durationText}`
    : distanceText || durationText || '';

  const dsDot =
    directionsStatus === 'live'    ? 'bg-green-500' :
    directionsStatus === 'loading' ? 'bg-amber-400 animate-pulse' : 'bg-red-500';

  const dsLabel =
    directionsStatus === 'live'    ? 'Live route' :
    directionsStatus === 'loading' ? 'Fetching…' :
    directionsStatus === 'error'   ? 'Fallback' : 'Fallback';

  return (
    <div className="absolute top-4 right-4 z-10 font-mono text-xs min-w-[220px] max-w-[260px]">
      <div className="bg-black/80 backdrop-blur-sm rounded-lg border border-white/10 text-white overflow-hidden shadow-xl">

        {/* Route header */}
        {(originName || destinationName) && (
          <div className="px-3 py-2 border-b border-white/10">
            <div className="text-[10px] text-blue-400 font-bold uppercase tracking-wider mb-1">
              Route{routeSummary ? ` · ${routeSummary}` : ''}
            </div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-green-500 font-bold shrink-0">✚</span>
              <span className="truncate text-white/90">{originName ?? 'Origin'}</span>
            </div>
            <div className="text-[10px] text-white/30 pl-4">↓</div>
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-red-400 font-bold shrink-0">✚</span>
              <span className="truncate text-white/90">{destinationName ?? 'Destination'}</span>
            </div>
          </div>
        )}

        {/* Live vitals */}
        <div className="px-3 py-2 space-y-1.5">
          {handoffActive ? (
            <div className="flex items-center gap-2 text-violet-300 font-bold">
              <span className="w-2 h-2 rounded-full bg-violet-400 animate-pulse shrink-0" />
              <span>Drone active — air corridor open</span>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <span className="text-red-400 font-semibold">◉ Exclusion zone</span>
                <span className={`tabular-nums font-bold ${alertedCount > 0 ? 'text-red-400' : 'text-white/50'}`}>
                  {alertedCount} veh
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-amber-400 font-semibold">◉ Warning zone</span>
                <span className={`tabular-nums font-bold ${warningCount > 0 ? 'text-amber-400' : 'text-white/50'}`}>
                  {warningCount} veh
                </span>
              </div>
            </>
          )}

          <div className="flex items-center justify-between text-blue-400/80">
            <span>Fleet in zones</span>
            <span className="font-bold tabular-nums">{fleetCount}</span>
          </div>

          {ambulanceSpeedKmh !== undefined && (
            <div className="flex items-center justify-between">
              <span className="text-white/60">Ambulance</span>
              <span className="text-green-400 font-bold tabular-nums">{ambulanceSpeedKmh} km/h</span>
            </div>
          )}
        </div>

        {/* Footer: route source dot + map-key toggle */}
        <div className="flex items-center justify-between px-3 py-1.5 border-t border-white/10 bg-white/5">
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dsDot}`} />
            <span className="text-[10px] text-white/50 uppercase tracking-wide">{dsLabel}</span>
            {routeSource && (
              <>
                <span className="text-white/20">·</span>
                <span className={`text-[10px] uppercase tracking-wide ${
                  routeSource === 'api' || routeSource === 'cached' ? 'text-green-400/70' :
                  routeSource === 'prerecorded' ? 'text-amber-400/70' : 'text-red-400/70'
                }`}>
                  {routeSource === 'api' ? 'API' : routeSource === 'cached' ? 'Cached' :
                   routeSource === 'prerecorded' ? 'Pre-rec' : 'N/A'}
                </span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setKeyOpen(o => !o)}
            className="text-[10px] text-white/40 hover:text-white/70 transition-colors uppercase tracking-wide"
          >
            {keyOpen ? 'Key ▲' : 'Key ▼'}
          </button>
        </div>

        {/* Expandable static key */}
        {keyOpen && (
          <div className="px-3 py-2 border-t border-white/10 space-y-1 text-[10px] text-white/70">
            {!handoffActive && (
              <>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-red-500/80 shrink-0" />
                  <span>2 km exclusion — reroute required</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-amber-500/80 shrink-0" />
                  <span>3 km warning — prepare to reroute</span>
                </div>
              </>
            )}
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-white/80 shrink-0" />
              <span>Ambulance</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
              <span>Rerouting</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
              <span>Completed</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
              <span>Failed</span>
            </div>
            {corridorSource && corridorSource !== 'none' && (
              <div className="flex items-center gap-2 pt-0.5 border-t border-white/10 mt-0.5">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${corridorSource === 'road-aligned' ? 'bg-green-500' : 'bg-amber-400'}`} />
                <span>{corridorSource === 'road-aligned' ? 'Road-aligned corridor' : 'Ping-based corridor'}</span>
              </div>
            )}
          </div>
        )}
      </div>
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
  const mission = useMission();
  const currentTripId = mission.trip?.id ?? null;
  const tripStatus = mission.trip?.status ?? null;
  const { ambulanceLat, ambulanceLng, ambulanceSpeedKph, corridorGeoJSON, handoffState, handoffStartedAt, riskPrediction, fleet: wsFleet } =
    useSipraWebSocket(backendWsUrl, currentTripId);
  const map = useMap();

  // The WS hook now drops any payload whose trip_id doesn't match
  // currentTripId, so handoff/risk state already belongs to this trip.
  const handoffForCurrentTrip = handoffState;
  const aiRecommendsDrone = riskPrediction?.recommendation === 'DISPATCH_DRONE';
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
    if (!map || directionsCalledRef.current) return;
    if (typeof google === 'undefined' || !google.maps?.DirectionsService) return;

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

  // ── Drone state — three-trigger activation, scoped to current trip ──────
  // `droneActive` is the single source of truth for "should the dashboard
  // show drone-mode". It gates ambulance, fleet, ground rings, drone marker,
  // aura, and ETA chip. The trip status path makes it durable across reloads
  // without needing a sticky local flag — once the backend sets
  // status='DroneHandoff' it never reverts.
  const droneActive =
    handoffForCurrentTrip !== null ||
    tripStatus === 'DroneHandoff' ||
    aiRecommendsDrone;

  // Real drone flight ETA from the backend (drone-dispatch mock computes it
  // from haversine(pickup, dropoff) / cruise_kph + spin-up). Falls back to 0
  // when handoff data isn't available — in that case the drone is rendered
  // stationary at spawn rather than animated by a magic-number flight time.
  const droneEtaSecondsTotal = handoffForCurrentTrip?.eta_seconds ?? 0;
  const flightDurationMs = droneEtaSecondsTotal * 1_000;

  // Drone spawn position — captured the first time droneActive flips true.
  // Resets when the trip changes so a previous trip's drone never lingers.
  const [droneSpawn, setDroneSpawn] = useState<GeoPoint | null>(null);
  type DroneFrame = { lat: number; lng: number; pulse: number; bearingDeg: number; etaSec: number };
  const droneFrameRef = useRef<DroneFrame | null>(null);

  // Reset session-scoped drone state when the active trip changes — without
  // this, switching from s3 (drone) to s1 (normal) would keep the drone
  // marker, fit-bounds flag, and any in-flight frame around.
  const droneFitRef = useRef(false);
  useEffect(() => {
    setDroneSpawn(null);
    droneFrameRef.current = null;
    droneFitRef.current = false;
  }, [currentTripId]);

  useEffect(() => {
    if (droneSpawn || !droneActive) return;
    const lat = ambulance.lat || origin?.lat || 0;
    const lng = ambulance.lng || origin?.lng || 0;
    if (lat === 0 && lng === 0) return; // wait for valid coords
    setDroneSpawn({ lat, lng });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [droneActive, ambulance.lat, ambulance.lng, origin?.lat, origin?.lng]);

  // Fit-bounds when drone mode activates so the entire flight path is in
  // view. This is the catch-all that handles users who reload after the
  // handoff (handoffState=null, but tripStatus='DroneHandoff' triggers
  // droneActive). Fires exactly once per trip.
  useEffect(() => {
    if (!droneActive || droneFitRef.current) return;
    if (!map || !droneSpawn || !destination) return;
    droneFitRef.current = true;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend({ lat: droneSpawn.lat, lng: droneSpawn.lng });
    bounds.extend({ lat: destination.lat, lng: destination.lng });
    map.fitBounds(bounds, 80);
  }, [droneActive, map, droneSpawn, destination]);

  // Live camera follow: keep drone in view as it flies. The fit-bounds above
  // frames the corridor at handoff; this pan keeps the marker centred even
  // if the operator manually panned away or the route extends past initial
  // bounds. Skipped while popup is initially being framed.
  useEffect(() => {
    if (!droneActive || !map) return;
    const id = setInterval(() => {
      if (!droneFrameRef.current) return;
      const bounds = map.getBounds();
      if (!bounds) return;
      const ne = bounds.getNorthEast();
      const sw = bounds.getSouthWest();
      const { lat, lng } = droneFrameRef.current;
      const inView =
        lat <= ne.lat() && lat >= sw.lat() &&
        lng <= ne.lng() && lng >= sw.lng();
      if (!inView) map.panTo({ lat, lng });
    }, 2_000);
    return () => clearInterval(id);
  }, [droneActive, map]);

  // ── Ground exclusion zones — dimmed during drone mode, never removed ───
  // The ambulance still physically holds the exclusion corridor until cargo
  // physically transfers; operators need to see where the ground vehicle is.
  const [zoneFillLayer, zoneRingLayer] = useCircularZoneLayer(
    ambulancePos, EXCLUSION_RADIUS_M, droneActive ? 0.25 : 1,
  );
  const [warningFillLayer, warningRingLayer] = useWarningZoneLayer(
    ambulancePos, WARNING_RADIUS_M, droneActive ? 0.2 : 0.8,
  );

  // ── Drone position frame — updated every rAF tick ─────────────────────
  // Animation is driven by the *real* backend ETA. Progress and remaining-
  // seconds both derive from `handoffStartedAt` (set by the WS hook when
  // HANDOFF_INITIATED arrives) and `eta_seconds` (computed by the drone-
  // dispatch service from haversine distance / cruise speed). If either is
  // missing the drone stays at spawn — no fabricated motion.
  const [droneFrame, setDroneFrame] = useState<DroneFrame | null>(null);

  useEffect(() => {
    if (!droneSpawn) {
      setDroneFrame(null);
      droneFrameRef.current = null;
      return;
    }
    const dest = destination ?? droneSpawn;
    const bearingDeg =
      (Math.atan2(dest.lng - droneSpawn.lng, dest.lat - droneSpawn.lat) * 180) / Math.PI;
    let rafId: number;

    const tick = (ts: number) => {
      const pulse = (Math.sin(ts * 0.006) + 1) / 2;

      let t = 0;
      let etaSec = droneEtaSecondsTotal;
      if (handoffStartedAt !== null && flightDurationMs > 0) {
        const elapsedMs = Date.now() - handoffStartedAt;
        t = Math.min(1, Math.max(0, elapsedMs / flightDurationMs));
        etaSec = Math.max(0, droneEtaSecondsTotal - Math.floor(elapsedMs / 1_000));
      }

      const lat = droneSpawn.lat + (dest.lat - droneSpawn.lat) * t;
      const lng = droneSpawn.lng + (dest.lng - droneSpawn.lng) * t;
      const frame: DroneFrame = { lat, lng, pulse, bearingDeg, etaSec };
      droneFrameRef.current = frame;
      setDroneFrame(frame);
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [droneSpawn, destination, handoffStartedAt, flightDurationMs, droneEtaSecondsTotal]);

  // Pulsing violet aura disc (Deck.gl) beneath the Three.js drone canvas.
  const droneAuraLayer = useMemo((): ScatterplotLayer<DroneDot> | null => {
    if (!droneFrame) return null;
    const { lat, lng, pulse } = droneFrame;
    const radius = Math.round(64 + pulse * 36);
    const alpha  = Math.round((0.07 + pulse * 0.18) * 255);
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

  // ── Ambulance marker — dimmed during drone mode, never removed ──────────
  // Keeps the ground vehicle visible so operators retain situational awareness
  // of the ambulance position throughout the handoff.
  const ambulanceLayer = useMemo(() => {
    const fillAlpha = droneActive ? 70  : 240;
    const lineAlpha = droneActive ? 50  : 255;
    const radius    = droneActive ? 10  : 14;
    const lineWidth = droneActive ? 2   : 3;
    return new ScatterplotLayer({
      id: 'ambulance',
      data: [{ lat: ambulance.lat, lng: ambulance.lng }],
      getPosition: (d: { lat: number; lng: number }) => [d.lng, d.lat],
      getRadius: radius,
      getFillColor: [255, 255, 255, fillAlpha],
      getLineColor: [220, 0, 0, lineAlpha],
      getLineWidth: lineWidth,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
      transitions: { getPosition: { duration: 300 } },
      updateTriggers: { getFillColor: fillAlpha, getLineColor: lineAlpha, getRadius: radius },
    });
  }, [ambulance.lat, ambulance.lng, droneActive]);

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
        handoffActive={droneActive}
        ambulanceSpeedKmh={ambulanceSpeedKph ?? undefined}
        distanceText={distanceText}
        durationText={durationText}
      />
      {/* Top-of-map DRONE MODE banner — fires the moment droneActive is true,
          giving operators (and the developer debugging HMR) a visible signal
          that the dashboard has pivoted away from ambulance/corridor mode. */}
      {droneActive && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 pointer-events-none">
          <div className="px-4 py-2 rounded-full bg-violet-700/95 border border-violet-300/60 shadow-lg shadow-violet-500/40 backdrop-blur-sm">
            <div className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest text-violet-50">
              <span className="text-base leading-none">🚁</span>
              <span>Drone Mode · Ambulance handoff complete</span>
            </div>
          </div>
        </div>
      )}
      <DeckGLOverlay
        layers={[
          // Blue PathLayer — sourced from overview_path
          routePathLayer,
          // Ground exclusion zones — dimmed during drone mode
          warningFillLayer,
          warningRingLayer,
          zoneFillLayer,
          zoneRingLayer,
          // Fleet — hidden during drone mode (evading logic tied to exclusion zone)
          droneActive ? null : fleetCircleLayer,
          droneActive ? null : fleetArrowLayer,
          // Ambulance marker — dimmed during drone mode
          ambulanceLayer,
          // 3D hospitals + labels (rendered last so they draw on top)
          ...hospitalLayers,
          // Violet ground-aura disc beneath the Three.js drone canvas
          droneAuraLayer,
        ]}
      />
      {/* Three.js 3D drone — rendered as a Google Maps OverlayView canvas */}
      <DroneThreeOverlay
        lat={droneFrame?.lat ?? 0}
        lng={droneFrame?.lng ?? 0}
        bearingDeg={droneFrame?.bearingDeg ?? 0}
        active={droneActive && droneFrame !== null}
      />
      {/* Floating ETA countdown chip pinned next to the drone */}
      {droneActive && droneFrame && (
        <AdvancedMarker
          position={{ lat: droneFrame.lat, lng: droneFrame.lng }}
          anchorPoint={AdvancedMarkerAnchorPoint.BOTTOM_LEFT}
        >
          <div
            className="ml-24 -mt-2 px-3 py-1.5 rounded-md bg-violet-950/85 border border-violet-400/60 shadow-lg backdrop-blur-sm pointer-events-none"
            style={{ minWidth: 96 }}
          >
            <div className="font-mono text-[10px] uppercase tracking-widest text-violet-300/80">
              Drone ETA
            </div>
            <div className="font-mono text-xl font-bold tabular-nums text-violet-100">
              {droneFrame.etaSec >= 60
                ? `${Math.floor(droneFrame.etaSec / 60)}m ${droneFrame.etaSec % 60}s`
                : `${droneFrame.etaSec}s`}
            </div>
          </div>
        </AdvancedMarker>
      )}
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

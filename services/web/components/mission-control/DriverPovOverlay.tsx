'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Signal, Wifi, BatteryFull, AlertTriangle, ShieldAlert } from 'lucide-react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useSimulatedDriverPosition } from '../../hooks/useSimulatedDriverPosition';
import { useDriverProximity } from '../../hooks/useDriverProximity';
import { useRoutePathLayer } from '../map/RoutePath';
import { useHospitalLayer } from '../map/HospitalMarkers';
import { useExclusionLayer } from '../map/ExclusionPolygon';
import { useMission } from '../../lib/MissionContext';
import type { GeoPoint } from '../../lib/types';

const DEFAULT_CENTER = { lat: 12.9783, lng: 77.6408 };
const DRIVER_ORBIT_M = 1800;
const NEAR_ENTER_M = 200;
const NEAR_EXIT_M = 250; // hysteresis band to avoid flicker near the boundary

type PovState = 'OUTSIDE' | 'NEAR' | 'INSIDE';

interface DriverPovOverlayProps {
  apiKey: string;
  origin?: GeoPoint;
  destination?: GeoPoint;
  /** Decoded road-geometry waypoints — synced from MissionContext via parent. */
  polyline?: GeoPoint[];
  open: boolean;
  onClose: () => void;
}

function DeckOverlay({ layers }: { layers: (Layer | null)[] }) {
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

// Fill/stroke colours keyed to the three proximity states.
const DRIVER_COLORS: Record<PovState, { fill: [number, number, number, number]; line: [number, number, number, number] }> = {
  OUTSIDE: { fill: [34, 197, 94, 240], line: [255, 255, 255, 230] },  // green
  NEAR:    { fill: [250, 204, 21, 240], line: [255, 255, 255, 230] }, // yellow
  INSIDE:  { fill: [239, 68, 68, 240],  line: [255, 255, 255, 230] }, // red
};

function DriverScene({
  origin,
  destination,
  polyline,
  onStateChange,
  onDistanceChange,
}: {
  origin?: GeoPoint;
  destination?: GeoPoint;
  polyline?: GeoPoint[];
  onStateChange: (s: PovState) => void;
  onDistanceChange: (d: number | null) => void;
}) {
  const { corridorGeoJSON } = useSipraWebSocket();
  const map = useMap();
  const didFitRef = useRef(false);

  const driverCenter = origin ?? DEFAULT_CENTER;
  const driverPosition = useSimulatedDriverPosition(driverCenter, DRIVER_ORBIT_M);
  const { state: baseState, distanceToEdgeM } = useDriverProximity(corridorGeoJSON, driverPosition);

  // Derive 3-state with hysteresis on the NEAR↔OUTSIDE threshold so small
  // distance jitter near the boundary doesn't strobe the UI.
  const prevStateRef = useRef<PovState>('OUTSIDE');
  const povState: PovState = useMemo(() => {
    if (baseState === 'INSIDE_ZONE') {
      prevStateRef.current = 'INSIDE';
      return 'INSIDE';
    }
    if (distanceToEdgeM === null) {
      prevStateRef.current = 'OUTSIDE';
      return 'OUTSIDE';
    }
    const prev = prevStateRef.current;
    let next: PovState;
    if (prev === 'NEAR') {
      next = distanceToEdgeM > NEAR_EXIT_M ? 'OUTSIDE' : 'NEAR';
    } else {
      next = distanceToEdgeM < NEAR_ENTER_M ? 'NEAR' : 'OUTSIDE';
    }
    prevStateRef.current = next;
    return next;
  }, [baseState, distanceToEdgeM]);

  useEffect(() => { onStateChange(povState); }, [povState, onStateChange]);
  useEffect(() => { onDistanceChange(distanceToEdgeM); }, [distanceToEdgeM, onDistanceChange]);

  // Fit once to show the full route plus the driver orbit footprint.
  useEffect(() => {
    if (!map || !origin || !destination || didFitRef.current) return;
    const bounds = new google.maps.LatLngBounds();
    bounds.extend({ lat: origin.lat, lng: origin.lng });
    bounds.extend({ lat: destination.lat, lng: destination.lng });
    const latPad = DRIVER_ORBIT_M / 111_132;
    const lngPad = DRIVER_ORBIT_M / (111_132 * Math.cos((driverCenter.lat * Math.PI) / 180));
    bounds.extend({ lat: driverCenter.lat + latPad, lng: driverCenter.lng + lngPad });
    bounds.extend({ lat: driverCenter.lat - latPad, lng: driverCenter.lng - lngPad });
    map.fitBounds(bounds, 32);
    didFitRef.current = true;
  }, [map, origin, destination, driverCenter.lat, driverCenter.lng]);

  const routePathLayer = useRoutePathLayer(origin, destination, polyline);
  const hospitalLayer = useHospitalLayer(origin, destination);
  const exclusionLayer = useExclusionLayer(corridorGeoJSON, povState === 'INSIDE' ? 2 : 1);

  const driverLayer = useMemo(() => {
    const c = DRIVER_COLORS[povState];
    return new ScatterplotLayer({
      id: 'driver-pov-self',
      data: [{ lat: driverPosition.lat, lng: driverPosition.lng }],
      getPosition: (d: { lat: number; lng: number }) => [d.lng, d.lat],
      getRadius: 10,
      getFillColor: c.fill,
      getLineColor: c.line,
      getLineWidth: 3,
      lineWidthUnits: 'pixels',
      radiusUnits: 'pixels',
      stroked: true,
      pickable: false,
      transitions: {
        getPosition: { duration: 900 },
        getFillColor: { duration: 400 },
        getLineColor: { duration: 400 },
      },
      updateTriggers: {
        getFillColor: povState,
        getLineColor: povState,
      },
    });
  }, [driverPosition.lat, driverPosition.lng, povState]);

  return (
    <DeckOverlay layers={[routePathLayer, hospitalLayer, exclusionLayer, driverLayer]} />
  );
}

function ProximityAlert({ state, distanceM }: { state: PovState; distanceM: number | null }) {
  if (state === 'OUTSIDE') return null;

  if (state === 'NEAR') {
    return (
      <div className="absolute top-2 left-2 right-2 z-10 rounded-lg border border-amber-300 bg-amber-400/95 text-amber-950 shadow-lg px-2.5 py-2 flex items-start gap-2">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-[10.5px] font-bold uppercase tracking-wide leading-tight">Warning</p>
          <p className="text-[11px] font-semibold leading-snug">Ambulance corridor ahead. Please reroute.</p>
          {distanceM !== null && (
            <p className="text-[10px] opacity-80 mt-0.5">{Math.round(distanceM)} m from boundary</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="absolute top-2 left-2 right-2 z-10 rounded-lg border border-red-400 bg-red-600/95 text-white shadow-[0_0_0_2px_rgba(239,68,68,0.35)] px-2.5 py-2 flex items-start gap-2 animate-pulse">
      <ShieldAlert className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <p className="text-[10.5px] font-bold uppercase tracking-wide leading-tight">Critical</p>
        <p className="text-[11px] font-semibold leading-snug">You are inside emergency corridor. Move away immediately.</p>
      </div>
    </div>
  );
}

function FooterCopy({ state, distanceM }: { state: PovState; distanceM: number | null }) {
  const { remainingMs, goldenHourMs, urgencyLevel } = useMission();
  const progress = Math.min(100, ((goldenHourMs - remainingMs) / Math.max(1, goldenHourMs)) * 100);
  const barColor =
    urgencyLevel === 'critical' ? 'bg-red-500' :
    urgencyLevel === 'elevated' ? 'bg-amber-400' :
    'bg-green-500';
  const remainSec = Math.floor(remainingMs / 1000);
  const remainMin = Math.floor(remainSec / 60);
  const remainSecPart = remainSec % 60;
  const fmtRemain = `${String(remainMin).padStart(2, '0')}:${String(remainSecPart).padStart(2, '0')}`;

  const statusBlock = (
    <div className="mt-1.5 space-y-0.5">
      <div className="flex justify-between text-[10px] font-mono text-slate-500">
        <span>Golden Hour</span>
        <span className={urgencyLevel === 'critical' ? 'text-red-500 font-bold' : ''}>{fmtRemain}</span>
      </div>
      <div className="w-full h-1.5 bg-slate-200 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${barColor} ${urgencyLevel === 'critical' ? 'animate-pulse' : ''}`}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );

  if (state === 'INSIDE') {
    return (
      <>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-bold text-red-600">Inside corridor</span>
          <span className="text-[11px] text-slate-500">move away now</span>
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">Yield to the approaching ambulance.</p>
        {statusBlock}
      </>
    );
  }
  if (state === 'NEAR') {
    return (
      <>
        <div className="flex items-baseline gap-2">
          <span className="text-base font-bold text-amber-600">Corridor nearby</span>
          {distanceM !== null && (
            <span className="text-[11px] text-slate-500">{Math.round(distanceM)} m away</span>
          )}
        </div>
        <p className="text-[11px] text-slate-500 mt-0.5">Prepare to reroute around the zone.</p>
        {statusBlock}
      </>
    );
  }
  return (
    <>
      <div className="flex items-baseline gap-2">
        <span className="text-base font-bold text-slate-900">All clear</span>
        <span className="text-[11px] text-slate-500">safe to proceed</span>
      </div>
      <p className="text-[11px] text-slate-500 mt-0.5">No active corridor near your route.</p>
      {statusBlock}
    </>
  );
}

export default function DriverPovOverlay({
  apiKey,
  origin,
  destination,
  polyline,
  open,
  onClose,
}: DriverPovOverlayProps) {
  const [povState, setPovState] = useState<PovState>('OUTSIDE');
  const [distanceM, setDistanceM] = useState<number | null>(null);

  if (!open) return null;

  const initialCenter = origin ?? DEFAULT_CENTER;

  const headerBg =
    povState === 'INSIDE' ? 'bg-red-600' : povState === 'NEAR' ? 'bg-amber-500 text-amber-950' : 'bg-blue-600';
  const headerText =
    povState === 'INSIDE'
      ? 'Driver POV — EVACUATE CORRIDOR'
      : povState === 'NEAR'
        ? 'Driver POV — corridor nearby'
        : 'Driver POV — live corridor feed';

  return (
    <div className="fixed bottom-4 right-4 z-40 hidden sm:block">
      <div className="relative w-[280px] h-[560px] rounded-[42px] border-[12px] border-slate-800 bg-black shadow-[0_20px_60px_-10px_rgba(0,0,0,0.8)] overflow-hidden">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-24 h-5 bg-slate-800 rounded-b-2xl z-20" />

        <button
          onClick={onClose}
          aria-label="Close Driver POV"
          className="absolute top-2 right-2 z-30 w-6 h-6 rounded-full bg-slate-900/80 border border-slate-700 flex items-center justify-center text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
        >
          <X className="w-3 h-3" />
        </button>

        <div className="absolute inset-0 bg-slate-100 flex flex-col">
          <div className="h-6 bg-slate-100 flex items-center justify-between px-5 pt-0.5 flex-shrink-0">
            <span className="text-[10px] font-semibold text-slate-800">LIVE</span>
            <div className="flex items-center gap-1 text-slate-700">
              <Signal className="w-2.5 h-2.5" />
              <Wifi className="w-2.5 h-2.5" />
              <BatteryFull className="w-2.5 h-2.5" />
            </div>
          </div>

          <div className={`text-white text-[11px] font-medium px-3 py-1.5 flex-shrink-0 transition-colors ${headerBg}`}>
            {headerText}
          </div>

          <div className="flex-1 relative overflow-hidden">
            <ProximityAlert state={povState} distanceM={distanceM} />
            <APIProvider apiKey={apiKey}>
              <Map
                defaultCenter={initialCenter}
                defaultZoom={13}
                mapId="sipra-dark-v1"
                gestureHandling="greedy"
                disableDefaultUI
              >
                <DriverScene
                  origin={origin}
                  destination={destination}
                  polyline={polyline}
                  onStateChange={setPovState}
                  onDistanceChange={setDistanceM}
                />
              </Map>
            </APIProvider>
          </div>

          <div className="bg-white border-t border-slate-200 px-3 py-2 flex-shrink-0">
            <FooterCopy state={povState} distanceM={distanceM} />
          </div>
        </div>
      </div>
    </div>
  );
}

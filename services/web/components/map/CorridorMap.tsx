'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

import { useExclusionLayer } from './ExclusionPolygon';
import { useFleetLayer } from './FleetSwarm';
import { useHospitalLayer } from './HospitalMarkers';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { FleetVehicle, GeoPoint, HandoffInitiatedPayload } from '../../lib/types';

// Default viewport: Indiranagar, Bangalore — matches the simulator's route origin.
const DEFAULT_CENTER = { lat: 12.9783, lng: 77.6408 };
const FLEET_WS_URL = 'ws://localhost:4001';

// --------------------------------------------------------------------------
// DeckGLOverlay
// Mounts a single GoogleMapsOverlay inside the Maps context and synchronises
// its layer list on every render. Using useEffect without a dependency array
// for the setProps call is intentional: we want to flush layer updates every
// render cycle so the pulsing animation always reaches the GL canvas.
// --------------------------------------------------------------------------
function DeckGLOverlay({ layers }: { layers: (Layer | null)[] }) {
  const map = useMap();
  const overlayRef = useRef<GoogleMapsOverlay | null>(null);

  useEffect(() => {
    if (!map) return;
    const overlay = new GoogleMapsOverlay({ layers: [] });
    overlayRef.current = overlay;
    // Defer setMap to next animation frame — Google Maps calls draw() synchronously
    // inside setMap, before the overlay's internal _map is set, causing addListener
    // to be called on null. One RAF gives the map's own setup cycle time to complete.
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
// MapLegend — bottom-right overlay (connection status lives in StatusBar)
// --------------------------------------------------------------------------
function MapLegend({ fleetCount, evadingCount }: { fleetCount: number; evadingCount: number }) {
  return (
    <div style={{
      position: 'absolute', top: 16, right: 16, zIndex: 10,
      padding: '10px 16px', borderRadius: 8,
      background: 'rgba(0,0,0,0.80)',
      color: '#fff', fontFamily: 'monospace', fontSize: 12, lineHeight: 2,
      minWidth: 200,
    }}>
      <div style={{ color: '#ff2828', fontWeight: 700 }}>⬛ EXCLUSION ZONE</div>
      <div style={{ color: '#1e78ff' }}>● FLEET  ({fleetCount} vehicles)</div>
      <div style={{ color: '#ffa500' }}>● EVADING  ({evadingCount} rerouting)</div>
      <div style={{ color: '#ffffff' }}>◎ AMBULANCE</div>
    </div>
  );
}

// --------------------------------------------------------------------------
// CorridorMap
// --------------------------------------------------------------------------
interface CorridorMapProps {
  googleMapsApiKey: string;
  backendWsUrl?: string;
  onHandoff?: (p: HandoffInitiatedPayload) => void;
  origin?: GeoPoint;
  destination?: GeoPoint;
}

function MapScene({
  backendWsUrl,
  onHandoff,
  origin,
  destination,
}: {
  backendWsUrl: string;
  onHandoff?: (p: HandoffInitiatedPayload) => void;
  origin?: GeoPoint;
  destination?: GeoPoint;
}) {
  const { ambulanceLat, ambulanceLng, corridorGeoJSON, handoffState } =
    useSipraWebSocket(backendWsUrl);
  const map = useMap();

  useEffect(() => {
    if (handoffState) onHandoff?.(handoffState);
  }, [handoffState, onHandoff]);

  const [fleet, setFleet] = useState<FleetVehicle[]>([]);

  // Fleet positions are served by the simulator's WebSocket on port 4001.
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
    return () => {
      ws?.close();
      clearTimeout(reconnectTimer);
    };
  }, []);

  // Ambulance dot: white fill + red ring so it stands out on any map tile.
  const ambulanceLayer = useMemo(() => {
    if (ambulanceLat === null || ambulanceLng === null) return null;
    return new ScatterplotLayer({
      id: 'ambulance',
      data: [{ lat: ambulanceLat, lng: ambulanceLng }],
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
  }, [ambulanceLat, ambulanceLng]);

  const hospitalLayer = useHospitalLayer(origin, destination);
  const exclusionLayer = useExclusionLayer(corridorGeoJSON, handoffState ? 2 : 1);
  const fleetLayer = useFleetLayer(fleet);

  const evadingCount = fleet.filter(v => v.evading).length;

  return (
    <>
      <MapLegend fleetCount={fleet.length} evadingCount={evadingCount} />
      <DeckGLOverlay layers={[hospitalLayer, exclusionLayer, fleetLayer, ambulanceLayer]} />
    </>
  );
}

export default function CorridorMap({
  googleMapsApiKey,
  backendWsUrl = 'ws://localhost:8080/ws/dashboard',
  onHandoff,
  origin,
  destination,
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
          />
        </Map>
      </div>
    </APIProvider>
  );
}

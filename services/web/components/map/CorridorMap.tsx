'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

import { useExclusionLayer } from './ExclusionPolygon';
import { useFleetLayer } from './FleetSwarm';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { FleetVehicle, HandoffInitiatedPayload } from '../../lib/types';

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
    overlayRef.current = new GoogleMapsOverlay({});
    overlayRef.current.setMap(map);
    return () => {
      overlayRef.current?.setMap(null);
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
// HUD
// --------------------------------------------------------------------------
const STATUS_COLOR: Record<string, string> = {
  connected: '#00e676',
  connecting: '#ffab00',
  disconnected: '#ff1744',
};

function HUD({
  status,
  fleetCount,
  evadingCount,
}: {
  status: string;
  fleetCount: number;
  evadingCount: number;
}) {
  const color = STATUS_COLOR[status] ?? '#888';
  return (
    <>
      {/* Connection badge */}
      <div style={{
        position: 'absolute', top: 16, left: 16, zIndex: 10,
        padding: '6px 16px', borderRadius: 20,
        background: 'rgba(0,0,0,0.80)',
        border: `1.5px solid ${color}`,
        color, fontFamily: 'monospace', fontSize: 13, letterSpacing: 1,
      }}>
        ● {status.toUpperCase()}
      </div>

      {/* Legend */}
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
    </>
  );
}

// --------------------------------------------------------------------------
// CorridorMap
// --------------------------------------------------------------------------
interface CorridorMapProps {
  googleMapsApiKey: string;
  backendWsUrl?: string;
  onHandoff?: (p: HandoffInitiatedPayload) => void;
}

function MapScene({ backendWsUrl, onHandoff }: { backendWsUrl: string; onHandoff?: (p: HandoffInitiatedPayload) => void }) {
  const { ambulanceLat, ambulanceLng, corridorGeoJSON, handoffState, status } =
    useSipraWebSocket(backendWsUrl);

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

  const exclusionLayer = useExclusionLayer(corridorGeoJSON);
  const fleetLayer = useFleetLayer(fleet);

  const evadingCount = fleet.filter(v => v.evading).length;

  return (
    <>
      <HUD status={status} fleetCount={fleet.length} evadingCount={evadingCount} />
      <DeckGLOverlay layers={[exclusionLayer, fleetLayer, ambulanceLayer]} />
    </>
  );
}

export default function CorridorMap({
  googleMapsApiKey,
  backendWsUrl = 'ws://localhost:8080/ws/dashboard',
  onHandoff,
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
          <MapScene backendWsUrl={backendWsUrl} onHandoff={onHandoff} />
        </Map>
      </div>
    </APIProvider>
  );
}

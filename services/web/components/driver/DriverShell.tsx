'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

import { useExclusionLayer } from '../map/ExclusionPolygon';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useSimulatedDriverPosition } from '../../hooks/useSimulatedDriverPosition';
import { useDriverProximity } from '../../hooks/useDriverProximity';
import { useExitPathLayer, exitDirectionLabel, ExitRouteCard } from './ExitRouteCard';
import { useBountyLifecycle } from '../../hooks/useBountyLifecycle';
import { usePointsWallet } from '../../hooks/usePointsWallet';
import { BountyModal } from './BountyModal';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';

const INDIRANAGAR = { lat: 12.9783, lng: 77.6408 };
const ORBIT_RADIUS_M = 800;

// ---------------------------------------------------------------------------
// MapInner — lives inside <Map> context; manages the DeckGL overlay and pans
// the camera to follow the driver.
// ---------------------------------------------------------------------------
function MapInner({
  driverPosition,
  layers,
}: {
  driverPosition: { lat: number; lng: number };
  layers: (Layer | null)[];
}) {
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

  useEffect(() => {
    if (!map) return;
    map.panTo({ lat: driverPosition.lat, lng: driverPosition.lng });
  }, [map, driverPosition.lat, driverPosition.lng]);

  return null;
}

// ---------------------------------------------------------------------------
// NORMAL state card
// ---------------------------------------------------------------------------
function NormalCard({ tripId }: { tripId: string }) {
  return (
    <Card className="border-green-700/40 bg-card">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Badge className="bg-green-600 text-white border-0 text-xs">All clear</Badge>
        </div>
        <CardTitle className="text-base mt-2 text-foreground">No corridor in your area</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">Indiranagar, Bengaluru</p>
        <p className="mt-1 font-mono text-xs opacity-50">Trip {tripId.slice(0, 8)}&hellip;</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// INSIDE_ZONE state card — "Reroute and earn reward?"
// ---------------------------------------------------------------------------
function InsideZoneCard({ onShowExitRoute }: { onShowExitRoute: () => void }) {
  return (
    <Card className="border-red-700/60 bg-red-950/30">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Badge className="bg-amber-500 text-black border-0 text-xs">Corridor active</Badge>
        </div>
        <CardTitle className="text-base mt-2 text-red-300">
          Reroute and earn reward?
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-4">
          An emergency ambulance corridor is active in your area. Accept the reroute
          to earn +50 points for clearing the corridor.
        </p>
        <Button
          onClick={onShowExitRoute}
          className="w-full bg-amber-500 hover:bg-amber-400 text-black font-semibold"
        >
          Show exit route
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// RerouteStatusBadge — persistent visual badge tied to lifecycle state
// ---------------------------------------------------------------------------
function RerouteStatusBadge({
  rerouteStatus,
}: {
  rerouteStatus: 'rerouting' | 'completed' | 'failed' | null;
}) {
  if (!rerouteStatus) return null;

  const config = {
    rerouting: {
      bg: 'bg-amber-500/15',
      border: 'border-amber-500/40',
      dot: 'bg-amber-400',
      text: 'text-amber-300',
      label: 'Rerouting',
      pulse: true,
    },
    completed: {
      bg: 'bg-green-500/15',
      border: 'border-green-500/40',
      dot: 'bg-green-400',
      text: 'text-green-300',
      label: 'Completed',
      pulse: false,
    },
    failed: {
      bg: 'bg-red-500/15',
      border: 'border-red-500/40',
      dot: 'bg-red-400',
      text: 'text-red-300',
      label: 'Failed',
      pulse: false,
    },
  }[rerouteStatus];

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border ${config.bg} ${config.border}`}>
      <div className={`w-2 h-2 rounded-full ${config.dot} ${config.pulse ? 'animate-pulse' : ''}`} />
      <span className={`text-xs font-semibold uppercase tracking-wider ${config.text}`}>
        {config.label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bottom status strip
// ---------------------------------------------------------------------------
function StatusStrip({
  tripId,
  wsStatus,
  points,
}: {
  tripId: string;
  wsStatus: string;
  points: number;
}) {
  const dotColor =
    wsStatus === 'connected'
      ? 'bg-green-500'
      : wsStatus === 'connecting'
        ? 'bg-yellow-400 animate-pulse'
        : 'bg-red-500';

  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-card/80 text-xs text-muted-foreground shrink-0">
      <span className="font-mono opacity-60">Trip {tripId.slice(0, 8)}&hellip;</span>
      <span className="text-yellow-400 font-semibold">⭐ {points} pts</span>
      <div className="flex items-center gap-1.5">
        <div className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span>{wsStatus}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DriverShell — the top-level client component
// ---------------------------------------------------------------------------
export default function DriverShell({ tripId }: { tripId: string }) {
  const wsUrl =
    process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

  const { corridorGeoJSON, status } = useSipraWebSocket(wsUrl);
  const driverPosition = useSimulatedDriverPosition(INDIRANAGAR, ORBIT_RADIUS_M);
  const { state: proximityState } = useDriverProximity(corridorGeoJSON, driverPosition);
  const [exitRouteOpen, setExitRouteOpen] = useState(false);
  const bountyLC = useBountyLifecycle(tripId, corridorGeoJSON, driverPosition, proximityState);
  const wallet = usePointsWallet();

  // Auto-open exit route sheet when bounty is claimed so the checkpoint polyline is visible.
  useEffect(() => {
    if (bountyLC.state === 'CLAIMED') setExitRouteOpen(true);
  }, [bountyLC.state]);

  const driverLayer = useMemo(
    () =>
      new ScatterplotLayer({
        id: 'driver-dot',
        data: [{ lat: driverPosition.lat, lng: driverPosition.lng }],
        getPosition: (d: { lat: number; lng: number }) => [d.lng, d.lat],
        getRadius: 12,
        getFillColor: [34, 197, 94, 230],
        getLineColor: [255, 255, 255, 200],
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        radiusUnits: 'pixels',
        stroked: true,
        pickable: false,
        transitions: { getPosition: { duration: 300 } },
      }),
    [driverPosition.lat, driverPosition.lng],
  );

  // Ambulance dot is intentionally absent — driver MUST NOT see it.
  const exclusionLayer = useExclusionLayer(
    corridorGeoJSON,
    proximityState === 'INSIDE_ZONE' ? 2 : 1,
  );

  // When CLAIMED, override the exit-path target to point at the bounty checkpoint.
  const checkpointTarget =
    bountyLC.state === 'CLAIMED' && bountyLC.checkpoint ? bountyLC.checkpoint : undefined;

  const exitPathLayer = useExitPathLayer(
    corridorGeoJSON,
    driverPosition,
    exitRouteOpen,
    checkpointTarget,
  );

  // Direction label: show checkpoint info when CLAIMED, normal exit otherwise.
  const directionLabel = useMemo(() => {
    if (bountyLC.state === 'CLAIMED' && bountyLC.checkpoint && bountyLC.distanceToCheckpointM !== null) {
      return `Head to checkpoint — ${Math.round(bountyLC.distanceToCheckpointM)}m away`;
    }
    return exitDirectionLabel(corridorGeoJSON, driverPosition);
  }, [bountyLC.state, bountyLC.checkpoint, bountyLC.distanceToCheckpointM, corridorGeoJSON, driverPosition]);

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Bounty modal (OFFERED dialog / CLAIMED strip / VERIFIED overlay / EXPIRED overlay) */}
      <BountyModal lifecycle={bountyLC} wallet={wallet} tripId={tripId} />

      {/* Top: 40vh map — exclusion polygon + driver dot, no ambulance */}
      <div className="relative shrink-0" style={{ height: '40vh' }}>
        <APIProvider apiKey={apiKey}>
          <Map
            defaultCenter={INDIRANAGAR}
            defaultZoom={15}
            mapId="sipra-dark-v1"
            gestureHandling="none"
            disableDefaultUI
            style={{ width: '100%', height: '100%' }}
          >
            <MapInner
              driverPosition={driverPosition}
              layers={[exclusionLayer, exitPathLayer, driverLayer]}
            />
          </Map>
        </APIProvider>
      </div>

      {/* Reroute status badge — shows Rerouting / Completed / Failed */}
      {bountyLC.rerouteStatus && (
        <div className="px-4 py-2 bg-card/60 border-b border-border flex items-center justify-center">
          <RerouteStatusBadge rerouteStatus={bountyLC.rerouteStatus} />
        </div>
      )}

      {/* Middle: state-driven card */}
      <div className="flex-1 overflow-auto p-4 min-h-0">
        {proximityState === 'NORMAL' ? (
          <NormalCard tripId={tripId} />
        ) : (
          <InsideZoneCard onShowExitRoute={() => setExitRouteOpen(true)} />
        )}
      </div>

      {/* Bottom: status strip */}
      <StatusStrip tripId={tripId} wsStatus={status} points={wallet.points} />

      {/* Exit route sheet — slides up from bottom */}
      <ExitRouteCard
        open={exitRouteOpen}
        onDismiss={() => setExitRouteOpen(false)}
        directionLabel={directionLabel}
        targetOverride={checkpointTarget}
      />
    </div>
  );
}

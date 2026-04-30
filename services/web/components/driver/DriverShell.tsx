'use client';

import { useCallback, useEffect, useMemo, useRef, useState, useContext } from 'react';
import { APIProvider, Map, useMap } from '@vis.gl/react-google-maps';
import { GoogleMapsOverlay } from '@deck.gl/google-maps';
import { ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

import { useExclusionLayer } from '../map/ExclusionPolygon';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useDriverProximity } from '../../hooks/useDriverProximity';
import { useExitPathLayer, exitDirectionLabel, ExitRouteCard } from './ExitRouteCard';
import { useBountyLifecycle } from '../../hooks/useBountyLifecycle';
import { usePointsWallet } from '../../hooks/usePointsWallet';
import { BountyModal } from './BountyModal';
import { Badge } from '../ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { MissionContext } from '../../lib/MissionContext';

// Utility: safely consume MissionContext corridor — returns null if not inside a provider.
// Uses useContext directly (never throws, returns null when context is absent).
function useSafeMissionCorridor(): import('geojson').Geometry | null {
  const ctx = useContext(MissionContext);
  return ctx?.corridorGeometry ?? null;
}

// Utility: safely consume MissionContext polyline — returns [] if not inside a provider.
function useSafeMissionPolyline(): import('../../lib/types').GeoPoint[] {
  const ctx = useContext(MissionContext);
  return ctx?.polyline ?? [];
}

const INDIRANAGAR = { lat: 12.9783, lng: 77.6408 };
const ORBIT_RADIUS_M = 800;

// Crawls a simulated driver along the polyline at ~30 km/h.
function useCrawlPosition(
  center: { lat: number; lng: number },
  polyline: import('../../lib/types').GeoPoint[] | undefined,
  seed: number,
): { lat: number; lng: number } {
  const startRef = useRef(Date.now());
  const [pos, setPos] = useState(center);

  const crawl = useCallback(() => {
    if (!polyline || polyline.length < 2) { setPos(center); return undefined; }
    const seedFrac = (seed % 100) / 100;
    const approxRouteM = (polyline.length - 1) * 40;
    const speedFrac = approxRouteM > 0 ? (30_000 / 3600) / approxRouteM : 0.0001;
    const tick = () => {
      const elapsedS = (Date.now() - startRef.current) / 1_000;
      const progress = (seedFrac + elapsedS * speedFrac) % 1;
      const n = polyline.length - 1;
      const segF = progress * n;
      const segIdx = Math.min(Math.floor(segF), n - 1);
      const a = polyline[segIdx];
      const b = polyline[segIdx + 1];
      const t = segF - segIdx;
      setPos({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
    };
    tick();
    return setInterval(tick, 1_000);
  }, [center, polyline, seed]);

  useEffect(() => {
    const id = crawl();
    return () => { if (id !== undefined) clearInterval(id); };
  }, [crawl]);

  return pos;
}

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
// WARNING state card — corridor is approaching (within 150 m)
// ---------------------------------------------------------------------------
function WarningCard() {
  return (
    <Card className="border-amber-600/60 bg-amber-950/20">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Badge className="bg-amber-500 text-black border-0 text-xs animate-pulse">⚠ Corridor nearby</Badge>
        </div>
        <CardTitle className="text-base mt-2 text-amber-300">
          Emergency corridor approaching
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-2">
          An ambulance corridor is active within 150 m. Prepare to reroute.
        </p>
        <p className="text-xs text-amber-400/70 font-mono">Slow down and stay clear of the marked zone.</p>
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
          <Badge className="bg-red-600 text-white border-0 text-xs animate-pulse">🚨 Inside corridor</Badge>
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
  corridorSource,
}: {
  tripId: string;
  wsStatus: string;
  points: number;
  corridorSource: 'road-aligned' | 'ws-based' | 'none';
}) {
  const dotColor =
    wsStatus === 'connected'
      ? 'bg-green-500'
      : wsStatus === 'connecting'
        ? 'bg-yellow-400 animate-pulse'
        : 'bg-red-500';

  const srcLabel =
    corridorSource === 'road-aligned' ? '🟢 Road-aligned'
    : corridorSource === 'ws-based'   ? '🟡 Ping-based'
    : '';

  return (
    <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-card/80 text-xs text-muted-foreground shrink-0">
      <span className="font-mono opacity-60">Trip {tripId.slice(0, 8)}&hellip;</span>
      {srcLabel && <span className="opacity-70">{srcLabel}</span>}
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
  const missionPolyline = useSafeMissionPolyline();
  const driverPosition = useCrawlPosition(INDIRANAGAR, missionPolyline.length >= 2 ? missionPolyline : undefined, 71);

  // Road-aligned corridor from MissionContext (same shape used in Mission Control).
  const missionCorridor = useSafeMissionCorridor();

  // Priority: MissionContext road-aligned → WS-pushed GeoJSON (ping-based) → null
  const activeCorridor = missionCorridor ?? corridorGeoJSON;
  const corridorSource: 'road-aligned' | 'ws-based' | 'none' =
    missionCorridor ? 'road-aligned'
    : corridorGeoJSON ? 'ws-based'
    : 'none';

  const { state: proximityState } = useDriverProximity(activeCorridor, driverPosition);
  const [exitRouteOpen, setExitRouteOpen] = useState(false);
  const bountyLC = useBountyLifecycle(tripId, activeCorridor, driverPosition, proximityState);
  const wallet = usePointsWallet();

  // Auto-open exit route sheet when bounty is claimed so the checkpoint polyline is visible.
  useEffect(() => {
    if (bountyLC.state === 'CLAIMED') setExitRouteOpen(true);
  }, [bountyLC.state]);

  // Driver marker color depends on proximity state.
  const driverFillColor: [number, number, number, number] =
    proximityState === 'INSIDE_ZONE' ? [239, 68, 68, 240]  // red
    : proximityState === 'WARNING'   ? [250, 204, 21, 240] // amber
    : [34, 197, 94, 230];                                   // green

  const driverLayer = useMemo(
    () =>
      new ScatterplotLayer({
        id: 'driver-dot',
        data: [{ lat: driverPosition.lat, lng: driverPosition.lng }],
        getPosition: (d: { lat: number; lng: number }) => [d.lng, d.lat],
        getRadius: 12,
        getFillColor: driverFillColor,
        getLineColor: [255, 255, 255, 200],
        getLineWidth: 2,
        lineWidthUnits: 'pixels',
        radiusUnits: 'pixels',
        stroked: true,
        pickable: false,
        transitions: {
          getPosition: { duration: 300 },
          getFillColor: { duration: 200 },
        },
        updateTriggers: { getFillColor: proximityState },
      }),
    [driverPosition.lat, driverPosition.lng, driverFillColor, proximityState],
  );

  // Ambulance dot is intentionally absent — driver MUST NOT see it.
  const exclusionLayer = useExclusionLayer(
    activeCorridor,
    proximityState === 'INSIDE_ZONE' ? 2 : 1,
  );

  // When CLAIMED, override the exit-path target to point at the bounty checkpoint.
  const checkpointTarget =
    bountyLC.state === 'CLAIMED' && bountyLC.checkpoint ? bountyLC.checkpoint : undefined;

  const exitPathLayer = useExitPathLayer(
    activeCorridor,
    driverPosition,
    exitRouteOpen,
    checkpointTarget,
  );

  // Direction label: show checkpoint info when CLAIMED, normal exit otherwise.
  const directionLabel = useMemo(() => {
    if (bountyLC.state === 'CLAIMED' && bountyLC.checkpoint && bountyLC.distanceToCheckpointM !== null) {
      return `Head to checkpoint — ${Math.round(bountyLC.distanceToCheckpointM)}m away`;
    }
    return exitDirectionLabel(activeCorridor, driverPosition);
  }, [bountyLC.state, bountyLC.checkpoint, bountyLC.distanceToCheckpointM, activeCorridor, driverPosition]);

  // Map border color driven by proximity state.
  const mapBorderColor =
    proximityState === 'INSIDE_ZONE' ? 'border-red-600'
    : proximityState === 'WARNING'   ? 'border-amber-500'
    : 'border-transparent';

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* Bounty modal (OFFERED dialog / CLAIMED strip / VERIFIED overlay / EXPIRED overlay) */}
      <BountyModal lifecycle={bountyLC} wallet={wallet} tripId={tripId} />

      {/* Top: 40vh map — exclusion polygon + driver dot, no ambulance */}
      <div className={`relative shrink-0 border-2 transition-colors duration-300 ${mapBorderColor}`} style={{ height: '40vh' }}>
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

        {/* In-map proximity alert banner */}
        {proximityState === 'WARNING' && (
          <div className="absolute top-2 left-2 right-2 z-10 rounded-lg border border-amber-400 bg-amber-500/90 text-black text-xs font-bold px-3 py-1.5 flex items-center gap-2 shadow-lg">
            <span>⚠</span>
            <span>Emergency corridor within 150 m — prepare to reroute</span>
          </div>
        )}
        {proximityState === 'INSIDE_ZONE' && (
          <div className="absolute top-2 left-2 right-2 z-10 rounded-lg border border-red-400 bg-red-600/95 text-white text-xs font-bold px-3 py-1.5 flex items-center gap-2 shadow-lg animate-pulse">
            <span>🚨</span>
            <span>Inside emergency corridor — evacuate now</span>
          </div>
        )}
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
        ) : proximityState === 'WARNING' ? (
          <WarningCard />
        ) : (
          <InsideZoneCard onShowExitRoute={() => setExitRouteOpen(true)} />
        )}
      </div>

      {/* Bottom: status strip */}
      <StatusStrip tripId={tripId} wsStatus={status} points={wallet.points} corridorSource={corridorSource} />

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

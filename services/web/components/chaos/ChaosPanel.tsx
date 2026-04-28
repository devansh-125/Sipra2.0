'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Waves, Car, Zap, RotateCcw } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import ScenarioButton from './ScenarioButton';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import {
  chaosFloodBridge,
  chaosForceHandoff,
  chaosReset,
  chaosSpawnFleet,
} from '../../lib/api';

const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';
const DEMO_TRIP_ID = process.env.NEXT_PUBLIC_DEMO_TRIP_ID ?? '';

const INPUT_CLS =
  'mt-1 w-full bg-card border border-border rounded-md px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring';

const LABEL_CLS = 'text-muted-foreground text-xs font-mono uppercase tracking-wide';

type ActiveDialog = 'flood' | 'fleet' | 'handoff' | 'reset' | null;

const TYPE_COLOR: Record<string, string> = {
  GPS_UPDATE: 'text-blue-400',
  CORRIDOR_UPDATE: 'text-purple-400',
  HANDOFF_INITIATED: 'text-red-400',
  FLEET_UPDATE: 'text-green-400',
  FLEET_SPAWN: 'text-yellow-400',
  REROUTE_STATUS: 'text-emerald-400',
};

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export default function ChaosPanel() {
  const [tripId, setTripId] = useState(DEMO_TRIP_ID);
  const [activeDialog, setActiveDialog] = useState<ActiveDialog>(null);
  const [busy, setBusy] = useState(false);

  // Flood Bridge form
  const [floodCount, setFloodCount] = useState(50);

  // Spawn Fleet form
  const [fleetCount, setFleetCount] = useState(100);
  const [fleetLat, setFleetLat] = useState(12.9656);  // Bangalore origin
  const [fleetLng, setFleetLng] = useState(77.5713);
  const [fleetRadius, setFleetRadius] = useState(2000);

  // Force Handoff form
  const [handoffReason, setHandoffReason] = useState(
    'Demo: golden-hour breach imminent',
  );

  const { recentEvents } = useSipraWebSocket(WS_URL);

  function close() {
    setActiveDialog(null);
  }

  async function runFloodBridge() {
    if (!tripId) {
      toast.error('Set a trip ID first');
      return;
    }
    setBusy(true);
    try {
      const res = await chaosFloodBridge({ trip_id: tripId, count: floodCount });
      toast.success(`Flood bridge: ${res.injected} pings injected`);
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Flood bridge failed');
    } finally {
      setBusy(false);
    }
  }

  async function runSpawnFleet() {
    if (!tripId) {
      toast.error('Set a trip ID first');
      return;
    }
    setBusy(true);
    try {
      const res = await chaosSpawnFleet({
        trip_id: tripId,
        count: fleetCount,
        center_lat: fleetLat,
        center_lng: fleetLng,
        radius_m: fleetRadius,
      });
      toast.success(`Fleet spawned: ${res.spawned} drivers rerouting`);
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Spawn fleet failed');
    } finally {
      setBusy(false);
    }
  }

  async function runForceHandoff() {
    if (!tripId) {
      toast.error('Set a trip ID first');
      return;
    }
    if (!handoffReason.trim()) {
      toast.error('Reason is required');
      return;
    }
    setBusy(true);
    try {
      await chaosForceHandoff({ trip_id: tripId, reason: handoffReason });
      toast.success('Handoff initiated — check Mission Control');
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Force handoff failed');
    } finally {
      setBusy(false);
    }
  }

  async function runReset() {
    setBusy(true);
    try {
      const res = await chaosReset();
      toast.success(
        `Reset: cleared ${res.cleared_flooded_trips} trips, ${res.cleared_fleet_ids} fleet IDs`,
      );
      close();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reset failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="h-full flex flex-col gap-6 p-6 overflow-y-auto">
      {/* Trip Selector */}
      <div className="flex items-center gap-3 max-w-2xl">
        <label htmlFor="trip-id-input" className={`${LABEL_CLS} shrink-0`}>
          Trip ID
        </label>
        <input
          id="trip-id-input"
          value={tripId}
          onChange={e => setTripId(e.target.value)}
          placeholder="paste a trip UUID…"
          className="flex-1 bg-card border border-border rounded-md px-3 py-1.5 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Main body */}
      <div className="flex flex-1 gap-6 min-h-0">
        {/* 2×2 Scenario Grid */}
        <div className="grid grid-cols-2 gap-4 w-[420px] shrink-0 self-start">
          <ScenarioButton
            icon={<Waves className="h-6 w-6 text-blue-400" />}
            title="Flood Bridge"
            description="Inject stuck-position pings to spike route ETA and trigger risk-monitor handoff."
            onClick={() => setActiveDialog('flood')}
          />
          <ScenarioButton
            icon={<Car className="h-6 w-6 text-green-400" />}
            title="Spawn & Evacuate Fleet"
            description="Spawn drivers, animate reroute acceptance, and complete bounty payouts."
            onClick={() => setActiveDialog('fleet')}
          />
          <ScenarioButton
            icon={<Zap className="h-6 w-6 text-yellow-400" />}
            title="Force Handoff"
            description="Immediately broadcast HANDOFF_INITIATED to all connected WS clients."
            onClick={() => setActiveDialog('handoff')}
          />
          <ScenarioButton
            icon={<RotateCcw className="h-6 w-6 text-red-400" />}
            title="Reset Demo"
            description="Clear in-memory chaos counters. Does not truncate Postgres or Redis."
            variant="danger"
            onClick={() => setActiveDialog('reset')}
          />
        </div>

        {/* Live WS Event Log */}
        <Card className="flex-1 flex flex-col min-h-0 max-h-[600px]">
          <CardHeader className="pb-2 shrink-0">
            <CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
              Live WS Events ({recentEvents.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 min-h-0 pt-0 px-4 pb-4">
            <ScrollArea className="h-full">
              {recentEvents.length === 0 ? (
                <p className="text-xs font-mono text-muted-foreground py-2">
                  Waiting for WebSocket events…
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {recentEvents.map((e, i) => (
                    <li
                      key={`${e.ts}-${i}`}
                      className="font-mono text-xs flex items-start gap-2"
                    >
                      <span className="text-muted-foreground shrink-0">
                        {fmtTime(e.ts)}
                      </span>
                      <span
                        className={`shrink-0 ${TYPE_COLOR[e.type] ?? 'text-foreground'}`}
                      >
                        {e.type}
                      </span>
                      {e.truncated_payload && (
                        <span className="text-muted-foreground truncate">
                          {e.truncated_payload}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        </Card>
      </div>

      {/* ── Flood Bridge Dialog ── */}
      <Dialog open={activeDialog === 'flood'} onOpenChange={open => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Flood Bridge</DialogTitle>
            <DialogDescription>
              Inject GPS pings at a bottleneck to stall the ambulance ETA.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="block text-sm">
              <span className={LABEL_CLS}>Count (1–500)</span>
              <input
                type="number"
                min={1}
                max={500}
                value={floodCount}
                onChange={e => setFloodCount(Number(e.target.value))}
                className={INPUT_CLS}
              />
            </label>
            <p className="text-xs text-muted-foreground font-mono">
              Trip:{' '}
              {tripId ? (
                <span className="text-foreground">{tripId.slice(0, 8)}…</span>
              ) : (
                <span className="text-red-400">none selected</span>
              )}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={runFloodBridge} disabled={busy || !tripId}>
              {busy ? 'Sending…' : 'Inject Pings'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Spawn Fleet Dialog ── */}
      <Dialog open={activeDialog === 'fleet'} onOpenChange={open => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Spawn Fleet</DialogTitle>
            <DialogDescription>
              Place synthetic drivers near the red zone and animate them out for bounty completion.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 py-2">
            <label className="block text-sm">
              <span className={LABEL_CLS}>Drivers (1–500)</span>
              <input
                type="number"
                min={1}
                max={500}
                value={fleetCount}
                onChange={e => setFleetCount(Number(e.target.value))}
                className={INPUT_CLS}
              />
            </label>
            <label className="block text-sm">
              <span className={LABEL_CLS}>Radius (m)</span>
              <input
                type="number"
                min={100}
                max={50000}
                value={fleetRadius}
                onChange={e => setFleetRadius(Number(e.target.value))}
                className={INPUT_CLS}
              />
            </label>
            <label className="block text-sm">
              <span className={LABEL_CLS}>Center Lat</span>
              <input
                type="number"
                step="0.0001"
                value={fleetLat}
                onChange={e => setFleetLat(Number(e.target.value))}
                className={INPUT_CLS}
              />
            </label>
            <label className="block text-sm">
              <span className={LABEL_CLS}>Center Lng</span>
              <input
                type="number"
                step="0.0001"
                value={fleetLng}
                onChange={e => setFleetLng(Number(e.target.value))}
                className={INPUT_CLS}
              />
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={runSpawnFleet} disabled={busy}>
              {busy ? 'Spawning…' : 'Spawn & Evacuate'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Force Handoff Dialog ── */}
      <Dialog open={activeDialog === 'handoff'} onOpenChange={open => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Force Handoff</DialogTitle>
            <DialogDescription>
              Broadcast HANDOFF_INITIATED to all connected WS clients, bypassing the Risk
              Monitor.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="block text-sm">
              <span className={LABEL_CLS}>Reason</span>
              <input
                value={handoffReason}
                onChange={e => setHandoffReason(e.target.value)}
                className={INPUT_CLS}
              />
            </label>
            <p className="text-xs text-muted-foreground font-mono">
              Trip:{' '}
              {tripId ? (
                <span className="text-foreground">{tripId.slice(0, 8)}…</span>
              ) : (
                <span className="text-red-400">none selected</span>
              )}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={runForceHandoff}
              disabled={busy || !tripId || !handoffReason.trim()}
            >
              {busy ? 'Triggering…' : 'Force Handoff'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Reset Dialog ── */}
      <Dialog open={activeDialog === 'reset'} onOpenChange={open => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Demo State</DialogTitle>
            <DialogDescription>
              Clears in-memory chaos counters. Does not truncate Postgres or Redis.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={runReset} disabled={busy}>
              {busy ? 'Resetting…' : 'Reset'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

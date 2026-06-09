'use client';

import { useCallback, useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useMission } from '../../lib/MissionContext';
import type { TripCompletedPayload } from '../../lib/types';

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

function fmt(seconds: number): string {
  if (seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function Row({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground font-mono uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-mono font-semibold tabular-nums ${accent ?? 'text-foreground'}`}>{value}</span>
    </div>
  );
}

export default function TripCompletedOverlay() {
  const { trip } = useMission();
  const { tripCompleted, clearTripCompleted } = useSipraWebSocket(WS_URL, trip?.id ?? null);
  // useSipraWebSocket filters by trip.id; any tripCompleted we receive is
  // already for the active trip.
  const completedForCurrentTrip = tripCompleted;

  const [open, setOpen] = useState(false);
  const [displayed, setDisplayed] = useState<TripCompletedPayload | null>(null);

  // Reset on trip change so the modal can't survive a scenario switch.
  useEffect(() => {
    setOpen(false);
    setDisplayed(null);
  }, [trip?.id]);

  useEffect(() => {
    if (!completedForCurrentTrip) return;
    setDisplayed(completedForCurrentTrip);
    setOpen(true);
  }, [completedForCurrentTrip]);

  const handleClose = useCallback(() => {
    setOpen(false);
    clearTripCompleted();
  }, [clearTripCompleted]);

  if (!displayed) return null;

  const deadlineColor = displayed.deadline_met ? 'text-green-400' : 'text-red-400';
  const droneLabel   = displayed.drone_used ? 'YES — drone handoff executed' : 'No — ambulance completed route';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={o => { if (!o) handleClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          className="fixed inset-0 z-50 flex items-center justify-center p-6 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95"
          aria-describedby={undefined}
        >
          <DialogPrimitive.Title className="sr-only">Mission Complete</DialogPrimitive.Title>

          <div className="relative w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
            {/* Close */}
            <DialogPrimitive.Close
              onClick={handleClose}
              className="absolute top-4 right-4 z-10 rounded-sm text-muted-foreground opacity-70 hover:opacity-100 transition-opacity focus:outline-none focus:ring-2 focus:ring-ring"
              aria-label="Dismiss"
            >
              <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </DialogPrimitive.Close>

            {/* Header */}
            <div className={`px-8 py-5 border-b ${displayed.deadline_met ? 'bg-green-950/50 border-green-500/30' : 'bg-red-950/50 border-red-500/30'}`}>
              <p className={`font-mono text-xs uppercase tracking-widest ${displayed.deadline_met ? 'text-green-400' : 'text-red-400'}`}>
                Mission Summary
              </p>
              <p className="font-mono text-2xl font-bold text-foreground mt-0.5">
                {displayed.deadline_met ? 'MISSION ACCOMPLISHED' : 'GOLDEN HOUR BREACHED'}
              </p>
              <p className="text-xs text-muted-foreground mt-1 font-mono">
                Trip {displayed.trip_id.slice(0, 8).toUpperCase()}
              </p>
            </div>

            {/* Stats */}
            <div className="px-8 py-6 space-y-0">
              <Row
                label="Golden Hour"
                value={displayed.deadline_met ? 'MET' : 'MISSED'}
                accent={deadlineColor}
              />
              <Row
                label="Total Time"
                value={fmt(displayed.total_seconds)}
              />
              <Row
                label="Road Distance"
                value={displayed.distance_km > 0 ? `${displayed.distance_km.toFixed(1)} km` : '—'}
              />
              <Row
                label="Drone Dispatched"
                value={droneLabel}
                accent={displayed.drone_used ? 'text-purple-400' : 'text-green-400'}
              />
            </div>

            {/* Footer CTA */}
            <div className="px-8 pb-6">
              <button
                onClick={handleClose}
                className="w-full py-2.5 rounded-lg bg-primary text-primary-foreground font-mono text-sm font-semibold hover:bg-primary/90 transition-colors"
              >
                Run Another Scenario
              </button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

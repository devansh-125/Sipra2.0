'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useMission, type UrgencyLevel, type MissionStateLabel } from '../../lib/MissionContext';
import type { TripStatus, CargoCategory } from '../../lib/types';

const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

// ── Colour mappings ─────────────────────────────────────────────────────────

const STATUS_CLASS: Record<TripStatus, string> = {
  Pending:      'bg-slate-500 text-white',
  InTransit:    'bg-blue-600 text-white',
  DroneHandoff: 'bg-purple-600 text-white',
  Completed:    'bg-green-600 text-white',
  Failed:       'bg-red-600 text-white',
};

const MISSION_STATE_CLASS: Record<MissionStateLabel, string> = {
  Pending:   'bg-slate-500 text-white',
  Active:    'bg-blue-600 text-white',
  Completed: 'bg-green-600 text-white',
  Failed:    'bg-red-600 text-white',
};

const URGENCY_CONFIG: Record<UrgencyLevel, { label: string; class: string; barColor: string; pulse: boolean }> = {
  normal:   { label: 'Normal',   class: 'bg-green-600 text-white',  barColor: 'bg-green-500',  pulse: false },
  elevated: { label: 'Elevated', class: 'bg-amber-500 text-white',  barColor: 'bg-amber-500',  pulse: false },
  critical: { label: 'Critical', class: 'bg-red-600 text-white',    barColor: 'bg-red-500',    pulse: true  },
};

const CARGO_VARIANT: Record<CargoCategory, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  Organ:      'destructive',
  Blood:      'destructive',
  Vaccine:    'default',
  Medication: 'secondary',
};

// ── Formatters ──────────────────────────────────────────────────────────────

function formatHMS(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtETA(seconds: number): string {
  if (seconds <= 0) return '–';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function TripPanel() {
  const {
    trip, tripError, tripLoading,
    remainingMs, elapsedMs, goldenHourMs,
    urgencyLevel, missionState,
    etaSeconds, routeSource,
  } = useMission();

  const { recentEvents } = useSipraWebSocket(WS_URL);
  const [eventsOpen, setEventsOpen] = useState(false);

  // ── Loading / error states ────────────────────────────────────────────────
  if (tripLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm font-mono">
        Loading trip…
      </div>
    );
  }
  if (tripError || !trip) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400 text-sm font-mono px-4 text-center">
        {tripError ?? 'Trip not found'}
      </div>
    );
  }

  // ── Derived values ────────────────────────────────────────────────────────
  const progress   = Math.min(100, (elapsedMs / Math.max(1, goldenHourMs)) * 100);
  const expired    = remainingMs === 0;
  const urgencyCfg = URGENCY_CONFIG[urgencyLevel];
  const recent5    = recentEvents.slice(0, 5);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">

      {/* ── Mission state + urgency ──────────────────────────────────────── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
            Mission Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* Mission state pill */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${MISSION_STATE_CLASS[missionState]}`}>
              {missionState}
            </span>
            {trip.status !== missionState && (
              <span className={`text-xs font-mono px-2 py-0.5 rounded-full ${STATUS_CLASS[trip.status]}`}>
                {trip.status}
              </span>
            )}
          </div>

          {/* Trip ID */}
          <p className="font-mono text-sm text-foreground truncate" title={trip.id}>
            {trip.id.slice(0, 8)}…
          </p>

          {/* Cargo */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={CARGO_VARIANT[trip.cargo.category]}>
              {trip.cargo.category}
            </Badge>
            {trip.cargo.description && (
              <span className="text-xs text-muted-foreground truncate max-w-[160px]" title={trip.cargo.description}>
                {trip.cargo.description}
              </span>
            )}
          </div>

          {/* Ambulance ID */}
          <p className="font-mono text-xs text-muted-foreground truncate" title={trip.ambulance_id}>
            Amb: {trip.ambulance_id}
          </p>
        </CardContent>
      </Card>

      {/* ── Golden Hour countdown ────────────────────────────────────────── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-widest flex items-center justify-between">
            <span>Golden Hour</span>
            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${urgencyCfg.class} ${urgencyCfg.pulse ? 'animate-pulse' : ''}`}>
              {urgencyCfg.label}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">

          {/* Remaining */}
          <div className="space-y-0.5">
            <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wide">Remaining</p>
            <p className={`text-2xl font-mono font-bold tabular-nums ${expired ? 'text-red-500 animate-pulse' : 'text-foreground'}`}>
              {formatHMS(remainingMs)}
            </p>
          </div>

          {/* Elapsed */}
          <div className="space-y-0.5">
            <p className="text-[10px] text-muted-foreground font-mono uppercase tracking-wide">Elapsed</p>
            <p className="text-sm font-mono tabular-nums text-muted-foreground">
              {formatHMS(elapsedMs)}
            </p>
          </div>

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground font-mono">
              <span>0%</span>
              <span>{Math.round(progress)}%</span>
              <span>100%</span>
            </div>
            <div className="w-full h-2.5 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${urgencyCfg.barColor} ${urgencyCfg.pulse ? 'animate-pulse' : ''}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* ETA from route */}
          <div className="flex items-center justify-between text-xs font-mono">
            <span className="text-muted-foreground">Route ETA</span>
            <span className="text-foreground">{fmtETA(etaSeconds)}</span>
          </div>

          {/* Route source indicator */}
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${
              routeSource === 'api' ? 'bg-green-500' :
              routeSource === 'simulation' ? 'bg-amber-400' :
              'bg-slate-500 animate-pulse'
            }`} />
            <span className="text-[10px] font-mono text-muted-foreground">
              {routeSource === 'api' ? 'Live routing (API)' :
               routeSource === 'simulation' ? 'Simulated route' :
               'Computing route…'}
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Recent events ────────────────────────────────────────────────── */}
      <Card className="bg-card border-border">
        <CardHeader
          className="pb-2 cursor-pointer select-none"
          onClick={() => setEventsOpen(o => !o)}
        >
          <CardTitle className="flex items-center justify-between text-xs font-mono text-muted-foreground uppercase tracking-widest">
            <span>Recent Events</span>
            <span className="text-muted-foreground">{eventsOpen ? '▲' : '▼'}</span>
          </CardTitle>
        </CardHeader>
        {eventsOpen && (
          <CardContent className="pt-0">
            <ScrollArea className="h-32">
              {recent5.length === 0 ? (
                <p className="text-xs text-muted-foreground font-mono py-1">
                  Waiting for events…
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {recent5.map((e, index) => (
                    <li
                      key={`${e.type}-${e.ts}-${index}`}
                      className="flex items-baseline justify-between gap-2"
                    >
                      <span className="font-mono text-xs text-foreground truncate">
                        {e.type}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground shrink-0">
                        {formatTime(e.ts)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </ScrollArea>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

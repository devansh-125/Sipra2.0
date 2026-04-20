'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { getTrip } from '../../lib/api';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { Trip, TripStatus, CargoCategory } from '../../lib/types';

const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

const DEMO_TRIP_ID = process.env.NEXT_PUBLIC_DEMO_TRIP_ID ?? '';

const STATUS_CLASS: Record<TripStatus, string> = {
  Pending:      'bg-slate-500 text-white',
  InTransit:    'bg-blue-600 text-white',
  DroneHandoff: 'bg-purple-600 text-white',
  Completed:    'bg-green-600 text-white',
  Failed:       'bg-red-600 text-white',
};

const CARGO_VARIANT: Record<CargoCategory, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  Organ:      'destructive',
  Blood:      'destructive',
  Vaccine:    'default',
  Medication: 'secondary',
};

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

export default function TripPanel() {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [remaining, setRemaining] = useState(0);
  const [eventsOpen, setEventsOpen] = useState(false);

  const { recentEvents } = useSipraWebSocket(WS_URL);

  useEffect(() => {
    if (!DEMO_TRIP_ID) {
      setError('Set NEXT_PUBLIC_DEMO_TRIP_ID to a seeded trip UUID');
      setLoading(false);
      return;
    }
    getTrip(DEMO_TRIP_ID)
      .then(t => { setTrip(t); setLoading(false); })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load trip');
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!trip) return;
    const deadline = new Date(trip.golden_hour_deadline).getTime();
    const tick = () => setRemaining(Math.max(0, deadline - Date.now()));
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [trip]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm font-mono">
        Loading trip…
      </div>
    );
  }

  if (error || !trip) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-400 text-sm font-mono px-4 text-center">
        {error ?? 'Trip not found'}
      </div>
    );
  }

  const deadline = new Date(trip.golden_hour_deadline).getTime();
  const created  = new Date(trip.created_at).getTime();
  const total    = Math.max(1, deadline - created);
  const elapsed  = Math.max(0, Date.now() - created);
  const progress = Math.min(100, (elapsed / total) * 100);
  const expired  = remaining === 0;

  const barColor =
    progress > 80 ? 'bg-red-500' :
    progress > 50 ? 'bg-amber-500' :
    'bg-green-500';

  const recent5 = recentEvents.slice(0, 5);

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-mono text-muted-foreground uppercase tracking-widest">
            Active Mission
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Trip ID */}
          <p
            className="font-mono text-sm text-foreground truncate"
            title={trip.id}
          >
            {trip.id.slice(0, 8)}…
          </p>

          {/* Cargo badge + status pill */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={CARGO_VARIANT[trip.cargo.category]}>
              {trip.cargo.category}
            </Badge>
            <span
              className={`text-xs font-mono px-2 py-0.5 rounded-full ${STATUS_CLASS[trip.status]}`}
            >
              {trip.status}
            </span>
          </div>

          {/* Golden-hour countdown */}
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground font-mono uppercase tracking-wide">
              Golden Hour
            </p>
            <p
              className={`text-2xl font-mono font-bold tabular-nums ${expired ? 'text-red-500' : 'text-foreground'}`}
            >
              {formatHMS(remaining)}
            </p>
          </div>

          {/* Progress bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground font-mono">
              <span>Elapsed</span>
              <span>{Math.round(progress)}%</span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-1000 ${barColor}`}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Meta */}
          <div className="space-y-0.5 text-xs font-mono text-muted-foreground">
            <p className="truncate" title={trip.ambulance_id}>
              Amb: {trip.ambulance_id}
            </p>
            {trip.cargo.description && (
              <p className="truncate" title={trip.cargo.description}>
                {trip.cargo.description}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Recent events */}
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

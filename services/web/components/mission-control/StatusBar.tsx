'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { PlayCircle, Smartphone, Zap } from 'lucide-react';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { ConnectionStatus } from '../../hooks/useSipraWebSocket';
import { useMission } from '../../lib/MissionContext';
import type { UrgencyLevel } from '../../lib/MissionContext';
import ScenarioPickerDialog from './ScenarioPickerDialog';

interface StatusBarProps {
  povOpen: boolean;
  onTogglePov: () => void;
}

const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

const CONN_DOT: Record<ConnectionStatus, string> = {
  connected:    'bg-green-500',
  connecting:   'bg-amber-500 animate-pulse',
  disconnected: 'bg-red-500',
};

const URGENCY_BG: Record<UrgencyLevel, string> = {
  normal:   'bg-card',
  elevated: 'bg-amber-950/30',
  critical: 'bg-red-950/35',
};

const URGENCY_COUNTDOWN: Record<UrgencyLevel, string> = {
  normal:   'text-foreground',
  elevated: 'text-amber-400',
  critical: 'text-red-400 animate-pulse',
};

function freshnessColor(lastMessageAt: number | null, now: number): string {
  if (lastMessageAt === null) return 'bg-red-500';
  const age = now - lastMessageAt;
  if (age < 3_000) return 'bg-green-500';
  if (age < 10_000) return 'bg-amber-500';
  return 'bg-red-500';
}

function formatHMS(ms: number): string {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map(n => String(n).padStart(2, '0')).join(':');
}

export default function StatusBar({ povOpen, onTogglePov }: StatusBarProps) {
  const { trip, remainingMs, urgencyLevel } = useMission();
  const { status, lastMessageAt, riskPrediction } = useSipraWebSocket(WS_URL, trip?.id ?? null);
  const [now, setNow] = useState(() => Date.now());
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // During the warm-up window the AI has <5 pings and one slow ramp-up sample
  // can mathematically force breach_probability to 1.0. The decision engine
  // already gates DISPATCH_DRONE behind ai_confidence >= 0.70; the dashboard
  // chrome should mirror that and not flash 100% BREACH before the AI is
  // confident in its own number. Show "WARMING UP" instead until confidence
  // crosses a small threshold.
  const isWarmingUp =
    riskPrediction !== null && riskPrediction.ai_confidence < 0.4;
  const breachPct =
    riskPrediction === null || isWarmingUp
      ? null
      : Math.round(riskPrediction.breach_probability * 100);

  const breachChipClass =
    breachPct === null ? '' :
    breachPct >= 80 ? 'text-red-400 border-red-500/50 bg-red-950/50' :
    breachPct >= 60 ? 'text-orange-400 border-orange-500/50 bg-orange-950/50' :
    breachPct >= 40 ? 'text-yellow-400 border-yellow-500/50 bg-yellow-950/50' :
    'text-green-400 border-green-500/50 bg-green-950/50';

  return (
    <header className={`h-10 shrink-0 flex items-center justify-between px-4 border-b border-border transition-colors duration-700 ${URGENCY_BG[urgencyLevel]}`}>

      {/* Left: branding */}
      <span className="font-mono font-bold text-sm tracking-widest uppercase text-foreground shrink-0">
        SIPRA
      </span>

      {/* Centre: mission vitals */}
      <div className="flex items-center gap-3 mx-6 min-w-0">
        {trip && (
          <span className="font-mono text-[11px] text-muted-foreground shrink-0">
            #{trip.id.slice(0, 8).toUpperCase()}
          </span>
        )}
        {trip && (
          <div className={`flex items-center gap-1.5 font-mono text-xs tabular-nums shrink-0 ${
            remainingMs === 0 ? 'text-red-400 animate-pulse' : URGENCY_COUNTDOWN[urgencyLevel]
          }`}>
            <span className="text-[9px] text-muted-foreground uppercase tracking-widest">GH</span>
            <span>{formatHMS(remainingMs)}</span>
          </div>
        )}
        {breachPct !== null && (
          <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded border shrink-0 ${breachChipClass}`}>
            {breachPct}% BREACH
          </span>
        )}
        {isWarmingUp && (
          <span className="font-mono text-[10px] px-1.5 py-0.5 rounded border shrink-0 text-slate-300 border-slate-500/50 bg-slate-800/60 animate-pulse">
            AI WARMING UP
          </span>
        )}
      </div>

      {/* Right: actions + status */}
      <div className="flex items-center gap-4 shrink-0">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground hover:text-green-400 transition-colors"
        >
          <PlayCircle className="w-3 h-3" />
          <span>Run Scenario</span>
        </button>

        {process.env.NEXT_PUBLIC_CHAOS_ENABLED === 'true' && (
          <Link
            href="/admin/chaos"
            target="_blank"
            className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide text-muted-foreground hover:text-yellow-400 transition-colors"
          >
            <Zap className="w-3 h-3" />
            <span>Chaos</span>
          </Link>
        )}

        <button
          type="button"
          onClick={onTogglePov}
          aria-pressed={povOpen}
          className={`flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide transition-colors ${
            povOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Smartphone className="w-3 h-3" />
          <span>Driver POV</span>
        </button>

        {/* Feed freshness */}
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${freshnessColor(lastMessageAt, now)}`} />
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-wide">feed</span>
        </div>

        {/* WS connection */}
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${CONN_DOT[status]}`} />
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-wide">{status}</span>
        </div>
      </div>

      <ScenarioPickerDialog open={pickerOpen} onOpenChange={setPickerOpen} />
    </header>
  );
}

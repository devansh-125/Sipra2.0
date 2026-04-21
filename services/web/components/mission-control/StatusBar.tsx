'use client';

import { useEffect, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { ConnectionStatus } from '../../hooks/useSipraWebSocket';

interface StatusBarProps {
  povOpen: boolean;
  onTogglePov: () => void;
}

const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

const CONN_DOT: Record<ConnectionStatus, string> = {
  connected:    'bg-green-500',
  connecting:   'bg-amber-500',
  disconnected: 'bg-red-500',
};

function freshnessColor(lastMessageAt: number | null, now: number): string {
  if (lastMessageAt === null) return 'bg-red-500';
  const age = now - lastMessageAt;
  if (age < 3_000) return 'bg-green-500';
  if (age < 10_000) return 'bg-amber-500';
  return 'bg-red-500';
}

export default function StatusBar({ povOpen, onTogglePov }: StatusBarProps) {
  const { status, lastMessageAt } = useSipraWebSocket(WS_URL);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  return (
    <header className="h-10 shrink-0 flex items-center justify-between px-4 border-b border-border bg-card">
      <span className="font-mono font-bold text-sm tracking-widest uppercase text-foreground">
        SIPRA — Mission Control
      </span>

      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onTogglePov}
          aria-pressed={povOpen}
          className={`flex items-center gap-1.5 font-mono text-xs uppercase tracking-wide transition-colors ${
            povOpen
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Smartphone className="w-3 h-3" />
          <span>Driver POV</span>
        </button>

        {/* Feed freshness */}
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${freshnessColor(lastMessageAt, now)}`} />
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-wide">
            feed
          </span>
        </div>

        {/* WS connection status */}
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${CONN_DOT[status]}`} />
          <span className="font-mono text-xs text-muted-foreground uppercase tracking-wide">
            {status}
          </span>
        </div>
      </div>
    </header>
  );
}

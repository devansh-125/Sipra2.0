'use client';

import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { ConnectionStatus } from '../../hooks/useSipraWebSocket';

const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

const DOT_CLASS: Record<ConnectionStatus, string> = {
  connected:    'bg-green-500',
  connecting:   'bg-amber-500',
  disconnected: 'bg-red-500',
};

export default function StatusBar() {
  const { status } = useSipraWebSocket(WS_URL);

  return (
    <header className="h-10 shrink-0 flex items-center justify-between px-4 border-b border-border bg-card">
      <span className="font-mono font-bold text-sm tracking-widest uppercase text-foreground">
        SIPRA — Mission Control
      </span>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${DOT_CLASS[status]}`} />
        <span className="font-mono text-xs text-muted-foreground uppercase tracking-wide">
          {status}
        </span>
      </div>
    </header>
  );
}

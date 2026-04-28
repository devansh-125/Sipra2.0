'use client';

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { ScrollArea } from '../ui/scroll-area';
import { Badge } from '../ui/badge';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { RerouteState } from '../../lib/types';

const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

const STATUS_CONFIG: Record<RerouteState, { label: string; color: string; dotColor: string }> = {
  rerouting: { label: 'Rerouting', color: 'bg-amber-600 text-white', dotColor: 'bg-amber-400' },
  completed: { label: 'Completed', color: 'bg-green-600 text-white', dotColor: 'bg-green-400' },
  failed:    { label: 'Failed',    color: 'bg-red-600 text-white',   dotColor: 'bg-red-400' },
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function RerouteStatusPanel() {
  const { rerouteStatuses } = useSipraWebSocket(WS_URL);
  const [open, setOpen] = useState(true);

  const entries = Object.entries(rerouteStatuses);
  const reroutingCount = entries.filter(([, v]) => v.status === 'rerouting').length;
  const completedCount = entries.filter(([, v]) => v.status === 'completed').length;
  const failedCount = entries.filter(([, v]) => v.status === 'failed').length;

  // Sort by most recent first
  const sorted = [...entries].sort(([, a], [, b]) => b.timestamp - a.timestamp);

  return (
    <Card className="bg-card border-border">
      <CardHeader
        className="pb-2 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <CardTitle className="flex items-center justify-between text-xs font-mono text-muted-foreground uppercase tracking-widest">
          <span>Reroute Status</span>
          <span className="text-muted-foreground">{open ? '▲' : '▼'}</span>
        </CardTitle>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 space-y-3">
          {/* Counters */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className="bg-amber-600/20 text-amber-400 border border-amber-600/30 text-[10px] font-mono">
              ● {reroutingCount} rerouting
            </Badge>
            <Badge className="bg-green-600/20 text-green-400 border border-green-600/30 text-[10px] font-mono">
              ● {completedCount} completed
            </Badge>
            <Badge className="bg-red-600/20 text-red-400 border border-red-600/30 text-[10px] font-mono">
              ● {failedCount} failed
            </Badge>
          </div>

          {/* Event list */}
          <ScrollArea className="h-36">
            {sorted.length === 0 ? (
              <p className="text-xs text-muted-foreground font-mono py-1">
                No reroute events yet…
              </p>
            ) : (
              <ul className="space-y-1.5">
                {sorted.slice(0, 10).map(([driverRef, entry]) => {
                  const cfg = STATUS_CONFIG[entry.status];
                  return (
                    <li
                      key={`${driverRef}-${entry.timestamp}`}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dotColor} ${entry.status === 'rerouting' ? 'animate-pulse' : ''}`} />
                        <span className="font-mono text-foreground truncate">
                          {driverRef}
                        </span>
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${cfg.color}`}>
                          {cfg.label}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {entry.bountyId && (
                          <span className="text-blue-400 font-mono text-[10px]" title={`Bounty: ${entry.bountyId}`}>
                            🎯
                          </span>
                        )}
                        {entry.amountPoints ? (
                          <span className="text-yellow-400 font-mono text-[10px]">
                            +{entry.amountPoints}
                          </span>
                        ) : null}
                        <span className="font-mono text-muted-foreground text-[10px]">
                          {formatTime(entry.timestamp)}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>
        </CardContent>
      )}
    </Card>
  );
}

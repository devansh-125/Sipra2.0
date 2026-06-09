'use client';

import { useMemo, useState } from 'react';
import { Coins, Target, CheckCircle2, XCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useMission } from '../../lib/MissionContext';
import { useAmbulanceAnimation } from '../../hooks/useAmbulanceAnimation';
import type { Bounty } from '../../lib/types';

interface DisplayBounty {
  id: string;
  driver_ref: string;
  amount_points: number;
  status: 'offered' | 'claimed' | 'verified' | 'expired';
  offered_at: string;
}

const EXCLUSION_RADIUS_KM = 2;
const WARNING_RADIUS_KM = 3;
const DEG = Math.PI / 180;
const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

const STATUS_COLOR: Record<DisplayBounty['status'], string> = {
  offered:  'text-yellow-400',
  claimed:  'text-orange-400',
  verified: 'text-green-400',
  expired:  'text-red-400',
};

function StatusIcon({ status }: { status: DisplayBounty['status'] }) {
  const cls = `w-4 h-4 shrink-0 ${STATUS_COLOR[status]}`;
  switch (status) {
    case 'offered':  return <Coins className={cls} />;
    case 'claimed':  return <Target className={cls} />;
    case 'verified': return <CheckCircle2 className={cls} />;
    case 'expired':  return <XCircle className={cls} />;
  }
}

export default function BountyPanel() {
  const [open, setOpen] = useState(false);

  const {
    ambulanceLat,
    ambulanceLng,
    fleet,
    rerouteStatuses,
  } = useSipraWebSocket(WS_URL);
  const { polyline, etaSeconds, origin, trip } = useMission();

  const animatedAmbulance = useAmbulanceAnimation(
    ambulanceLat,
    ambulanceLng,
    polyline,
    etaSeconds,
    trip?.started_at,
    origin,
  );

  const createdBounties = useMemo<Map<string, Bounty>>(() => new Map(), []);

  const bountyStats = useMemo(() => {
    const displayMap = new Map<string, DisplayBounty>();

    createdBounties.forEach((b, vid) => {
      displayMap.set(vid, {
        id: b.id,
        driver_ref: b.driver_ref,
        amount_points: b.amount_points,
        status: b.status.toLowerCase() as DisplayBounty['status'],
        offered_at: b.offered_at,
      });
    });

    for (const [driverRef, rs] of Object.entries(rerouteStatuses)) {
      const overlayStatus: DisplayBounty['status'] =
        rs.status === 'rerouting' ? 'claimed' :
        rs.status === 'completed' ? 'verified' : 'expired';
      const existing = displayMap.get(driverRef);
      if (existing) {
        displayMap.set(driverRef, {
          ...existing,
          status: overlayStatus,
          amount_points: rs.amountPoints ?? existing.amount_points,
        });
      } else {
        displayMap.set(driverRef, {
          id: rs.bountyId ?? `status-${driverRef}`,
          driver_ref: driverRef,
          amount_points: rs.amountPoints ?? 0,
          status: overlayStatus,
          offered_at: new Date(rs.timestamp).toISOString(),
        });
      }
    }

    const ambulancePos = { lat: animatedAmbulance.lat, lng: animatedAmbulance.lng };
    if (ambulancePos.lat && ambulancePos.lng) {
      const nowIso = new Date().toISOString();
      for (const vehicle of fleet) {
        if (displayMap.has(vehicle.id)) continue;
        const distKm = haversineKm(ambulancePos, { lat: vehicle.lat, lng: vehicle.lng });
        const inRed = distKm <= EXCLUSION_RADIUS_KM;
        const inYellow = !inRed && distKm <= WARNING_RADIUS_KM;
        if (!inRed && !inYellow) continue;
        displayMap.set(vehicle.id, {
          id: `pending-${vehicle.id}`,
          driver_ref: vehicle.id,
          amount_points: 150,
          status: 'offered',
          offered_at: nowIso,
        });
      }
    }

    const allBounties = Array.from(displayMap.values());
    const activeBounties = [...allBounties]
      .sort((a, b) => b.offered_at.localeCompare(a.offered_at))
      .slice(0, 10);

    return {
      total_offered:       allBounties.filter(b => b.status === 'offered').length,
      total_claimed:       allBounties.filter(b => b.status === 'claimed').length,
      total_verified:      allBounties.filter(b => b.status === 'verified').length,
      total_points_awarded: allBounties.filter(b => b.status === 'verified').reduce((s, b) => s + b.amount_points, 0),
      active_bounties: activeBounties,
    };
  }, [createdBounties, rerouteStatuses, fleet, animatedAmbulance.lat, animatedAmbulance.lng]);

  const totalActive = bountyStats.total_offered + bountyStats.total_claimed;

  return (
    <Card className="bg-card border-border">
      <CardHeader
        className="pb-2 cursor-pointer select-none"
        onClick={() => setOpen(o => !o)}
      >
        <CardTitle className="flex items-center justify-between text-xs font-mono text-muted-foreground uppercase tracking-widest">
          <div className="flex items-center gap-2">
            <span>Bounty System</span>
            {totalActive > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-[10px] font-mono border border-yellow-500/30">
                {totalActive} active
              </span>
            )}
          </div>
          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </CardTitle>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 space-y-3">
          {/* Stat grid */}
          <div className="grid grid-cols-2 gap-2">
            {([
              { count: bountyStats.total_offered,       label: 'Offered',  color: 'text-yellow-400' },
              { count: bountyStats.total_claimed,       label: 'Claimed',  color: 'text-orange-400' },
              { count: bountyStats.total_verified,      label: 'Verified', color: 'text-green-400'  },
              { count: bountyStats.total_points_awarded, label: 'Points',   color: 'text-blue-400'   },
            ] as { count: number; label: string; color: string }[]).map(({ count, label, color }) => (
              <div key={label} className="bg-muted/40 rounded-lg p-2.5">
                <div className={`text-xl font-bold tabular-nums font-mono ${color}`}>{count}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</div>
              </div>
            ))}
          </div>

          {/* Activity list */}
          <div className="space-y-1">
            <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest">Recent Activity</p>
            <div className="max-h-44 overflow-y-auto space-y-1.5">
              {bountyStats.active_bounties.length === 0 ? (
                <p className="text-xs text-muted-foreground font-mono py-2 text-center">
                  Waiting for fleet vehicles to enter corridor…
                </p>
              ) : (
                bountyStats.active_bounties.map((bounty) => (
                  <div
                    key={bounty.id}
                    className="flex items-center justify-between bg-muted/30 rounded-lg px-2.5 py-1.5"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusIcon status={bounty.status} />
                      <div className="min-w-0">
                        <div className="text-xs font-mono text-foreground truncate">{bounty.driver_ref}</div>
                        <div className={`text-[10px] font-mono uppercase tracking-wide ${STATUS_COLOR[bounty.status]}`}>
                          {bounty.status}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0 ml-2">
                      <div className="text-xs font-mono font-bold text-foreground tabular-nums">
                        {bounty.amount_points} pts
                      </div>
                      <div className="text-[10px] font-mono text-muted-foreground">
                        {bounty.id.startsWith('pending-') ? 'pending…' : `${bounty.id.slice(0, 8)}…`}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  );
}

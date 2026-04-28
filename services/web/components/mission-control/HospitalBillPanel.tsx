'use client';

import { useMission } from '../../lib/MissionContext';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import type { GeoPoint } from '../../lib/types';

const PLATFORM_FEE_INR = 500;
const RATE_PER_KM_INR  = 15;
const ROAD_FACTOR      = 1.4; // same as AI brain

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const R    = 6_371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function fmt(n: number): string {
  return '₹' + n.toFixed(2);
}

export default function HospitalBillPanel() {
  const { trip, origin, destination } = useMission();
  const { rerouteStatuses } = useSipraWebSocket();

  // ── Distance ───────────────────────────────────────────────────────────────
  const roadKm =
    origin && destination
      ? haversineKm(origin, destination) * ROAD_FACTOR
      : 0;
  const distanceCharge = roadKm * RATE_PER_KM_INR;

  // ── Reward points redeemed (verified bounties only) ────────────────────────
  let totalPointsRedeemed = 0;
  let verifiedCount = 0;
  Object.values(rerouteStatuses).forEach(s => {
    if (s.status === 'completed' && s.amountPoints) {
      totalPointsRedeemed += s.amountPoints;
      verifiedCount++;
    }
  });
  const rewardsCharge = totalPointsRedeemed; // 1 point = ₹1

  // ── Total ──────────────────────────────────────────────────────────────────
  const total = PLATFORM_FEE_INR + distanceCharge + rewardsCharge;

  const cargoLabel = trip
    ? `${trip.cargo.category} — ${trip.cargo.description}`
    : '—';

  const fromLabel = trip?.hospital_dispatch_id ?? (origin ? `${origin.lat.toFixed(4)}, ${origin.lng.toFixed(4)}` : '—');
  const toLabel   = destination ? `${destination.lat.toFixed(4)}, ${destination.lng.toFixed(4)}` : '—';

  const tripShort = trip ? `#${trip.id.slice(0, 8).toUpperCase()}` : '—';

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-3 font-mono text-xs">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-foreground">Hospital Invoice</div>
          <div className="text-muted-foreground">Sipra Bio-Logistics Platform</div>
        </div>
        <span className="text-[10px] bg-green-900/40 text-green-400 border border-green-700 rounded px-1.5 py-0.5">
          LIVE
        </span>
      </div>

      {/* Trip meta */}
      <div className="bg-muted/40 rounded p-2 space-y-1 text-muted-foreground">
        <div className="flex justify-between">
          <span>Trip</span>
          <span className="text-foreground">{tripShort}</span>
        </div>
        <div className="flex justify-between">
          <span>Cargo</span>
          <span className="text-foreground truncate max-w-[130px]" title={cargoLabel}>{cargoLabel}</span>
        </div>
        <div className="flex justify-between">
          <span>From</span>
          <span className="text-foreground truncate max-w-[130px]" title={fromLabel}>{fromLabel}</span>
        </div>
        <div className="flex justify-between">
          <span>Distance</span>
          <span className="text-foreground">{roadKm.toFixed(2)} km</span>
        </div>
      </div>

      {/* Line items */}
      <div className="space-y-2">
        {/* Platform fee */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground">Platform Fee</div>
            <div className="text-muted-foreground text-[10px]">Corridor engine + AI brain</div>
          </div>
          <div className="text-foreground font-semibold">{fmt(PLATFORM_FEE_INR)}</div>
        </div>

        {/* Distance */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground">Distance Charge</div>
            <div className="text-muted-foreground text-[10px]">{roadKm.toFixed(2)} km × ₹{RATE_PER_KM_INR}/km</div>
          </div>
          <div className="text-foreground font-semibold">{fmt(distanceCharge)}</div>
        </div>

        {/* Fleet rewards redeemed */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-foreground">Fleet Rewards Redeemed</div>
            <div className="text-muted-foreground text-[10px]">{verifiedCount} drivers × avg {verifiedCount > 0 ? (totalPointsRedeemed / verifiedCount).toFixed(0) : 0} pts</div>
          </div>
          <div className="text-orange-400 font-semibold">{fmt(rewardsCharge)}</div>
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border" />

      {/* Total */}
      <div className="flex items-center justify-between">
        <span className="text-foreground font-bold text-sm">TOTAL</span>
        <span className="text-green-400 font-bold text-base">{fmt(total)}</span>
      </div>

      {/* Reward ledger */}
      <div className="flex items-center justify-between border-t border-border pt-2">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground">Reward points</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-1.5 h-1.5 rounded-full bg-green-400" />
          <span className="text-muted-foreground">Internal</span>
        </div>
      </div>
    </div>
  );
}

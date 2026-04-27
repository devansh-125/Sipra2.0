'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { IndianRupee, WalletCards } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { FALLBACK_DESTINATION, FALLBACK_ORIGIN } from '../../../lib/routing';
import { buildRewardsSettlement } from '../../../lib/rewardsSettlement';
import type { RewardSettlement } from '../../../lib/rewardsSettlement';
import type { GeoPoint } from '../../../lib/types';
import dynamic from 'next/dynamic';

const GemmaRewardsPanel = dynamic(
  () => import('../../../components/demo/GemmaRewardsPanel'),
  { ssr: false },
);

// ── Formatters ────────────────────────────────────────────────────────────────

function rupees(value: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(value);
}

/** Format a Date to HH:MM:SS am/pm — always runs client-side only */
function fmtTime(date: Date): string {
  return date.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function parsePoint(lat: string | null, lng: string | null, fallback: GeoPoint): GeoPoint {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return fallback;
  return { lat: parsedLat, lng: parsedLng };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function RewardsSettlementPage() {
  const searchParams = useSearchParams();
  const tripId = searchParams.get('tripId') ?? process.env.NEXT_PUBLIC_DEMO_TRIP_ID ?? 'demo-trip-001';
  const destination = parsePoint(
    searchParams.get('destinationLat'),
    searchParams.get('destinationLng'),
    FALLBACK_DESTINATION,
  );
  const distanceMeters = Number(searchParams.get('distanceMeters') ?? '16800') || 16800;

  const droneActivated = searchParams.get('droneActivated') === 'true';

  // Name passed directly from the corridor-sim page via URL param (most reliable).
  const paramName = searchParams.get('destinationName') ?? '';
  const [destinationName, setDestinationName] = useState(paramName || 'Tender Palm Hospital');

  // If no name was passed in the URL, resolve asynchronously via Places API
  useEffect(() => {
    if (paramName) {
      setDestinationName(paramName);
      return;
    }
    // Async fallback: try reverse geocoding
    const params = new URLSearchParams({
      lat: String(destination.lat),
      lng: String(destination.lng),
      type: 'hospital',
    });
    fetch(`/api/places/nearby?${params.toString()}`, { signal: AbortSignal.timeout(6_000) })
      .then((r) => r.ok ? r.json() : null)
      .then((data: { name?: string } | null) => {
        if (data?.name) setDestinationName(data.name);
      })
      .catch(() => { /* keep current value */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramName]);

  // ── CRITICAL FIX: build settlement data ONLY on the client to avoid
  // SSR/client mismatch from new Date() producing different timestamps.
  const [settlement, setSettlement] = useState<RewardSettlement | null>(null);

  useEffect(() => {
    const data = buildRewardsSettlement({ tripId, distanceMeters });
    setSettlement(data);

    // Log to Trust Ledger on settlement creation
    import('../../../lib/trustLedger').then(({ TrustLedger }) => {
      TrustLedger.addEvent('DEMO-MISSION', 'Driver Reward Creation', 'Smart Contract', { driversRewarded: data.drivers.length, amount: rupees(data.rewardsSubtotal) });
      TrustLedger.addEvent('DEMO-MISSION', 'Payment Generation', 'Billing Engine', { total: rupees(data.totalPayable), status: 'Pending' });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripId, distanceMeters]);

  // suppress unused import warning
  void FALLBACK_ORIGIN;

  // ── Loading skeleton while data generates on client ───────────────────────
  if (!settlement) {
    return (
      <main
        style={{ height: '100vh', overflowY: 'auto' }}
        className="bg-background text-foreground p-6 md:p-8 flex items-center justify-center"
      >
        <div className="text-muted-foreground font-mono text-sm animate-pulse">Generating settlement…</div>
      </main>
    );
  }

  // ── Full render ───────────────────────────────────────────────────────────
  return (
    // height:100vh + overflowY:auto makes this element its own scroll container,
    // bypassing the global overflow:hidden set on html/body in globals.css
    <main
      style={{ height: '100vh', overflowY: 'auto' }}
      className="bg-background text-foreground p-6 md:p-8"
    >
      <div className="mx-auto max-w-7xl space-y-6">

        {/* ── Top header row ── */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
              SIPRA — Rewards Settlement
            </p>
            <h1 className="text-2xl font-semibold tracking-tight">Red-Zone Driver Rewards Ledger</h1>
            <p className="text-sm text-muted-foreground">
              {settlement.drivers.length} drivers were rewarded for clearing the emergency corridor.
            </p>
          </div>

          {/* Total Payable card */}
          <Card className="w-full md:w-[320px] border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-mono uppercase tracking-widest text-muted-foreground">
                Total Payable
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-3xl font-bold leading-none text-foreground">
                  {rupees(settlement.totalPayable)}
                </span>
                <IndianRupee className="h-7 w-7 text-emerald-500" />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Trip: {tripId.slice(0, 16)}…</p>
            </CardContent>
          </Card>
        </div>

        {/* ── Destination + Payment row ── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
                Destination Hospital
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              <p className="text-xl font-semibold">{destinationName}</p>
              <p className="font-mono text-xs text-muted-foreground">
                Coordinates: {destination.lat.toFixed(4)}, {destination.lng.toFixed(4)}
              </p>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
                Payment
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Button type="button" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">
                <WalletCards className="mr-2 h-4 w-4" />
                Pay with GPay
              </Button>
              <p className="text-xs text-muted-foreground">
                Demo-only CTA. No live payment is triggered.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ── Driver rewards table ── */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
              Rewarded Drivers (Red Zone) — {settlement.drivers.length} drivers
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left font-mono text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 pr-4">#</th>
                    <th className="py-2 pr-4">Driver ID</th>
                    <th className="py-2 pr-4">Red Alert Time</th>
                    <th className="py-2 pr-4">Exit Time</th>
                    <th className="py-2 text-right">Reward</th>
                  </tr>
                </thead>
                <tbody>
                  {settlement.drivers.map((row, i) => (
                    <tr key={row.driverId} className="border-b border-border/60 hover:bg-white/[0.02] transition-colors">
                      <td className="py-2 pr-4 text-muted-foreground text-xs">{i + 1}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-foreground">{row.driverId}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{fmtTime(row.redAlertAt)}</td>
                      <td className="py-2 pr-4 text-muted-foreground">{fmtTime(row.movedOutAt)}</td>
                      <td className="py-2 text-right font-semibold text-emerald-500">{rupees(row.rewardRupees)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* ── Billing Breakdown + Actions ── */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
                Billing Breakdown
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Driver rewards subtotal ({settlement.drivers.length} drivers)
                </span>
                <span className="font-semibold">{rupees(settlement.rewardsSubtotal)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Distance fee ({settlement.distanceKm.toFixed(1)} km × ₹{settlement.perKmRate}/km)
                </span>
                <span className="font-semibold">{rupees(settlement.distanceFee)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  Platform service charge ({Math.round(settlement.platformRate * 100)}%)
                </span>
                <span className="font-semibold">{rupees(settlement.platformCharge)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Emergency compliance fee</span>
                <span className="font-semibold">{rupees(settlement.complianceFee)}</span>
              </div>
              <div className="mt-2 border-t border-border pt-2 flex items-center justify-between text-base">
                <span className="font-semibold">Total payable</span>
                <span className="font-bold text-emerald-500">{rupees(settlement.totalPayable)}</span>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-mono uppercase tracking-widest text-muted-foreground">
                Actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button type="button" className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold">
                <WalletCards className="mr-2 h-4 w-4" />
                Pay with GPay
              </Button>
              <Button asChild variant="outline" className="w-full">
                <Link href="/demo/corridor-sim">← Back to Dashboard</Link>
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* ── Gemma AI Panels ── */}
        <GemmaRewardsPanel
          tripId={tripId}
          distanceMeters={distanceMeters}
          drivers={settlement.drivers}
          rewardsSubtotal={settlement.rewardsSubtotal}
          distanceFee={settlement.distanceFee}
          platformCharge={settlement.platformCharge}
          complianceFee={settlement.complianceFee}
          totalPayable={settlement.totalPayable}
          destinationName={destinationName}
          droneActivated={droneActivated}
        />

      </div>
    </main>
  );
}
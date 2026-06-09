'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import TripPanel from './TripPanel';
import StatusBar from './StatusBar';
import HandoffOverlay from './HandoffOverlay';
import TripCompletedOverlay from './TripCompletedOverlay';
import DriverPovOverlay from './DriverPovOverlay';
import RerouteStatusPanel from './RerouteStatusPanel';
import BountyPanel from './BountyPanel';
import AIBrainPanel from './AIBrainPanel';
import HospitalBillPanel from './HospitalBillPanel';
import { MissionProvider, useMission } from '../../lib/MissionContext';
import type { UrgencyLevel } from '../../lib/MissionContext';

const CorridorMap = dynamic(() => import('../map/CorridorMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-[#111] flex items-center justify-center text-[#555] font-mono text-sm">
      Loading map…
    </div>
  ),
});

type SidebarTab = 'live' | 'ops';

const URGENCY_BORDER: Record<UrgencyLevel, string> = {
  normal:   'border-border',
  elevated: 'border-amber-500/50',
  critical: 'border-red-500/60',
};

function MissionLayout() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  const { origin, destination, polyline, etaSeconds, routeSource, trip, urgencyLevel } = useMission();
  const [povOpen, setPovOpen] = useState(false);
  const [tab, setTab] = useState<SidebarTab>('live');

  const borderClass = URGENCY_BORDER[urgencyLevel];

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background">
      <StatusBar povOpen={povOpen} onTogglePov={() => setPovOpen(o => !o)} />

      <div className="flex flex-1 overflow-hidden">
        <aside className={`w-80 shrink-0 border-r-2 ${borderClass} bg-card flex flex-col transition-colors duration-700`}>

          {/* Tab switcher */}
          <div className="flex shrink-0 border-b border-border">
            {(['live', 'ops'] as SidebarTab[]).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-1 py-2 font-mono text-[11px] uppercase tracking-widest transition-colors ${
                  tab === t
                    ? 'text-foreground bg-muted/40 border-b-2 border-primary -mb-px'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {t === 'live' ? '● Live' : '⚙ Ops'}
              </button>
            ))}
          </div>

          {/* Panel content */}
          <div className="flex-1 overflow-y-auto">
            {tab === 'live' ? (
              <>
                <TripPanel />
                <div className="px-4 pb-4">
                  <AIBrainPanel />
                </div>
              </>
            ) : (
              <div className="p-4 space-y-3">
                <RerouteStatusPanel />
                <BountyPanel />
                <HospitalBillPanel />
              </div>
            )}
          </div>
        </aside>

        <main className="relative flex-1 overflow-hidden">
          <CorridorMap
            googleMapsApiKey={apiKey}
            startedAt={trip?.started_at}
            routeSource={routeSource}
            origin={origin}
            destination={destination}
            polyline={polyline}
            etaSeconds={etaSeconds}
          />
        </main>
      </div>

      <DriverPovOverlay
        apiKey={apiKey}
        origin={origin}
        destination={destination}
        polyline={polyline}
        open={povOpen}
        onClose={() => setPovOpen(false)}
      />

      <HandoffOverlay />
      <TripCompletedOverlay />
    </div>
  );
}

export default function MissionControlLayout() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tripId = searchParams.get('tripId') ?? null;

  // Auto-hydrate when the user opens /dashboard without ?tripId= but a trip
  // is actively broadcasting on the WS (e.g. they started the scenario from
  // the CLI). We pluck the trip_id from the next trip-scoped WS frame and
  // replace the URL so TripPanel/CorridorMap/AIBrainPanel all bind to it.
  // No filter on the hook call — we want to *discover* whichever trip is live.
  const { riskPrediction, handoffState } = useSipraWebSocket();
  useEffect(() => {
    if (tripId) return;
    const discovered = riskPrediction?.trip_id ?? handoffState?.trip_id ?? null;
    if (discovered) {
      router.replace(`/dashboard?tripId=${discovered}`);
    }
  }, [tripId, riskPrediction?.trip_id, handoffState?.trip_id, router]);

  return (
    <MissionProvider tripId={tripId}>
      <MissionLayout />
    </MissionProvider>
  );
}

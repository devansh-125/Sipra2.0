'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import TripPanel from './TripPanel';
import StatusBar from './StatusBar';
import HandoffOverlay from './HandoffOverlay';
import DriverPovOverlay from './DriverPovOverlay';
import RerouteStatusPanel from './RerouteStatusPanel';
import { MissionProvider, useMission } from '../../lib/MissionContext';

const CorridorMap = dynamic(() => import('../map/CorridorMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-[#111] flex items-center justify-center text-[#555] font-mono text-sm">
      Loading map…
    </div>
  ),
});

// Inner layout — reads from MissionContext.
function MissionLayout() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';
  const {
    origin, destination, polyline, etaSeconds, routeSource,
    corridorGeometry, trip,
  } = useMission();
  const [povOpen, setPovOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background">
      <StatusBar povOpen={povOpen} onTogglePov={() => setPovOpen(o => !o)} />

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-80 shrink-0 border-r border-border bg-card flex flex-col overflow-y-auto">
          <TripPanel />
          <div className="px-4 pb-4">
            <RerouteStatusPanel />
          </div>
        </aside>

        <main className="relative flex-1 overflow-hidden">
          <CorridorMap
            googleMapsApiKey={apiKey}
            origin={origin}
            destination={destination}
            polyline={polyline}
            etaSeconds={etaSeconds}
            startedAt={trip?.started_at}
            routeSource={routeSource}
            corridorGeometry={corridorGeometry}
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
    </div>
  );
}

// Outer layout — provides MissionContext.
export default function MissionControlLayout() {
  const searchParams = useSearchParams();
  const tripId = searchParams.get('tripId') ?? process.env.NEXT_PUBLIC_DEMO_TRIP_ID ?? null;

  return (
    <MissionProvider tripId={tripId}>
      <MissionLayout />
    </MissionProvider>
  );
}

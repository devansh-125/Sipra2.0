import dynamic from 'next/dynamic';
import TripPanel from './TripPanel';
import StatusBar from './StatusBar';
import HandoffOverlay from './HandoffOverlay';

const CorridorMap = dynamic(() => import('../map/CorridorMap'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-[#111] flex items-center justify-center text-[#555] font-mono text-sm">
      Loading map…
    </div>
  ),
});

export default function MissionControlLayout() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background">
      <StatusBar />

      <div className="flex flex-1 overflow-hidden">
        <aside className="w-80 shrink-0 border-r border-border bg-card flex flex-col">
          <TripPanel />
        </aside>

        <main className="relative flex-1 overflow-hidden">
          <CorridorMap googleMapsApiKey={apiKey} />
        </main>
      </div>

      <HandoffOverlay />
    </div>
  );
}

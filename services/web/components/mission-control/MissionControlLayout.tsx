import DashboardClient from '../DashboardClient';
import TripPanel from './TripPanel';
import StatusBar from './StatusBar';

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
          <DashboardClient googleMapsApiKey={apiKey} />
        </main>
      </div>
    </div>
  );
}

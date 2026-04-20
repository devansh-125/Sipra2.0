import DashboardClient from '../DashboardClient';

export default function MissionControlLayout() {
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background">
      <aside className="w-80 shrink-0 border-r border-border bg-card flex flex-col">
        <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm font-mono px-6 text-center">
          Trip Panel — coming Session 2
        </div>
      </aside>

      <main className="relative flex-1 overflow-hidden">
        <DashboardClient googleMapsApiKey={apiKey} />
      </main>
    </div>
  );
}

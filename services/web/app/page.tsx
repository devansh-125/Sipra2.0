import DashboardClient from '../components/DashboardClient';

export default function DashboardPage() {
  return (
    <main style={{ width: '100vw', height: '100vh' }}>
      <DashboardClient
        googleMapsApiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ''}
      />
    </main>
  );
}

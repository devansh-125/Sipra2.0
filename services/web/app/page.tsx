import dynamic from 'next/dynamic';

// Google Maps, deck.gl, and WebSocket are browser-only APIs.
const CorridorMap = dynamic(
  () => import('../components/map/CorridorMap'),
  {
    ssr: false,
    loading: () => (
      <div style={{ width: '100vw', height: '100vh', background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontFamily: 'monospace' }}>
        Loading map…
      </div>
    ),
  },
);

export default function DashboardPage() {
  return (
    <main style={{ width: '100vw', height: '100vh' }}>
      <CorridorMap
        googleMapsApiKey={process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? ''}
      />
    </main>
  );
}

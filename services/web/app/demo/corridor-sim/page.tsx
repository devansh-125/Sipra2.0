'use client';

/**
 * /demo/corridor-sim — Three-Column Mission Control Dashboard
 *
 * Layout:
 *   Left  (20%): MissionStatusSidebar — Golden Hour, mission details, controls
 *   Center(60%): CorridorSimMap — live map with ambulance, exclusion zone, drivers
 *   Right (20%): SimDriverPhone — driver phone mockup reacting to sim state
 *
 * State sharing: the useCorridorSimulation hook is called here at the page level
 * and its state is passed down to all three columns so they stay in sync.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useCorridorSimulation } from '../../../hooks/useCorridorSimulation';
import { APIProvider } from '@vis.gl/react-google-maps';

const CorridorSimMap = dynamic(
  () => import('../../../components/demo/CorridorSimMap'),
  { ssr: false },
);

const MissionStatusSidebar = dynamic(
  () => import('../../../components/demo/MissionStatusSidebar'),
  { ssr: false },
);

const SimDriverPhone = dynamic(
  () => import('../../../components/demo/SimDriverPhone'),
  { ssr: false },
);

const MissionTrustLedger = dynamic(
  () => import('../../../components/demo/MissionTrustLedger'),
  { ssr: false },
);

const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

// Tender Palm Hospital — destination used by the corridor sim
const DESTINATION_LAT = 26.8547;
const DESTINATION_LNG = 80.9180;
const DESTINATION_NAME = 'Tender Palm Hospital';

export default function CorridorSimPage() {
  const sim = useCorridorSimulation();
  const [speed, setSpeed] = useState(1);
  const router = useRouter();

  const handleSpeedChange = useCallback(
    (s: number) => {
      setSpeed(s);
      sim.setSpeed(s);
    },
    [sim],
  );

  /** Navigate to the Reward Summary page with trip telemetry as query params. */
  const handleViewRewards = useCallback(() => {
    const params = new URLSearchParams({
      tripId: `demo-trip-${Date.now()}`,
      distanceMeters: String(sim.distanceMeters || 16800),
      destinationLat: String(DESTINATION_LAT),
      destinationLng: String(DESTINATION_LNG),
      destinationName: DESTINATION_NAME,
      droneActivated: String(sim.isEmergencyMode),
    });
    router.push(`/demo/rewards-settlement?${params.toString()}`);
  }, [sim.distanceMeters, sim.isEmergencyMode, router]);

  return (
    <>
      <head>
        <title>Sipra — Mission Control Dashboard</title>
        <meta
          name="description"
          content="Three-column mission control dashboard with ambulance corridor simulation, fleet status, and driver POV"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <APIProvider apiKey={apiKey} libraries={['geometry']}>
        <div
          style={{
            width: '100vw',
            height: '100vh',
            overflow: 'hidden',
            margin: 0,
            padding: 0,
            display: 'grid',
            gridTemplateColumns: 'minmax(280px, 18%) 1fr minmax(320px, 20%) minmax(320px, 23%)',
            background: '#0c0c1a',
          }}
        >
          {/* Left Column — Mission Status */}
          <div className="custom-scrollbar" style={{ overflowY: 'auto', height: '100vh' }}>
            <MissionStatusSidebar
              sim={sim}
              speed={speed}
              onSpeedChange={handleSpeedChange}
              onViewRewards={handleViewRewards}
            />
          </div>

          {/* Center Column — Corridor Map */}
          <main style={{ position: 'relative', overflow: 'hidden', height: '100vh' }}>
            <CorridorSimMap apiKey={apiKey} sim={sim} embedded />
          </main>

          {/* Right Column — Driver Phone */}
          <div className="custom-scrollbar" style={{ overflowY: 'auto', height: '100vh', display: 'flex', justifyContent: 'center' }}>
            <SimDriverPhone sim={sim} />
          </div>

          {/* Far Right Column — Trust Ledger */}
          <div className="custom-scrollbar" style={{ overflowY: 'auto', height: '100vh' }}>
            <MissionTrustLedger />
          </div>
        </div>
      </APIProvider>
    </>
  );
}

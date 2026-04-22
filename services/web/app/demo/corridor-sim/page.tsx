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

const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

export default function CorridorSimPage() {
  const sim = useCorridorSimulation();
  const [speed, setSpeed] = useState(1);

  const handleSpeedChange = useCallback(
    (s: number) => {
      setSpeed(s);
      sim.setSpeed(s);
    },
    [sim],
  );

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
          gridTemplateColumns: '20% 1fr 20%',
          background: '#0c0c1a',
        }}
      >
        {/* Left Column — Mission Status */}
        <MissionStatusSidebar
          sim={sim}
          speed={speed}
          onSpeedChange={handleSpeedChange}
        />

        {/* Center Column — Corridor Map */}
        <main style={{ position: 'relative', overflow: 'hidden' }}>
          <CorridorSimMap apiKey={apiKey} sim={sim} embedded />
        </main>

        {/* Right Column — Driver Phone */}
        <SimDriverPhone sim={sim} />
      </div>
      </APIProvider>
    </>
  );
}

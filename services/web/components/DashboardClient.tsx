'use client';

import dynamic from 'next/dynamic';
import { useCallback, useState } from 'react';
import type { HandoffInitiatedPayload } from '../lib/types';
import HandoffBanner from './HandoffBanner';

const CorridorMap = dynamic(() => import('./map/CorridorMap'), {
  ssr: false,
  loading: () => (
    <div style={{ width: '100vw', height: '100vh', background: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontFamily: 'monospace' }}>
      Loading map…
    </div>
  ),
});

export default function DashboardClient({ googleMapsApiKey }: { googleMapsApiKey: string }) {
  const [handoffState, setHandoffState] = useState<HandoffInitiatedPayload | null>(null);
  const onHandoff = useCallback((p: HandoffInitiatedPayload) => setHandoffState(p), []);

  return (
    <>
      <HandoffBanner handoffState={handoffState} />
      <CorridorMap googleMapsApiKey={googleMapsApiKey} onHandoff={onHandoff} />
    </>
  );
}

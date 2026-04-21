'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import DriverShell from '../../../components/driver/DriverShell';
import { MissionProvider } from '../../../lib/MissionContext';

function DriverContent() {
  const params = useParams<{ tripId: string }>();
  const tripId = params?.tripId ?? 'unknown';
  return (
    <MissionProvider tripId={tripId}>
      <DriverShell tripId={tripId} />
    </MissionProvider>
  );
}

export default function DriverPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm">Loading driver session…</p>}>
      <DriverContent />
    </Suspense>
  );
}

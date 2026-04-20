'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import DriverShell from '../../../components/driver/DriverShell';

function DriverContent() {
  const params = useParams<{ tripId: string }>();
  const tripId = params?.tripId ?? 'unknown';
  return <DriverShell tripId={tripId} />;
}

export default function DriverPage() {
  return (
    <Suspense fallback={<p className="p-4 text-sm">Loading driver session…</p>}>
      <DriverContent />
    </Suspense>
  );
}

'use client';

/**
 * /demo/ambulance-dispatch — Real-Time Ambulance Dispatch System
 *
 * Full-page demo that uses REAL Google Maps APIs:
 *   - Places API (Nearby Search) to fetch REAL hospitals
 *   - Directions API for real driving routes
 *   - Maps JavaScript API for rendering
 *
 * Zero dummy data — everything comes from Google APIs.
 */

import dynamic from 'next/dynamic';
import { APIProvider } from '@vis.gl/react-google-maps';

const AmbulanceDispatchMap = dynamic(
  () => import('../../../components/demo/AmbulanceDispatchMap'),
  { ssr: false },
);

const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

export default function AmbulanceDispatchPage() {
  return (
    <>
      <head>
        <title>Sipra — Real-Time Ambulance Dispatch</title>
        <meta
          name="description"
          content="Real-time ambulance dispatch system with live hospital data from Google Places API and actual road routes from Google Directions API"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <APIProvider apiKey={apiKey}>
        <div style={{
          width: '100vw',
          height: '100vh',
          overflow: 'hidden',
          margin: 0,
          padding: 0,
        }}>
          <AmbulanceDispatchMap apiKey={apiKey} />
        </div>
      </APIProvider>
    </>
  );
}

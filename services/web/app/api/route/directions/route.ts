import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/route/directions
 *
 * Server-side proxy for the Google Maps Directions API.
 * Keeps the API key out of the browser bundle.
 *
 * Query params:
 *   origin      — "lat,lng"
 *   destination — "lat,lng"
 *
 * Returns:
 *   { polylineEncoded: string, etaSeconds: number }
 *   or { error: string }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const origin      = searchParams.get('origin');
  const destination = searchParams.get('destination');

  if (!origin || !destination) {
    return NextResponse.json({ error: 'origin and destination are required' }, { status: 400 });
  }

  // Prefer the server-only key; fall back to the public one (common for demos).
  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'no API key configured' }, { status: 503 });
  }

  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', origin);
  url.searchParams.set('destination', destination);
  url.searchParams.set('departure_time', 'now');
  url.searchParams.set('traffic_model', 'best_guess');
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', apiKey);

  try {
    const res = await fetch(url.toString(), { next: { revalidate: 0 } });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Directions API HTTP ${res.status}` },
        { status: 502 },
      );
    }

    const data = await res.json() as {
      status: string;
      routes?: Array<{
        overview_polyline: { points: string };
        legs?: Array<{
          duration_in_traffic?: { value: number };
          duration?: { value: number };
        }>;
      }>;
      error_message?: string;
    };

    if (data.status !== 'OK' || !data.routes?.length) {
      console.error('[directions-proxy] API status:', data.status, data.error_message);
      return NextResponse.json(
        { error: data.error_message ?? `Directions API status: ${data.status}` },
        { status: 502 },
      );
    }

    const route = data.routes[0];
    const leg   = route.legs?.[0];

    const etaSeconds =
      leg?.duration_in_traffic?.value ??
      leg?.duration?.value ??
      0;

    return NextResponse.json({
      polylineEncoded: route.overview_polyline.points,
      etaSeconds,
    });
  } catch (err) {
    console.error('[directions-proxy] fetch error:', err);
    return NextResponse.json({ error: 'upstream fetch failed' }, { status: 502 });
  }
}

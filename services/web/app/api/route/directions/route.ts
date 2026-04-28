import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/route/directions
 *
 * Server-side proxy for the Google Maps Directions API.
 * Keeps the API key out of the browser bundle.
 *
 * Query params:
 *   origin       — "lat,lng"
 *   destination  — "lat,lng"
 *   alternatives — "true" (optional) – return alternate routes
 *
 * Returns (single route):
 *   { polylineEncoded: string, etaSeconds: number, distanceMeters: number }
 *
 * Returns (with alternatives=true):
 *   { routes: [{ polylineEncoded, etaSeconds, distanceMeters }, ...],
 *     polylineEncoded, etaSeconds, distanceMeters }   ← first route for backwards compat
 *
 * Or { error: string }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const origin       = searchParams.get('origin');
  const destination  = searchParams.get('destination');
  const alternatives = searchParams.get('alternatives') === 'true';

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
  if (alternatives) {
    url.searchParams.set('alternatives', 'true');
  }

  try {
    const res = await fetch(url.toString(), {
      cache: 'no-store',
      signal: AbortSignal.timeout(9000),
    });
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
          distance?: { value: number };
        }>;
      }>;
      error_message?: string;
    };

    if (data.status !== 'OK' || !data.routes?.length) {
      console.error('[directions-proxy] Google status:', data.status, '|', data.error_message ?? '(no message)');
      return NextResponse.json(
        { error: data.error_message ?? `Directions API status: ${data.status}` },
        { status: 502 },
      );
    }

    // Map all routes to a uniform shape
    const allRoutes = data.routes.map((route) => {
      const leg = route.legs?.[0];
      return {
        polylineEncoded: route.overview_polyline.points,
        etaSeconds:
          leg?.duration_in_traffic?.value ??
          leg?.duration?.value ??
          0,
        distanceMeters: leg?.distance?.value ?? 0,
      };
    });

    const primary = allRoutes[0];

    return NextResponse.json(
      {
        // Backwards-compatible top-level fields (first route)
        polylineEncoded: primary.polylineEncoded,
        etaSeconds: primary.etaSeconds,
        distanceMeters: primary.distanceMeters,
        // All routes (only meaningful when alternatives were requested)
        ...(alternatives ? { routes: allRoutes } : {}),
      },
      {
        headers: {
          'Cache-Control': 'private, max-age=120',
        },
      },
    );
  } catch (err) {
    const isTimeout =
      (err instanceof Error && err.name === 'TimeoutError') ||
      (err instanceof Error && (err as NodeJS.ErrnoException).code === 'UND_ERR_CONNECT_TIMEOUT');
    console.error('[directions-proxy] fetch error:', isTimeout ? 'connect timeout' : err);
    return NextResponse.json(
      { error: isTimeout ? 'directions API timed out — check network' : 'upstream fetch failed' },
      { status: isTimeout ? 504 : 502 },
    );
  }
}

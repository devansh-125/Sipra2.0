import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/places/search
 *
 * Server-side proxy for the Google Places Nearby Search API.
 * Returns real hospitals with full details including rating.
 *
 * Query params:
 *   lat    — latitude  (required)
 *   lng    — longitude (required)
 *   radius — search radius in metres (default: 10000)
 *   type   — place type (default: 'hospital')
 *
 * Returns:
 *   { results: Array<{ place_id, name, lat, lng, address, rating, open_now, types }> }
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const latStr    = searchParams.get('lat');
  const lngStr    = searchParams.get('lng');
  const radiusStr = searchParams.get('radius') ?? '10000';
  const type      = searchParams.get('type') ?? 'hospital';

  if (!latStr || !lngStr) {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 });
  }

  const lat    = parseFloat(latStr);
  const lng    = parseFloat(lngStr);
  const radius = parseInt(radiusStr, 10);

  if (isNaN(lat) || isNaN(lng)) {
    return NextResponse.json({ error: 'lat and lng must be valid numbers' }, { status: 400 });
  }

  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'no API key configured' }, { status: 503 });
  }

  try {
    const placesUrl = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
    placesUrl.searchParams.set('location', `${lat},${lng}`);
    placesUrl.searchParams.set('radius', String(Math.min(radius, 50_000)));
    placesUrl.searchParams.set('type', type);
    placesUrl.searchParams.set('key', apiKey);

    const placesRes = await fetch(placesUrl.toString(), { next: { revalidate: 3600 } });

    if (!placesRes.ok) {
      return NextResponse.json(
        { error: `Places API HTTP ${placesRes.status}` },
        { status: 502 },
      );
    }

    const data = await placesRes.json() as {
      status: string;
      results?: Array<{
        place_id: string;
        name: string;
        geometry: { location: { lat: number; lng: number } };
        formatted_address?: string;
        vicinity?: string;
        rating?: number;
        user_ratings_total?: number;
        opening_hours?: { open_now?: boolean };
        types?: string[];
      }>;
      error_message?: string;
    };

    if (data.status !== 'OK' || !data.results?.length) {
      return NextResponse.json({ results: [] });
    }

    const results = data.results.slice(0, 20).map(r => ({
      place_id: r.place_id,
      name: r.name,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      address: r.formatted_address ?? r.vicinity ?? '',
      rating: r.rating ?? null,
      user_ratings_total: r.user_ratings_total ?? 0,
      open_now: r.opening_hours?.open_now ?? null,
      types: r.types ?? [],
    }));

    return NextResponse.json(
      { results },
      { headers: { 'Cache-Control': 'private, max-age=3600' } },
    );
  } catch (err) {
    console.error('[places-search-proxy] fetch error:', err);
    return NextResponse.json({ error: 'upstream fetch failed' }, { status: 502 });
  }
}

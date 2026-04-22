import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/places/hospitals
 *
 * Server-side proxy for the Google Places Nearby Search API.
 * Searches for hospitals within a given radius of a location.
 * Keeps the API key out of the browser bundle.
 *
 * Query params:
 *   lat    — latitude  (required)
 *   lng    — longitude (required)
 *   radius — search radius in metres (default: 5000)
 *
 * Returns:
 *   { hospitals: Array<{ place_id, name, lat, lng, formatted_address }> }
 *   or { error: string } on configuration / upstream failure
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const latStr    = searchParams.get('lat');
  const lngStr    = searchParams.get('lng');
  const radiusStr = searchParams.get('radius') ?? '5000';

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
    placesUrl.searchParams.set('radius', String(Math.min(radius, 50_000))); // cap at 50 km
    placesUrl.searchParams.set('type', 'hospital');
    placesUrl.searchParams.set('key', apiKey);

    const placesRes = await fetch(placesUrl.toString(), { next: { revalidate: 86_400 } }); // cache 24 h

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
      }>;
      error_message?: string;
    };

    if (data.status !== 'OK' || !data.results?.length) {
      return NextResponse.json({ hospitals: [] });
    }

    // Return up to 10 results with persisted fields
    const hospitals = data.results.slice(0, 10).map(r => ({
      place_id: r.place_id,
      name: r.name,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      formatted_address: r.formatted_address ?? r.vicinity ?? '',
    }));

    return NextResponse.json({ hospitals });
  } catch (err) {
    console.error('[hospitals-proxy] fetch error:', err);
    return NextResponse.json({ error: 'upstream fetch failed' }, { status: 502 });
  }
}

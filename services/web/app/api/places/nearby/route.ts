import { NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/places/nearby
 *
 * Server-side proxy for the Google Places Nearby Search API.
 * Keeps the API key out of the browser bundle and avoids CORS issues.
 *
 * Query params:
 *   lat   — latitude  (required)
 *   lng   — longitude (required)
 *   type  — place type to search for (default: "hospital")
 *
 * Returns:
 *   { name: string, address: string | null, placeId: string | null }
 *   or { name: null } when no result is found
 *   or { error: string } on configuration / upstream failure
 *
 * Strategy (in priority order):
 *   1. Google Places Nearby Search (radius 200 m) — most accurate for hospitals
 *   2. Google Geocoding API reverse-lookup — returns locality/area name as fallback
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const latStr = searchParams.get('lat');
  const lngStr = searchParams.get('lng');
  const type   = searchParams.get('type') ?? 'hospital';

  if (!latStr || !lngStr) {
    return NextResponse.json({ error: 'lat and lng are required' }, { status: 400 });
  }

  const lat = parseFloat(latStr);
  const lng = parseFloat(lngStr);
  if (isNaN(lat) || isNaN(lng)) {
    return NextResponse.json({ error: 'lat and lng must be valid numbers' }, { status: 400 });
  }

  const apiKey =
    process.env.GOOGLE_MAPS_API_KEY ??
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  if (!apiKey) {
    return NextResponse.json({ error: 'no API key configured' }, { status: 503 });
  }

  // ── Strategy 1: Places Nearby Search ──────────────────────────────────────
  try {
    const placesUrl = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
    placesUrl.searchParams.set('location', `${lat},${lng}`);
    placesUrl.searchParams.set('radius', '300');        // 300 m search radius
    placesUrl.searchParams.set('type', type);
    placesUrl.searchParams.set('key', apiKey);

    const placesRes = await fetch(placesUrl.toString(), { next: { revalidate: 86_400 } }); // cache 24 h
    if (placesRes.ok) {
      const data = await placesRes.json() as {
        status: string;
        results?: Array<{ name: string; formatted_address?: string; place_id?: string }>;
      };

      if (data.status === 'OK' && data.results?.length) {
        const best = data.results[0];
        return NextResponse.json({
          name:    best.name,
          address: best.formatted_address ?? null,
          placeId: best.place_id ?? null,
        });
      }
    }
  } catch (err) {
    console.warn('[places-proxy] Places Nearby Search failed:', err);
  }

  // ── Strategy 2: Geocoding reverse-lookup (name fallback) ─────────────────
  try {
    const geoUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json');
    geoUrl.searchParams.set('latlng', `${lat},${lng}`);
    geoUrl.searchParams.set('result_type', 'establishment|point_of_interest');
    geoUrl.searchParams.set('key', apiKey);

    const geoRes = await fetch(geoUrl.toString(), { next: { revalidate: 86_400 } });
    if (geoRes.ok) {
      const data = await geoRes.json() as {
        status: string;
        results?: Array<{ formatted_address: string; place_id?: string }>;
      };

      if (data.status === 'OK' && data.results?.length) {
        // Take the first address component as a human-readable name
        const addr = data.results[0].formatted_address;
        // Try to extract just the first segment (before the first comma)
        const name = addr.split(',')[0].trim();
        return NextResponse.json({ name, address: addr, placeId: data.results[0].place_id ?? null });
      }
    }
  } catch (err) {
    console.warn('[places-proxy] Geocoding reverse-lookup failed:', err);
  }

  // ── Fallback: no result found ─────────────────────────────────────────────
  return NextResponse.json({ name: null, address: null, placeId: null });
}

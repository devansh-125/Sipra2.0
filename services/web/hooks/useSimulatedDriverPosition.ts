import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { GeoPoint } from '../lib/types';

interface LatLng {
  lat: number;
  lng: number;
}

/**
 * useSimulatedDriverPosition
 *
 * Returns a simulated lat/lng for the driver POV demo mode.
 *
 * Priority:
 *  1. ?lat=&lng= query params — hard overrides (used by the simulator).
 *  2. Polyline-crawl mode — when a route polyline is provided, the simulated
 *     driver walks along it at a realistic speed starting at a random offset
 *     derived from `driverSeed`. This keeps demo drivers on real roads.
 *  3. Static center — when no polyline is available, return the center point
 *     without any off-road drift. NEVER orbit off-road.
 *
 * @param center    - Centre point for the static fallback.
 * @param radiusM   - Unused (kept for API compatibility).
 * @param tickMs    - Position update interval (milliseconds).
 * @param polyline  - Optional road-geometry polyline (GeoPoints).
 * @param driverSeed - Deterministic seed for polyline start offset (e.g. driver ID hash).
 */
export function useSimulatedDriverPosition(
  center: LatLng,
  _radiusM: number = 500,
  tickMs: number = 1000,
  polyline?: GeoPoint[],
  driverSeed: number = 0,
): LatLng {
  const searchParams  = useSearchParams();
  const overrideLat   = searchParams.get('lat');
  const overrideLng   = searchParams.get('lng');

  const startRef      = useRef(Date.now());
  const [position, setPosition] = useState<LatLng>(center);

  useEffect(() => {
    // ── Priority 1: query-param override ──────────────────────────────────
    const parsedLat = overrideLat !== null ? parseFloat(overrideLat) : NaN;
    const parsedLng = overrideLng !== null ? parseFloat(overrideLng) : NaN;
    if (!isNaN(parsedLat) && !isNaN(parsedLng)) {
      setPosition({ lat: parsedLat, lng: parsedLng });
      return;
    }

    // ── Priority 2: polyline-crawl (road-aligned) ─────────────────────────
    if (polyline && polyline.length >= 2) {
      // Each driver starts at a different fractional offset along the route
      // so they appear spread out rather than bunched at the origin.
      const seedFraction = (driverSeed % 100) / 100; // 0.00 … 0.99

      // Crawl speed: ~30 km/h expressed as fraction-of-route per second.
      // Adjust based on a rough route length estimate (n waypoints ≈ n*40 m avg).
      const approxRouteM   = (polyline.length - 1) * 40;
      const speedMs        = approxRouteM > 0 ? (30_000 / 3600) / approxRouteM : 0.0001;

      const tick = () => {
        const elapsedS  = (Date.now() - startRef.current) / 1_000;
        // Wrap at 1 so the driver loops the route (continuous demo motion)
        const progress  = (seedFraction + elapsedS * speedMs) % 1;

        // Interpolate position along the polyline (road-snapped segments)
        const n       = polyline.length - 1;
        const segF    = progress * n;
        const segIdx  = Math.min(Math.floor(segF), n - 1);
        const segT    = segF - segIdx;
        const a       = polyline[segIdx];
        const b       = polyline[segIdx + 1];
        setPosition({
          lat: a.lat + (b.lat - a.lat) * segT,
          lng: a.lng + (b.lng - a.lng) * segT,
        });
      };

      tick();
      const id = setInterval(tick, tickMs);
      return () => clearInterval(id);
    }

    // ── Priority 3: Static center (no off-road drift) ─────────────────────
    // When no polyline and no query override, sit at center.
    // NEVER orbit off-road in circles.
    setPosition(center);
  }, [center.lat, center.lng, tickMs, overrideLat, overrideLng, polyline, driverSeed]);

  return position;
}

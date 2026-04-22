'use client';

/**
 * useCorridorSimulation
 *
 * Self-contained hook that orchestrates the entire corridor-sim demo:
 *   1. Fetches a route via native google.maps.DirectionsService (client-side)
 *      — extracts overview_path (hundreds of road-snapped points)
 *      — extracts real distance.text / duration.text telemetry from legs[0]
 *   2. Steps an ambulance along the high-fidelity polyline point-by-point
 *   3. Manages 50 mock driver markers with proximity-based status
 *   4. Road-snapped evasion: when a driver enters the 2km zone, a single
 *      DirectionsService call fetches a micro-route to a safe perpendicular
 *      target. The driver then animates along real streets.
 *   5. Spatial render culling: drivers >4km from the ambulance are flagged
 *      invisible so downstream renderers can skip them.
 *
 * 100% client-side — no Go backend, no WebSocket, no server proxy.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GeoPoint } from '../lib/types';
import { decodePolyline } from '../lib/routing';

// ---------------------------------------------------------------------------
// Lucknow hospital pair
// Medanta Hospital → Tender Palm Hospital
// ---------------------------------------------------------------------------
const MEDANTA_HOSPITAL: GeoPoint = { lat: 26.7863, lng: 81.0190 };    // Medanta, Sushant Golf City
const TENDER_PALM_HOSPITAL: GeoPoint = { lat: 26.8547, lng: 80.9180 }; // Tender Palm, near Chowk

// ---------------------------------------------------------------------------
// Pre-recorded encoded polyline (Google overview_polyline captured offline)
// Medanta Hospital → Tender Palm Hospital via Lucknow main arteries.
// Used ONLY when DirectionsService is unreachable.
// Captured road path: Shaheed Path → Faizabad Rd → Hazratganj → Chowk
// ---------------------------------------------------------------------------
const PRERECORDED_POLYLINE =
  'o}~kDcuq{N}@xB{AlDgAfCy@dCo@rCe@hCa@fDUnCMtCI|CF~CJrC' +
  'RrCZdC`@xBl@xBx@pBbAnBnArBrAbB|AjBbBzAfBhAfBz@jB~@pBdA' +
  'rAp@|Al@`Bn@hBt@hAh@~Ax@bB`ArBhAnBdA`Bx@tBfAtBjAbBdA|Ax@' +
  'xAv@nAp@|@h@jAn@tAz@fAbAdAvAfA|AfBbBhBhBnBvBrBxBzBnBlBnB' +
  'fBrBfBjBtA~AhAzAfAnAhA~AtAhBbBzBzBnCxB~CxBdDlBhDlBfDhBnD' +
  'dBtDzAdDbAlDdAxDhAlDjApDbArCbAzBz@nBz@nBdAhCpAdCrAtCrAxCnA' +
  'xCnAzClAxChA|CfAtCbAtCbArC~@pC~@rCz@pCz@tCz@vCx@zCv@|Cv@' +
  '~Ct@bDp@dDn@hDl@jDj@lDh@nDf@rDb@tD^xDZzDV|DTbER';
const PRERECORDED_ETA_SECONDS = 2520;        // ~42 min
const PRERECORDED_DISTANCE_METERS = 16800;   // ~16.8 km
const PRERECORDED_DISTANCE_TEXT = '16.8 km';
const PRERECORDED_DURATION_TEXT = '42 mins';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type DriverStatus = 'safe' | 'alerted' | 'evading';
export type EmergencyPhase = 'none' | 'ambulance-to-midpoint' | 'transfer' | 'drone-flight' | 'arrived';

export interface SimDriver {
  id: string;
  lat: number;
  lng: number;
  baseLat: number;
  baseLng: number;
  status: DriverStatus;
  /** Road-snapped escape route (overview_path from DirectionsService). */
  escapeRoute?: GeoPoint[];
  /** Current index along the escape route animation. */
  escapeRouteIdx?: number;
  /** Rate-limit flag — true once the Directions API call has been fired. */
  hasFetchedEscapeRoute?: boolean;
  /** Spatial culling flag — false when driver is >4km from ambulance. */
  visible?: boolean;
}

export interface CorridorSimState {
  isLoading: boolean;
  routePoints: GeoPoint[];
  alternateRoutePoints: GeoPoint[];
  ambulancePosition: GeoPoint;
  progress: number;
  drivers: SimDriver[];
  isRunning: boolean;
  start: () => void;
  pause: () => void;
  reset: () => void;
  setSpeed: (multiplier: number) => void;
  etaSeconds: number;
  distanceMeters: number;
  /** Human-readable distance from Google, e.g. "16.8 km". */
  distanceText: string;
  /** Human-readable duration from Google, e.g. "42 mins". */
  durationText: string;
  driversInZone: number;
  driversAlerted: number;
  /** Number of drivers currently visible (within 4km culling radius). */
  driversVisible: number;
  // ── Emergency drone-delivery mode ─────────────────────────────────────────
  isEmergencyMode: boolean;
  emergencyPhase: EmergencyPhase;
  /** Drone position, linearly interpolated from midpoint → destination. */
  dronePosition: GeoPoint;
  droneProgress: number;
  /** True for ~3.5 s during the organ-transfer popup. */
  showTransferPopup: boolean;
  /** Geographic midpoint of the primary route. */
  midpoint: GeoPoint | null;
  activateEmergency: () => void;
}

// ---------------------------------------------------------------------------
// Geo helpers
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;
const EARTH_KM = 6_371;

function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG_TO_RAD) *
    Math.cos(b.lat * DEG_TO_RAD) *
    Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Bearing from a → b in radians. */
function bearing(a: GeoPoint, b: GeoPoint): number {
  const dLng = (b.lng - a.lng) * DEG_TO_RAD;
  const y = Math.sin(dLng) * Math.cos(b.lat * DEG_TO_RAD);
  const x =
    Math.cos(a.lat * DEG_TO_RAD) * Math.sin(b.lat * DEG_TO_RAD) -
    Math.sin(a.lat * DEG_TO_RAD) *
    Math.cos(b.lat * DEG_TO_RAD) *
    Math.cos(dLng);
  return Math.atan2(y, x);
}

/** Translate a point along a given bearing (radians) by distKm. */
function translateKm(
  point: GeoPoint,
  bearingRad: number,
  distKm: number,
): GeoPoint {
  const angDist = distKm / EARTH_KM;
  const lat1 = point.lat * DEG_TO_RAD;
  const lng1 = point.lng * DEG_TO_RAD;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angDist) +
    Math.cos(lat1) * Math.sin(angDist) * Math.cos(bearingRad),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearingRad) * Math.sin(angDist) * Math.cos(lat1),
      Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: lat2 * RAD_TO_DEG, lng: lng2 * RAD_TO_DEG };
}

// ---------------------------------------------------------------------------
// Mock driver generation
// ---------------------------------------------------------------------------

function generateDrivers(routePoints: GeoPoint[], count: number): SimDriver[] {
  if (routePoints.length === 0) return [];

  const drivers: SimDriver[] = [];
  for (let i = 0; i < count; i++) {
    // Pick a random route point and add jitter (wider spread for long route)
    const refIdx = Math.floor(Math.random() * routePoints.length);
    const ref = routePoints[refIdx];
    const jitterLat = (Math.random() - 0.5) * 0.06; // ±0.03°
    const jitterLng = (Math.random() - 0.5) * 0.06;
    const lat = ref.lat + jitterLat;
    const lng = ref.lng + jitterLng;
    drivers.push({
      id: `sim-driver-${i}`,
      lat,
      lng,
      baseLat: lat,
      baseLng: lng,
      status: 'safe',
      visible: true,
    });
  }
  return drivers;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXCLUSION_RADIUS_KM = 2;
const ALERT_RADIUS_KM = 3;
const CULL_RADIUS_KM = 4;
const TICK_MS = 500;
const DRIVER_COUNT = 50;
/** How many escape-route waypoints to advance per tick. */
const ESCAPE_STEPS_PER_TICK = 2;

// ---------------------------------------------------------------------------
// Wait for Google Maps JS API to be ready (loaded by APIProvider upstream)
// ---------------------------------------------------------------------------
function waitForGoogleMaps(timeoutMs = 8_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof google !== 'undefined' && google.maps?.DirectionsService) {
      resolve(true);
      return;
    }
    const start = Date.now();
    const check = setInterval(() => {
      if (typeof google !== 'undefined' && google.maps?.DirectionsService) {
        clearInterval(check);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(check);
        resolve(false);
      }
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// Compute a "Safe Target" — ~1km perpendicular to the ambulance's path,
// on whichever side the driver is already on.
// ---------------------------------------------------------------------------
function computeSafeTarget(
  driverPos: GeoPoint,
  ambulancePos: GeoPoint,
  ambulanceHeadingRad: number,
): GeoPoint {
  const perpLeft = ambulanceHeadingRad - Math.PI / 2;
  const perpRight = ambulanceHeadingRad + Math.PI / 2;

  // Pick the perpendicular direction closest to the driver's current bearing
  const driverBearing = bearing(ambulancePos, driverPos);
  const diffLeft = Math.abs(
    ((driverBearing - perpLeft + Math.PI * 3) % (Math.PI * 2)) - Math.PI,
  );
  const diffRight = Math.abs(
    ((driverBearing - perpRight + Math.PI * 3) % (Math.PI * 2)) - Math.PI,
  );

  const escapeDir = diffLeft < diffRight ? perpLeft : perpRight;
  return translateKm(driverPos, escapeDir, 1.0);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useCorridorSimulation(): CorridorSimState {
  const [isLoading, setIsLoading] = useState(true);
  const [routePoints, setRoutePoints] = useState<GeoPoint[]>([]);
  const [alternateRoutePoints, setAlternateRoutePoints] = useState<GeoPoint[]>([]);
  const [etaSeconds, setEtaSeconds] = useState(0);
  const [distanceMeters, setDistanceMeters] = useState(0);
  const [distanceText, setDistanceText] = useState('');
  const [durationText, setDurationText] = useState('');

  const [ambulanceIdx, setAmbulanceIdx] = useState(0);
  const [drivers, setDrivers] = useState<SimDriver[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const speedRef = useRef(1);

  // ── Emergency mode state ──────────────────────────────────────────────────
  const [isEmergencyMode, setIsEmergencyMode] = useState(false);
  const [emergencyPhase, setEmergencyPhase] = useState<EmergencyPhase>('none');
  const [droneProgress, setDroneProgress] = useState(0);
  const [showTransferPopup, setShowTransferPopup] = useState(false);
  /** Mutable ref so tick callback sees the latest phase without stale closure. */
  const emergencyPhaseRef = useRef<EmergencyPhase>('none');

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const idxRef = useRef(0); // mutable mirror of ambulanceIdx for the interval

  // Track generated drivers so we only recreate on route change
  const driversInitializedRef = useRef(false);

  // ── Rate-limit: track which drivers have already requested escape routes ──
  const escapeRequestedRef = useRef<Set<string>>(new Set());
  // ── Cache of fetched escape routes (keyed by driver ID) ───────────────────
  const escapeRoutesRef = useRef<Map<string, GeoPoint[]>>(new Map());

  // ── 1. Fetch route via google.maps.DirectionsService ─────────────────────
  useEffect(() => {
    let cancelled = false;

    async function loadRoute() {
      setIsLoading(true);

      // ── Primary: Client-side DirectionsService ──────────────────────────
      const mapsReady = await waitForGoogleMaps();

      if (!cancelled && mapsReady) {
        try {
          const service = new google.maps.DirectionsService();
          const result = await service.route({
            origin: { lat: MEDANTA_HOSPITAL.lat, lng: MEDANTA_HOSPITAL.lng },
            destination: { lat: TENDER_PALM_HOSPITAL.lat, lng: TENDER_PALM_HOSPITAL.lng },
            travelMode: google.maps.TravelMode.DRIVING,
            provideRouteAlternatives: true,
          });

          if (!cancelled && result.routes.length > 0) {
            // ── Extract high-fidelity overview_path ────────────────────────
            const primaryRoute = result.routes[0];
            const overviewPath = primaryRoute.overview_path;
            const points: GeoPoint[] = overviewPath.map((p) => ({
              lat: p.lat(),
              lng: p.lng(),
            }));

            if (points.length >= 2) {
              setRoutePoints(points);

              // ── Extract real-time telemetry from legs[0] ────────────────
              const leg = primaryRoute.legs[0];
              setEtaSeconds(leg.duration?.value ?? 0);
              setDistanceMeters(leg.distance?.value ?? 0);
              setDistanceText(leg.distance?.text ?? '');
              setDurationText(leg.duration?.text ?? '');

              // ── Alternate route ─────────────────────────────────────────
              if (result.routes.length > 1) {
                const altPath = result.routes[1].overview_path;
                const altPoints: GeoPoint[] = altPath.map((p) => ({
                  lat: p.lat(),
                  lng: p.lng(),
                }));
                if (altPoints.length >= 2) setAlternateRoutePoints(altPoints);
              }

              // ── Generate drivers along the route ────────────────────────
              if (!driversInitializedRef.current) {
                setDrivers(generateDrivers(points, DRIVER_COUNT));
                driversInitializedRef.current = true;
              }

              console.info(
                '[useCorridorSimulation] DirectionsService OK —',
                points.length, 'overview_path points,',
                leg.distance?.text, ',', leg.duration?.text,
              );
              setIsLoading(false);
              return;
            }
          }
        } catch (e) {
          console.warn('[useCorridorSimulation] DirectionsService failed:', e);
        }
      }

      // ── Fallback: pre-recorded encoded polyline (real road geometry) ────
      if (!cancelled) {
        console.info('[useCorridorSimulation] Using pre-recorded route fallback');
        const points = decodePolyline(PRERECORDED_POLYLINE);
        // If decode produced < 2 points, synthesize a straight path for safety
        const finalPoints = points.length >= 2
          ? points
          : [MEDANTA_HOSPITAL, TENDER_PALM_HOSPITAL];

        setRoutePoints(finalPoints);
        setEtaSeconds(PRERECORDED_ETA_SECONDS);
        setDistanceMeters(PRERECORDED_DISTANCE_METERS);
        setDistanceText(PRERECORDED_DISTANCE_TEXT);
        setDurationText(PRERECORDED_DURATION_TEXT);

        if (!driversInitializedRef.current) {
          setDrivers(generateDrivers(finalPoints, DRIVER_COUNT));
          driversInitializedRef.current = true;
        }
        setIsLoading(false);
      }
    }

    loadRoute();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── 2. Ambulance position — smooth point-by-point traversal ───────────────
  const ambulancePosition: GeoPoint = useMemo(() => {
    if (routePoints.length === 0) return MEDANTA_HOSPITAL;
    const idx = Math.min(ambulanceIdx, routePoints.length - 1);
    return routePoints[idx];
  }, [routePoints, ambulanceIdx]);

  /** Geographic midpoint of the primary route (used as drone pickup point). */
  const midpoint: GeoPoint | null = useMemo(() => {
    if (routePoints.length === 0) return null;
    return routePoints[Math.floor((routePoints.length - 1) / 2)];
  }, [routePoints]);

  /** Drone position: linear interpolation from midpoint → destination. */
  const dronePosition: GeoPoint = useMemo(() => {
    if (!midpoint || routePoints.length === 0) return MEDANTA_HOSPITAL;
    const dest = routePoints[routePoints.length - 1];
    return {
      lat: midpoint.lat + (dest.lat - midpoint.lat) * droneProgress,
      lng: midpoint.lng + (dest.lng - midpoint.lng) * droneProgress,
    };
  }, [midpoint, droneProgress, routePoints]);

  const progress = useMemo(() => {
    if (routePoints.length <= 1) return 0;
    const ambFraction = ambulanceIdx / (routePoints.length - 1);
    // During drone flight, blend ambulance half (0.5) + drone progress (0→0.5)
    if (isEmergencyMode && (emergencyPhase === 'drone-flight' || emergencyPhase === 'arrived')) {
      return 0.5 + 0.5 * droneProgress;
    }
    return ambFraction;
  }, [ambulanceIdx, routePoints.length, isEmergencyMode, emergencyPhase, droneProgress]);

  // ── Helper: fetch a single escape route for a driver (fire-and-forget) ────
  const fetchEscapeRoute = useCallback(
    (driverId: string, driverPos: GeoPoint, safeTarget: GeoPoint) => {
      // Guard: already requested
      if (escapeRequestedRef.current.has(driverId)) return;
      escapeRequestedRef.current.add(driverId);

      // Mark the driver so we don't re-request in the next tick
      setDrivers(prev =>
        prev.map(d =>
          d.id === driverId ? { ...d, hasFetchedEscapeRoute: true } : d,
        ),
      );

      // Fire async DirectionsService request
      (async () => {
        try {
          const service = new google.maps.DirectionsService();
          const result = await service.route({
            origin: { lat: driverPos.lat, lng: driverPos.lng },
            destination: { lat: safeTarget.lat, lng: safeTarget.lng },
            travelMode: google.maps.TravelMode.DRIVING,
          });

          if (result.routes.length > 0) {
            const path = result.routes[0].overview_path;
            const points: GeoPoint[] = path.map(p => ({
              lat: p.lat(),
              lng: p.lng(),
            }));

            if (points.length >= 2) {
              // Store in ref cache
              escapeRoutesRef.current.set(driverId, points);

              // Inject into driver state
              setDrivers(prev =>
                prev.map(d =>
                  d.id === driverId
                    ? { ...d, escapeRoute: points, escapeRouteIdx: 0 }
                    : d,
                ),
              );
              console.info(
                `[evasion] ${driverId}: escape route fetched — ${points.length} waypoints`,
              );
              return;
            }
          }
        } catch (err) {
          console.warn(`[evasion] ${driverId}: DirectionsService failed:`, err);
        }

        // If the API call fails, mark the driver so we don't retry
        // (the tick will fall back to linear evasion for this driver)
        console.warn(`[evasion] ${driverId}: no escape route, using linear fallback`);
      })();
    },
    [],
  );

  // ── 3. Tick function — advances ambulance + applies evasion logic ─────────
  const tick = useCallback(() => {
    if (routePoints.length === 0) return;

    const phase = emergencyPhaseRef.current;

    // ── Drone flight: advance drone, skip ambulance & drivers ─────────────
    if (phase === 'drone-flight') {
      const droneStep = Math.max(0.012, 0.012 * speedRef.current);
      setDroneProgress((prev) => {
        const next = Math.min(prev + droneStep, 1);
        if (next >= 1) {
          setEmergencyPhase('arrived');
          emergencyPhaseRef.current = 'arrived';
          setIsRunning(false);
        }
        return next;
      });
      return;
    }

    // Advance ambulance — with hundreds of points, each step is a smooth curve
    const speed = speedRef.current;
    const stepsPerTick = Math.max(1, Math.round(speed));
    // In emergency mode, cap ambulance at the midpoint index
    const midpointIdx = Math.floor((routePoints.length - 1) / 2);
    const upperBound = (phase === 'ambulance-to-midpoint')
      ? midpointIdx
      : routePoints.length - 1;
    const nextIdx = Math.min(idxRef.current + stepsPerTick, upperBound);
    idxRef.current = nextIdx;
    setAmbulanceIdx(nextIdx);

    // ── Emergency: ambulance reached midpoint → trigger transfer ──────────
    if (phase === 'ambulance-to-midpoint' && nextIdx >= midpointIdx) {
      setEmergencyPhase('transfer');
      emergencyPhaseRef.current = 'transfer';
      setIsRunning(false);
      return;
    }

    const ambPos = routePoints[nextIdx];

    // Compute ambulance heading (bearing from current → next route point)
    const nextRouteIdx = Math.min(nextIdx + 1, routePoints.length - 1);
    const ambulanceHeading = bearing(ambPos, routePoints[nextRouteIdx]);

    // Drivers that need escape route fetching (collected outside setDrivers)
    const toFetch: { id: string; pos: GeoPoint; target: GeoPoint }[] = [];

    // Classify & evade drivers
    setDrivers((prev) =>
      prev.map((d) => {
        const dist = haversineKm(ambPos, { lat: d.baseLat, lng: d.baseLng });

        // ── Spatial culling: >4km = invisible ───────────────────────────
        const visible = dist <= CULL_RADIUS_KM;

        let status: DriverStatus;
        let newLat = d.lat;
        let newLng = d.lng;
        let escapeRoute = d.escapeRoute;
        let escapeRouteIdx = d.escapeRouteIdx;
        let hasFetchedEscapeRoute = d.hasFetchedEscapeRoute;

        if (dist < EXCLUSION_RADIUS_KM) {
          status = 'evading';

          // Check if escape route is available from the ref cache
          const cachedRoute = escapeRoutesRef.current.get(d.id);
          if (cachedRoute && cachedRoute.length >= 2) {
            // ── Road-snapped animation: step along the escape route ─────
            escapeRoute = cachedRoute;
            const currentIdx = escapeRouteIdx ?? 0;
            const nextEscIdx = Math.min(
              currentIdx + ESCAPE_STEPS_PER_TICK,
              cachedRoute.length - 1,
            );
            escapeRouteIdx = nextEscIdx;
            const target = cachedRoute[nextEscIdx];
            // Smooth lerp toward the next waypoint
            newLat = d.lat + (target.lat - d.lat) * 0.5;
            newLng = d.lng + (target.lng - d.lng) * 0.5;
          } else {
            // ── Escape route not yet available ──────────────────────────
            if (!hasFetchedEscapeRoute && !escapeRequestedRef.current.has(d.id)) {
              // Schedule fetch (collected outside this map callback)
              const safeTarget = computeSafeTarget(
                { lat: d.baseLat, lng: d.baseLng },
                ambPos,
                ambulanceHeading,
              );
              toFetch.push({
                id: d.id,
                pos: { lat: d.lat, lng: d.lng },
                target: safeTarget,
              });
              hasFetchedEscapeRoute = true;
            }

            // Linear fallback while waiting for the route
            const b = bearing(ambPos, { lat: d.baseLat, lng: d.baseLng });
            const pushDist = (EXCLUSION_RADIUS_KM - dist) * 0.15;
            const pushed = translateKm({ lat: d.lat, lng: d.lng }, b, pushDist);
            newLat = d.lat + (pushed.lat - d.lat) * 0.3;
            newLng = d.lng + (pushed.lng - d.lng) * 0.3;
          }
        } else if (dist < ALERT_RADIUS_KM) {
          status = 'alerted';
          // Return toward base
          newLat = d.lat + (d.baseLat - d.lat) * 0.1;
          newLng = d.lng + (d.baseLng - d.lng) * 0.1;
          // Clear escape route state if ambulance has passed
          escapeRoute = undefined;
          escapeRouteIdx = undefined;
        } else {
          status = 'safe';
          // Snap back to base
          newLat = d.lat + (d.baseLat - d.lat) * 0.2;
          newLng = d.lng + (d.baseLng - d.lng) * 0.2;
          // Clear escape route state
          escapeRoute = undefined;
          escapeRouteIdx = undefined;
          // Allow re-fetch if the driver re-enters the zone later
          if (hasFetchedEscapeRoute) {
            escapeRequestedRef.current.delete(d.id);
            escapeRoutesRef.current.delete(d.id);
            hasFetchedEscapeRoute = false;
          }
        }

        return {
          ...d,
          lat: newLat,
          lng: newLng,
          status,
          visible,
          escapeRoute,
          escapeRouteIdx,
          hasFetchedEscapeRoute,
        };
      }),
    );

    // Fire escape route fetches AFTER the setDrivers call (avoids state conflicts)
    for (const req of toFetch) {
      fetchEscapeRoute(req.id, req.pos, req.target);
    }

    // Auto-stop at end (normal mode only)
    if (nextIdx >= routePoints.length - 1 && phase === 'none') {
      setIsRunning(false);
    }
  }, [routePoints, fetchEscapeRoute]);

  // ── 4. Interval management ────────────────────────────────────────────────
  useEffect(() => {
    if (isRunning) {
      tickRef.current = setInterval(tick, TICK_MS);
    } else {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    }
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [isRunning, tick]);

  // ── 4b. Emergency transfer phase: show popup, then launch drone ───────────
  useEffect(() => {
    if (emergencyPhase !== 'transfer') return;
    setShowTransferPopup(true);
    const timer = setTimeout(() => {
      setShowTransferPopup(false);
      setEmergencyPhase('drone-flight');
      emergencyPhaseRef.current = 'drone-flight';
      setIsRunning(true); // restart interval for drone animation
    }, 3500);
    return () => clearTimeout(timer);
  }, [emergencyPhase]);

  // ── 5. Controls ───────────────────────────────────────────────────────────
  const start = useCallback(() => {
    if (routePoints.length === 0) return;
    // If at end, reset first
    if (idxRef.current >= routePoints.length - 1) {
      idxRef.current = 0;
      setAmbulanceIdx(0);
    }
    setIsRunning(true);
  }, [routePoints]);

  const pause = useCallback(() => {
    setIsRunning(false);
  }, []);

  const reset = useCallback(() => {
    setIsRunning(false);
    idxRef.current = 0;
    setAmbulanceIdx(0);
    // Reset emergency mode
    setIsEmergencyMode(false);
    setEmergencyPhase('none');
    emergencyPhaseRef.current = 'none';
    setDroneProgress(0);
    setShowTransferPopup(false);
    // Clear all escape route caches
    escapeRequestedRef.current.clear();
    escapeRoutesRef.current.clear();
    // Reset drivers to base positions
    setDrivers((prev) =>
      prev.map((d) => ({
        ...d,
        lat: d.baseLat,
        lng: d.baseLng,
        status: 'safe' as const,
        visible: true,
        escapeRoute: undefined,
        escapeRouteIdx: undefined,
        hasFetchedEscapeRoute: false,
      })),
    );
  }, []);

  const setSpeed = useCallback((multiplier: number) => {
    speedRef.current = multiplier;
  }, []);

  const activateEmergency = useCallback(() => {
    if (routePoints.length === 0) return;
    const midIdx = Math.floor((routePoints.length - 1) / 2);
    setIsEmergencyMode(true);
    setDroneProgress(0);
    if (idxRef.current >= midIdx) {
      // Already at/past midpoint — jump straight to transfer
      setEmergencyPhase('transfer');
      emergencyPhaseRef.current = 'transfer';
      setIsRunning(false);
    } else {
      setEmergencyPhase('ambulance-to-midpoint');
      emergencyPhaseRef.current = 'ambulance-to-midpoint';
      setIsRunning(true); // ensure ambulance is moving toward midpoint
    }
  }, [routePoints]);

  // ── 6. Stats ──────────────────────────────────────────────────────────────
  const driversInZone = useMemo(
    () => drivers.filter((d) => d.status === 'evading').length,
    [drivers],
  );
  const driversAlerted = useMemo(
    () => drivers.filter((d) => d.status === 'alerted').length,
    [drivers],
  );
  const driversVisible = useMemo(
    () => drivers.filter((d) => d.visible !== false).length,
    [drivers],
  );

  return {
    isLoading,
    routePoints,
    alternateRoutePoints,
    ambulancePosition,
    progress,
    drivers,
    isRunning,
    start,
    pause,
    reset,
    setSpeed,
    etaSeconds,
    distanceMeters,
    distanceText,
    durationText,
    driversInZone,
    driversAlerted,
    driversVisible,
    // Emergency drone-delivery mode
    isEmergencyMode,
    emergencyPhase,
    dronePosition,
    droneProgress,
    showTransferPopup,
    midpoint,
    activateEmergency,
  };
}

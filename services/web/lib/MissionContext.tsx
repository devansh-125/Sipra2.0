'use client';

/**
 * MissionContext — single source of truth for the active emergency mission.
 *
 * Powers:
 *   - Mission Control sidebar (TripPanel)
 *   - Main map (CorridorMap)
 *   - Driver POV overlay (DriverPovOverlay)
 *
 * Data flow:
 *   1. Loads trip via REST on mount.
 *   2. Fetches real road-geometry route via Google Maps proxy (w/ simulation fallback).
 *   3. Ticks a golden-hour countdown every second.
 *   4. Derives urgency level from elapsed fraction.
 *   5. Maps trip.status → missionState (Pending → Active → Completed / Failed).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { getTrip } from './api';
import { useMissionRoute } from '../hooks/useMissionRoute';
import { useCorridorGeometry } from '../hooks/useCorridorGeometry';
import { useSipraWebSocket } from '../hooks/useSipraWebSocket';
import type { GeoPoint, Trip, TripStatus } from './types';
import type { RouteSource } from './routing';

import type { Polygon } from 'geojson';

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

export type UrgencyLevel = 'normal' | 'elevated' | 'critical';
export type MissionStateLabel = 'Pending' | 'Active' | 'Completed' | 'Failed';

export interface MissionContextValue {
  // Trip data
  trip: Trip | null;
  tripError: string | null;
  tripLoading: boolean;

  // Geography
  origin: GeoPoint | undefined;
  destination: GeoPoint | undefined;

  // Route
  polyline: GeoPoint[];
  etaSeconds: number;
  routeSource: RouteSource;

  /**
   * Road-aligned buffered corridor polygon derived from the route polyline.
   * Uses a 75 m buffer on each side.  Null while the route is still loading.
   * This is the canonical corridor shape shared by Mission Control, Driver POV,
   * and the DriverShell mobile view.
   */
  corridorGeometry: Polygon | null;

  // Golden hour
  goldenHourMs: number;    // total window in ms
  remainingMs: number;     // live countdown
  elapsedMs: number;       // since mission started
  urgencyLevel: UrgencyLevel;

  // Mission lifecycle
  missionState: MissionStateLabel;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function tripStatusToMissionState(status: TripStatus): MissionStateLabel {
  switch (status) {
    case 'InTransit':
    case 'DroneHandoff':
      return 'Active';
    case 'Completed':
      return 'Completed';
    case 'Failed':
      return 'Failed';
    default:
      return 'Pending';
  }
}

function calcUrgency(elapsed: number, total: number): UrgencyLevel {
  if (total <= 0) return 'normal';
  const fraction = elapsed / total;
  if (fraction >= 0.66) return 'critical';
  if (fraction >= 0.33) return 'elevated';
  return 'normal';
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const MissionContext = createContext<MissionContextValue | null>(null);

interface MissionProviderProps {
  children: React.ReactNode;
  /** Pulled from search params or env. */
  tripId: string | null;
}

export function MissionProvider({ children, tripId }: MissionProviderProps) {
  const [trip, setTrip]           = useState<Trip | null>(null);
  const [tripError, setTripError] = useState<string | null>(null);
  const [tripLoading, setLoading] = useState(true);
  const [remainingMs, setRemaining] = useState(0);
  const [elapsedMs, setElapsed]     = useState(0);

  // The WS singleton outlives client-side route changes, so its trip-tied
  // state (handoff banner, corridor polygon, risk prediction, completion
  // summary) carries from scenario to scenario unless we explicitly clear
  // it. Reset every time the URL trip changes so s1 → s2 starts fresh.
  const { resetForTrip } = useSipraWebSocket();
  useEffect(() => {
    resetForTrip();
    setTrip(null);
  }, [tripId, resetForTrip]);

  // ── Load trip + poll status until terminal ─────────────────────────────
  // The backend Risk Monitor transitions trips InTransit → DroneHandoff
  // asynchronously while the dashboard is open. Without a refresh, the
  // dashboard's `trip.status` would stay frozen at whatever was loaded on
  // mount, and downstream consumers (CorridorMap, AIBrainPanel) wouldn't
  // know to switch to drone-mode. So we poll every 5 s while the trip is
  // still in a transient state, and stop once it reaches a terminal one.
  useEffect(() => {
    if (!tripId) {
      setTripError('Click Run Scenario to start a trip');
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const fetchOnce = (isInitial: boolean) => {
      if (cancelled) return;
      if (isInitial) setLoading(true);
      getTrip(tripId)
        .then(t => {
          if (cancelled) return;
          setTrip(t);
          if (isInitial) setLoading(false);
          const terminal = t.status === 'Completed' || t.status === 'Failed';
          if (!terminal) {
            timer = setTimeout(() => fetchOnce(false), 5_000);
          }
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          if (isInitial) {
            setTripError(e instanceof Error ? e.message : 'Failed to load trip');
            setLoading(false);
          }
          // Even on transient error, keep polling so the panel recovers.
          timer = setTimeout(() => fetchOnce(false), 5_000);
        });
    };

    fetchOnce(true);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tripId]);

  // ── Golden-hour countdown ────────────────────────────────────────────────
  const missionStartMs = useMemo(() => {
    if (!trip) return Date.now();
    // Use started_at if available; otherwise fall back to created_at.
    return trip.started_at
      ? new Date(trip.started_at).getTime()
      : new Date(trip.created_at).getTime();
  }, [trip]);

  const deadlineMs = useMemo(() => {
    if (!trip) return Date.now() + 3_600_000;
    return new Date(trip.golden_hour_deadline).getTime();
  }, [trip]);

  const goldenHourMs = useMemo(
    () => Math.max(1, deadlineMs - missionStartMs),
    [deadlineMs, missionStartMs],
  );

  useEffect(() => {
    const tick = () => {
      const now       = Date.now();
      const elapsed   = Math.max(0, now - missionStartMs);
      const remaining = Math.max(0, deadlineMs - now);
      setElapsed(elapsed);
      setRemaining(remaining);
    };
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [missionStartMs, deadlineMs]);

  // ── Derive origin / destination ──────────────────────────────────────────
  const origin: GeoPoint | undefined = useMemo(() => {
    if (!trip) return undefined;
    return { lat: trip.origin.lat, lng: trip.origin.lng };
  }, [trip]);

  const destination: GeoPoint | undefined = useMemo(() => {
    if (!trip) return undefined;
    return { lat: trip.destination.lat, lng: trip.destination.lng };
  }, [trip]);

  // ── Route ────────────────────────────────────────────────────────────────
  const { polyline, etaSeconds, routeSource } = useMissionRoute(origin, destination);

  // ── Road-aligned corridor geometry ──────────────────────────────────────
  const corridorGeometry = useCorridorGeometry(polyline, 75, origin, destination);

  // ── Mission state ────────────────────────────────────────────────────────
  const missionState: MissionStateLabel = useMemo(() => {
    if (!trip) return 'Pending';
    return tripStatusToMissionState(trip.status);
  }, [trip]);

  // ── Urgency ──────────────────────────────────────────────────────────────
  const urgencyLevel = useMemo(
    () => calcUrgency(elapsedMs, goldenHourMs),
    [elapsedMs, goldenHourMs],
  );

  // ── Assemble context value ───────────────────────────────────────────────
  const value: MissionContextValue = {
    trip,
    tripError,
    tripLoading,
    origin,
    destination,
    polyline,
    etaSeconds,
    routeSource,
    corridorGeometry,
    goldenHourMs,
    remainingMs,
    elapsedMs,
    urgencyLevel,
    missionState,
  };

  return (
    <MissionContext.Provider value={value}>
      {children}
    </MissionContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Consumer hook
// ---------------------------------------------------------------------------

export function useMission(): MissionContextValue {
  const ctx = useContext(MissionContext);
  if (!ctx) throw new Error('useMission must be used inside <MissionProvider>');
  return ctx;
}

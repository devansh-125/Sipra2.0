'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Geometry } from 'geojson';
import type {
  CorridorUpdatePayload,
  FleetSpawnPayload,
  FleetUpdatePayload,
  FleetVehicle,
  GPSUpdatePayload,
  HandoffInitiatedPayload,
  RerouteState,
  RerouteStatusPayload,
  RiskPredictionPayload,
  TripCompletedPayload,
  WSEnvelope,
} from '../lib/types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface RecentEvent {
  type: string;
  timestamp: string;
  ts: number;
  truncated_payload?: string;
}

export interface SipraWSState {
  ambulanceLat: number | null;
  ambulanceLng: number | null;
  ambulanceSpeedKph: number | null;
  corridorGeoJSON: Geometry | null;
  handoffState: HandoffInitiatedPayload | null;
  /** Wall-clock ms when handoffState was set. Anchors the drone-flight countdown. Null until first HANDOFF_INITIATED. */
  handoffStartedAt: number | null;
  tripCompleted: TripCompletedPayload | null;
  riskPrediction: RiskPredictionPayload | null;
  fleet: FleetVehicle[];
  rerouteStatuses: Record<string, {
    status: RerouteState;
    tripId: string;
    bountyId?: string;
    amountPoints?: number;
    timestamp: number;
  }>;
  status: ConnectionStatus;
  lastMessageAt: number | null;
  lastEnvelopeType: string | null;
  recentEvents: RecentEvent[];
  clearHandoff: () => void;
  clearTripCompleted: () => void;
  /**
   * Drops every piece of trip-tied state (ambulance position, corridor
   * polygon, handoff banner, risk prediction, completion summary) without
   * touching the WS connection itself. Used by MissionProvider so that
   * switching scenarios (s1 → s2) starts the dashboard fresh instead of
   * leaking the previous trip's drone-handoff banner.
   */
  resetForTrip: () => void;
}

type SharedState = Omit<SipraWSState, 'clearHandoff' | 'clearTripCompleted' | 'resetForTrip'> & {
  // Source trip_id for each piece of trip-scoped state. Used by the hook to
  // drop updates that belong to a different trip than the one this dashboard
  // tab is viewing (e.g. orphan trips still being polled by the Risk Monitor
  // after a prior scenario was aborted).
  ambulanceTripId: string | null;
  corridorTripId: string | null;
  handoffTripId: string | null;
  tripCompletedTripId: string | null;
  riskPredictionTripId: string | null;
};
type Listener = (state: SharedState) => void;

interface SharedConnection {
  url: string;
  ws: WebSocket | null;
  timer: ReturnType<typeof setTimeout> | null;
  retryCount: number;
  listeners: Set<Listener>;
  state: SharedState;
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const MAX_RETRIES = 8;
const RING_SIZE = 200;
const CONNECTIONS = new Map<string, SharedConnection>();

declare global {
  interface Window {
    __fakeHandoff?: () => void;
  }
}

function createInitialState(): SharedState {
  return {
    ambulanceLat: null,
    ambulanceLng: null,
    ambulanceSpeedKph: null,
    corridorGeoJSON: null,
    handoffState: null,
    handoffStartedAt: null,
    tripCompleted: null,
    riskPrediction: null,
    fleet: [],
    rerouteStatuses: {},
    status: 'connecting',
    lastMessageAt: null,
    lastEnvelopeType: null,
    recentEvents: [],
    ambulanceTripId: null,
    corridorTripId: null,
    handoffTripId: null,
    tripCompletedTripId: null,
    riskPredictionTripId: null,
  };
}

function notify(connection: SharedConnection): void {
  connection.listeners.forEach(listener => {
    listener(connection.state);
  });
}

function setSharedState(
  connection: SharedConnection,
  updater: (prev: SharedState) => SharedState,
): void {
  connection.state = updater(connection.state);
  notify(connection);
}

function scheduleReconnect(connection: SharedConnection): void {
  if (connection.listeners.size === 0 || connection.timer) return;

  if (connection.retryCount >= MAX_RETRIES) {
    console.warn(
      `[useSipraWebSocket] Backend WS offline after ${MAX_RETRIES} retries.`,
      'Running in offline mode - fleet/GPS layers disabled.',
    );
    return;
  }

  const delay = BACKOFF_MS[Math.min(connection.retryCount, BACKOFF_MS.length - 1)];
  connection.retryCount++;
  connection.timer = setTimeout(() => {
    connection.timer = null;
    connectSharedSocket(connection);
  }, delay);
}

function applyMessage(prev: SharedState, msg: WSEnvelope, now: number): SharedState {
  const event: RecentEvent = {
    type: msg.type,
    timestamp: msg.timestamp,
    ts: now,
    truncated_payload: JSON.stringify(msg.payload).slice(0, 120),
  };

  const base: SharedState = {
    ...prev,
    lastMessageAt: now,
    lastEnvelopeType: msg.type,
    recentEvents: [event, ...prev.recentEvents].slice(0, RING_SIZE),
  };

  switch (msg.type) {
    case 'GPS_UPDATE': {
      const p = msg.payload as GPSUpdatePayload;
      return {
        ...base,
        ambulanceLat: p.lat,
        ambulanceLng: p.lng,
        ambulanceSpeedKph: p.speed_kph ?? null,
        ambulanceTripId: p.trip_id,
      };
    }
    case 'CORRIDOR_UPDATE': {
      const p = msg.payload as CorridorUpdatePayload;
      return { ...base, corridorGeoJSON: p.polygon_geojson, corridorTripId: p.trip_id };
    }
    case 'HANDOFF_INITIATED': {
      const p = msg.payload as HandoffInitiatedPayload;
      // Reset the start anchor every time a fresh handoff arrives (new trip).
      return { ...base, handoffState: p, handoffStartedAt: now, handoffTripId: p.trip_id };
    }
    case 'FLEET_UPDATE': {
      const payload = msg.payload as FleetUpdatePayload | FleetVehicle[];
      return {
        ...base,
        fleet: Array.isArray(payload) ? payload : payload.fleet ?? [],
      };
    }
    case 'FLEET_SPAWN': {
      const p = msg.payload as FleetSpawnPayload;
      return { ...base, fleet: p.vehicles ?? [] };
    }
    case 'REROUTE_STATUS': {
      const p = msg.payload as RerouteStatusPayload;
      return {
        ...base,
        rerouteStatuses: {
          ...prev.rerouteStatuses,
          [p.driver_ref]: {
            status: p.status,
            tripId: p.trip_id,
            bountyId: p.bounty_id,
            amountPoints: p.amount_points,
            timestamp: now,
          },
        },
      };
    }
    case 'RISK_PREDICTION': {
      const p = msg.payload as RiskPredictionPayload;
      return { ...base, riskPrediction: p, riskPredictionTripId: p.trip_id };
    }
    case 'TRIP_COMPLETED': {
      const p = msg.payload as TripCompletedPayload;
      return { ...base, tripCompleted: p, tripCompletedTripId: p.trip_id };
    }
    default:
      return base;
  }
}

function connectSharedSocket(connection: SharedConnection): void {
  if (connection.ws || connection.listeners.size === 0) return;

  let ws: WebSocket;
  try {
    ws = new WebSocket(connection.url);
  } catch {
    scheduleReconnect(connection);
    return;
  }

  connection.ws = ws;
  setSharedState(connection, prev => ({ ...prev, status: 'connecting' }));

  ws.onopen = () => {
    connection.retryCount = 0;
    setSharedState(connection, prev => ({ ...prev, status: 'connected' }));
  };

  ws.onmessage = ({ data }) => {
    connection.retryCount = 0;
    try {
      const msg = JSON.parse(data as string) as WSEnvelope;
      const now = Date.now();
      setSharedState(connection, prev => applyMessage(prev, msg, now));
    } catch {
      // Ignore malformed frames from test tools.
    }
  };

  ws.onclose = () => {
    connection.ws = null;
    setSharedState(connection, prev => ({ ...prev, status: 'disconnected' }));
    scheduleReconnect(connection);
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      // Socket already closed.
    }
  };
}

function getSharedConnection(url: string): SharedConnection {
  const existing = CONNECTIONS.get(url);
  if (existing) return existing;

  const created: SharedConnection = {
    url,
    ws: null,
    timer: null,
    retryCount: 0,
    listeners: new Set(),
    state: createInitialState(),
  };
  CONNECTIONS.set(url, created);
  return created;
}

function subscribe(url: string, listener: Listener): () => void {
  const connection = getSharedConnection(url);
  connection.listeners.add(listener);
  listener(connection.state);
  connectSharedSocket(connection);

  return () => {
    connection.listeners.delete(listener);
    if (connection.listeners.size > 0) return;

    if (connection.timer) {
      clearTimeout(connection.timer);
      connection.timer = null;
    }
    if (connection.ws) {
      try {
        connection.ws.close();
      } catch {
        // Ignore close errors during teardown.
      }
      connection.ws = null;
    }
    CONNECTIONS.delete(url);
  };
}

export function useSipraWebSocket(
  url: string = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard',
  activeTripId: string | null = null,
): SipraWSState {
  const [state, setState] = useState<SharedState>(() => getSharedConnection(url).state);

  useEffect(() => subscribe(url, setState), [url]);

  // Filter trip-scoped state by activeTripId. When no trip is selected
  // (activeTripId === null) the connection-level data is shown unfiltered
  // for backward compatibility with consumers that don't pass a tripId.
  // When a tripId is set, GPS/corridor/handoff/risk/completion fields are
  // hidden unless the underlying payload's trip_id matches — preventing
  // cross-trip leakage and stale state from prior runs.
  const matches = (tid: string | null): boolean =>
    activeTripId === null || tid === activeTripId;

  const filtered: SharedState = {
    ...state,
    ambulanceLat:       matches(state.ambulanceTripId)       ? state.ambulanceLat       : null,
    ambulanceLng:       matches(state.ambulanceTripId)       ? state.ambulanceLng       : null,
    ambulanceSpeedKph:  matches(state.ambulanceTripId)       ? state.ambulanceSpeedKph  : null,
    corridorGeoJSON:    matches(state.corridorTripId)        ? state.corridorGeoJSON    : null,
    handoffState:       matches(state.handoffTripId)         ? state.handoffState       : null,
    handoffStartedAt:   matches(state.handoffTripId)         ? state.handoffStartedAt   : null,
    tripCompleted:      matches(state.tripCompletedTripId)   ? state.tripCompleted      : null,
    riskPrediction:     matches(state.riskPredictionTripId)  ? state.riskPrediction     : null,
  };

  const clearHandoff = useCallback(() => {
    const connection = getSharedConnection(url);
    setSharedState(connection, prev => ({ ...prev, handoffState: null }));
  }, [url]);

  const clearTripCompleted = useCallback(() => {
    const connection = getSharedConnection(url);
    setSharedState(connection, prev => ({ ...prev, tripCompleted: null }));
  }, [url]);

  const resetForTrip = useCallback(() => {
    const connection = getSharedConnection(url);
    setSharedState(connection, prev => ({
      ...prev,
      ambulanceLat: null,
      ambulanceLng: null,
      ambulanceSpeedKph: null,
      corridorGeoJSON: null,
      handoffState: null,
      handoffStartedAt: null,
      tripCompleted: null,
      riskPrediction: null,
      ambulanceTripId: null,
      corridorTripId: null,
      handoffTripId: null,
      tripCompletedTripId: null,
      riskPredictionTripId: null,
    }));
  }, [url]);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    window.__fakeHandoff = () => {
      const connection = getSharedConnection(url);
      const fakeTripId = activeTripId ?? 'dev-fake-trip-0000';
      setSharedState(connection, prev => ({
        ...prev,
        handoffState: {
          trip_id: fakeTripId,
          drone_id: 'DRONE-DEV-01',
          eta_seconds: 120,
          reason: 'DEV fake handoff - golden hour breach predicted',
          predicted_eta_seconds: 180,
        },
        handoffStartedAt: Date.now(),
        handoffTripId: fakeTripId,
        lastEnvelopeType: 'HANDOFF_INITIATED',
      }));
    };

    return () => {
      delete window.__fakeHandoff;
    };
  }, [url, activeTripId]);

  return { ...filtered, clearHandoff, clearTripCompleted, resetForTrip };
}

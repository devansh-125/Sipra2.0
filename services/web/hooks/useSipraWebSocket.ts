'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Geometry } from 'geojson';
import type { CorridorUpdatePayload, GPSUpdatePayload, HandoffInitiatedPayload, WSEnvelope, FleetVehicle, FleetUpdatePayload } from '../lib/types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface RecentEvent {
  type: string;
  timestamp: string;
  ts: number;
}

export interface SipraWSState {
  ambulanceLat: number | null;
  ambulanceLng: number | null;
  corridorGeoJSON: Geometry | null;
  handoffState: HandoffInitiatedPayload | null;
  fleet: FleetVehicle[];
  status: ConnectionStatus;
  lastMessageAt: number | null;
  lastEnvelopeType: string | null;
  recentEvents: RecentEvent[];
  clearHandoff: () => void;
}

// Backoff steps in ms: 1s → 2s → 4s → 8s, then capped at 10s.
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const RING_SIZE = 10;

declare global {
  interface Window {
    __fakeHandoff?: () => void;
  }
}

export function useSipraWebSocket(
  url: string = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard',
): SipraWSState {
  const [state, setState] = useState<Omit<SipraWSState, 'clearHandoff'>>({
    ambulanceLat: null,
    ambulanceLng: null,
    corridorGeoJSON: null,
    handoffState: null,
    fleet: [],
    status: 'connecting',
    lastMessageAt: null,
    lastEnvelopeType: null,
    recentEvents: [],
  });

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const retryRef = useRef(0);

  const clearHandoff = useCallback(() => {
    setState(s => ({ ...s, handoffState: null }));
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      // Invalid URL — schedule retry without crashing.
      const delay = BACKOFF_MS[Math.min(retryRef.current, BACKOFF_MS.length - 1)];
      retryRef.current++;
      timerRef.current = setTimeout(connect, delay);
      return;
    }

    wsRef.current = ws;

    ws.onopen = () => {
      if (mountedRef.current) setState(s => ({ ...s, status: 'connected' }));
    };

    ws.onmessage = ({ data }) => {
      if (!mountedRef.current) return;
      retryRef.current = 0; // successful frame — reset backoff
      try {
        const msg: WSEnvelope = JSON.parse(data as string);
        const now = Date.now();
        const event: RecentEvent = { type: msg.type, timestamp: msg.timestamp, ts: now };

        setState(s => {
          const recentEvents = [event, ...s.recentEvents].slice(0, RING_SIZE);
          const base: Omit<SipraWSState, 'clearHandoff'> = {
            ...s,
            lastMessageAt: now,
            lastEnvelopeType: msg.type,
            recentEvents,
          };

          if (msg.type === 'GPS_UPDATE') {
            const p = msg.payload as GPSUpdatePayload;
            return { ...base, ambulanceLat: p.lat, ambulanceLng: p.lng };
          }
          if (msg.type === 'CORRIDOR_UPDATE') {
            const p = msg.payload as CorridorUpdatePayload;
            return { ...base, corridorGeoJSON: p.polygon_geojson };
          }
          if (msg.type === 'HANDOFF_INITIATED') {
            const p = msg.payload as HandoffInitiatedPayload;
            return { ...base, handoffState: p };
          }
          if (msg.type === 'FLEET_UPDATE') {
            const payload = msg.payload as FleetUpdatePayload | FleetVehicle[];
            const fleet = Array.isArray(payload) ? payload : (payload as FleetUpdatePayload).fleet || [];
            return { ...base, fleet };
          }
          return base;
        });
      } catch {
        // malformed frame — discard silently
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setState(s => ({ ...s, status: 'disconnected' }));
      const delay = BACKOFF_MS[Math.min(retryRef.current, BACKOFF_MS.length - 1)];
      retryRef.current++;
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      try { ws.close(); } catch { /* already closed */ }
    };
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [connect]);

  // DEV-only helper: window.__fakeHandoff() dispatches a synthetic HANDOFF_INITIATED payload.
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    window.__fakeHandoff = () => {
      setState(s => ({
        ...s,
        handoffState: {
          trip_id: 'dev-fake-trip-0000',
          drone_id: 'DRONE-DEV-01',
          eta_seconds: 120,
          reason: 'DEV fake handoff — golden hour breach predicted',
          predicted_eta_seconds: 180,
        },
        lastEnvelopeType: 'HANDOFF_INITIATED',
      }));
    };
    return () => {
      delete window.__fakeHandoff;
    };
  }, []);

  return { ...state, clearHandoff };
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Geometry } from 'geojson';
import type { CorridorUpdatePayload, GPSUpdatePayload, HandoffInitiatedPayload, WSEnvelope } from '../lib/types';

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
  status: ConnectionStatus;
  lastMessageAt: number | null;
  lastEnvelopeType: string | null;
  recentEvents: RecentEvent[];
}

// Backoff steps in ms: 1s → 2s → 4s → 8s, then capped at 10s.
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000];
const RING_SIZE = 10;

export function useSipraWebSocket(
  url: string = process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard',
): SipraWSState {
  const [state, setState] = useState<SipraWSState>({
    ambulanceLat: null,
    ambulanceLng: null,
    corridorGeoJSON: null,
    handoffState: null,
    status: 'connecting',
    lastMessageAt: null,
    lastEnvelopeType: null,
    recentEvents: [],
  });

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const retryRef = useRef(0);

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
          const base: SipraWSState = {
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

  return state;
}

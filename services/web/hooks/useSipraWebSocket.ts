'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Geometry } from 'geojson';
import type { CorridorUpdatePayload, GPSUpdatePayload, HandoffInitiatedPayload, WSEnvelope } from '../lib/types';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface SipraWSState {
  ambulanceLat: number | null;
  ambulanceLng: number | null;
  corridorGeoJSON: Geometry | null;
  handoffState: HandoffInitiatedPayload | null;
  status: ConnectionStatus;
}

const RECONNECT_DELAY_MS = 3_000;

/**
 * Manages a WebSocket connection to the Sipra Go backend.
 * Parses GPS_UPDATE and CORRIDOR_UPDATE envelopes and exposes them as React state.
 * Auto-reconnects on unexpected close.
 */
export function useSipraWebSocket(url: string): SipraWSState {
  const [state, setState] = useState<SipraWSState>({
    ambulanceLat: null,
    ambulanceLng: null,
    corridorGeoJSON: null,
    handoffState: null,
    status: 'connecting',
  });

  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (mountedRef.current) setState(s => ({ ...s, status: 'connected' }));
    };

    ws.onmessage = ({ data }) => {
      if (!mountedRef.current) return;
      try {
        const msg: WSEnvelope = JSON.parse(data as string);
        if (msg.type === 'GPS_UPDATE') {
          const p = msg.payload as GPSUpdatePayload;
          setState(s => ({ ...s, ambulanceLat: p.lat, ambulanceLng: p.lng }));
        } else if (msg.type === 'CORRIDOR_UPDATE') {
          const p = msg.payload as CorridorUpdatePayload;
          setState(s => ({ ...s, corridorGeoJSON: p.polygon_geojson }));
        } else if (msg.type === 'HANDOFF_INITIATED') {
          const p = msg.payload as HandoffInitiatedPayload;
          setState(s => ({ ...s, handoffState: p }));
        }
      } catch {
        // malformed frame — discard silently
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setState(s => ({ ...s, status: 'disconnected' }));
      timerRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => ws.close();
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

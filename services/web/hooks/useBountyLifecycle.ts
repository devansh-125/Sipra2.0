'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Geometry, MultiPolygon, Polygon, Position } from 'geojson';

import { claimBounty, createBounty, verifyBounty } from '../lib/api';
import type { Bounty, CreateBountyRequest, RerouteState } from '../lib/types';
import type { ProximityState } from './useDriverProximity';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type BountyLifecycleState = 'IDLE' | 'OFFERED' | 'CLAIMED' | 'VERIFIED' | 'EXPIRED' | 'ERROR';

export interface BountyLifecycleResult {
  state: BountyLifecycleState;
  bounty: Bounty | null;
  checkpoint: { lat: number; lng: number } | null;
  distanceToCheckpointM: number | null;
  /** Derived reroute status for UI badges */
  rerouteStatus: RerouteState | null;
  /** Countdown: ms remaining before CLAIMED expires */
  timeRemainingMs: number;
  /** Total time window in ms (for progress calculation) */
  totalTimeMs: number;
  accept: () => void;
  dismiss: () => void;
  retry: () => void;
}

// ---------------------------------------------------------------------------
// Geometry helpers (no extra turf imports — @turf/distance not needed here)
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;

function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000;
  const dLat = (bLat - aLat) * DEG_TO_RAD;
  const dLng = (bLng - aLng) * DEG_TO_RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * DEG_TO_RAD) * Math.cos(bLat * DEG_TO_RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function corridorRings(geo: Geometry): Position[][] {
  if (geo.type === 'Polygon') return (geo as Polygon).coordinates;
  if (geo.type === 'MultiPolygon') return (geo as MultiPolygon).coordinates.flat(1);
  return [];
}

function nearestVertex(geo: Geometry, lat: number, lng: number): Position | null {
  let best: Position | null = null;
  let bestDist = Infinity;
  for (const ring of corridorRings(geo)) {
    for (const v of ring) {
      const d = haversineM(lat, lng, v[1], v[0]);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
  }
  return best;
}

// Project a point 50 m beyond `vertex` along the vector (origin → vertex).
// The direction vector is computed in degree-space and then scaled to metres.
function projectBeyond50m(
  originLat: number,
  originLng: number,
  vertexLng: number,
  vertexLat: number,
): { lat: number; lng: number } {
  const dLat = vertexLat - originLat;
  const dLng = vertexLng - originLng;
  const len = Math.sqrt(dLat * dLat + dLng * dLng) || 1e-12;
  const nLat = dLat / len;
  const nLng = dLng / len;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(vertexLat * DEG_TO_RAD);
  return {
    lat: vertexLat + (nLat * 50) / mPerDegLat,
    lng: vertexLng + (nLng * 50) / mPerDegLng,
  };
}

// Backbone approximation: quarter of the outer ring perimeter.
function polygonBackboneM(geo: Geometry): number {
  let total = 0;
  for (const ring of corridorRings(geo)) {
    for (let i = 1; i < ring.length; i++) {
      total += haversineM(ring[i - 1][1], ring[i - 1][0], ring[i][1], ring[i][0]);
    }
    break; // outer ring only
  }
  return total / 4;
}

// ---------------------------------------------------------------------------
// Simple hash for corridor geometry — used for dedup key
// ---------------------------------------------------------------------------
function corridorHash(geo: Geometry): string {
  const rings = corridorRings(geo);
  if (rings.length === 0 || rings[0].length === 0) return 'empty';
  // Hash from first 4 vertices of outer ring for speed
  const pts = rings[0].slice(0, 4);
  return pts.map(p => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join('|');
}

// ---------------------------------------------------------------------------
// Dedup helpers — prevent multiple rewards for the same corridor event
// ---------------------------------------------------------------------------
const DEDUP_STORAGE_KEY = 'sipra.bounty_dedup';

function dedupKey(tripId: string, geo: Geometry): string {
  return `${tripId}:${corridorHash(geo)}`;
}

function isDeduplicated(tripId: string, geo: Geometry): boolean {
  try {
    const stored = sessionStorage.getItem(DEDUP_STORAGE_KEY);
    if (!stored) return false;
    const keys: string[] = JSON.parse(stored);
    return keys.includes(dedupKey(tripId, geo));
  } catch {
    return false;
  }
}

function markDeduplicated(tripId: string, geo: Geometry): void {
  try {
    const stored = sessionStorage.getItem(DEDUP_STORAGE_KEY);
    const keys: string[] = stored ? JSON.parse(stored) : [];
    const key = dedupKey(tripId, geo);
    if (!keys.includes(key)) {
      keys.push(key);
      // Keep only last 20 entries to avoid unbounded growth
      if (keys.length > 20) keys.shift();
      sessionStorage.setItem(DEDUP_STORAGE_KEY, JSON.stringify(keys));
    }
  } catch {
    // sessionStorage unavailable — skip silently
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_POINTS = 100;
const CHECKPOINT_RADIUS_M = 50;
const BOUNTY_TTL_MS = 15 * 60 * 1_000; // 15 min
/** Time window for driver to reach checkpoint after accepting */
const REROUTE_TIMEOUT_MS = 5 * 60 * 1_000; // 5 min

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type PendingOp = 'create' | 'claim' | 'verify';

interface EntrySnapshot {
  geo: Geometry;
  lat: number;
  lng: number;
}

// ---------------------------------------------------------------------------
// Helper: dispatch custom event for cross-component sync
// ---------------------------------------------------------------------------
function dispatchRerouteEvent(status: RerouteState, tripId: string, bountyId?: string, points?: number) {
  window.dispatchEvent(
    new CustomEvent('reroute:status', {
      detail: { status, tripId, bountyId, points },
    }),
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useBountyLifecycle(
  tripId: string,
  corridorGeoJSON: Geometry | null,
  driverPosition: { lat: number; lng: number },
  proximityState: ProximityState,
): BountyLifecycleResult {
  const [lifecycleState, setLifecycleState] = useState<BountyLifecycleState>('IDLE');
  const [bounty, setBounty] = useState<Bounty | null>(null);
  const [checkpoint, setCheckpoint] = useState<{ lat: number; lng: number } | null>(null);

  // Timeout state
  const [timeRemainingMs, setTimeRemainingMs] = useState(0);
  const claimedAtRef = useRef<number | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Refs that must not trigger re-renders
  const prevProximityRef = useRef<ProximityState>(proximityState);
  const inflightRef = useRef(false);
  const pendingOpRef = useRef<PendingOp | null>(null);
  const entrySnapshotRef = useRef<EntrySnapshot | null>(null);
  const claimAttemptsRef = useRef(0);

  // Always-current mirrors — lets callbacks avoid stale closures without
  // listing every mutable value as a useCallback dep.
  const bountyRef = useRef(bounty);
  bountyRef.current = bounty;
  const checkpointRef = useRef(checkpoint);
  checkpointRef.current = checkpoint;
  const driverPosRef = useRef(driverPosition);
  driverPosRef.current = driverPosition;
  const tripIdRef = useRef(tripId);
  tripIdRef.current = tripId;
  const lifecycleStateRef = useRef(lifecycleState);
  lifecycleStateRef.current = lifecycleState;

  // ---------------------------------------------------------------------------
  // Derived: distance to checkpoint — cheap haversine on every render tick
  // ---------------------------------------------------------------------------
  const distanceToCheckpointM: number | null =
    checkpoint !== null
      ? haversineM(driverPosition.lat, driverPosition.lng, checkpoint.lat, checkpoint.lng)
      : null;

  // ---------------------------------------------------------------------------
  // Derived: rerouteStatus for UI badges
  // ---------------------------------------------------------------------------
  const rerouteStatus: RerouteState | null =
    lifecycleState === 'CLAIMED' ? 'rerouting' :
    lifecycleState === 'VERIFIED' ? 'completed' :
    lifecycleState === 'EXPIRED' ? 'failed' :
    null;

  // ---------------------------------------------------------------------------
  // Timeout: start countdown when CLAIMED, expire if time runs out
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (lifecycleState === 'CLAIMED') {
      if (claimedAtRef.current === null) {
        claimedAtRef.current = Date.now();
      }
      const tick = () => {
        const elapsed = Date.now() - (claimedAtRef.current ?? Date.now());
        const remaining = Math.max(0, REROUTE_TIMEOUT_MS - elapsed);
        setTimeRemainingMs(remaining);
        if (remaining <= 0 && lifecycleStateRef.current === 'CLAIMED') {
          setLifecycleState('EXPIRED');
          dispatchRerouteEvent('failed', tripIdRef.current, bountyRef.current?.id);
        }
      };
      tick();
      timeoutTimerRef.current = setInterval(tick, 500);
      return () => {
        if (timeoutTimerRef.current) clearInterval(timeoutTimerRef.current);
      };
    } else {
      // Reset timer state when leaving CLAIMED
      if (lifecycleState !== 'EXPIRED') {
        claimedAtRef.current = null;
        setTimeRemainingMs(0);
      }
      if (timeoutTimerRef.current) {
        clearInterval(timeoutTimerRef.current);
        timeoutTimerRef.current = null;
      }
    }
  }, [lifecycleState]);

  // ---------------------------------------------------------------------------
  // Auto-reset from terminal states (VERIFIED / EXPIRED) after 6s
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (lifecycleState === 'VERIFIED' || lifecycleState === 'EXPIRED') {
      const timer = setTimeout(() => {
        setLifecycleState('IDLE');
        setBounty(null);
        setCheckpoint(null);
        claimedAtRef.current = null;
        setTimeRemainingMs(0);
        pendingOpRef.current = null;
        entrySnapshotRef.current = null;
      }, 6_000);
      return () => clearTimeout(timer);
    }
  }, [lifecycleState]);

  // ---------------------------------------------------------------------------
  // doCreate — fires createBounty and drives IDLE→OFFERED or ERROR.
  // Stable reference (no deps): reads all mutable state via refs.
  // ---------------------------------------------------------------------------
  const doCreate = useCallback((snap: EntrySnapshot, cp: { lat: number; lng: number }) => {
    inflightRef.current = true;
    pendingOpRef.current = 'create';
    const corridorM = polygonBackboneM(snap.geo);
    const deviationM = haversineM(snap.lat, snap.lng, cp.lat, cp.lng);
    const expiresAt = new Date(Date.now() + BOUNTY_TTL_MS).toISOString();
    const body: CreateBountyRequest = {
      driver_ref: `driver-${tripIdRef.current.slice(0, 8)}`,
      base_amount_points: BASE_POINTS,
      corridor_length_m: corridorM,
      deviation_m: deviationM,
      checkpoint_lat: cp.lat,
      checkpoint_lng: cp.lng,
      checkpoint_radius_m: CHECKPOINT_RADIUS_M,
      expires_at: expiresAt,
    };
    createBounty(tripIdRef.current, body)
      .then(b => {
        setBounty(b);
        setLifecycleState('OFFERED');
        pendingOpRef.current = null;
      })
      .catch(() => setLifecycleState('ERROR'))
      .finally(() => {
        inflightRef.current = false;
      });
  }, []);

  // ---------------------------------------------------------------------------
  // Entry detection: NORMAL → INSIDE_ZONE triggers bounty creation
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const prev = prevProximityRef.current;
    prevProximityRef.current = proximityState;

    if (
      prev === 'INSIDE_ZONE' ||
      proximityState !== 'INSIDE_ZONE' ||
      lifecycleState !== 'IDLE' ||
      corridorGeoJSON === null ||
      inflightRef.current
    ) return;

    // Dedup: skip if this corridor event already earned a reward
    if (isDeduplicated(tripId, corridorGeoJSON)) return;

    const pos = driverPosRef.current;
    const v = nearestVertex(corridorGeoJSON, pos.lat, pos.lng);
    if (!v) return;

    // Checkpoint is deterministic for this (tripId, entry event): it is derived
    // from the fixed corridor geometry and driver position at the moment of entry.
    const cp = projectBeyond50m(pos.lat, pos.lng, v[0], v[1]);
    const snap: EntrySnapshot = { geo: corridorGeoJSON, lat: pos.lat, lng: pos.lng };
    entrySnapshotRef.current = snap;
    setCheckpoint(cp);
    doCreate(snap, cp);
  }, [proximityState, corridorGeoJSON, lifecycleState, doCreate, tripId]);

  // ---------------------------------------------------------------------------
  // CLAIMED: auto-verify on each position tick when inside checkpoint radius
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (
      lifecycleState !== 'CLAIMED' ||
      !bountyRef.current ||
      !checkpointRef.current ||
      inflightRef.current
    ) return;

    const cp = checkpointRef.current;
    const dist = haversineM(driverPosition.lat, driverPosition.lng, cp.lat, cp.lng);
    if (dist >= CHECKPOINT_RADIUS_M) return;

    const id = bountyRef.current.id;
    inflightRef.current = true;
    pendingOpRef.current = 'verify';
    verifyBounty(id, driverPosition.lat, driverPosition.lng)
      .then(() => {
        setBounty(b => (b ? { ...b, status: 'Verified' } : b));
        setLifecycleState('VERIFIED');
        pendingOpRef.current = null;
        // Mark as deduplicated so same corridor event won't trigger again
        if (entrySnapshotRef.current) {
          markDeduplicated(tripIdRef.current, entrySnapshotRef.current.geo);
        }
        dispatchRerouteEvent('completed', tripIdRef.current, id, 50);
      })
      .catch(() => setLifecycleState('ERROR'))
      .finally(() => {
        inflightRef.current = false;
      });
  }, [lifecycleState, driverPosition]);

  // ---------------------------------------------------------------------------
  // accept: OFFERED → CLAIMED (one automatic retry on first failure)
  // ---------------------------------------------------------------------------
  const accept = useCallback(() => {
    const b = bountyRef.current;
    if (lifecycleState !== 'OFFERED' || !b || inflightRef.current) return;

    inflightRef.current = true;
    pendingOpRef.current = 'claim';
    claimAttemptsRef.current = 0;

    const attempt = () => {
      claimBounty(b.id)
        .then(() => {
          setBounty(prev => (prev ? { ...prev, status: 'Claimed' } : prev));
          setLifecycleState('CLAIMED');
          pendingOpRef.current = null;
          inflightRef.current = false;
          dispatchRerouteEvent('rerouting', tripIdRef.current, b.id);
        })
        .catch(() => {
          if (claimAttemptsRef.current < 1) {
            claimAttemptsRef.current++;
            attempt();
          } else {
            setLifecycleState('ERROR');
            inflightRef.current = false;
          }
        });
    };
    attempt();
  }, [lifecycleState]);

  // ---------------------------------------------------------------------------
  // dismiss: OFFERED → IDLE (no API call)
  // ---------------------------------------------------------------------------
  const dismiss = useCallback(() => {
    if (lifecycleState !== 'OFFERED') return;
    setBounty(null);
    setCheckpoint(null);
    pendingOpRef.current = null;
    entrySnapshotRef.current = null;
    setLifecycleState('IDLE');
  }, [lifecycleState]);

  // ---------------------------------------------------------------------------
  // retry: ERROR → re-attempt the failed operation
  // ---------------------------------------------------------------------------
  const retry = useCallback(() => {
    if (lifecycleState !== 'ERROR' || inflightRef.current) return;

    const op = pendingOpRef.current;

    if (op === 'create') {
      const snap = entrySnapshotRef.current;
      const cp = checkpointRef.current;
      if (!snap || !cp) {
        pendingOpRef.current = null;
        setLifecycleState('IDLE');
        return;
      }
      doCreate(snap, cp);
    } else if (op === 'claim') {
      const b = bountyRef.current;
      if (!b) return;
      inflightRef.current = true;
      claimBounty(b.id)
        .then(() => {
          setBounty(prev => (prev ? { ...prev, status: 'Claimed' } : prev));
          setLifecycleState('CLAIMED');
          pendingOpRef.current = null;
          inflightRef.current = false;
          dispatchRerouteEvent('rerouting', tripIdRef.current, b.id);
        })
        .catch(() => {
          setLifecycleState('ERROR');
          inflightRef.current = false;
        });
    } else if (op === 'verify') {
      const b = bountyRef.current;
      const cp = checkpointRef.current;
      if (!b || !cp) return;
      const pos = driverPosRef.current;
      inflightRef.current = true;
      verifyBounty(b.id, pos.lat, pos.lng)
        .then(() => {
          setBounty(prev => (prev ? { ...prev, status: 'Verified' } : prev));
          setLifecycleState('VERIFIED');
          pendingOpRef.current = null;
          inflightRef.current = false;
          if (entrySnapshotRef.current) {
            markDeduplicated(tripIdRef.current, entrySnapshotRef.current.geo);
          }
          dispatchRerouteEvent('completed', tripIdRef.current, b.id, 50);
        })
        .catch(() => {
          setLifecycleState('ERROR');
          inflightRef.current = false;
        });
    }
  }, [lifecycleState, doCreate]);

  return {
    state: lifecycleState,
    bounty,
    checkpoint,
    distanceToCheckpointM,
    rerouteStatus,
    timeRemainingMs,
    totalTimeMs: REROUTE_TIMEOUT_MS,
    accept,
    dismiss,
    retry,
  };
}

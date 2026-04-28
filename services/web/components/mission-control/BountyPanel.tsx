'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Geometry, MultiPolygon, Polygon, Position } from 'geojson';
import { useSipraWebSocket } from '../../hooks/useSipraWebSocket';
import { useMission } from '../../lib/MissionContext';
import { useAmbulanceAnimation } from '../../hooks/useAmbulanceAnimation';
import { chaosSpawnFleet, createBounty } from '../../lib/api';
import type { Bounty } from '../../lib/types';

// ---------------------------------------------------------------------------
// Geometry helpers for checkpoint calculation (same logic as useBountyLifecycle)
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

// Checkpoint is placed 2 050 m from the ambulance center along the vehicle's
// exit direction — just outside the 2 km exclusion zone boundary.
function projectCheckpointFromCenter(
  ambLat: number, ambLng: number,
  vehLat: number, vehLng: number,
): { lat: number; lng: number } {
  const dLat = vehLat - ambLat;
  const dLng = vehLng - ambLng;
  const len = Math.sqrt(dLat * dLat + dLng * dLng) || 1e-12;
  const nLat = dLat / len;
  const nLng = dLng / len;
  const mPerDegLat = 111_320;
  const mPerDegLng = 111_320 * Math.cos(vehLat * DEG_TO_RAD);
  const exitM = 2_050;
  return {
    lat: ambLat + (nLat * exitM) / mPerDegLat,
    lng: ambLng + (nLng * exitM) / mPerDegLng,
  };
}

function polygonBackboneM(geo: Geometry): number {
  let total = 0;
  for (const ring of corridorRings(geo)) {
    for (let i = 1; i < ring.length; i++) {
      total += haversineM(ring[i - 1][1], ring[i - 1][0], ring[i][1], ring[i][0]);
    }
    break;
  }
  return total / 4;
}

// ---------------------------------------------------------------------------
// Local display type
// ---------------------------------------------------------------------------

interface DisplayBounty {
  id: string;
  driver_ref: string;
  amount_points: number;
  status: 'offered' | 'claimed' | 'verified' | 'expired';
  offered_at: string;
}

const EXCLUSION_RADIUS_KM = 2;
const WARNING_RADIUS_KM = 3;
const DEG = Math.PI / 180;
const WS_URL =
  process.env.NEXT_PUBLIC_BACKEND_WS_URL ?? 'ws://localhost:8080/ws/dashboard';

function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLng = (b.lng - a.lng) * DEG;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371 * Math.asin(Math.min(1, Math.sqrt(s)));
}

export default function BountyPanel() {
  const {
    ambulanceLat,
    ambulanceLng,
    corridorGeoJSON,
    fleet,
    rerouteStatuses,
  } = useSipraWebSocket(WS_URL);
  const { polyline, etaSeconds, origin, trip } = useMission();

  const animatedAmbulance = useAmbulanceAnimation(
    ambulanceLat,
    ambulanceLng,
    polyline,
    etaSeconds,
    trip?.started_at,
    origin,
  );

  // ---------------------------------------------------------------------------
  // Dynamic bounty creation — fires createBounty() when a fleet vehicle
  // newly enters the 2 km exclusion zone, using vehicle.id as driver_ref.
  // Refs prevent stale-closure issues without causing extra re-renders.
  // ---------------------------------------------------------------------------
  const [createdBounties, setCreatedBounties] = useState<Map<string, Bounty>>(new Map());
  const createdBountiesRef = useRef<Map<string, Bounty>>(new Map());
  const inflightRef = useRef<Set<string>>(new Set());
  const prevInRedRef = useRef<Set<string>>(new Set());
  const lastSpawnRef = useRef(0);

  const RESPAWN_COOLDOWN_MS = 8_000;

  // ---------------------------------------------------------------------------
  // Auto-spawn fleet — fires whenever no vehicles remain in the exclusion zone.
  // A cooldown prevents back-to-back spawns during the brief gap between an old
  // fleet leaving and the FLEET_SPAWN message arriving for the new one.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!trip?.id) return;

    const ambLat = ambulanceLat ?? trip.origin?.lat;
    const ambLng = ambulanceLng ?? trip.origin?.lng;
    if (!ambLat || !ambLng) return;

    // Re-spawn only when all vehicles have cleared the exclusion zone
    const hasRedZoneVehicles = fleet.some(
      v => haversineKm({ lat: ambLat, lng: ambLng }, { lat: v.lat, lng: v.lng }) <= EXCLUSION_RADIUS_KM,
    );
    if (hasRedZoneVehicles) return;

    const now = Date.now();
    if (now - lastSpawnRef.current < RESPAWN_COOLDOWN_MS) return;

    lastSpawnRef.current = now;
    chaosSpawnFleet({
      trip_id: trip.id,
      count: 20,
      center_lat: ambLat,
      center_lng: ambLng,
      radius_m: 1800,
    }).catch(() => {});
  }, [ambulanceLat, ambulanceLng, fleet, trip?.id, trip?.origin]);

  useEffect(() => {
    if (!ambulanceLat || !ambulanceLng || !trip?.id) return;

    const ambulancePos = { lat: ambulanceLat, lng: ambulanceLng };
    const nowInRed = new Set<string>();

    for (const vehicle of fleet) {
      if (haversineKm(ambulancePos, { lat: vehicle.lat, lng: vehicle.lng }) <= EXCLUSION_RADIUS_KM) {
        nowInRed.add(vehicle.id);
      }
    }

    Array.from(nowInRed).forEach(vid => {
      if (prevInRedRef.current.has(vid)) return;        // already in zone last tick
      if (inflightRef.current.has(vid)) return;         // request already in flight
      if (createdBountiesRef.current.has(vid)) return;  // bounty already created

      const vehicle = fleet.find(v => v.id === vid);
      if (!vehicle) return;

      const cp = projectCheckpointFromCenter(ambulanceLat, ambulanceLng, vehicle.lat, vehicle.lng);
      const corridorM = corridorGeoJSON ? polygonBackboneM(corridorGeoJSON) : 4_000;

      const tripId = trip.id;
      inflightRef.current.add(vid);
      createBounty(tripId, {
        driver_ref: vid,
        base_amount_points: 150,
        corridor_length_m: corridorM,
        deviation_m: haversineM(vehicle.lat, vehicle.lng, cp.lat, cp.lng),
        checkpoint_lat: cp.lat,
        checkpoint_lng: cp.lng,
        checkpoint_radius_m: 50,
        expires_at: new Date(Date.now() + 15 * 60 * 1_000).toISOString(),
      })
        .then(b => {
          createdBountiesRef.current.set(vid, b);
          setCreatedBounties(new Map(createdBountiesRef.current));
        })
        .catch(() => {})
        .finally(() => {
          inflightRef.current.delete(vid);
        });
    });

    prevInRedRef.current = nowInRed;
  }, [fleet, ambulanceLat, ambulanceLng, corridorGeoJSON, trip?.id]);

  // ---------------------------------------------------------------------------
  // Merge real backend bounties with reroute-status broadcasts for display
  // ---------------------------------------------------------------------------
  const bountyStats = useMemo(() => {
    const displayMap = new Map<string, DisplayBounty>();

    // Seed from actual backend-created bounties
    createdBounties.forEach((b, vid) => {
      displayMap.set(vid, {
        id: b.id,
        driver_ref: b.driver_ref,
        amount_points: b.amount_points,
        status: b.status.toLowerCase() as DisplayBounty['status'],
        offered_at: b.offered_at,
      });
    });

    // Overlay reroute-status events (claim / verify broadcasts)
    for (const [driverRef, rs] of Object.entries(rerouteStatuses)) {
      const overlayStatus: DisplayBounty['status'] =
        rs.status === 'rerouting' ? 'claimed' :
        rs.status === 'completed' ? 'verified' : 'expired';
      const existing = displayMap.get(driverRef);
      if (existing) {
        displayMap.set(driverRef, {
          ...existing,
          status: overlayStatus,
          amount_points: rs.amountPoints ?? existing.amount_points,
        });
      } else {
        displayMap.set(driverRef, {
          id: rs.bountyId ?? `status-${driverRef}`,
          driver_ref: driverRef,
          amount_points: rs.amountPoints ?? 0,
          status: overlayStatus,
          offered_at: new Date(rs.timestamp).toISOString(),
        });
      }
    }

    // Show in-zone vehicles that are pending backend creation (inflight)
    const ambulancePos = { lat: animatedAmbulance.lat, lng: animatedAmbulance.lng };
    if (ambulancePos.lat && ambulancePos.lng) {
      const nowIso = new Date().toISOString();
      for (const vehicle of fleet) {
        if (displayMap.has(vehicle.id)) continue;
        const distKm = haversineKm(ambulancePos, { lat: vehicle.lat, lng: vehicle.lng });
        const inRed = distKm <= EXCLUSION_RADIUS_KM;
        const inYellow = !inRed && distKm <= WARNING_RADIUS_KM;
        if (!inRed && !inYellow) continue;
        displayMap.set(vehicle.id, {
          id: `pending-${vehicle.id}`,
          driver_ref: vehicle.id,
          amount_points: 150,
          status: 'offered',
          offered_at: nowIso,
        });
      }
    }

    const allBounties = Array.from(displayMap.values());
    const activeBounties = [...allBounties]
      .sort((a, b) => b.offered_at.localeCompare(a.offered_at))
      .slice(0, 10);

    const totalOffered  = allBounties.filter(b => b.status === 'offered').length;
    const totalClaimed  = allBounties.filter(b => b.status === 'claimed').length;
    const totalVerified = allBounties.filter(b => b.status === 'verified').length;
    const totalPoints   = allBounties
      .filter(b => b.status === 'verified')
      .reduce((sum, b) => sum + b.amount_points, 0);

    return {
      total_offered: totalOffered,
      total_claimed: totalClaimed,
      total_verified: totalVerified,
      total_points_awarded: totalPoints,
      active_bounties: activeBounties,
    };
  }, [createdBounties, rerouteStatuses, fleet, animatedAmbulance.lat, animatedAmbulance.lng]);

  const getStatusColor = (status: DisplayBounty['status']) => {
    switch (status) {
      case 'offered':  return 'text-yellow-400';
      case 'claimed':  return 'text-orange-400';
      case 'verified': return 'text-green-400';
      case 'expired':  return 'text-red-400';
      default:         return 'text-gray-400';
    }
  };

  const getStatusIcon = (status: DisplayBounty['status']) => {
    switch (status) {
      case 'offered':  return '💰';
      case 'claimed':  return '🎯';
      case 'verified': return '✅';
      case 'expired':  return '❌';
      default:         return '⚪';
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-foreground">Bounty System</h3>
        <div className="text-xs text-muted-foreground">Live Updates</div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-muted/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-yellow-400">{bountyStats.total_offered}</div>
          <div className="text-xs text-muted-foreground">Offered</div>
        </div>
        <div className="bg-muted/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-orange-400">{bountyStats.total_claimed}</div>
          <div className="text-xs text-muted-foreground">Claimed</div>
        </div>
        <div className="bg-muted/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-green-400">{bountyStats.total_verified}</div>
          <div className="text-xs text-muted-foreground">Verified</div>
        </div>
        <div className="bg-muted/50 rounded-lg p-3">
          <div className="text-2xl font-bold text-blue-400">{bountyStats.total_points_awarded}</div>
          <div className="text-xs text-muted-foreground">Points</div>
        </div>
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium text-foreground">Recent Activity</h4>
        <div className="max-h-48 overflow-y-auto space-y-2">
          {bountyStats.active_bounties.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-4">
              No bounties yet. Waiting for fleet vehicles to enter corridor...
            </div>
          ) : (
            bountyStats.active_bounties.map((bounty) => (
              <div key={bounty.id} className="flex items-center justify-between bg-muted/30 rounded-lg p-2">
                <div className="flex items-center space-x-2">
                  <span className="text-lg">{getStatusIcon(bounty.status)}</span>
                  <div>
                    <div className="text-sm font-medium text-foreground">
                      {bounty.driver_ref}
                    </div>
                    <div className={`text-xs ${getStatusColor(bounty.status)}`}>
                      {bounty.status.toUpperCase()}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-foreground">
                    {bounty.amount_points} pts
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {bounty.id.startsWith('pending-') ? 'pending…' : `${bounty.id.slice(0, 8)}…`}
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

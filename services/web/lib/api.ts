import type { Bounty, ClaimBountyResponse, CreateBountyRequest, Trip, VerifyBountyResponse } from './types';
import { FALLBACK_DESTINATION, FALLBACK_ORIGIN } from './routing';

const BASE_URL = process.env.NEXT_PUBLIC_BACKEND_HTTP_URL ?? 'http://localhost:8080';
const BACKEND_HTTP_ENABLED = process.env.NEXT_PUBLIC_ENABLE_BACKEND_HTTP === 'true';

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function getTrip(id: string): Promise<Trip> {
  if (!BACKEND_HTTP_ENABLED) {
    const nowIso = new Date().toISOString();
    const deadlineIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return Promise.resolve({
      id,
      status: 'InTransit',
      cargo: {
        category: 'Organ',
        description: 'Demo payload (frontend fallback)',
        tolerance_celsius: 4,
      },
      origin: FALLBACK_ORIGIN,
      destination: FALLBACK_DESTINATION,
      golden_hour_deadline: deadlineIso,
      started_at: nowIso,
      ambulance_id: 'AMB-DEMO-001',
      hospital_dispatch_id: 'HOSP-DEMO-001',
      created_at: nowIso,
      updated_at: nowIso,
    });
  }

  return fetchJSON<Trip>(`${BASE_URL}/api/v1/trips/${encodeURIComponent(id)}`).catch(() => {
    const nowIso = new Date().toISOString();
    const deadlineIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return {
      id,
      status: 'InTransit',
      cargo: {
        category: 'Organ',
        description: 'Demo payload (frontend fallback)',
        tolerance_celsius: 4,
      },
      origin: FALLBACK_ORIGIN,
      destination: FALLBACK_DESTINATION,
      golden_hour_deadline: deadlineIso,
      started_at: nowIso,
      ambulance_id: 'AMB-DEMO-001',
      hospital_dispatch_id: 'HOSP-DEMO-001',
      created_at: nowIso,
      updated_at: nowIso,
    };
  });
}

export interface CreateTripBody {
  cargo_category: string;
  cargo_description: string;
  cargo_tolerance_celsius?: number;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  golden_hour_deadline: string; // RFC3339
  ambulance_id: string;
  hospital_dispatch_id?: string;
}

export interface CreateTripResponse {
  trip_id: string;
  status: string;
  golden_hour_deadline: string;
}

export function createTrip(body: CreateTripBody): Promise<CreateTripResponse> {
  return fetchJSON<CreateTripResponse>(`${BASE_URL}/api/v1/trips`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface StartTripResponse {
  trip_id: string;
  status: string;
}

export function startTrip(id: string): Promise<StartTripResponse> {
  return fetchJSON<StartTripResponse>(
    `${BASE_URL}/api/v1/trips/${encodeURIComponent(id)}/start`,
    { method: 'POST' },
  );
}

export function createBounty(tripId: string, body: CreateBountyRequest): Promise<Bounty> {
  return fetchJSON<Bounty>(
    `${BASE_URL}/api/v1/trips/${encodeURIComponent(tripId)}/bounties`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

export function claimBounty(bountyId: string): Promise<ClaimBountyResponse> {
  return fetchJSON<ClaimBountyResponse>(
    `${BASE_URL}/api/v1/bounties/${encodeURIComponent(bountyId)}/claim`,
    { method: 'POST' },
  );
}

export function verifyBounty(
  bountyId: string,
  pingLat: number,
  pingLng: number,
): Promise<VerifyBountyResponse> {
  return fetchJSON<VerifyBountyResponse>(
    `${BASE_URL}/api/v1/bounties/${encodeURIComponent(bountyId)}/verify`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ping_lat: pingLat, ping_lng: pingLng }),
    },
  );
}

// -----------------------------------------------------------------------------
// Chaos API
// -----------------------------------------------------------------------------

export interface ChaosFloodBridgeResponse {
  injected: number;
  trip_id: string;
}

export interface ChaosSpawnFleetResponse {
  spawned: number;
  vehicle_ids: string[];
  evacuation_run?: boolean;
  run_duration_sec?: number;
}

export interface ChaosForceHandoffResponse {
  trip_id: string;
  reason: string;
  predicted_eta_seconds: number;
}

export interface ChaosResetResponse {
  cleared_flooded_trips: number;
  cleared_fleet_ids: number;
}

export function chaosFloodBridge(body: {
  trip_id: string;
  count: number;
}): Promise<ChaosFloodBridgeResponse> {
  return fetchJSON<ChaosFloodBridgeResponse>(`${BASE_URL}/api/v1/chaos/flood-bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function chaosSpawnFleet(body: {
  trip_id?: string;
  count: number;
  center_lat: number;
  center_lng: number;
  radius_m: number;
}): Promise<ChaosSpawnFleetResponse> {
  return fetchJSON<ChaosSpawnFleetResponse>(`${BASE_URL}/api/v1/chaos/spawn-fleet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function chaosForceHandoff(body: {
  trip_id: string;
  reason: string;
}): Promise<ChaosForceHandoffResponse> {
  return fetchJSON<ChaosForceHandoffResponse>(`${BASE_URL}/api/v1/chaos/force-handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function chaosReset(): Promise<ChaosResetResponse> {
  return fetchJSON<ChaosResetResponse>(`${BASE_URL}/api/v1/chaos/reset`, { method: 'POST' });
}

import type { Trip } from './types';

const BASE_URL = process.env.NEXT_PUBLIC_BACKEND_HTTP_URL ?? 'http://localhost:8080';

async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export function getTrip(id: string): Promise<Trip> {
  return fetchJSON<Trip>(`${BASE_URL}/api/v1/trips/${encodeURIComponent(id)}`);
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

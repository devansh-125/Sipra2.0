import type { Geometry } from 'geojson';

// -----------------------------------------------------------------------------
// Trip domain types (mirrors services/core-go/internal/domain/trip.go)
// -----------------------------------------------------------------------------

export type TripStatus = 'Pending' | 'InTransit' | 'DroneHandoff' | 'Completed' | 'Failed';

export type CargoCategory = 'Organ' | 'Vaccine' | 'Blood' | 'Medication';

export interface Cargo {
  category: CargoCategory;
  description: string;
  tolerance_celsius?: number | null;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface Trip {
  id: string;
  status: TripStatus;
  cargo: Cargo;
  origin: GeoPoint;
  destination: GeoPoint;
  golden_hour_deadline: string; // RFC3339
  started_at?: string | null;
  completed_at?: string | null;
  ambulance_id: string;
  hospital_dispatch_id?: string;
  created_at: string;
  updated_at: string;
}

// -----------------------------------------------------------------------------
// WebSocket envelope types
// -----------------------------------------------------------------------------

export interface GPSUpdatePayload {
  trip_id: string;
  ping_id: string;
  lat: number;
  lng: number;
  heading_deg?: number;
  speed_kph?: number;
  recorded_at: string;
}

export interface CorridorUpdatePayload {
  trip_id: string;
  corridor_id: string;
  version: number;
  buffer_meters: number;
  polygon_geojson: Geometry;
}

export interface DroneMetadata {
  model: string;
  max_payload_kg: number;
  battery_pct: number;
  launch_pad_id: string;
  altitude_m_cruise: number;
  cruise_kph: number;
  route_km: number;
}

export interface HandoffInitiatedPayload {
  trip_id: string;
  drone_id?: string;
  eta_seconds?: number;
  reason: string;
  predicted_eta_seconds: number;
  drone_metadata?: DroneMetadata;
}

export type Recommendation = 'CONTINUE' | 'REQUEST_BOUNTY_BOOST' | 'DISPATCH_DRONE';

export interface TripCompletedPayload {
  trip_id: string;
  final_status: string;
  drone_used: boolean;
  deadline_met: boolean;
  total_seconds: number;
  distance_km: number;
}

export type WSMessageType =
  | 'GPS_UPDATE'
  | 'CORRIDOR_UPDATE'
  | 'HANDOFF_INITIATED'
  | 'FLEET_UPDATE'
  | 'FLEET_SPAWN'
  | 'REROUTE_STATUS'
  | 'RISK_PREDICTION'
  | 'BOUNTY_BOOST_REQUESTED'
  | 'TRIP_COMPLETED';

export interface RiskPredictionPayload {
  trip_id: string;
  predicted_eta_seconds: number;
  deadline_seconds_remaining: number;
  breach_probability: number;
  will_breach: boolean;
  recommendation: Recommendation;
  weather_condition: string;
  weather_factor: number;
  fleet_density_in_corridor: number;
  fleet_penalty: number;
  effective_speed_kph: number;
  ai_confidence: number;
  reasoning: string;
}

export interface BountyBoostRequestedPayload {
  trip_id: string;
  breach_probability: number;
  reason: string;
}

export interface FleetUpdatePayload {
  fleet: FleetVehicle[];
}

export interface FleetSpawnPayload {
  vehicles: FleetVehicle[];
}

export interface WSEnvelope {
  type: WSMessageType;
  timestamp: string;
  payload:
    | GPSUpdatePayload
    | CorridorUpdatePayload
    | HandoffInitiatedPayload
    | FleetUpdatePayload
    | FleetSpawnPayload
    | FleetVehicle[]
    | RerouteStatusPayload
    | RiskPredictionPayload
    | BountyBoostRequestedPayload
    | TripCompletedPayload;
}

export type RerouteState = 'rerouting' | 'completed' | 'failed';

export interface FleetVehicle {
  id: string;
  lat: number;
  lng: number;
  evading?: boolean;
  status?: string;
  /** True when the vehicle is in the 3 km warning zone but outside the 2 km exclusion zone. Set client-side. */
  inWarningZone?: boolean;
  reroute_status?: RerouteState | null;
  /** Compass bearing (0 = north, 90 = east, …). Undefined until first tick. */
  heading_deg?: number;
  /** Which predefined road polyline this vehicle is crawling along. */
  route_id?: string;
}

export interface RerouteStatusPayload {
  driver_ref: string;
  trip_id: string;
  status: RerouteState;
  bounty_id?: string;
  amount_points?: number;
}

// -----------------------------------------------------------------------------
// Bounty domain types (mirrors services/core-go/internal/domain/bounty.go)
// -----------------------------------------------------------------------------

export type BountyStatus = 'Offered' | 'Claimed' | 'Verified' | 'Expired';

export interface Bounty {
  id: string;
  trip_id: string;
  driver_ref: string;
  partner_id?: string;
  amount_points: number;
  checkpoint: { lat: number; lng: number };
  checkpoint_radius_m: number;
  status: BountyStatus;
  offered_at: string;
  claimed_at?: string;
  verified_at?: string;
  expires_at: string;
}

export interface CreateBountyRequest {
  driver_ref: string;
  partner_id?: string;
  base_amount_points: number;
  corridor_length_m: number;
  deviation_m: number;
  checkpoint_lat: number;
  checkpoint_lng: number;
  checkpoint_radius_m: number;
  expires_at: string; // RFC3339
}

export interface ClaimBountyResponse {
  bounty_id: string;
  status: string;
}

export interface VerifyBountyResponse {
  bounty_id: string;
  status: string;
}

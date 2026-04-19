import type { Geometry } from 'geojson';

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

export type WSMessageType = 'GPS_UPDATE' | 'CORRIDOR_UPDATE';

export interface WSEnvelope {
  type: WSMessageType;
  timestamp: string;
  payload: GPSUpdatePayload | CorridorUpdatePayload;
}

export interface FleetVehicle {
  id: string;
  lat: number;
  lng: number;
  evading: boolean;
}

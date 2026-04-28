from __future__ import annotations

import math
import os
import random
from datetime import datetime, timezone
from uuid import UUID

import httpx

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Sipra AI Brain", version="0.1.0")

# Add CORS middleware to allow frontend requests
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for development
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Road distance is ~40% longer than straight-line haversine on urban routes.
TRAFFIC_FACTOR = 1.4

# Weather impact factors (mock values for integration documentation)
WEATHER_FACTORS = {
    "clear": 1.0,      # No weather impact
    "light_rain": 1.15, # 15% slower due to reduced visibility/caution
    "heavy_rain": 1.35, # 35% slower due to poor conditions
    "fog": 1.25,       # 25% slower due to reduced visibility
    "storm": 1.5,      # 50% slower due to dangerous conditions
}


def get_mock_weather_factor() -> tuple[str, float]:
    """Fallback mock weather factor when API key is missing."""
    conditions = [
        ("clear", 0.6), ("light_rain", 0.25), ("fog", 0.1),
        ("heavy_rain", 0.04), ("storm", 0.01),
    ]
    rand = random.random()
    cumulative = 0.0
    for condition, probability in conditions:
        cumulative += probability
        if rand <= cumulative:
            return condition, WEATHER_FACTORS[condition]
    return "clear", WEATHER_FACTORS["clear"]

async def get_real_weather_factor(lat: float, lng: float) -> tuple[str, float]:
    """Fetches real weather from OpenWeatherMap."""
    api_key = os.getenv("OPENWEATHERMAP_API_KEY")
    if not api_key:
        return get_mock_weather_factor()
    
    url = f"https://api.openweathermap.org/data/2.5/weather?lat={lat}&lon={lng}&appid={api_key}"
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(url, timeout=5.0)
            resp.raise_for_status()
            data = resp.json()
            weather_id = data["weather"][0]["id"]
            
            # Map OWM codes to our categories
            if 200 <= weather_id <= 232: return "storm", WEATHER_FACTORS["storm"]
            elif 300 <= weather_id <= 321: return "light_rain", WEATHER_FACTORS["light_rain"]
            elif 500 <= weather_id <= 504: return "heavy_rain", WEATHER_FACTORS["heavy_rain"]
            elif 511 <= weather_id <= 531: return "heavy_rain", WEATHER_FACTORS["heavy_rain"]
            elif 701 <= weather_id <= 781: return "fog", WEATHER_FACTORS["fog"]
            else: return "clear", WEATHER_FACTORS["clear"]
    except Exception as e:
        print(f"Weather API error: {e}")
        return get_mock_weather_factor()


def haversine_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    R = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    )
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))

async def get_google_route(origin_lat: float, origin_lng: float, dest_lat: float, dest_lng: float) -> dict:
    """Fetches real route, distance, and duration from Google Routes API."""
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        straight_m = haversine_meters(origin_lat, origin_lng, dest_lat, dest_lng)
        return {
            "distance_meters": straight_m * TRAFFIC_FACTOR,
            "duration_seconds": None,  # Will be calculated using average speed
            "polyline": None,
            "is_mock": True,
            "straight_m": straight_m
        }

    url = "https://routes.googleapis.com/directions/v2:computeRoutes"
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPath"
    }
    payload = {
        "origin": {
            "location": {
                "latLng": {"latitude": origin_lat, "longitude": origin_lng}
            }
        },
        "destination": {
            "location": {
                "latLng": {"latitude": dest_lat, "longitude": dest_lng}
            }
        },
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE"
    }
    
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(url, json=payload, headers=headers, timeout=5.0)
            resp.raise_for_status()
            data = resp.json()
            if not data.get("routes"):
                raise ValueError("No routes returned")
            
            route = data["routes"][0]
            duration_str = route.get("duration", "0s")
            duration_seconds = int(duration_str.replace("s", ""))
            
            return {
                "distance_meters": route.get("distanceMeters", 0),
                "duration_seconds": duration_seconds,
                "polyline": route.get("polyline", {}).get("encodedPath"),
                "is_mock": False
            }
    except Exception as e:
        print(f"Google Routes API error: {e}")
        straight_m = haversine_meters(origin_lat, origin_lng, dest_lat, dest_lng)
        return {
            "distance_meters": straight_m * TRAFFIC_FACTOR,
            "duration_seconds": None,
            "polyline": None,
            "is_mock": True,
            "straight_m": straight_m
        }


class PredictRequest(BaseModel):
    trip_id: UUID
    current_lat: float = Field(..., ge=-90, le=90)
    current_lng: float = Field(..., ge=-180, le=180)
    destination_lat: float = Field(..., ge=-90, le=90)
    destination_lng: float = Field(..., ge=-180, le=180)
    golden_hour_deadline: datetime
    avg_speed_kph: float = Field(..., gt=0)


class PredictResponse(BaseModel):
    trip_id: UUID
    predicted_eta_seconds: int
    deadline_seconds_remaining: int
    breach_probability: float
    will_breach: bool
    weather_condition: str
    weather_factor: float
    reasoning: str
    ai_confidence: float
    ai_reasoning: str
    risk_factors: list[str]
    recommendations: list[str]


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "cors": "enabled"}


@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest) -> PredictResponse:
    # Get Route info (Distance, Base ETA)
    route_data = await get_google_route(
        req.current_lat, req.current_lng,
        req.destination_lat, req.destination_lng
    )

    road_m = route_data["distance_meters"]
    
    # Get Weather conditions
    weather_condition, weather_factor = await get_real_weather_factor(req.current_lat, req.current_lng)

    # Calculate predicted ETA
    if route_data["is_mock"] or route_data["duration_seconds"] is None:
        speed_mps = req.avg_speed_kph * 1000 / 3600
        weather_adjusted_speed_mps = speed_mps / weather_factor
        predicted_eta_seconds = int(road_m / weather_adjusted_speed_mps)
        straight_m = route_data["straight_m"]
        route_reasoning = f"Step 1 — Haversine straight-line distance: {straight_m / 1000:.2f} km. Step 2 — Mock Road distance (×{TRAFFIC_FACTOR} traffic factor): {road_m / 1000:.2f} km. "
        speed_reasoning = f"Step 4 — At avg speed {req.avg_speed_kph:.1f} km/h, weather-adjusted to {weather_adjusted_speed_mps:.1f} m/s → predicted ETA {predicted_eta_seconds} s ({predicted_eta_seconds / 60:.1f} min). "
    else:
        # If real API is used, duration already accounts for traffic.
        # We only apply weather factor to the duration directly as a multiplier (since speed decreases, time increases).
        predicted_eta_seconds = int(route_data["duration_seconds"] * weather_factor)
        route_reasoning = f"Step 1/2 — Google Routes API actual road distance: {road_m / 1000:.2f} km, live traffic duration: {route_data['duration_seconds']} s. "
        speed_reasoning = f"Step 4 — Live traffic base ETA scaled by weather factor → predicted ETA {predicted_eta_seconds} s ({predicted_eta_seconds / 60:.1f} min). "

    # Step 5: seconds until golden-hour deadline
    now = datetime.now(timezone.utc)
    deadline = req.golden_hour_deadline
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    deadline_seconds_remaining = int((deadline - now).total_seconds())

    # Step 6: breach probability via logistic sigmoid centred at zero buffer.
    buffer_seconds = deadline_seconds_remaining - predicted_eta_seconds
    breach_probability = round(1 / (1 + math.exp(buffer_seconds / 300)), 3)
    will_breach = predicted_eta_seconds >= deadline_seconds_remaining

    reasoning = (
        route_reasoning +
        f"Step 3 — Weather conditions: {weather_condition} (×{weather_factor:.2f} impact factor). " +
        speed_reasoning +
        f"Step 5 — Golden-hour deadline in {deadline_seconds_remaining} s "
        f"({deadline_seconds_remaining / 60:.1f} min). "
        f"Step 6 — Buffer {buffer_seconds} s → breach probability {breach_probability:.3f} "
        f"(logistic sigmoid, scale=300 s). "
        f"Decision: {'WILL BREACH — drone handoff recommended.' if will_breach else 'ON TRACK — continue monitoring.'}"
    )

    # ai_confidence: certainty of the prediction — 0 at 50/50, 1 at fully certain
    ai_confidence = round(abs(0.5 - breach_probability) * 2, 3)

    risk_factors: list[str] = []
    if weather_factor > 1.0:
        risk_factors.append(f"weather:{weather_condition} (×{weather_factor:.2f})")
    if buffer_seconds < 0:
        risk_factors.append(f"eta_exceeds_deadline:{abs(buffer_seconds)}s over")
    elif buffer_seconds < 300:
        risk_factors.append(f"tight_buffer:{buffer_seconds}s remaining")
    if req.avg_speed_kph < 20:
        risk_factors.append(f"low_speed:{req.avg_speed_kph:.1f}kph")

    if will_breach:
        ai_reasoning = (
            f"Predicted ETA {predicted_eta_seconds}s exceeds deadline by "
            f"{abs(buffer_seconds)}s. Drone handoff recommended."
        )
        recommendations = [
            "Initiate drone handoff immediately.",
            "Notify receiving hospital of revised ETA.",
            "Alert ground coordinator.",
        ]
    else:
        ai_reasoning = (
            f"Predicted ETA {predicted_eta_seconds}s within deadline by "
            f"{buffer_seconds}s. Continue monitoring."
        )
        recommendations = [
            "Continue on current route.",
            "Re-evaluate if speed drops below 20 kph.",
        ]

    return PredictResponse(
        trip_id=req.trip_id,
        predicted_eta_seconds=predicted_eta_seconds,
        deadline_seconds_remaining=deadline_seconds_remaining,
        breach_probability=breach_probability,
        will_breach=will_breach,
        weather_condition=weather_condition,
        weather_factor=weather_factor,
        reasoning=reasoning,
        ai_confidence=ai_confidence,
        ai_reasoning=ai_reasoning,
        risk_factors=risk_factors,
        recommendations=recommendations,
    )

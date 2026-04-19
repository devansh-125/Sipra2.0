from __future__ import annotations

import math
from datetime import datetime, timezone
from uuid import UUID

from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI(title="Sipra AI Brain", version="0.1.0")

# Road distance is ~40% longer than straight-line haversine on urban routes.
TRAFFIC_FACTOR = 1.4


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
    reasoning: str


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/predict", response_model=PredictResponse)
async def predict(req: PredictRequest) -> PredictResponse:
    # Step 1: straight-line distance
    straight_m = haversine_meters(
        req.current_lat, req.current_lng,
        req.destination_lat, req.destination_lng,
    )

    # Step 2: estimate road distance with traffic factor
    road_m = straight_m * TRAFFIC_FACTOR

    # Step 3: travel time at average speed
    speed_mps = req.avg_speed_kph * 1000 / 3600
    predicted_eta_seconds = int(road_m / speed_mps)

    # Step 4: seconds until golden-hour deadline
    now = datetime.now(timezone.utc)
    deadline = req.golden_hour_deadline
    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=timezone.utc)
    deadline_seconds_remaining = int((deadline - now).total_seconds())

    # Step 5: breach probability via logistic sigmoid centred at zero buffer.
    # buffer > 0 → time to spare; buffer < 0 → already late.
    # Scale factor 300 s means probability crosses 0.5 exactly at the breach point
    # and reaches 0.88 at 5-min overshoot, 0.98 at 15-min overshoot.
    buffer_seconds = deadline_seconds_remaining - predicted_eta_seconds
    breach_probability = round(1 / (1 + math.exp(buffer_seconds / 300)), 3)
    will_breach = predicted_eta_seconds >= deadline_seconds_remaining

    reasoning = (
        f"Step 1 — Haversine straight-line distance: {straight_m / 1000:.2f} km. "
        f"Step 2 — Road distance (×{TRAFFIC_FACTOR} traffic factor): {road_m / 1000:.2f} km. "
        f"Step 3 — At avg speed {req.avg_speed_kph:.1f} km/h "
        f"({speed_mps:.1f} m/s) → predicted ETA {predicted_eta_seconds} s "
        f"({predicted_eta_seconds / 60:.1f} min). "
        f"Step 4 — Golden-hour deadline in {deadline_seconds_remaining} s "
        f"({deadline_seconds_remaining / 60:.1f} min). "
        f"Step 5 — Buffer {buffer_seconds} s → breach probability {breach_probability:.3f} "
        f"(logistic sigmoid, scale=300 s). "
        f"Decision: {'WILL BREACH — drone handoff recommended.' if will_breach else 'ON TRACK — continue monitoring.'}"
    )

    return PredictResponse(
        trip_id=req.trip_id,
        predicted_eta_seconds=predicted_eta_seconds,
        deadline_seconds_remaining=deadline_seconds_remaining,
        breach_probability=breach_probability,
        will_breach=will_breach,
        reasoning=reasoning,
    )

"""
POST /predict-drone — drone flight prediction.

Called by the Go risk monitor immediately after a DISPATCH_DRONE decision,
before invoking the partner drone-fleet dispatch API. The dispatcher then
echoes the AI-computed cruise speed, altitude, and ETA so the dashboard
banner reflects the live weather snapshot instead of a hardcoded constant.

Best-effort weather fetch: if no weather_condition is supplied in the
request and the live weather lookup fails, the predictor falls back to
'clear', matching the ETA-prediction fallback behavior.
"""
from __future__ import annotations

from fastapi import APIRouter

from ..domain import DronePredictRequest, DronePredictResponse
from ..drone_predictor import predict_drone_flight
from ..integrations import fetch_weather

router = APIRouter()


@router.post("/predict-drone", response_model=DronePredictResponse)
async def predict_drone(req: DronePredictRequest) -> DronePredictResponse:
    weather_observed = req.weather_condition
    if weather_observed is None:
        weather_observed, _src = await fetch_weather(req.pickup)

    outcome = predict_drone_flight(req, weather_condition_observed=weather_observed)
    return outcome.response

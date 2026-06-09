"""
Drone flight predictor.

Computes the air-route ETA the operator dashboard surfaces when the risk
monitor commits a DISPATCH_DRONE decision. The dispatcher mock no longer
hardcodes cruise speed or altitude — both come from this module and vary
with live weather, urgency, and payload.

Approach:

    nominal_cruise_kph                      (Sipra-MK2 spec sheet)
    × weather_speed_factor[weather]         (FAA Order 8900.1 weather minima)
    × payload_speed_factor(payload_kg)      (lift-coefficient derate)
    = effective_cruise_kph

    haversine(pickup, dropoff) / effective_cruise_kph * 3600
    + spin_up_seconds(urgency)              (preflight checklist time)
    = predicted_eta_seconds

Altitude is also weather-driven: VFR clear at 120 m, dropping to 50 m in
storm conditions to stay below worst turbulence. Every factor is logged
in the response so the dashboard can render the same explainability
panel it does for ETA predictions.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Optional

from .domain import (
    DronePredictRequest, DronePredictResponse, Factor, UrgencyTier,
)
from .integrations import haversine_meters


# ---------------------------------------------------------------------
# Drone-class capability constants — public Sipra-MK2 spec sheet.
# Treated as physical capability, not policy: the AI shapes them with
# environmental factors below.
# ---------------------------------------------------------------------

NOMINAL_CRUISE_KPH       = 95.0   # Wingcopter 198 / Zipline P2 class
NOMINAL_ALTITUDE_M       = 120    # VFR clear-weather cruise (per CAR Part 107)
PAYLOAD_KG_REFERENCE     = 2.0    # baseline organ-carrier weight
PAYLOAD_KG_MAX           = 4.5    # MK2 hardware ceiling


# Visibility/precipitation derate on cruise. Drone airspeed in heavy
# weather is reduced by the same orders of magnitude as small fixed-wing
# operations under FAA Order 8900.1 Vol 3 Ch 1.
WEATHER_CRUISE_FACTOR = {
    "clear":      1.00,
    "light_rain": 0.92,
    "heavy_rain": 0.78,
    "fog":        0.85,
    "storm":      0.62,
    "snow":       0.70,
}

# Lower altitude in poor weather to stay below worst turbulence and
# maintain ground-track visibility for the autonomous nav stack.
WEATHER_ALTITUDE_M = {
    "clear":      120,
    "light_rain": 100,
    "heavy_rain": 80,
    "fog":        60,
    "storm":      45,
    "snow":       70,
}

# Spin-up time by urgency — CRITICAL skips the long preflight checklist.
SPIN_UP_SECONDS_BY_URGENCY = {
    UrgencyTier.CRITICAL: 30,
    UrgencyTier.HIGH:     45,
    UrgencyTier.MEDIUM:   60,
    UrgencyTier.LOW:      90,
}
DEFAULT_SPIN_UP_SECONDS = 60


def payload_speed_factor(payload_kg: Optional[float]) -> float:
    """
    Lift-coefficient derate. Heavier payload → marginally lower cruise.
    Capped at 0.85 for max payload. Reference payload yields 1.0.
    """
    if payload_kg is None or payload_kg <= PAYLOAD_KG_REFERENCE:
        return 1.0
    over = min(PAYLOAD_KG_MAX, payload_kg) - PAYLOAD_KG_REFERENCE
    span = PAYLOAD_KG_MAX - PAYLOAD_KG_REFERENCE
    # Linear derate from 1.0 (at reference) to 0.85 (at max).
    return max(0.85, 1.0 - 0.15 * (over / span))


@dataclass
class DronePredictionOutcome:
    response:   DronePredictResponse
    latency_ms: int


def predict_drone_flight(
    req: DronePredictRequest,
    *,
    weather_condition_observed: Optional[str] = None,
) -> DronePredictionOutcome:
    """
    Pure computation — no network, no I/O. weather_condition_observed
    is the same string fetched by the ETA predictor for the ambulance
    (clear|light_rain|heavy_rain|fog|storm|snow); the drone predictor
    re-uses it so both predictions agree on the weather snapshot.
    """
    t0 = time.monotonic()

    weather = (
        req.weather_condition
        or weather_condition_observed
        or "clear"
    )
    weather_factor   = WEATHER_CRUISE_FACTOR.get(weather, 1.0)
    altitude_m       = WEATHER_ALTITUDE_M.get(weather, NOMINAL_ALTITUDE_M)
    payload_factor   = payload_speed_factor(req.payload_kg)
    spin_up_seconds  = SPIN_UP_SECONDS_BY_URGENCY.get(
        req.urgency_tier, DEFAULT_SPIN_UP_SECONDS
    ) if req.urgency_tier else DEFAULT_SPIN_UP_SECONDS

    cruise_kph = max(20.0, NOMINAL_CRUISE_KPH * weather_factor * payload_factor)

    route_m  = haversine_meters(
        req.pickup.lat, req.pickup.lng, req.dropoff.lat, req.dropoff.lng
    )
    route_km = round(route_m / 1000.0, 1)

    flight_seconds = int(round((route_m / 1000.0) / cruise_kph * 3600.0))
    eta_seconds    = flight_seconds + spin_up_seconds

    factors: list[Factor] = [
        Factor(
            name="nominal_cruise_kph",
            value=NOMINAL_CRUISE_KPH,
            unit="kph",
            description="Sipra-MK2 spec-sheet cruise at gross weight.",
            citation="Wingcopter 198 / Zipline P2 medical-delivery class spec.",
        ),
        Factor(
            name="weather_cruise_factor",
            value=weather_factor,
            unit="multiplier",
            description=f"Weather {weather!r} → cruise derate from FAA Order 8900.1 weather minima.",
            citation="FAA Order 8900.1 Vol 3 Ch 1 — small-aircraft weather operations.",
        ),
        Factor(
            name="payload_factor",
            value=payload_factor,
            unit="multiplier",
            description=(
                f"Payload {req.payload_kg or 0:.1f} kg "
                f"(reference {PAYLOAD_KG_REFERENCE:.1f} kg, max {PAYLOAD_KG_MAX:.1f} kg)."
            ),
            citation="Lift-coefficient derate — drone aerodynamics first principles.",
        ),
        Factor(
            name="effective_cruise_kph",
            value=round(cruise_kph, 1),
            unit="kph",
            description="nominal_cruise × weather_factor × payload_factor.",
            citation="Sipra drone-flight model.",
        ),
        Factor(
            name="altitude_m_cruise",
            value=float(altitude_m),
            unit="m",
            description=f"VFR altitude for weather {weather!r}.",
            citation="CAR Part 107 / DGCA RPAS Rules altitude guidance.",
        ),
        Factor(
            name="spin_up_seconds",
            value=float(spin_up_seconds),
            unit="s",
            description=(
                f"Preflight checklist time for urgency tier "
                f"{(req.urgency_tier.value if req.urgency_tier else 'unknown')}."
            ),
            citation="Sipra dispatch policy — urgency-tiered preflight.",
        ),
    ]

    reasoning = (
        f"Route {route_km:.1f} km haversine. "
        f"Nominal cruise {NOMINAL_CRUISE_KPH:.0f} kph × weather {weather} "
        f"×{weather_factor:.2f} × payload ×{payload_factor:.2f} "
        f"= effective {cruise_kph:.1f} kph at {altitude_m} m AGL. "
        f"Flight {flight_seconds} s + spin-up {spin_up_seconds} s "
        f"= ETA {eta_seconds} s."
    )

    response = DronePredictResponse(
        trip_id=req.trip_id,
        route_km=route_km,
        cruise_kph=round(cruise_kph, 1),
        altitude_m_cruise=altitude_m,
        spin_up_seconds=spin_up_seconds,
        flight_seconds=flight_seconds,
        eta_seconds=eta_seconds,
        weather_condition=weather,
        weather_factor=weather_factor,
        payload_factor=payload_factor,
        reasoning=reasoning,
        factors=factors,
    )

    return DronePredictionOutcome(
        response=response,
        latency_ms=int((time.monotonic() - t0) * 1000),
    )


__all__ = [
    "predict_drone_flight",
    "payload_speed_factor",
    "DronePredictionOutcome",
    "WEATHER_CRUISE_FACTOR",
    "WEATHER_ALTITUDE_M",
    "SPIN_UP_SECONDS_BY_URGENCY",
    "NOMINAL_CRUISE_KPH",
]

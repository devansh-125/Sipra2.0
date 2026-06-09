"""
External-API adapters: Google Routes v2, OpenWeatherMap, Vertex AI (Gemini).

Each call is wrapped in a circuit breaker + bounded timeout. Every call
returns a `source` field so the predictor can record degraded-mode use
in the audit log.
"""
from __future__ import annotations

import math
from typing import Any, Optional

import httpx

from .config import SETTINGS
from .domain import LatLng
from .reliability import (
    CircuitOpenError,
    ROUTES_BREAKER,
    VERTEX_BREAKER,
    WEATHER_BREAKER,
    retry_async,
)


# ---------------------------------------------------------------------
# Geo helper
# ---------------------------------------------------------------------

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


# ---------------------------------------------------------------------
# Google Routes API v2
#
# TRAFFIC_AWARE_OPTIMAL returns a duration produced by Google's GNN ETA
# model (Derrow-Pinion et al., CIKM 2021, arxiv.org/abs/2108.11482).
# We retain that value as the BACKBONE estimate; residual corrections
# (priority, weather, density, observed deviation) are layered on top.
# ---------------------------------------------------------------------

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"


async def fetch_route(origin: LatLng, dest: LatLng,
                      fallback_multiplier: float) -> dict[str, Any]:
    api_key = SETTINGS.google_maps_api_key

    def _fallback(reason: str) -> dict[str, Any]:
        straight_m = haversine_meters(origin.lat, origin.lng, dest.lat, dest.lng)
        return {
            "distance_meters":  straight_m * fallback_multiplier,
            "duration_seconds": None,
            "source":           reason,
        }

    if not api_key:
        return _fallback("fallback_no_api_key")

    headers = {
        "Content-Type":     "application/json",
        "X-Goog-Api-Key":   api_key,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
    }
    payload = {
        "origin":      {"location": {"latLng": {"latitude": origin.lat, "longitude": origin.lng}}},
        "destination": {"location": {"latLng": {"latitude": dest.lat,   "longitude": dest.lng}}},
        "travelMode":          "DRIVE",
        "routingPreference":   "TRAFFIC_AWARE_OPTIMAL",
    }

    async def _do() -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=SETTINGS.routes_timeout_s) as c:
            r = await c.post(ROUTES_URL, json=payload, headers=headers)
            r.raise_for_status()
            data = r.json()
            route = (data.get("routes") or [None])[0]
            if not route:
                raise ValueError("routes_empty")
            duration_s = int(str(route.get("duration", "0s")).rstrip("s"))
            return {
                "distance_meters":  route.get("distanceMeters", 0),
                "duration_seconds": duration_s,
                "source":           "google_routes_traffic_aware_optimal",
            }

    try:
        return await ROUTES_BREAKER.call(lambda: retry_async(_do, attempts=2))
    except CircuitOpenError:
        return _fallback("fallback_circuit_open")
    except Exception as exc:
        return _fallback(f"fallback_after_error:{type(exc).__name__}")


# ---------------------------------------------------------------------
# OpenWeatherMap → FHWA road-impact category
#
# FHWA "How Do Weather Events Impact Roads" gives empirical multipliers
# on free-flow speed. We map OWM's weather-code groups to those buckets.
# ---------------------------------------------------------------------

OWM_URL = "https://api.openweathermap.org/data/2.5/weather"


def _owm_to_category(wid: int) -> str:
    if 200 <= wid <= 232: return "storm"
    if 300 <= wid <= 321: return "light_rain"
    if 500 <= wid <= 504: return "heavy_rain"
    if 511 <= wid <= 531: return "heavy_rain"
    if 600 <= wid <= 622: return "snow"
    if 701 <= wid <= 781: return "fog"
    return "clear"


async def fetch_weather(at: LatLng) -> tuple[str, str]:
    """
    Returns (category, source). Caller maps category → multiplier from
    the active model_runs.parameters.weather_factors table.
    """
    api_key = SETTINGS.openweathermap_api_key
    if not api_key:
        return "clear", "fallback_no_api_key"

    async def _do() -> tuple[str, str]:
        async with httpx.AsyncClient(timeout=SETTINGS.weather_timeout_s) as c:
            r = await c.get(OWM_URL, params={"lat": at.lat, "lon": at.lng, "appid": api_key})
            r.raise_for_status()
            wid = r.json()["weather"][0]["id"]
            return _owm_to_category(int(wid)), "openweathermap"

    try:
        return await WEATHER_BREAKER.call(lambda: retry_async(_do, attempts=2))
    except CircuitOpenError:
        return "clear", "fallback_circuit_open"
    except Exception as exc:
        return "clear", f"fallback_after_error:{type(exc).__name__}"


# ---------------------------------------------------------------------
# Vertex AI Gemini — narrative generation for trip reports.
#
# The structured timeline is built deterministically from DB rows; Gemini
# only gets the structured payload and writes prose around it. If Vertex
# is unconfigured or fails, the report still ships with the deterministic
# Markdown summary. This keeps reporting *available* but lets the
# narrative quality scale with available infrastructure.
# ---------------------------------------------------------------------

async def vertex_narrate(prompt: str, *, max_tokens: int = 1024) -> Optional[str]:
    endpoint = SETTINGS.vertex_ai_endpoint
    token    = SETTINGS.vertex_ai_token
    if not endpoint or not token:
        return None

    async def _do() -> Optional[str]:
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type":  "application/json",
        }
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature":     0.2,
                "maxOutputTokens": max_tokens,
            },
        }
        async with httpx.AsyncClient(timeout=SETTINGS.vertex_timeout_s) as c:
            r = await c.post(endpoint, json=body, headers=headers)
            r.raise_for_status()
            data = r.json()
            cands = data.get("candidates") or []
            if not cands:
                return None
            parts = cands[0].get("content", {}).get("parts", [])
            return "".join(p.get("text", "") for p in parts) or None

    try:
        return await VERTEX_BREAKER.call(lambda: retry_async(_do, attempts=2))
    except (CircuitOpenError, Exception):
        return None

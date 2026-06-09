"""Smoke tests for the AI brain — no network calls, fallback path only."""
from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import (
    app,
    breach_probability,
    fleet_penalty_for_density,
    haversine_meters,
    recommend,
)

client = TestClient(app)


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_haversine_known_distance():
    # 0.1146° latitude separation at Mumbai longitude → ~12.7 km straight-line.
    d = haversine_meters(18.9398, 72.8355, 19.0544, 72.8402)
    assert 12_500 < d < 13_000, f"unexpected distance {d:.0f} m"


def test_fleet_penalty_below_threshold_is_neutral():
    assert fleet_penalty_for_density(0) == 1.0
    assert fleet_penalty_for_density(5) == 1.0


def test_fleet_penalty_above_threshold_grows():
    p10 = fleet_penalty_for_density(10)
    p20 = fleet_penalty_for_density(20)
    assert 1.0 < p10 < p20
    # Cap at +30%.
    assert fleet_penalty_for_density(1000) == 1.30


def test_breach_probability_sigmoid_endpoints():
    assert breach_probability(10_000) < 0.01    # huge buffer → safe
    assert breach_probability(-10_000) > 0.99   # huge overrun → certain
    assert 0.45 < breach_probability(0) < 0.55  # zero buffer → 50/50


def test_recommend_thresholds():
    assert recommend(0.10) == "CONTINUE"
    assert recommend(0.50) == "REQUEST_BOUNTY_BOOST"
    assert recommend(0.90) == "DISPATCH_DRONE"


def test_predict_will_breach_in_fallback_mode():
    # No GOOGLE_MAPS_API_KEY in test env → haversine fallback.
    # 50 km away at 30 kph, deadline 30 min → certain breach.
    payload = {
        "trip_id": str(uuid4()),
        "current_position": {"lat": 18.9398, "lng": 72.8355},
        "destination":      {"lat": 19.3909, "lng": 72.8355},  # ~55 km north
        "deadline_seconds_remaining": 1800,
        "recent_speeds_kph": [30, 28, 32, 29, 31],
        "fleet_density_in_corridor": 8,
    }
    r = client.post("/predict", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["will_breach"] is True
    assert data["breach_probability"] > 0.85
    assert data["recommendation"] == "DISPATCH_DRONE"


def test_predict_on_track_in_fallback_mode():
    # 1 km away at 60 kph, deadline 60 min → comfortably safe.
    payload = {
        "trip_id": str(uuid4()),
        "current_position": {"lat": 18.9398, "lng": 72.8355},
        "destination":      {"lat": 18.9488, "lng": 72.8355},  # ~1 km north
        "deadline_seconds_remaining": 3600,
        "recent_speeds_kph": [60, 58, 62, 61, 59],
        "fleet_density_in_corridor": 2,
    }
    r = client.post("/predict", json=payload)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["will_breach"] is False
    assert data["breach_probability"] < 0.05
    assert data["recommendation"] == "CONTINUE"


def test_predict_response_includes_all_contract_fields():
    payload = {
        "trip_id": str(uuid4()),
        "current_position": {"lat": 12.9716, "lng": 77.5946},
        "destination":      {"lat": 13.3379, "lng": 77.1031},
        "deadline_seconds_remaining": 4800,
        "recent_speeds_kph": [42, 44, 40, 38, 36],
        "fleet_density_in_corridor": 7,
    }
    r = client.post("/predict", json=payload)
    data = r.json()
    for field in (
        "trip_id", "predicted_eta_seconds", "deadline_seconds_remaining",
        "breach_probability", "will_breach", "recommendation",
        "weather_condition", "weather_factor", "fleet_density_in_corridor",
        "fleet_penalty", "effective_speed_kph", "ai_confidence", "reasoning",
    ):
        assert field in data, f"contract field {field!r} missing from response"

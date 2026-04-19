"""Smoke tests for the rules-based ETA estimator — no network, no DB."""
import math
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import app, haversine_meters

client = TestClient(app)


def test_healthz():
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_haversine_known_distance():
    # Mumbai CST to Bandra (roughly 8.7 km by road, ~6.2 km straight-line)
    d = haversine_meters(18.9398, 72.8355, 19.0544, 72.8402)
    assert 6_000 < d < 7_000, f"unexpected distance {d:.0f} m"


def test_predict_will_breach():
    """50 km away at 30 km/h, deadline 30 min → should breach."""
    deadline = datetime.now(timezone.utc) + timedelta(minutes=30)
    payload = {
        "trip_id": str(uuid4()),
        "current_lat": 18.9398,
        "current_lng": 72.8355,
        "destination_lat": 19.3609,  # ~50 km north
        "destination_lng": 72.8355,
        "golden_hour_deadline": deadline.isoformat(),
        "avg_speed_kph": 30.0,
    }
    r = client.post("/predict", json=payload)
    assert r.status_code == 200
    data = r.json()
    assert data["will_breach"] is True
    assert data["breach_probability"] > 0.5
    assert "WILL BREACH" in data["reasoning"]


def test_predict_on_track():
    """1 km away at 60 km/h, deadline 60 min → should be on track."""
    deadline = datetime.now(timezone.utc) + timedelta(minutes=60)
    payload = {
        "trip_id": str(uuid4()),
        "current_lat": 18.9398,
        "current_lng": 72.8355,
        "destination_lat": 18.9488,  # ~1 km north
        "destination_lng": 72.8355,
        "golden_hour_deadline": deadline.isoformat(),
        "avg_speed_kph": 60.0,
    }
    r = client.post("/predict", json=payload)
    assert r.status_code == 200
    data = r.json()
    assert data["will_breach"] is False
    assert data["breach_probability"] < 0.5
    assert "ON TRACK" in data["reasoning"]


def test_predict_reasoning_contains_all_steps():
    deadline = datetime.now(timezone.utc) + timedelta(minutes=45)
    payload = {
        "trip_id": str(uuid4()),
        "current_lat": 12.9716,
        "current_lng": 77.5946,
        "destination_lat": 13.0827,
        "destination_lng": 80.2707,
        "golden_hour_deadline": deadline.isoformat(),
        "avg_speed_kph": 80.0,
    }
    r = client.post("/predict", json=payload)
    reasoning = r.json()["reasoning"]
    for step in ("Step 1", "Step 2", "Step 3", "Step 4", "Step 5"):
        assert step in reasoning, f"{step} missing from reasoning"

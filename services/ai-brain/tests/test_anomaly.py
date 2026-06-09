"""Anomaly detector — pure, no I/O."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from app.anomaly import (
    detect_deviation, detect_jitter, detect_no_progress, detect_speed_anomaly,
    detect_stale_ping, scan,
)
from app.domain import AnomalyKind, AnomalySeverity, GPSPing, LatLng


def _ping(lat, lng, t, speed=40.0):
    return GPSPing(
        trip_id=uuid4(),
        position=LatLng(lat=lat, lng=lng),
        speed_kph=speed,
        recorded_at=t,
    )


def test_stale_ping_detected():
    tid = uuid4()
    now  = datetime.now(tz=timezone.utc)
    past = now - timedelta(seconds=300)
    out = detect_stale_ping(tid, _ping(12.97, 77.59, past), now=now)
    assert len(out) == 1
    assert out[0].kind is AnomalyKind.STALE_PING
    assert out[0].severity is AnomalySeverity.CRITICAL


def test_no_stale_when_fresh():
    tid = uuid4()
    now = datetime.now(tz=timezone.utc)
    out = detect_stale_ping(tid, _ping(12.97, 77.59, now), now=now)
    assert out == []


def test_jitter_detected_when_implied_speed_unphysical():
    tid = uuid4()
    t0 = datetime.now(tz=timezone.utc)
    pings = [
        _ping(12.97, 77.59, t0),
        _ping(13.07, 77.59, t0 + timedelta(seconds=1)),  # ~11 km in 1s
    ]
    out = detect_jitter(tid, pings)
    assert any(a.kind is AnomalyKind.GPS_JITTER for a in out)


def test_speed_anomaly():
    tid = uuid4()
    t = datetime.now(tz=timezone.utc)
    out = detect_speed_anomaly(tid, [_ping(12.97, 77.59, t, speed=250.0)])
    assert len(out) == 1
    assert out[0].kind is AnomalyKind.SPEED_ANOMALY


def test_deviation_off_route():
    tid = uuid4()
    # Planned route runs ~north along longitude 77.59, lat 12.97 → 13.0.
    route = [LatLng(lat=12.97, lng=77.59), LatLng(lat=13.00, lng=77.59)]
    far_off = LatLng(lat=12.97, lng=77.65)  # ~6.5 km east of the line
    out = detect_deviation(tid, far_off, route)
    assert len(out) == 1
    assert out[0].kind is AnomalyKind.ROUTE_DEVIATION


def test_deviation_on_route():
    tid = uuid4()
    route = [LatLng(lat=12.97, lng=77.59), LatLng(lat=13.00, lng=77.59)]
    near_route = LatLng(lat=12.985, lng=77.5905)
    assert detect_deviation(tid, near_route, route) == []


def test_no_progress_when_idle():
    tid = uuid4()
    t0 = datetime.now(tz=timezone.utc)
    pings = [
        _ping(12.9700, 77.5900, t0,                    speed=0),
        _ping(12.9700, 77.5900, t0 + timedelta(seconds=120), speed=0),
        _ping(12.9701, 77.5900, t0 + timedelta(seconds=240), speed=0),
    ]
    out = detect_no_progress(tid, pings, window_seconds=300, min_progress_m=50)
    assert len(out) == 1
    assert out[0].kind is AnomalyKind.NO_PROGRESS


def test_scan_combines_all():
    tid = uuid4()
    t0 = datetime.now(tz=timezone.utc)
    pings = [
        _ping(12.9700, 77.5900, t0,                    speed=250.0),  # speed anomaly
        _ping(13.0700, 77.5900, t0 + timedelta(seconds=1), speed=40),  # jitter
    ]
    out = scan(tid, pings)
    kinds = {a.kind for a in out}
    assert AnomalyKind.SPEED_ANOMALY in kinds
    assert AnomalyKind.GPS_JITTER in kinds

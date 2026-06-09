"""
Anomaly detection over a window of GPS pings.

Four kinds, each with a citation-backed threshold from app/config.py:

  STALE_PING       — last ping > N seconds old
  GPS_JITTER       — implied speed between consecutive pings
                     exceeds physically plausible cap
  SPEED_ANOMALY    — reported speed exceeds plausible cap
  ROUTE_DEVIATION  — current position is more than R metres from the
                     nearest point on the planned route polyline
  NO_PROGRESS      — distance covered in last K minutes < ε while
                     status == InTransit

Detection is *pure* — caller hands in pings + optional route polyline,
gets back Anomaly[]. Persistence is the caller's job.
"""
from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from .config import SETTINGS
from .domain import Anomaly, AnomalyKind, AnomalySeverity, GPSPing, LatLng
from .integrations import haversine_meters


def _utcnow() -> datetime:
    return datetime.now(tz=timezone.utc)


def detect_stale_ping(trip_id: UUID, last: GPSPing,
                      *, now: datetime | None = None) -> list[Anomaly]:
    now = now or _utcnow()
    age = (now - last.recorded_at).total_seconds()
    if age <= SETTINGS.stale_ping_seconds:
        return []
    severity = AnomalySeverity.CRITICAL if age >= 5 * SETTINGS.stale_ping_seconds else AnomalySeverity.WARNING
    return [Anomaly(
        trip_id=trip_id,
        kind=AnomalyKind.STALE_PING,
        severity=severity,
        evidence={"age_seconds": age, "threshold_seconds": SETTINGS.stale_ping_seconds},
    )]


def detect_jitter(trip_id: UUID, pings: list[GPSPing]) -> list[Anomaly]:
    if len(pings) < 2:
        return []
    out: list[Anomaly] = []
    for prev, cur in zip(pings, pings[1:]):
        dt = (cur.recorded_at - prev.recorded_at).total_seconds()
        if dt <= 0:
            continue
        d_m = haversine_meters(
            prev.position.lat, prev.position.lng,
            cur.position.lat,  cur.position.lng,
        )
        implied_mps = d_m / dt
        if implied_mps > SETTINGS.jitter_meters_per_second_max:
            out.append(Anomaly(
                trip_id=trip_id,
                kind=AnomalyKind.GPS_JITTER,
                severity=AnomalySeverity.WARNING,
                evidence={
                    "implied_mps":  round(implied_mps, 2),
                    "threshold_mps": SETTINGS.jitter_meters_per_second_max,
                    "distance_m":    round(d_m, 1),
                    "delta_seconds": round(dt, 2),
                    "from": prev.position.model_dump(),
                    "to":   cur.position.model_dump(),
                },
            ))
    return out


def detect_speed_anomaly(trip_id: UUID, pings: list[GPSPing]) -> list[Anomaly]:
    out: list[Anomaly] = []
    for p in pings:
        if p.speed_kph is None:
            continue
        if p.speed_kph > SETTINGS.speed_anomaly_kph_max:
            out.append(Anomaly(
                trip_id=trip_id,
                kind=AnomalyKind.SPEED_ANOMALY,
                severity=AnomalySeverity.WARNING,
                evidence={
                    "speed_kph":     p.speed_kph,
                    "threshold_kph": SETTINGS.speed_anomaly_kph_max,
                    "recorded_at":   p.recorded_at.isoformat(),
                },
            ))
    return out


def _point_to_segment_meters(p: LatLng, a: LatLng, b: LatLng) -> float:
    """
    Approximate point-to-segment distance using small-angle planar
    geometry on the local tangent plane. Good enough for deviation
    thresholds in the kilometre range; haversine for the legs.
    """
    da = haversine_meters(p.lat, p.lng, a.lat, a.lng)
    db = haversine_meters(p.lat, p.lng, b.lat, b.lng)
    ab = haversine_meters(a.lat, a.lng, b.lat, b.lng)
    if ab < 1e-6:
        return min(da, db)
    # Project p onto the segment using the law of cosines on the triangle.
    # cos(angle at a) = (da^2 + ab^2 - db^2) / (2*da*ab)
    if da == 0:
        return 0.0
    cos_a = max(-1.0, min(1.0, (da * da + ab * ab - db * db) / (2 * da * ab)))
    proj = da * cos_a
    if proj <= 0:
        return da
    if proj >= ab:
        return db
    perp_sq = max(0.0, da * da - proj * proj)
    return perp_sq ** 0.5


def detect_deviation(trip_id: UUID, current: LatLng,
                     planned_route: list[LatLng]) -> list[Anomaly]:
    if len(planned_route) < 2:
        return []
    min_m = min(
        _point_to_segment_meters(current, a, b)
        for a, b in zip(planned_route, planned_route[1:])
    )
    if min_m <= SETTINGS.deviation_meters_max:
        return []
    severity = (
        AnomalySeverity.CRITICAL
        if min_m > 3 * SETTINGS.deviation_meters_max
        else AnomalySeverity.WARNING
    )
    return [Anomaly(
        trip_id=trip_id,
        kind=AnomalyKind.ROUTE_DEVIATION,
        severity=severity,
        evidence={
            "deviation_m":   round(min_m, 1),
            "threshold_m":   SETTINGS.deviation_meters_max,
            "current":       current.model_dump(),
        },
    )]


def detect_no_progress(trip_id: UUID, pings: list[GPSPing],
                       *, window_seconds: int = 300,
                       min_progress_m: float = 50.0) -> list[Anomaly]:
    if len(pings) < 2:
        return []
    end = pings[-1]
    cutoff = end.recorded_at.timestamp() - window_seconds
    window = [p for p in pings if p.recorded_at.timestamp() >= cutoff]
    if len(window) < 2:
        return []
    progress_m = haversine_meters(
        window[0].position.lat, window[0].position.lng,
        window[-1].position.lat, window[-1].position.lng,
    )
    if progress_m >= min_progress_m:
        return []
    return [Anomaly(
        trip_id=trip_id,
        kind=AnomalyKind.NO_PROGRESS,
        severity=AnomalySeverity.WARNING,
        evidence={
            "window_seconds": window_seconds,
            "progress_m":     round(progress_m, 1),
            "threshold_m":    min_progress_m,
            "samples":        len(window),
        },
    )]


def scan(trip_id: UUID, pings: list[GPSPing], *,
         planned_route: list[LatLng] | None = None,
         now: datetime | None = None) -> list[Anomaly]:
    if not pings:
        return []
    out: list[Anomaly] = []
    out += detect_stale_ping(trip_id, pings[-1], now=now)
    out += detect_jitter(trip_id, pings)
    out += detect_speed_anomaly(trip_id, pings)
    out += detect_no_progress(trip_id, pings)
    if planned_route:
        out += detect_deviation(trip_id, pings[-1].position, planned_route)
    return out

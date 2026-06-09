"""Decision-engine state-machine tests — pure, no I/O."""
from uuid import uuid4

from app.decision_engine import decide
from app.domain import (
    Anomaly, AnomalyKind, AnomalySeverity, DecisionAction, OrganType,
    PredictResponse, UrgencyTier,
)
from app.predictor import BOOTSTRAP_PARAMS

MP = BOOTSTRAP_PARAMS


def _pred(**overrides) -> PredictResponse:
    base = dict(
        trip_id=uuid4(),
        predicted_eta_seconds=600,
        deadline_seconds_remaining=1200,
        breach_probability=0.10,
        will_breach=False,
        recommendation="CONTINUE",
        weather_condition="clear",
        weather_factor=1.0,
        fleet_density_in_corridor=0,
        fleet_penalty=1.0,
        effective_speed_kph=40.0,
        ai_confidence=0.9,
        reasoning="-",
        backbone="google_routes_traffic_aware_optimal",
        urgency_tier=UrgencyTier.LOW,
    )
    base.update(overrides)
    return PredictResponse(**base)


def test_continue_when_safe():
    d = decide(_pred(), anomalies=[], mp=MP, corridor_active=False)
    assert d.action is DecisionAction.CONTINUE
    assert d.rule_path == ["R6:continue"]


def test_drone_when_high_breach():
    d = decide(_pred(breach_probability=0.95, will_breach=True), anomalies=[], mp=MP, corridor_active=True)
    assert d.action is DecisionAction.DISPATCH_DRONE
    assert any("R2" in r for r in d.rule_path)


def test_drone_when_critical_organ_will_breach():
    d = decide(
        _pred(breach_probability=0.55, will_breach=True, urgency_tier=UrgencyTier.CRITICAL),
        anomalies=[], mp=MP, corridor_active=True,
    )
    assert d.action is DecisionAction.DISPATCH_DRONE


def test_activate_corridor_first_time():
    d = decide(_pred(breach_probability=0.55), anomalies=[], mp=MP, corridor_active=False)
    assert d.action is DecisionAction.ACTIVATE_CORRIDOR


def test_request_bounty_when_corridor_already_active():
    d = decide(_pred(breach_probability=0.55), anomalies=[], mp=MP, corridor_active=True)
    assert d.action is DecisionAction.REQUEST_BOUNTY_BOOST


def test_abort_on_deviation_plus_no_progress():
    tid = uuid4()
    anoms = [
        Anomaly(trip_id=tid, kind=AnomalyKind.ROUTE_DEVIATION, severity=AnomalySeverity.CRITICAL, evidence={}),
        Anomaly(trip_id=tid, kind=AnomalyKind.NO_PROGRESS,    severity=AnomalySeverity.WARNING,  evidence={}),
    ]
    d = decide(_pred(trip_id=tid), anomalies=anoms, mp=MP, corridor_active=True)
    assert d.action is DecisionAction.ABORT
    assert d.rule_path[0].startswith("R1")


def test_reroute_on_deviation_only_with_routes_backbone():
    tid = uuid4()
    anoms = [Anomaly(trip_id=tid, kind=AnomalyKind.ROUTE_DEVIATION, severity=AnomalySeverity.WARNING, evidence={})]
    d = decide(_pred(trip_id=tid), anomalies=anoms, mp=MP, corridor_active=True)
    assert d.action is DecisionAction.REROUTE


def test_critical_anomaly_lowers_confidence():
    tid = uuid4()
    anoms = [Anomaly(trip_id=tid, kind=AnomalyKind.GPS_JITTER, severity=AnomalySeverity.CRITICAL, evidence={})]
    d = decide(_pred(trip_id=tid, ai_confidence=0.9), anomalies=anoms, mp=MP, corridor_active=True)
    assert d.confidence <= 0.45 + 1e-9


def test_organ_critical_tier_classification():
    from app.domain import urgency_tier
    # Heart: 4h ceiling. 30 min remaining → critical.
    assert urgency_tier(OrganType.HEART, 30 * 60) is UrgencyTier.CRITICAL
    # Kidney: 18h ceiling. 12h remaining → high (12/18 = 0.67 → MEDIUM actually).
    # Note 12/18 = 0.67 → MEDIUM bucket.
    assert urgency_tier(OrganType.KIDNEY, 12 * 3600) is UrgencyTier.MEDIUM
    # Cornea: 7d ceiling. 6d remaining → low.
    assert urgency_tier(OrganType.CORNEA, 6 * 24 * 3600) is UrgencyTier.LOW
